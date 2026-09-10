#!/usr/bin/env node
/**
 * SVG conformance harness — resvg test suite.
 *
 * Drives the real editor in a headless browser: for each vendored test it
 * resets to a blank document sized to the SVG viewBox, imports the SVG via the
 * app's own importer (`app.ui.parseSVG`), rasterises the document to PNG at the
 * same scale the reference was rendered at (refWidth / viewBoxWidth), then
 * compares the two images pixel-for-pixel *inside the page* using CanvasKit
 * (both flattened onto white to normalise alpha). No native image deps needed.
 *
 * The editor's importer is lossy by design, so this is a *conformance tracker*,
 * not a pass/fail gate: it records a per-test similarity score and compares the
 * run against a committed baseline. CI fails only on REGRESSIONS (a test that
 * scored well before and now scores worse), never on the large body of
 * features that simply aren't implemented yet.
 *
 * Usage:
 *   node tests/svg-suite/harness.mjs                 # run all, compare to baseline
 *   node tests/svg-suite/harness.mjs --update        # run all, (re)write baseline.json
 *   node tests/svg-suite/harness.mjs --filter shapes # only tests whose path contains "shapes"
 *   node tests/svg-suite/harness.mjs --diff          # write diff PNGs for regressions to report/
 *   node tests/svg-suite/harness.mjs --url http://localhost:5173   # use an already-running dev server
 *
 * Env knobs: PASS_THRESHOLD (default 0.98), REGRESSION_EPS (default 0.02).
 */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');
const FIXTURES = join(__dirname, 'fixtures', 'tests');
const BASELINE_PATH = join(__dirname, 'baseline.json');
const REPORT_DIR = join(__dirname, 'report');

const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const flagVal = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const UPDATE = hasFlag('--update');
const WRITE_DIFF = hasFlag('--diff');
// Round-trip mode: import → export SVG → re-import → render. Compared against
// the normal import baseline, so any drop reveals an EXPORT fidelity loss.
const ROUNDTRIP = hasFlag('--roundtrip');
const FILTER = flagVal('--filter');
const EXTERNAL_URL = flagVal('--url');
const LIMIT = flagVal('--limit') ? parseInt(flagVal('--limit'), 10) : Infinity;
const PASS_THRESHOLD = parseFloat(process.env.PASS_THRESHOLD ?? '0.98');
const REGRESSION_EPS = parseFloat(process.env.REGRESSION_EPS ?? '0.02');

// ── Discover test files ────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.svg') && existsSync(p.replace(/\.svg$/, '.png'))) out.push(p);
  }
  return out;
}
let tests = walk(FIXTURES).sort();
if (FILTER) tests = tests.filter((p) => relative(FIXTURES, p).includes(FILTER));
tests = tests.slice(0, LIMIT);
if (tests.length === 0) { console.error('No matching tests.'); process.exit(1); }
console.log(`Discovered ${tests.length} test(s).`);

// ── Parse the SVG viewport (used for doc size + render scale) ───────────────
function parseViewport(svgText) {
  // Only read width/height off the <svg> opening tag. A leading \s guard keeps
  // `stroke-width=` (and child-element width/height) from matching.
  const svgTag = (svgText.match(/<svg\b[^>]*>/i) || [''])[0];
  const w = parseFloat((svgTag.match(/(?:^|\s)width\s*=\s*["']([\d.]+)/) || [])[1]);
  const h = parseFloat((svgTag.match(/(?:^|\s)height\s*=\s*["']([\d.]+)/) || [])[1]);
  const vb = svgText.match(/viewBox\s*=\s*["']([^"']+)["']/);
  if (vb) {
    const p = vb[1].trim().split(/[\s,]+/).map(Number);
    if (p.length >= 4 && p[2] > 0 && p[3] > 0) {
      // When explicit width/height define a DIFFERENT aspect ratio than the
      // viewBox, the SVG viewport is width×height and the viewBox is fitted
      // into it via preserveAspectRatio — resvg renders at the viewport size.
      // Keep width/height in that case so the importer applies the fit; the
      // common (matching-aspect) case keeps geometry in viewBox units.
      const hasWH = w > 0 && h > 0;
      const aspectDiffers = hasWH && Math.abs((w / h) - (p[2] / p[3])) > 0.01;
      if (aspectDiffers) return { w, h, hasViewBox: true, keepWH: true };
      return { w: p[2], h: p[3], hasViewBox: true, keepWH: false };
    }
  }
  if (w > 0 && h > 0) return { w, h, hasViewBox: false, keepWH: false };
  return null;
}

// PNG dimensions straight from the IHDR chunk — avoids decoding on the Node side.
function pngSize(buf) {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// ── Dev server ──────────────────────────────────────────────────────────────
async function freePort() {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.listen(0, () => { const { port } = srv.address(); srv.close(() => res(port)); });
  });
}

async function startServer() {
  if (EXTERNAL_URL) return { url: EXTERNAL_URL, stop: async () => {} };
  const port = await freePort();
  const bin = join(REPO, 'node_modules', '.bin', 'vite');
  const proc = spawn(bin, [join(REPO, 'packages', 'app'), '--port', String(port), '--strictPort'], { cwd: REPO, stdio: 'ignore' });
  const url = `http://localhost:${port}`;
  // Wait for the server to answer.
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(url); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return { url, stop: async () => { proc.kill(); } };
}

// ── Browser ──────────────────────────────────────────────────────────────────
// Puppeteer ships without a browser: its pinned Chrome is a separate, one-time
// download that `pnpm install` does NOT perform. Say so, with the command to
// run, instead of letting a raw launcher stack trace be the first thing a
// newcomer sees.
async function launchBrowser() {
  try {
    return await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  } catch (e) {
    if (!/Could not find Chrome/i.test(String((e && e.message) || e))) throw e;
    console.error(
      '\n✗ Chrome for Puppeteer is not installed — the suite drives the editor in it.\n' +
      '  One-time setup, from the repo root:\n\n' +
      '      ./node_modules/.bin/puppeteer browsers install chrome\n\n' +
      '  (~350 MB, cached in ~/.cache/puppeteer and shared by every checkout.)\n');
    return null;
  }
}

// ── In-page: import + rasterise + pixel-diff (runs inside the browser) ───────
// Returns { status, similarity, rmse, refW, refH, outW, outH, scale, error?, diffB64? }.
async function runInPage(page, svgText, refB64, vp, wantDiff, roundtrip) {
  return page.evaluate(async (svgText, refB64, vp, wantDiff, roundtrip) => {
    const app = window.app, ck = app.ck;
    try {
      app.scene.newDocument(vp.w, vp.h);
      // When a viewBox defines the coordinate system, drop width/height so the
      // importer keeps geometry in viewBox units (matching resvg's render).
      let svg = svgText;
      if (vp.hasViewBox && !vp.keepWH) {
        svg = svg.replace(/<svg([^>]*)>/, (m, a) =>
          '<svg' + a.replace(/\s(width|height)\s*=\s*["'][^"']*["']/g, '') + '>');
      }
      await app.ui.parseSVG(svg);

      // Round-trip: export what we just imported, then re-import it. The render
      // below then reflects EXPORT fidelity (vs the import-only baseline).
      if (roundtrip) {
        const exported = app.ui.buildSVGString();
        app.scene.newDocument(vp.w, vp.h);
        await app.ui.parseSVG(exported);
      }

      // Text faces are fetched asynchronously (the import kicks them off).
      // Exporting before they arrive rasterises a fallback face, which measures
      // a network race rather than rendering fidelity — 316 of the suite's text
      // tests ask for "Noto Sans".
      if (app.fontsReady) await app.fontsReady();

      const refBytes = Uint8Array.from(atob(refB64), (c) => c.charCodeAt(0));
      const refImg = ck.MakeImageFromEncoded(refBytes);
      const refW = refImg.width(), refH = refImg.height();
      const scale = refW / vp.w;

      const blob = app.renderer.exportPNG(scale);
      if (!blob) { refImg.delete(); return { status: 'error', error: 'exportPNG returned null' }; }
      const outBytes = new Uint8Array(await blob.arrayBuffer());
      const outImg = ck.MakeImageFromEncoded(outBytes);
      const outW = outImg.width(), outH = outImg.height();

      const info = (img) => ({
        width: img.width(), height: img.height(),
        colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul,
        colorSpace: ck.ColorSpace.SRGB,
      });
      const refPx = refImg.readPixels(0, 0, info(refImg));
      const outPx = outImg.readPixels(0, 0, info(outImg));

      const W = Math.min(refW, outW), H = Math.min(refH, outH);
      const maxArea = Math.max(refW, outW) * Math.max(refH, outH);
      const flat = (px, i) => {
        const a = px[i + 3] / 255;
        return [px[i] * a + 255 * (1 - a), px[i + 1] * a + 255 * (1 - a), px[i + 2] * a + 255 * (1 - a)];
      };
      let diffCount = 0, sse = 0;
      let diffData = null;
      if (wantDiff) diffData = new Uint8ClampedArray(W * H * 4);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const ir = (y * refW + x) * 4, io = (y * outW + x) * 4;
          const r = flat(refPx, ir), o = flat(outPx, io);
          const d = Math.abs(r[0] - o[0]) + Math.abs(r[1] - o[1]) + Math.abs(r[2] - o[2]);
          sse += (r[0] - o[0]) ** 2 + (r[1] - o[1]) ** 2 + (r[2] - o[2]) ** 2;
          const differs = d > 30;
          if (differs) diffCount++;
          if (diffData) {
            const di = (y * W + x) * 4;
            // magenta where different, faded grey of the reference elsewhere
            if (differs) { diffData[di] = 255; diffData[di + 1] = 0; diffData[di + 2] = 255; diffData[di + 3] = 255; }
            else { const g = (r[0] + r[1] + r[2]) / 3; diffData[di] = diffData[di + 1] = diffData[di + 2] = 128 + g / 2; diffData[di + 3] = 255; }
          }
        }
      }
      // Count non-overlapping area (size mismatch) as fully different.
      const overlap = W * H;
      const total = maxArea;
      const totalDiff = diffCount + (total - overlap);

      let diffB64 = null;
      if (diffData) {
        const surf = ck.MakeSurface(W, H);
        const img2 = ck.MakeImage({ width: W, height: H, colorType: ck.ColorType.RGBA_8888,
          alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB }, diffData, W * 4);
        const cv = surf.getCanvas(); cv.drawImage(img2, 0, 0);
        const snap = surf.makeImageSnapshot();
        const enc = snap.encodeToBytes();
        diffB64 = btoa(String.fromCharCode(...enc));
        img2.delete(); snap.delete(); surf.delete();
      }
      refImg.delete(); outImg.delete();
      return {
        status: 'ok', similarity: 1 - totalDiff / total, rmse: Math.sqrt(sse / (overlap * 3)),
        refW, refH, outW, outH, scale, diffB64,
      };
    } catch (e) {
      return { status: 'error', error: String(e && e.message || e) };
    }
  }, svgText, refB64, vp, wantDiff, roundtrip);
}

// ── Main ─────────────────────────────────────────────────────────────────────
const server = await startServer();
console.log(`Dev server: ${server.url}`);
const browser = await launchBrowser();
if (!browser) { await server.stop(); process.exit(1); }

const APP_READY = () => window.app && window.app.scene && window.app.scene.engine
  && window.app.ui && window.app.renderer && window.app.ck;

let page;
async function loadApp() {
  // Use a FRESH page each time (not reload): it fully resets the JS/WASM heap
  // and sidesteps two flakiness sources in the newer app — long-lived
  // connections (HMR, autosave/version-history) that keep the network from ever
  // idling, and vite's cold dep-optimization forcing a mid-load reload that
  // aborts navigation. Navigation is best-effort; the real readiness gate is
  // `window.app` appearing. The old page is only closed once the new one is
  // healthy, so a failed refresh leaves the previous page usable.
  const fresh = await browser.newPage();
  fresh.on('pageerror', () => { /* swallow: per-test try/catch reports real errors */ });
  try { await fresh.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch { /* nav aborted; app may still load */ }
  await fresh.evaluate(() => localStorage.clear()).catch(() => {});
  try { await fresh.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }); } catch { /* same */ }
  await fresh.waitForFunction(APP_READY, { timeout: 120000 });
  if (page) await page.close().catch(() => {});
  page = fresh;
}
await loadApp();

const results = {};
let done = 0;
const t0 = Date.now();
for (const svgPath of tests) {
  const rel = relative(FIXTURES, svgPath).replace(/\\/g, '/');
  const svgText = readFileSync(svgPath, 'utf8');
  const refBuf = readFileSync(svgPath.replace(/\.svg$/, '.png'));
  const vp = parseViewport(svgText) || { ...pngSize(refBuf), hasViewBox: false };
  const refB64 = refBuf.toString('base64');

  // An errored test is recorded as 0.000, which reads exactly like a
  // regression — so anything transient manufactures phantom regressions. Two
  // failures are known to be transient rather than real:
  //
  //   * `timeout` — the budget is a fixed 20s, so a machine busy with
  //     something else (a parallel build, another suite) pushes a slow test
  //     over it.
  //   * `Execution context was destroyed` — vite reloads the page when it
  //     first optimises a lazily-imported dependency, which can land in the
  //     middle of a test.
  //
  // Both survive a retry on a fresh page; neither reproduces when the affected
  // tests are run on their own. A genuine hang or crash fails twice, and the
  // second failure is labelled so the distinction stays visible.
  const TRANSIENT = /^timeout$|Execution context was destroyed/;
  const attempt = () =>
    Promise.race([
      runInPage(page, svgText, refB64, vp, WRITE_DIFF, ROUNDTRIP),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000)),
    ]);

  let res;
  try {
    res = await attempt();
  } catch (e) {
    const transient = TRANSIENT.test(String(e.message || e));
    await loadApp(); // recover the page after a hang/crash
    if (transient) {
      try {
        res = await attempt();
      } catch (e2) {
        res = { status: 'error', error: `${String(e2.message || e2)} (twice)` };
        await loadApp();
      }
    } else {
      res = { status: 'error', error: String(e.message || e) };
    }
  }

  // A CanvasKit `Aborted()` (WASM OOM) is caught *inside* runInPage and returned
  // as status:'error' — it never throws out to the catch above, so without this
  // the aborted page survives and every later test fails ('exportPNG returned
  // null'), silently zeroing hundreds of scores. On any error, probe whether the
  // WASM context is still alive; reload only if it's dead. Cheap: runs solely on
  // the error path, which is rare once exports don't leak.
  if (res.status === 'error') {
    const alive = await page
      .evaluate(() => {
        try {
          const s = window.app.ck.MakeSurface(1, 1);
          if (!s) return false;
          s.delete();
          return true;
        } catch {
          return false;
        }
      })
      .catch(() => false);
    if (!alive) await loadApp();
  }

  const { diffB64, ...rec } = res;
  results[rel] = rec;
  // Only dump diffs for tests that actually fail — combine with --filter to
  // inspect a specific area without producing a diff for all ~1.7k tests.
  if (WRITE_DIFF && diffB64 && !(rec.status === 'ok' && rec.similarity >= PASS_THRESHOLD)) {
    const outPath = join(REPORT_DIR, 'diffs', rel.replace(/\.svg$/, '.diff.png'));
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, Buffer.from(diffB64, 'base64'));
  }

  done++;
  if (done % 50 === 0 || done === tests.length) {
    const pct = ((done / tests.length) * 100).toFixed(0);
    process.stdout.write(`\r  ${done}/${tests.length} (${pct}%)   `);
  }
  // Periodic page reload to keep the WASM heap from growing unbounded. Best
  // effort: if a reload fails to re-init the app in time, keep going on the
  // current page rather than aborting the whole run (per-test newDocument +
  // the render-buffer copy already bound heap growth).
  if (done % 400 === 0) {
    try { await loadApp(); } catch { /* refresh failed; keep the previous page */ }
  }
}
process.stdout.write('\n');
await browser.close();
await server.stop();

// ── Aggregate + report ────────────────────────────────────────────────────
const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
const cats = {};
let sumSim = 0, okCount = 0, errCount = 0, passCount = 0;
for (const [rel, r] of Object.entries(results)) {
  const cat = rel.split('/')[0];
  cats[cat] ??= { n: 0, sum: 0, pass: 0, err: 0 };
  cats[cat].n++;
  if (r.status === 'ok') {
    okCount++; sumSim += r.similarity; cats[cat].sum += r.similarity;
    if (r.similarity >= PASS_THRESHOLD) { passCount++; cats[cat].pass++; }
  } else { errCount++; cats[cat].err++; }
}
mkdirSync(REPORT_DIR, { recursive: true });
writeFileSync(join(REPORT_DIR, 'results.json'),
  JSON.stringify({ meta: { when: new Date().toISOString(), tests: tests.length, elapsed, PASS_THRESHOLD }, results }, null, 2));

console.log(`\n── SVG conformance (resvg suite) ──  ${elapsed}s`);
console.log(`  passing (≥${PASS_THRESHOLD}): ${passCount}/${tests.length}` +
  `   mean similarity: ${(sumSim / Math.max(okCount, 1)).toFixed(4)}   errors: ${errCount}`);
console.log('  by category:');
for (const [cat, c] of Object.entries(cats).sort()) {
  console.log(`    ${cat.padEnd(14)} pass ${String(c.pass).padStart(4)}/${String(c.n).padStart(4)}` +
    `   mean ${(c.sum / Math.max(c.n - c.err, 1)).toFixed(3)}${c.err ? `   err ${c.err}` : ''}`);
}

// An errored test scores 0 and drags the pass count down, so an unexplained
// `errors: N` looks exactly like a real regression. The message was recorded in
// results.json but never shown, which left the only actionable detail buried in
// a file nobody opens. Print it, grouped, so a flaky run is diagnosable from the
// console it was run in.
if (errCount) {
  const byMessage = new Map();
  for (const [rel, r] of Object.entries(results)) {
    if (r.status !== 'error') continue;
    const key = String(r.error || 'unknown');
    if (!byMessage.has(key)) byMessage.set(key, []);
    byMessage.get(key).push(rel);
  }
  console.log(`\n  ${errCount} test(s) errored (each scores 0.000):`);
  for (const [msg, rels] of [...byMessage].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`    ${rels.length}x  ${msg}`);
    for (const rel of rels.slice(0, 5)) console.log(`          ${rel}`);
    if (rels.length > 5) console.log(`          …and ${rels.length - 5} more`);
  }
}

// ── Baseline: update or gate on regressions ────────────────────────────────
if (UPDATE && ROUNDTRIP) {
  console.log('\n⚠ Refusing to --update the baseline in --roundtrip mode (it holds import scores).');
  process.exit(1);
}
if (ROUNDTRIP) {
  // Compare round-trip scores to the import baseline: any drop is an export bug.
  const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : {};
  const drops = [];
  for (const [rel, r] of Object.entries(results)) {
    const base = baseline[rel];
    if (base == null || r.status !== 'ok') continue;
    const delta = base - r.similarity;
    if (delta > REGRESSION_EPS) drops.push({ rel, base, got: r.similarity, delta });
  }
  drops.sort((a, b) => b.delta - a.delta);
  console.log(`\n── Export round-trip fidelity ──`);
  console.log(`  ${drops.length} test(s) lose >${REGRESSION_EPS} fidelity on export (import → export → re-import):`);
  for (const d of drops.slice(0, 40)) {
    console.log(`    ${d.base.toFixed(3)} → ${d.got.toFixed(3)}  (−${d.delta.toFixed(3)})  ${d.rel}`);
  }
  if (drops.length > 40) console.log(`    …and ${drops.length - 40} more`);
  process.exit(0);
}
if (UPDATE) {
  const baseline = {};
  for (const [rel, r] of Object.entries(results)) baseline[rel] = r.status === 'ok' ? +r.similarity.toFixed(4) : null;
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 0).replace(/,/g, ',\n') + '\n');
  console.log(`\n✔ baseline.json written (${Object.keys(baseline).length} entries).`);
  process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
  console.log('\n⚠ No baseline.json — run with --update to create one. Skipping regression gate.');
  process.exit(0);
}
const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
// A regression is a test that was PASSING in the baseline (>= PASS_THRESHOLD)
// and has now clearly broken (dropped below the threshold by more than the
// noise margin). We deliberately do NOT gate on movement within the large body
// of already-failing tests: several of those (patterns, filters) are rendered
// through async/AA paths that jitter run-to-run, and gating them would produce
// false failures. Progress on failing tests shows up in the pass count / mean.
// Five baseline entries record a score the current architecture cannot reach
// again. They are NOT bugs — each was diagnosed by rendering the diff and
// looking at it (see README, "Known"), and each is a ceiling imposed by
// comparing Chrome's rasterizer against resvg's, not by our code:
//
//   feTile/*            Chrome and resvg disagree on the tile PHASE. The diff
//                       is the full lattice, present in both, displaced.
//   feConvolveMatrix    Magenta traces tile OUTLINES only; every interior
//                       matches. The convolution is right, the AA is not ours.
//   image-rendering     Magenta traces the nearest-neighbour block boundaries;
//                       interiors match. A sub-pixel sample-grid disagreement.
//
// They are pinned at their true current scores rather than re-recorded at
// 1.000 via `--update`, which would bless them as correct and destroy the
// record of what still differs. A drop BELOW these values is still a
// regression and still fails the run.
const KNOWN_CEILING = {
  'painting/image-rendering/optimizeSpeed.svg': 0.956,
  'filters/feConvolveMatrix/preserveAlpha=true.svg': 0.950,
  'filters/feTile/simple-case.svg': 0.941,
  'filters/feTile/with-subregion-2.svg': 0.897,
  'filters/feTile/with-subregion-1.svg': 0.896,
};

const regressions = [];
for (const [rel, r] of Object.entries(results)) {
  const base = baseline[rel];
  if (base == null || base < PASS_THRESHOLD) continue; // only guard known-good tests
  const cur = r.status === 'ok' ? r.similarity : 0;
  // A known ceiling replaces the baseline as the bar this test must clear.
  const ceiling = KNOWN_CEILING[rel];
  const bar = ceiling != null ? ceiling : PASS_THRESHOLD;
  if (cur < bar - REGRESSION_EPS) regressions.push({ rel, base: ceiling != null ? ceiling : base, cur: +cur.toFixed(4) });
}
regressions.sort((a, b) => (a.base - a.cur) - (b.base - b.cur));
if (regressions.length) {
  console.log(`\n✗ ${regressions.length} REGRESSION(S) (dropped >${REGRESSION_EPS} below baseline):`);
  for (const g of regressions.slice(0, 40)) console.log(`    ${g.base.toFixed(3)} → ${g.cur.toFixed(3)}   ${g.rel}`);
  if (regressions.length > 40) console.log(`    …and ${regressions.length - 40} more`);
  process.exit(1);
}
const held = Object.keys(KNOWN_CEILING).filter((rel) => results[rel]).length;
console.log(`\n✔ No regressions vs baseline (${held} known-ceiling entr${held === 1 ? 'y' : 'ies'} held; see README).`);
process.exit(0);
