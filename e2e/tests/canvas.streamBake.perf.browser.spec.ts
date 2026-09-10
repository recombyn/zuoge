/**
 * Browser perf after WebGL default-on + Worker tile bake.
 * Inject 5k rects → measure select / zoom / pan + ink backend / bake cache.
 *
 *   npx playwright test canvas.streamBake.perf.browser.spec.ts --workers=1
 *   STREAM_PERF_N=5000
 */
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { E2E_TOKEN_SKIP_REASON } from './e2eAuth';
import {
  TOKEN,
  injectAuth,
  openBlankEditor,
  sleep,
  waitForEditorToolbar,
  selectionChromeCount,
} from './canvasStressHelpers';

const N = Math.max(500, Number(process.env.STREAM_PERF_N || 5_000) || 5_000);

test.setTimeout(8 * 60_000);

type SelectReport = {
  kind?: string;
  label?: string;
  totalMs: number;
  slowest?: { name: string; ms: number };
  stages?: Array<{ name: string; ms: number; detail?: Record<string, unknown> }>;
};

async function injectDenseRects(page: Page, count: number) {
  return page.evaluate(async ({ n }) => {
    const mod = await import('/src/store/modules/editor.ts');
    const setDocument = (mod as { setDocument: (doc: unknown) => void }).setDocument;
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
    const cols = 80;
    for (let i = 0; i < n; i += 1) {
      const id = `r${i}`;
      children.push(id);
      deltaSetLike[id] = {
        id,
        key: 'shape',
        x: 40 + (i % cols) * 36,
        y: 40 + Math.floor(i / cols) * 28,
        width: 30,
        height: 22,
        attrs: {
          shapeType: 'rect',
          'fill-color': '#93C5FD',
          'fill-enabled': 'true',
          'border-width': 1,
          'border-color': '#1E3A8A',
          frameId: 'board',
          frameOrder: i,
        },
        children: [],
      };
    }
    const boardW = 40 + cols * 36 + 80;
    const boardH = 40 + Math.ceil(n / cols) * 28 + 80;
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
      stackOrder: ['frame:board', ...children.map((id) => `node:${id}`)],
    });
    return { n, boardW, boardH };
  }, { n: count });
}

async function readRuntime(page: Page) {
  return page.evaluate(() => {
    type Probe = {
      inkBackend: string;
      webglEnv: boolean;
      bakeThreshold: number;
      shouldBake: boolean;
      bufCount: number;
      bakeTiles: number;
    };
    const probe = (
      window as Window & { __RCB_SOA_RUNTIME__?: () => Probe }
    ).__RCB_SOA_RUNTIME__?.();
    const layer = document.querySelector('[data-rcb-shapes-layer="1"]');
    return {
      inkBackend: probe?.inkBackend ?? 'unknown',
      webglEnv: Boolean(probe?.webglEnv),
      bakeThreshold: probe?.bakeThreshold ?? -1,
      shouldBake: Boolean(probe?.shouldBake),
      bufCount: probe?.bufCount ?? -1,
      bakeTiles: probe?.bakeTiles ?? -1,
      canvasIdle: Number(layer?.getAttribute('data-rcb-canvas-idle-count') || -1),
      fullHost: Number(layer?.getAttribute('data-rcb-full-host-count') || -1),
      visible: Number(layer?.getAttribute('data-rcb-visible-count') || -1),
      hasInkCanvas: Boolean(document.querySelector('[data-rcb-idle-ink-canvas]')),
    };
  });
}

async function enableSelectPerf(page: Page) {
  await page.evaluate(() => {
    const w = window as Window & {
      __RCB_SELECT_PERF?: boolean;
      __RCB_SELECT_PERF_LAST?: SelectReport;
    };
    w.__RCB_SELECT_PERF = true;
    w.__RCB_SELECT_PERF_LAST = undefined;
  });
}

async function readLastSelect(page: Page): Promise<SelectReport | null> {
  return page.evaluate(() => {
    const w = window as Window & { __RCB_SELECT_PERF_LAST?: SelectReport };
    const last = w.__RCB_SELECT_PERF_LAST || null;
    w.__RCB_SELECT_PERF_LAST = undefined;
    return last;
  });
}

function stageIdleMs(stages: SelectReport['stages'], name: string): number {
  if (!stages) return -1;
  let sum = 0;
  let hit = false;
  for (const s of stages) {
    if (s.name === name) {
      sum += s.ms;
      hit = true;
    }
  }
  return hit ? Math.round(sum * 10) / 10 : -1;
}

async function measureZoomBurst(page: Page) {
  return page.evaluate(async () => {
    const el =
      (document.querySelector('[data-rcb-canvas="1"]') as HTMLElement | null) || document.body;
    const box = el.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const samples: number[] = [];
    let last = performance.now();
    for (let i = 0; i < 16; i += 1) {
      el.dispatchEvent(
        new WheelEvent('wheel', {
          clientX: cx,
          clientY: cy,
          deltaY: i % 2 === 0 ? -80 : 80,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
      await new Promise<number>((r) => requestAnimationFrame(r));
      const now = performance.now();
      samples.push(now - last);
      last = now;
    }
    // Let Worker tiles stream a bit.
    await new Promise<void>((resolve) => {
      const ric = (
        window as Window & {
          requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
        }
      ).requestIdleCallback;
      if (typeof ric === 'function') {
        ric(() => resolve(), { timeout: 1200 });
        return;
      }
      window.setTimeout(() => resolve(), 600);
    });
    const avg = samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);
    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
    return {
      avgFrameMs: Math.round(avg * 10) / 10,
      p95FrameMs: Math.round(p95 * 10) / 10,
      approxFps: avg > 0 ? Math.round((1000 / avg) * 10) / 10 : 0,
      samples: samples.length,
    };
  });
}

async function measurePanBurst(page: Page) {
  return page.evaluate(async () => {
    const el =
      (document.querySelector('[data-rcb-canvas="1"]') as HTMLElement | null) || document.body;
    const box = el.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const samples: number[] = [];
    let last = performance.now();
    for (let i = 0; i < 24; i += 1) {
      el.dispatchEvent(
        new WheelEvent('wheel', {
          clientX: cx,
          clientY: cy,
          deltaX: i % 2 === 0 ? 64 : -64,
          deltaY: ((i % 3) - 1) * 32,
          deltaMode: 0,
          bubbles: true,
          cancelable: true,
        })
      );
      await new Promise<number>((r) => requestAnimationFrame(r));
      const now = performance.now();
      samples.push(now - last);
      last = now;
    }
    const usable = samples.slice(4);
    const avg = usable.reduce((a, b) => a + b, 0) / Math.max(1, usable.length);
    const sorted = [...usable].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
    return {
      avgFrameMs: Math.round(avg * 10) / 10,
      p95FrameMs: Math.round(p95 * 10) / 10,
      approxFps: avg > 0 ? Math.round((1000 / avg) * 10) / 10 : 0,
      samples: usable.length,
    };
  });
}

test.describe('stream bake browser perf', () => {
  test.skip(!TOKEN, E2E_TOKEN_SKIP_REASON);

  test.beforeEach(async ({ page }) => {
    await injectAuth(page);
  });

  test(`n=${N}: select + zoom + pan report`, async ({ page }) => {
    const stage = await openBlankEditor(page, 'stream-bake-perf');
    await waitForEditorToolbar(page);
    await enableSelectPerf(page);

    const inj = await injectDenseRects(page, N);
    await sleep(1500);
    await page.keyboard.press('v');
    await sleep(200);

    await expect
      .poll(async () => (await readRuntime(page)).canvasIdle, { timeout: 90_000 })
      .toBeGreaterThan(100);

    const runtimeBefore = await readRuntime(page);

    // Blank click then select a dense node near viewport center.
    const box = await stage.boundingBox();
    expect(box).toBeTruthy();
    await page.mouse.click(box!.x + 16, box!.y + 16);
    await sleep(200);
    await expect.poll(async () => selectionChromeCount(page), { timeout: 8_000 }).toBe(0);

    await page.mouse.click(box!.x + box!.width * 0.35, box!.y + box!.height * 0.35);
    await page.waitForFunction(
      () => {
        const last = (window as Window & { __RCB_SELECT_PERF_LAST?: SelectReport })
          .__RCB_SELECT_PERF_LAST;
        return Boolean(last && String(last.label || '').includes('select n='));
      },
      undefined,
      { timeout: 45_000 }
    );
    const selectOne = await readLastSelect(page);
    expect(selectOne).toBeTruthy();

    await sleep(800);
    const runtimeAfterSelect = await readRuntime(page);

    const zoom = await measureZoomBurst(page);
    await sleep(500);
    const runtimeAfterZoom = await readRuntime(page);

    const pan = await measurePanBurst(page);
    await sleep(400);
    const runtimeAfterPan = await readRuntime(page);

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
      /* ignore */
    }

    const report = {
      generatedAt: new Date().toISOString(),
      n: inj.n,
      board: { w: inj.boardW, h: inj.boardH },
      heapUsedMb,
      runtimeBefore,
      runtimeAfterSelect,
      runtimeAfterZoom,
      runtimeAfterPan,
      select: {
        totalMs: selectOne!.totalMs,
        slowest: selectOne!.slowest,
        revealKitMs: stageIdleMs(selectOne!.stages, 'reveal-kit'),
        spatialMs: stageIdleMs(selectOne!.stages, 'spatial-sync-memo'),
        label: selectOne!.label,
        stages: selectOne!.stages,
      },
      zoom,
      pan,
      baselineBeforeFix: {
        note: 'User log before fix (select ~5k)',
        selectTotalMs: 1287,
        idlePaintMs: 755,
      },
    };

    writeFileSync(
      path.resolve(__dirname, 'canvas.streamBake.perf.browser.results.json'),
      JSON.stringify(report, null, 2),
      'utf8'
    );
    console.log('[e2e:stream-bake-perf]', JSON.stringify(report));

    expect(runtimeBefore.webglEnv || runtimeBefore.inkBackend === 'webgl').toBe(true);
    expect(runtimeBefore.bufCount).toBeGreaterThanOrEqual(800);
    expect(runtimeBefore.shouldBake).toBe(true);
    // Tiles stream in before interaction; zoom/select dirty can drop cache briefly.
    expect(runtimeBefore.bakeTiles).toBeGreaterThan(0);
    expect(report.select.totalMs).toBeLessThan(2500);
  });
});
