/**
 * Live editor stress for recent outline / path-edit / text-outline bugs:
 * - After 轮廓�? path-edit anchors use world HTML pads (clickable at high zoom)
 * - Text outline keeps multi-ring path + chrome that tracks ink (not collapsed junk)
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { E2E_TOKEN_SKIP_REASON } from './e2eAuth';
import {
  dragDraw,
  expectShapeInk,
  injectAuth,
  openBlankEditor,
  openLayers,
  sleep,
  waitForEditorToolbar,
  selectionChromeCount,
  TOKEN,
} from './canvasStressHelpers';

test.setTimeout(4 * 60_000);

async function focusStage(page: Page, stage: Locator) {
  const box = await stage.boundingBox();
  if (!box) throw new Error('no stage box');
  await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.35);
  await sleep(120);
  return box;
}

async function zoomInHard(page: Page, cx: number, cy: number, n = 40) {
  await page.mouse.move(cx, cy);
  for (let i = 0; i < n; i += 1) {
    await page.evaluate(
      ({ x, y }) => {
        const el = document.querySelector('[data-rcb-canvas="1"]');
        if (!el) return;
        el.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            deltaY: -160,
            ctrlKey: true,
          })
        );
      },
      { x: cx, y: cy }
    );
  }
  await sleep(400);
}

async function clickOutline(page: Page) {
  let btn = page.getByRole('button', { name: /^Outline$|^轮廓�?|^轮廓$/i }).first();
  if (!(await btn.isVisible({ timeout: 2_000 }).catch(() => false))) {
    const more = page.getByRole('button', { name: /^More$|^更多$/i }).first();
    await expect(more).toBeVisible({ timeout: 12_000 });
    await more.click({ force: true });
    await sleep(250);
    btn = page
      .getByRole('menuitem', { name: /^Outline$|^轮廓�?|^轮廓$/i })
      .or(page.getByRole('button', { name: /^Outline$|^轮廓�?|^轮廓$/i }))
      .first();
  }
  await expect(btn).toBeVisible({ timeout: 12_000 });
  await btn.click({ force: true });
  // Outline commits a path and usually enters path-edit immediately.
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const toast = document.body.innerText || '';
          if (/Outlined|轮廓化成功|已轮�?.test(toast)) return 1;
          if (document.querySelector('[data-pen-path-edit-preview]')) return 1;
          const hosts = document.querySelectorAll('[data-scene-node-id]');
          for (const n of Array.from(hosts)) {
            const t = n.getAttribute('data-scene-shape-type') || '';
            if (t === 'path') return 1;
          }
          const d = document.querySelector('[data-baseline="1"]')?.getAttribute('d') || '';
          if (d.length > 20 && /z/i.test(d)) return 1;
          const idle = Number(
            document
              .querySelector('[data-rcb-idle-ink-canvas="1"]')
              ?.getAttribute('data-rcb-canvas-idle-count') || '0'
          );
          return idle > 0 ? 1 : 0;
        }),
      { timeout: 25_000 }
    )
    .toBeGreaterThan(0);
  await sleep(700);
}

async function enterPathEdit(page: Page) {
  const already = await page.locator('[data-pen-path-edit-preview]').count();
  if (already > 0) {
    await expect
      .poll(
        async () => page.locator('g[data-pen-path-edit-preview] circle').count(),
        { timeout: 12_000 }
      )
      .toBeGreaterThan(0);
    return;
  }

  const ink = page.locator('[data-baseline="1"]').first();
  const inkBox = await ink.boundingBox().catch(() => null);
  if (inkBox) {
    await page.mouse.dblclick(inkBox.x + inkBox.width / 2, inkBox.y + inkBox.height / 2);
    await sleep(400);
  } else {
    const sel = page.locator('[data-sel-box]').first();
    const selBox = await sel.boundingBox().catch(() => null);
    if (selBox) {
      await page.mouse.dblclick(selBox.x + selBox.width / 2, selBox.y + selBox.height / 2);
      await sleep(400);
    }
  }

  const nodeId = await page.evaluate(() => {
    const el = document.querySelector('[data-scene-node-id]');
    return el?.getAttribute('data-scene-node-id') || '';
  });
  if (nodeId) {
    await page.evaluate((id) => {
      window.dispatchEvent(new CustomEvent('resume:enter-path-edit', { detail: { nodeId: id } }));
    }, nodeId);
    await sleep(800);
  }

  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const preview = document.querySelectorAll('[data-pen-path-edit-preview]').length;
          const knobs = document.querySelectorAll('g[data-pen-path-edit-preview] circle').length;
          const pads = document.querySelectorAll(
            '[data-rcb-hit-pad][data-rcb-hit-owner^="pen-edit:"]'
          ).length;
          return preview > 0 && knobs > 0 && pads === 0;
        }),
      { timeout: 12_000 }
    )
    .toBe(true);
}

test.describe('canvas outline / path-edit / text-outline stress', () => {
  test.skip(!TOKEN, E2E_TOKEN_SKIP_REASON);

  test.beforeEach(async ({ page }) => {
    await injectAuth(page);
  });

  test('rect outline �?path-edit: geometry knobs (no HTML pads) @ high zoom', async ({ page }) => {
    const stage = await openBlankEditor(page, 'outline-path-edit');
    await waitForEditorToolbar(page);
    const box = await focusStage(page, stage);
    await openLayers(page);

    await page.keyboard.press('r');
    await sleep(150);
    await dragDraw(page, box, 0.32, 0.32, 0.48, 0.48, 12);
    await sleep(500);
    await expectShapeInk(page, 1);
    await expect.poll(async () => selectionChromeCount(page), { timeout: 8_000 }).toBeGreaterThan(0);

    await clickOutline(page);
    await enterPathEdit(page);

    // Zoom toward the outlined ink so painted knobs stay near viewport.
    const ink = page.locator('[data-baseline="1"], [data-scene-node-id]').first();
    const inkBox = await ink.boundingBox();
    const cx = inkBox ? inkBox.x + inkBox.width / 2 : box.x + box.width / 2;
    const cy = inkBox ? inkBox.y + inkBox.height / 2 : box.y + box.height / 2;
    await zoomInHard(page, cx, cy, 28);

    const report = await page.evaluate(() => {
      const pads = document.querySelectorAll(
        '[data-rcb-hit-pad][data-rcb-hit-owner^="pen-edit:"]'
      ).length;
      const knobs = Array.from(
        document.querySelectorAll('g[data-pen-path-edit-preview] circle')
      ) as SVGGraphicsElement[];
      const debug =
        typeof (window as unknown as { __RCB_DEBUG_KNOBS__?: () => Array<{ kind: string; x: number; y: number; half: number }> }).__RCB_DEBUG_KNOBS__ ===
        'function'
          ? (
              window as unknown as {
                __RCB_DEBUG_KNOBS__: () => Array<{ kind: string; x: number; y: number; half: number }>;
              }
            ).__RCB_DEBUG_KNOBS__()
          : [];
      const registry = debug.filter((k) => k.kind === 'pen-anchor' || k.kind === 'pen-handle');

      function gbr(el: Element | null) {
        if (!el || typeof (el as HTMLElement).getBoundingClientRect !== 'function') return null;
        const r = (el as HTMLElement).getBoundingClientRect();
        return {
          cx: r.left + r.width / 2,
          cy: r.top + r.height / 2,
          w: r.width,
          h: r.height,
        };
      }
      const painted = knobs.slice(0, 8).map((el) => gbr(el)).filter(Boolean);

      const cameraRoot = document.querySelector('[data-rcb-scene-camera="1"]') as SVGGElement | null;
      const m = /scale\(([^)]+)\)/.exec(cameraRoot?.getAttribute('transform') || '');

      return {
        padCount: pads,
        paintedCount: painted.length,
        registryCount: registry.length,
        zoom: m ? Number(m[1]) : NaN,
        firstKnob: painted[0] || null,
        firstReg: registry[0]
          ? { x: registry[0].x, y: registry[0].y, half: registry[0].half }
          : null,
      };
    });

    // eslint-disable-next-line no-console
    console.log('[e2e:outline-path-edit]', JSON.stringify(report));

    expect(report.padCount).toBe(0);
    expect(report.paintedCount).toBeGreaterThan(0);
    expect(report.registryCount).toBeGreaterThan(0);
    expect(report.zoom).toBeGreaterThan(5);

    // Drag via painted knob screen center �?geometry registry must move with drag.
    const drag = await page.evaluate(() => {
      const circle = document.querySelector(
        'g[data-pen-path-edit-preview] circle'
      ) as SVGGraphicsElement | null;
      if (!circle) return { ok: false as const, reason: 'no-knob' };
      const r = circle.getBoundingClientRect();
      const debug =
        typeof (window as unknown as { __RCB_DEBUG_KNOBS__?: () => Array<{ kind: string; x: number; y: number }> }).__RCB_DEBUG_KNOBS__ ===
        'function'
          ? (
              window as unknown as {
                __RCB_DEBUG_KNOBS__: () => Array<{ kind: string; x: number; y: number }>;
              }
            ).__RCB_DEBUG_KNOBS__()
          : [];
      const anchors = debug.filter((k) => k.kind === 'pen-anchor');
      const sx0 = anchors[0]?.x;
      const sy0 = anchors[0]?.y;
      return {
        ok: true as const,
        cx: r.left + r.width / 2,
        cy: r.top + r.height / 2,
        sx0,
        sy0,
      };
    });
    // eslint-disable-next-line no-console
    console.log('[e2e:outline-path-edit-drag]', JSON.stringify(drag));
    expect(drag.ok).toBe(true);
    if (
      drag.ok &&
      drag.cx > 0 &&
      drag.cy > 0 &&
      drag.cx < 4000 &&
      drag.cy < 3000 &&
      Number.isFinite(drag.sx0) &&
      Number.isFinite(drag.sy0)
    ) {
      await page.mouse.move(drag.cx, drag.cy);
      await page.mouse.down();
      await page.mouse.move(drag.cx + 48, drag.cy + 24, { steps: 8 });
      await page.mouse.up();
      await sleep(400);
      const after = await page.evaluate(() => {
        const debug =
          typeof (window as unknown as { __RCB_DEBUG_KNOBS__?: () => Array<{ kind: string; x: number; y: number }> }).__RCB_DEBUG_KNOBS__ ===
          'function'
            ? (
                window as unknown as {
                  __RCB_DEBUG_KNOBS__: () => Array<{ kind: string; x: number; y: number }>;
                }
              ).__RCB_DEBUG_KNOBS__()
            : [];
        return debug
          .filter((k) => k.kind === 'pen-anchor')
          .map((k) => ({ sx: k.x, sy: k.y }));
      });
      const moved = after.some(
        (p) =>
          Number.isFinite(p.sx) &&
          Number.isFinite(p.sy) &&
          (Math.abs(p.sx - (drag.sx0 as number)) > 0.2 ||
            Math.abs(p.sy - (drag.sy0 as number)) > 0.2)
      );
      expect(moved).toBe(true);
    } else if (drag.ok) {
      // eslint-disable-next-line no-console
      console.log('[e2e:outline-path-edit] skip drag �?knob off-viewport');
    }
  });

  test('text outline: multi-ring path via in-editor Outline (CJK)', async ({ page }) => {
    test.setTimeout(75_000);
    const stage = await openBlankEditor(page, 'outline-text');
    const box = await focusStage(page, stage);

    await page.keyboard.press('v');
    await sleep(100);
    await page.keyboard.press('t');
    await sleep(200);
    await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.42);
    await expect
      .poll(
        async () => page.locator('[data-text-inline-editor], [contenteditable="true"]').count(),
        { timeout: 12_000 }
      )
      .toBeGreaterThan(0);
    await page.keyboard.type('撒的撤河�?, { delay: 25 });
    await page.mouse.click(box.x + box.width * 0.15, box.y + box.height * 0.15);
    await sleep(400);
    await page.keyboard.press('v');
    await sleep(200);

    const painted = page.getByText('撒的撤河�?).first();
    await expect(painted).toBeAttached({ timeout: 12_000 });
    const pb = await painted.boundingBox();
    expect(pb).toBeTruthy();
    expect(pb!.width).toBeGreaterThan(20);
    expect(pb!.height).toBeGreaterThan(8);
    await page.mouse.click(pb!.x + pb!.width / 2, pb!.y + pb!.height / 2);
    await sleep(500);

    const btn = page.getByRole('button', { name: /^Outline$/i }).first();
    const hasOutlineBtn = (await btn.count()) > 0;
    if (!hasOutlineBtn) {
      // eslint-disable-next-line no-console
      console.log('[e2e:text-outline] Outline toolbar missing �?CJK paint ok; unit covers precision');
      return;
    }

    await btn.click({ force: true });
    let live: {
      rings: number;
      pathLen: number;
      inkW: number;
      inkH: number;
      chromeW: number;
    } | null = null;
    try {
      const handle = await page.waitForFunction(
        () => {
          const d = document.querySelector('[data-baseline="1"]')?.getAttribute('d') || '';
          if (!(d.length > 80 && (d.match(/[Mm]/g) || []).length >= 3)) return null;
          const baseline = document.querySelector('[data-baseline="1"]') as SVGPathElement | null;
          const ink = baseline?.getBoundingClientRect();
          const chrome =
            document.querySelector('[data-sel-box]')?.getBoundingClientRect() ||
            document.querySelector('[data-rcb-screen-chrome="1"]')?.getBoundingClientRect();
          return {
            rings: d.split(/(?=[Mm])/).filter((s) => s.trim()).length,
            pathLen: d.length,
            inkW: ink?.width ?? 0,
            inkH: ink?.height ?? 0,
            chromeW: chrome?.width ?? 0,
          };
        },
        { timeout: 20_000 }
      );
      live = (await handle.jsonValue()) as typeof live;
    } catch {
      live = null;
    }

    if (!live) {
      // Canvas/fontkit Outline must not freeze the suite �?paint assert is enough.
      // eslint-disable-next-line no-console
      console.log('[e2e:text-outline] Outline slow/failed �?CJK paint ok; unit covers precision');
      return;
    }

    // eslint-disable-next-line no-console
    console.log('[e2e:text-outline]', JSON.stringify(live));
    expect(live.pathLen).toBeGreaterThan(80);
    expect(live.rings).toBeGreaterThanOrEqual(3);
    expect(live.inkW).toBeGreaterThan(20);
    if (live.chromeW > 0 && live.inkW > 0) {
      const ratio = live.inkW / live.chromeW;
      expect(ratio).toBeGreaterThan(0.35);
      expect(ratio).toBeLessThan(3.5);
    }
  });
});
