/**
 * Real Chromium: blank editor → inject N shapes → host counts + pan FPS.
 * Headed: `npx playwright test tests/canvas.soa10k.browser.spec.ts --headed --workers=1`
 * Count: `CANVAS_BROWSER_N=10000` (default 10000).
 * Mixed ladder: `CANVAS_BROWSER_MIXED=1` (default; 2k/5k/10k rect+text+image+video+path).
 * Homogeneous only: `CANVAS_BROWSER_MIXED=0`.
 */
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { test, expect, type Page, type Locator } from '@playwright/test';
import { E2E_TOKEN_SKIP_REASON, resolveE2EToken } from './e2eAuth';

const ROOT = path.resolve(__dirname, '../..');
const TOKEN = resolveE2EToken(ROOT);
const API = (process.env.E2E_API || process.env.FUNC_API || 'http://127.0.0.1:8000').replace(
  /\/$/,
  ''
);
const COUNT = Math.max(
  150,
  Number(process.env.CANVAS_BROWSER_N || process.env.SOA_BROWSER_N || 10_000) || 10_000
);
const RUN_MIXED_LADDER =
  (process.env.CANVAS_BROWSER_MIXED || process.env.SOA_BROWSER_MIXED || '1').trim() !== '0';
/** 1×1 PNG — shared src so thousands of image/video nodes stay cheap. */
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test.setTimeout(20 * 60_000);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function injectAuth(page: Page) {
  await page.context().addInitScript((tok) => {
    localStorage.setItem('recombine-auth-token-v1', tok);
    localStorage.setItem('recombyn-editor-tour-v3', '1');
    localStorage.setItem('recombyn-editor-tour-v3:user_super_admin', '1');
  }, TOKEN);
}

async function seedAuthSession(page: Page) {
  const me = await page.request.get(`${API}/api/v1/auth/me`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    timeout: 20_000,
  });
  if (!me.ok()) throw new Error(`auth/me ${me.status()}`);
  const body = await me.json();
  const user = body?.user;
  if (!user?.id) throw new Error('auth/me missing user');
  await page.goto('/home', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.evaluate(
    ({ tok, user: u }) => {
      localStorage.setItem('recombine-auth-token-v1', tok);
      localStorage.setItem('resume-scene-auth-v1', JSON.stringify({ user: u }));
      localStorage.setItem('recombyn-editor-tour-v3', '1');
      localStorage.setItem('recombyn-editor-tour-v3:user_super_admin', '1');
    },
    { tok: TOKEN, user }
  );
}

async function dismissBlockingDialogs(page: Page) {
  for (let i = 0; i < 8; i += 1) {
    const skip = page.getByRole('button', { name: /^Skip$|^跳过$/i });
    if ((await skip.count()) > 0) {
      await skip.last().click({ force: true }).catch(() => undefined);
      await sleep(150);
      continue;
    }
    const dialog = page.locator('[role="dialog"]').first();
    if (!(await dialog.isVisible().catch(() => false))) break;
    await page.keyboard.press('Escape');
    await sleep(150);
  }
}

async function openBlankEditor(page: Page) {
  await seedAuthSession(page);
  const res = await page.request.put(`${API}/api/v1/projects`, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    data: { name: `soa-browser-${Date.now()}`, document: null },
    timeout: 30_000,
  });
  if (!res.ok()) throw new Error(`create project ${res.status()} ${await res.text()}`);
  const json = await res.json();
  const id = String(json?.project?.id || json?.id || '').trim();
  if (!id) throw new Error('missing project id');
  await page.goto(`/editor/${id}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await expect(page).toHaveURL(new RegExp(`/editor/${id}`), { timeout: 45_000 });
  await dismissBlockingDialogs(page);
  const stage = page.locator('[data-rcb-canvas="1"], [data-canvas-stage="1"]').first();
  await expect(stage).toBeVisible({ timeout: 45_000 });
  await page.keyboard.press('Escape');
  await sleep(300);
  return { stage, id };
}

async function injectStressDoc(page: Page, n: number, kind: 'rect' | 'polygon') {
  return page.evaluate(
    async ({ n: count, kind: shapeKind }) => {
      const mod = await import('/src/store/modules/editor.ts');
      const setDocument = (mod as { setDocument: (doc: unknown) => void }).setDocument;
      if (typeof setDocument !== 'function') {
        throw new Error('setDocument not exported from editor module');
      }
      const cols = Math.ceil(Math.sqrt(count));
      const cell = 28;
      const boardW = cols * cell + 64;
      const boardH = Math.ceil(count / cols) * cell + 64;
      const children: string[] = [];
      const deltaSetLike: Record<string, unknown> = {
        ROOT: {
          id: 'ROOT',
          key: 'entry',
          children,
          attrs: {},
          x: 0,
          y: 0,
          width: 0,
          height: 0,
        },
      };
      for (let i = 0; i < count; i += 1) {
        const id = `s${i}`;
        children.push(id);
        deltaSetLike[id] = {
          id,
          key: 'shape',
          x: (i % cols) * cell,
          y: Math.floor(i / cols) * cell,
          width: 48,
          height: 48,
          attrs: {
            shapeType: shapeKind === 'polygon' ? 'polygon' : 'rect',
            ...(shapeKind === 'polygon' ? { sides: 6 } : {}),
            'fill-color': '#ffffff',
            'border-color': '#111111',
            'border-width': 1,
            frameId: 'board',
            frameOrder: i,
          },
          children: [],
        };
      }
      const t0 = performance.now();
      setDocument({
        x: 0,
        y: 0,
        width: boardW,
        height: boardH,
        backgroundColor: '',
        frames: [
          {
            id: 'board',
            name: 'Board',
            x: 0,
            y: 0,
            width: boardW,
            height: boardH,
            clipContent: true,
            kind: 'artboard',
          },
        ],
        activeFrameId: 'board',
        pages: [{ id: 'page1', name: 'Page 1', children: children.slice() }],
        activePageId: 'page1',
        deltaSetLike,
        stackOrder: ['frame:board'],
      });
      return { setDocumentMs: performance.now() - t0 };
    },
    { n, kind }
  );
}

/**
 * Product-like mix (~20-slot cycle):
 * 10 rect · 4 text · 2 image · 1 video · 3 path
 */
async function injectMixedStressDoc(page: Page, n: number, tinyPng: string) {
  return page.evaluate(
    async ({ n: count, png }) => {
      const mod = await import('/src/store/modules/editor.ts');
      const setDocument = (mod as { setDocument: (doc: unknown) => void }).setDocument;
      if (typeof setDocument !== 'function') {
        throw new Error('setDocument not exported from editor module');
      }
      const cols = Math.ceil(Math.sqrt(count));
      const cell = 36;
      const boardW = cols * cell + 80;
      const boardH = Math.ceil(count / cols) * cell + 80;
      const children: string[] = [];
      const deltaSetLike: Record<string, unknown> = {
        ROOT: {
          id: 'ROOT',
          key: 'entry',
          children,
          attrs: {},
          x: 0,
          y: 0,
          width: 0,
          height: 0,
        },
      };
      const tallies = { rect: 0, text: 0, image: 0, video: 0, path: 0 };
      const pathD = 'M 4 20 L 20 4 L 36 20 L 20 36 Z';

      for (let i = 0; i < count; i += 1) {
        const id = `m${i}`;
        children.push(id);
        const x = (i % cols) * cell;
        const y = Math.floor(i / cols) * cell;
        const slot = i % 20;
        let node: Record<string, unknown>;
        if (slot < 10) {
          tallies.rect += 1;
          node = {
            id,
            key: 'shape',
            x,
            y,
            width: 28,
            height: 28,
            attrs: {
              shapeType: 'rect',
              'fill-color': i % 3 === 0 ? '#EEF2FF' : '#F8FAFC',
              'fill-enabled': 'true',
              'border-color': '#334155',
              'border-width': 1,
              frameId: 'board',
              frameOrder: i,
            },
            children: [],
          };
        } else if (slot < 14) {
          tallies.text += 1;
          node = {
            id,
            key: 'text',
            x,
            y,
            width: 96,
            height: 24,
            attrs: {
              markdown: `T${i}`,
              DATA: `T${i}`,
              fontSize: 12,
              fontFamily: 'Inter',
              'fill-color': '#111827',
              frameId: 'board',
              frameOrder: i,
            },
            children: [],
          };
        } else if (slot < 16) {
          tallies.image += 1;
          node = {
            id,
            key: 'image',
            x,
            y,
            width: 32,
            height: 32,
            attrs: {
              src: png,
              frameId: 'board',
              frameOrder: i,
            },
            children: [],
          };
        } else if (slot < 17) {
          tallies.video += 1;
          node = {
            id,
            key: 'video',
            x,
            y,
            width: 40,
            height: 28,
            attrs: {
              src: '',
              poster: png,
              frameId: 'board',
              frameOrder: i,
            },
            children: [],
          };
        } else {
          tallies.path += 1;
          node = {
            id,
            key: 'shape',
            x,
            y,
            width: 32,
            height: 32,
            attrs: {
              shapeType: 'path',
              path: pathD,
              closed: true,
              'fill-color': '#FEE2E2',
              'fill-enabled': 'true',
              'border-width': 1,
              'border-color': '#991B1B',
              frameId: 'board',
              frameOrder: i,
            },
            children: [],
          };
        }
        deltaSetLike[id] = node;
      }

      const t0 = performance.now();
      setDocument({
        x: 0,
        y: 0,
        width: boardW,
        height: boardH,
        backgroundColor: '',
        frames: [
          {
            id: 'board',
            name: 'Board',
            x: 0,
            y: 0,
            width: boardW,
            height: boardH,
            clipContent: true,
            kind: 'artboard',
          },
        ],
        activeFrameId: 'board',
        pages: [{ id: 'page1', name: 'Page 1', children: children.slice() }],
        activePageId: 'page1',
        deltaSetLike,
        stackOrder: ['frame:board'],
      });
      return {
        setDocumentMs: performance.now() - t0,
        tallies,
        boardW,
        boardH,
      };
    },
    { n, png: tinyPng }
  );
}

async function readCounts(page: Page) {
  const dom = await page.evaluate(() => {
    const layer = document.querySelector('[data-rcb-shapes-layer="1"]');
    const rcb = document.querySelector('[data-rcb-canvas="1"]');
    return {
      fullHost: Number(layer?.getAttribute('data-rcb-full-host-count') || -1),
      canvasIdle: Number(
        layer?.getAttribute('data-rcb-canvas-idle-count') ||
          rcb?.getAttribute('data-rcb-canvas-idle-count') ||
          -1
      ),
      visible: Number(layer?.getAttribute('data-rcb-visible-count') || -1),
      hasInkCanvas: Boolean(document.querySelector('[data-rcb-idle-ink-canvas]')),
      sceneNodeHosts: document.querySelectorAll('[data-scene-node-id]').length,
      videoEls: document.querySelectorAll('video').length,
      imageEls: document.querySelectorAll('[data-rcb-shape-host] image, img').length,
    };
  });
  let heapUsedMb = -1;
  try {
    const client = await page.context().newCDPSession(page);
    await client.send('Performance.enable');
    const got = await client.send('Performance.getMetrics');
    await client.detach().catch(() => undefined);
    const row = (got?.metrics || []).find((m: { name: string }) => m.name === 'JSHeapUsedSize');
    if (row && typeof row.value === 'number') {
      heapUsedMb = Math.round((row.value / (1024 * 1024)) * 10) / 10;
    }
  } catch {
    try {
      const m = await page.metrics();
      if (m?.JSHeapUsedSize != null) {
        heapUsedMb = Math.round((m.JSHeapUsedSize / (1024 * 1024)) * 10) / 10;
      }
    } catch {
      /* metrics unavailable */
    }
  }
  return { ...dom, heapUsedMb };
}

async function measurePanFps(page: Page, stage: Locator) {
  const box = await stage.boundingBox();
  if (!box) throw new Error('no stage box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // In-page wheel pan (RcbCanvas onWheel) — avoids Playwright mouse.move hanging
  // when the main thread is busy at 5k+.
  const result = await page.evaluate(async ({ sx, sy }) => {
    const el =
      (document.querySelector('[data-rcb-canvas="1"]') as HTMLElement | null) || document.body;
    const dts: number[] = [];
    let last = performance.now();
    const deadline = last + 6_000;
    for (let i = 0; i < 28 && performance.now() < deadline; i += 1) {
      el.dispatchEvent(
        new WheelEvent('wheel', {
          clientX: sx,
          clientY: sy,
          deltaX: i % 2 === 0 ? 48 : -48,
          deltaY: ((i % 3) - 1) * 24,
          deltaMode: 0,
          bubbles: true,
          cancelable: true,
        })
      );
      await new Promise<number>((r) => requestAnimationFrame(r));
      const now = performance.now();
      dts.push(now - last);
      last = now;
    }
    return dts.slice(4);
  }, { sx: cx, sy: cy });

  if (!result.length) {
    return { avgFrameMs: 9999, p95FrameMs: 9999, approxFps: 0, samples: 0 };
  }
  const avg = result.reduce((a, b) => a + b, 0) / Math.max(1, result.length);
  const sorted = [...result].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
  const fps = avg > 0 ? Math.round((1000 / avg) * 10) / 10 : 0;
  return {
    avgFrameMs: Math.round(avg * 100) / 100,
    p95FrameMs: Math.round(p95 * 100) / 100,
    approxFps: fps,
    samples: result.length,
  };
}

async function settleAndMeasure(page: Page, stage: Locator, opts?: { minVisible?: number }) {
  const minVisible = opts?.minVisible ?? 0;
  // Mixed docs may keep some media as hosts; wait until something is mounted / painted.
  await expect
    .poll(
      async () => {
        const c = await readCounts(page);
        return c.canvasIdle > 0 || c.visible > 0 || c.sceneNodeHosts > 1 || c.hasInkCanvas;
      },
      { timeout: 120_000 }
    )
    .toBe(true);

  if (minVisible > 0) {
    // Zoom into the board until enough idle ink is on-screen (fit-to-board culls
    // a sparse 10k grid down to dozens of nodes).
    await page.evaluate(async ({ want, sx, sy }) => {
      const el =
        (document.querySelector('[data-rcb-canvas="1"]') as HTMLElement | null) || document.body;
      const readIdle = () =>
        Number(
          document.querySelector('[data-rcb-shapes-layer="1"]')?.getAttribute('data-rcb-canvas-idle-count') ||
            document.querySelector('[data-rcb-canvas="1"]')?.getAttribute('data-rcb-canvas-idle-count') ||
            0
        );
      const deadline = performance.now() + 8_000;
      while (performance.now() < deadline && readIdle() < want) {
        el.dispatchEvent(
          new WheelEvent('wheel', {
            clientX: sx,
            clientY: sy,
            deltaY: -80,
            ctrlKey: true,
            deltaMode: 0,
            bubbles: true,
            cancelable: true,
          })
        );
        await new Promise<number>((r) => requestAnimationFrame(r));
      }
    }, {
      want: minVisible,
      sx: (await stage.boundingBox())!.x + 40,
      sy: (await stage.boundingBox())!.y + 40,
    });
    await sleep(400);
  }

  await sleep(500);
  const counts = await readCounts(page);
  console.log('[e2e:soa-settle]', JSON.stringify(counts));
  const pan = await measurePanFps(page, stage);
  return { counts, pan };
}

test.describe('Kit canvas density (browser)', () => {
  test.skip(!TOKEN, E2E_TOKEN_SKIP_REASON);

  test.beforeEach(async ({ page }) => {
    await injectAuth(page);
  });

  test(`inject ${COUNT} stroked rects — host counts + pan FPS`, async ({ page }) => {
    test.skip(RUN_MIXED_LADDER, 'CANVAS_BROWSER_MIXED=1 runs the mixed ladder instead');
    const { stage } = await openBlankEditor(page);

    const tInj0 = Date.now();
    const inj = await injectStressDoc(page, COUNT, 'rect');
    const injectWallMs = Date.now() - tInj0;
    const { counts, pan } = await settleAndMeasure(page, stage);
    const report = {
      n: COUNT,
      kind: 'rect',
      setDocumentMs: Math.round(inj.setDocumentMs * 10) / 10,
      injectWallMs,
      counts,
      pan,
    };
    console.log('[e2e:soa-browser]', JSON.stringify(report, null, 2));
    writeFileSync(
      path.resolve(__dirname, 'canvas.soa10k.browser.results.json'),
      JSON.stringify(report, null, 2),
      'utf8'
    );
    await page.screenshot({
      path: path.resolve(__dirname, 'canvas.soa10k.browser.png'),
      fullPage: false,
    });

    expect(counts.hasInkCanvas).toBe(true);
    expect(counts.fullHost).toBeLessThanOrEqual(96);
    expect(counts.canvasIdle).toBeGreaterThan(0);
  });

  test('mixed ladder 2k/5k/10k — rect+text+image+video+path pan FPS', async ({ page }) => {
    test.skip(!RUN_MIXED_LADDER, 'set CANVAS_BROWSER_MIXED=1 (default) for mixed ladder');
    console.log('[e2e:soa-mixed] open editor');
    const { stage } = await openBlankEditor(page);
    console.log('[e2e:soa-mixed] editor ready');
    const ladder = [2000, 5000, 10_000];
    const rows: Array<Record<string, unknown>> = [];

    for (const n of ladder) {
      const t0 = Date.now();
      const inj = await injectMixedStressDoc(page, n, TINY_PNG);
      const injectWallMs = Date.now() - t0;
      console.log(`[e2e:soa-mixed] injected n=${n} setDocumentMs=${inj.setDocumentMs} tallies=`, inj.tallies);
      await sleep(800);
      const { counts, pan } = await settleAndMeasure(page, stage, { minVisible: 280 });
      const row = {
        n,
        kind: 'mixed',
        tallies: inj.tallies,
        setDocumentMs: Math.round(inj.setDocumentMs * 10) / 10,
        injectWallMs,
        counts,
        pan,
        smoothEnough: pan.avgFrameMs <= 20 && pan.p95FrameMs <= 33,
      };
      rows.push(row);
      console.log(`[e2e:soa-mixed] n=${n}`, JSON.stringify(row));
      await page.screenshot({
        path: path.resolve(__dirname, `canvas.soa-mixed-${n}.browser.png`),
        fullPage: false,
      });
    }

    const report = {
      generatedAt: new Date().toISOString(),
      mix: '10 rect / 4 text / 2 image / 1 video / 3 path per 20',
      rows,
    };
    writeFileSync(
      path.resolve(__dirname, 'canvas.soa-mixed-ladder.browser.results.json'),
      JSON.stringify(report, null, 2),
      'utf8'
    );
    writeFileSync(
      path.resolve(__dirname, 'canvas.soa10k.browser.results.json'),
      JSON.stringify(rows[rows.length - 1], null, 2),
      'utf8'
    );

    const at2k = rows[0] as {
      pan: { avgFrameMs: number };
      counts: { fullHost: number; visible: number; canvasIdle: number };
    };
    const at10k = rows[rows.length - 1] as {
      counts: { hasInkCanvas: boolean; fullHost: number; canvasIdle: number; visible: number };
      pan: { avgFrameMs: number; p95FrameMs: number; approxFps: number };
    };
    // Capacity report: assert demotion path is live; FPS is recorded for the canvas summary.
    expect(at2k.counts.canvasIdle).toBeGreaterThan(0);
    expect(at2k.counts.visible + at2k.counts.canvasIdle).toBeGreaterThan(0);
    expect(at10k.counts.hasInkCanvas || at10k.counts.canvasIdle > 0).toBe(true);
    // Viewport hosts only — full scene stays on Kit idle ink.
    expect(at10k.counts.fullHost).toBeLessThanOrEqual(400);
  });
});
