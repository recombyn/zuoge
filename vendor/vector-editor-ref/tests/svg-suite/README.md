# SVG conformance suite

Pixel-level SVG-compliance tracking for the editor, built on the
[resvg test suite](https://github.com/RazrFalcon/resvg-test-suite) (MIT — see
[`LICENSE-resvg`](./LICENSE-resvg)).

Each test is an `.svg` file paired with a reference `.png` that resvg rendered
from it. The harness drives the **real editor** in a headless browser: it
imports the SVG through the app's own importer, rasterises the document to PNG,
and compares the result against the reference pixel-for-pixel.

## What it measures

The editor's SVG importer is lossy by design (it builds an *editable* scene, not
a spec-perfect render), so most of the 1679 tests will never match
pixel-for-pixel. This is therefore a **conformance tracker**, not a green/red
gate:

- Every test gets a **similarity score** in `[0, 1]` (fraction of pixels
  matching within tolerance, both images flattened onto white).
- A test "passes" at `similarity ≥ 0.98` (tunable via `PASS_THRESHOLD`).
- [`baseline.json`](./baseline.json) records the committed score of every test.
- CI **fails only on regressions**: a test that was passing in the baseline and
  has since dropped below the threshold. Movement within the large body of
  already-failing tests (many of which render through async/AA paths that jitter
  run-to-run) is intentionally *not* gated — progress there shows up in the pass
  count and per-category means.

Current standing (see the per-category summary printed by a run): **936/1679
passing**, mean similarity 0.911, no errors.

| Category | Passing | Mean |
|---|---|---|
| `shapes` | 96/133 (72%) | 0.934 |
| `painting` | 212/304 (70%) | 0.916 |
| `paint-servers` | 95/149 (64%) | 0.861 |
| `filters` | 252/397 (63%) | 0.911 |
| `structure` | 152/247 (62%) | 0.874 |
| `masking` | 48/93 (52%) | 0.863 |
| `text` | 81/356 (23%) | 0.958 |

`text` is the interesting row: it has the **highest** mean similarity of any
category and the **lowest** pass rate. Text renders very nearly right and then
misses the 0.98 bar on glyph-level antialiasing — so it is the category where
small rasterisation work would convert the most tests, not the one that is
least implemented.

## Running

Requires the app's `engine/pkg` to be built and `node_modules` installed. The
harness starts (and tears down) its own Vite dev server unless you pass `--url`.

It also needs the Chrome that Puppeteer pins. That browser is a separate
download — `pnpm install` does **not** fetch it — so once per machine:

```sh
./node_modules/.bin/puppeteer browsers install chrome
```

(~350 MB, cached in `~/.cache/puppeteer` and shared by every checkout. Without
it the harness exits 1 and prints this same command.)

```sh
# Run everything, compare against the committed baseline (exit 1 on regressions)
node tests/svg-suite/harness.mjs

# Only a subset (substring match on the test path)
node tests/svg-suite/harness.mjs --filter shapes/circle

# Write magenta/grey diff PNGs for failing tests into report/ (combine with --filter)
node tests/svg-suite/harness.mjs --filter painting --diff

# Reuse an already-running dev server instead of spawning one
node tests/svg-suite/harness.mjs --url http://localhost:5173

# Re-record the baseline after an intentional importer/renderer change
node tests/svg-suite/harness.mjs --update
```

Knobs: `PASS_THRESHOLD` (default `0.98`), `REGRESSION_EPS` (noise margin below
the threshold before a drop counts as a regression, default `0.02`).

## How a test is rendered

For a test with `viewBox="0 0 W H"` whose reference PNG is `Wr × Hr`:

1. `app.scene.newDocument(W, H)` — blank document sized to the viewBox.
2. `width`/`height` attributes are stripped (when a viewBox is present) so the
   importer keeps geometry in viewBox units, matching how resvg renders the
   suite.
3. `app.ui.parseSVG(svg)` — import through the app's importer.
4. `app.renderer.exportPNG(Wr / W)` — rasterise at the same scale the reference
   was rendered at, producing a `Wr × Hr` image.
5. Both images are decoded with CanvasKit *inside the page*, flattened onto
   white, and compared. No native image dependencies are needed.

Output (git-ignored) lands in `report/`: `results.json` (full per-test scores)
and, with `--diff`, `report/diffs/**.diff.png`.

## Updating the vendored suite

`fixtures/` holds a snapshot of the resvg suite's `tests/` and `resources/`
trees. To refresh, re-download the upstream repo, copy those two directories
over `fixtures/`, and re-run with `--update` to regenerate the baseline (review
the diff — an upstream change can legitimately move scores).

## Known: 5 ceiling entries, all diagnosed and pinned

A clean run reports **936/1679 passing**, no errors, and **exits 0**. Five
`baseline.json` entries record a score the current architecture cannot reach
again; they are pinned in `KNOWN_CEILING` in the harness at their true present
values, so the run is green while they hold and red the moment one drops
further. None are caused by pending work — verified by building from an
unmodified tree at the pre-change commit and re-running: the scores come out
identical.

All five are *stale high-water marks*. `baseline.json` is maintained by raising
only (`max(old, new)`), so a score recorded under an earlier renderer sticks
even when the current architecture cannot reach it again. Each has been
diagnosed by rendering its diff and looking at it, rather than left as a
mystery:

| Test | Baseline → now | Diagnosis |
|---|---|---|
| `filters/feTile/*` (3) | 1.000 → 0.896–0.941 | Tile **phase** offset, not blur — the diff is an alternating checkerboard, displaced by exactly the fixture's `feOffset dx/dy`. Unsupported filters are rasterized *by the browser*, and Chrome and resvg disagree on which subregion `feTile` repeats. Not fixable without implementing the filter pipeline natively. |
| `filters/feConvolveMatrix/preserveAlpha=true` | 1.000 → 0.950 | Edge antialiasing only — the diff shows magenta tracing tile **outlines** while every interior matches exactly. `preserveAlpha` itself is handled correctly. This is the AA/colour-space ceiling against a different rasterizer. |
| `painting/image-rendering/optimizeSpeed` | 1.000 → 0.956 | **Was** a genuine missing feature at 0.824 (`image-rendering` was never parsed); now implemented end to end. The residual 0.044 is the same AA ceiling. |

An earlier revision of this section listed **26** regressions and 522 passing.
Most were four real bugs — a broken supersampled export, a text baseline error,
a dropped `font-family` on import, and luminance masks ignoring alpha — since
fixed, which is what took the suite from 522 to 927.

**Deliberately not `--update`d, and deliberately not silenced.** Refreshing the
baseline would bless these as 1.000 and destroy the record of what still
differs; ignoring them outright would hide a real drop. Pinning them at the
scores above keeps both properties — the diffs stay the clearest statement of
the gap, and going *below* a pin still fails the run.

Reading a run: the regression list should be **empty**, and the closing line
names how many ceiling entries were held. Anything in the regression list is
yours. Errors are not regressions but score 0.000, so check the `N test(s)
errored` block first — a busy machine can time a test out, and the harness
retries once before believing it.
