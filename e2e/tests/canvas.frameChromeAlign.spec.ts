/**
 * Frame plate ink vs selection chrome under high zoom (user: content dances off chrome/grid).
 */
import { test, expect } from '@playwright/test';
import { E2E_TOKEN_SKIP_REASON } from './e2eAuth';
import {
  dragDraw,
  injectAuth,
  openBlankEditor,
  openLayers,
  sleep,
  waitForEditorToolbar,
  selectionChromeCount,
  TOKEN,
} from './canvasStressHelpers';

test.describe('canvas frame chrome �?plate align', () => {
  test.skip(!TOKEN, E2E_TOKEN_SKIP_REASON);
  test.setTimeout(3 * 60_000);
  // User repro: browser zoom �?fractional DPR (MCP tab had data-rcb-dpr=0.75).
  test.use({ deviceScaleFactor: 0.75 });

  test.beforeEach(async ({ page }) => {
    await injectAuth(page);
  });

  test('frame plate GBR tracks chrome within 2.5 CSS px @ high zoom', async ({ page }) => {
    const stage = await openBlankEditor(page, 'frame-chrome');
    await waitForEditorToolbar(page);
    const box = await stage.boundingBox();
    if (!box) throw new Error('no stage');
    await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.35);
    await sleep(120);
    await openLayers(page);
    await page.keyboard.press('f');
    await sleep(150);
    await dragDraw(page, box, 0.28, 0.28, 0.62, 0.68, 14);
    await sleep(400);

    await expect(page.locator('[data-rcb-frame-plate="1"]').first()).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(async () => selectionChromeCount(page), { timeout: 12_000 })
      .toBeGreaterThan(0);

    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    for (let i = 0; i < 40; i += 1) {
      await page.evaluate(
        ({ x, y }) => {
          const el = document.querySelector('[data-rcb-canvas="1"]');
          el?.dispatchEvent(
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
    await page.waitForTimeout(400);

    // Mid-gesture zoom stress: ink must stay glued to chrome while zooming.
    const mid = await page.evaluate(async () => {
      const stage = document.querySelector('[data-rcb-canvas="1"]') as HTMLElement | null;
      if (!stage) return { maxDrift: -1, n: 0 };
      const r = stage.getBoundingClientRect();
      const samples: number[] = [];
      for (let i = 0; i < 12; i += 1) {
        stage.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            clientX: r.left + r.width / 2,
            clientY: r.top + r.height / 2,
            deltaY: i % 2 === 0 ? -100 : 100,
            ctrlKey: true,
          })
        );
        await new Promise((res) => requestAnimationFrame(() => res(null)));
        const plate = document.querySelector('[data-rcb-frame-plate="1"]');
        const chrome = document.querySelector('[data-sel-box]');
        if (!(plate instanceof SVGGraphicsElement) || !(chrome instanceof SVGGraphicsElement)) continue;
        if (plate.closest('[data-rcb-scene-camera="1"]') !== chrome.closest('[data-rcb-scene-camera="1"]')) {
          samples.push(Number.POSITIVE_INFINITY);
          continue;
        }
        const a = plate.getCTM();
        const b = chrome.getCTM();
        if (!a || !b) continue;
        const plateBox = plate.getBBox();
        samples.push(Math.max(
          Math.abs(a.a - b.a), Math.abs(a.b - b.b), Math.abs(a.c - b.c),
          Math.abs(a.d - b.d), Math.abs(a.e - b.e), Math.abs(a.f - b.f),
          Math.abs(plateBox.x - Number(chrome.getAttribute('x'))),
          Math.abs(plateBox.y - Number(chrome.getAttribute('y'))),
          Math.abs(plateBox.width - Number(chrome.getAttribute('width'))),
          Math.abs(plateBox.height - Number(chrome.getAttribute('height')))
        ));
      }
      return { maxDrift: samples.length ? Math.max(...samples) : -1, n: samples.length };
    });
    // eslint-disable-next-line no-console
    console.log('[e2e:frame-zoom-stress]', JSON.stringify(mid));
    expect(mid.n).toBeGreaterThan(0);
    if (typeof mid.maxDrift === 'number' && Number.isFinite(mid.maxDrift)) {
      expect(mid.maxDrift).toBe(0);
    }

    const report = await page.evaluate(() => {
      const plate = document.querySelector(
        '[data-rcb-frame-plate="1"]'
      ) as SVGGraphicsElement | null;
      const chromeBox = document.querySelector(
        '[data-sel-box]'
      ) as SVGGraphicsElement | null;
      const cameraRoot = document.querySelector('[data-rcb-scene-camera="1"]') as SVGGElement | null;
      const stageEl = document.querySelector('[data-rcb-canvas="1"]') as HTMLElement | null;
      const tf = plate?.getAttribute('transform') || '';
      const tm = /translate\(\s*([-\d.eE+]+)\s*[, ]\s*([-\d.eE+]+)/.exec(tf);
      const any = plate as unknown as {
        __sceneLeft?: number;
        __sceneTop?: number;
        sceneWidth?: number;
        sceneHeight?: number;
      };
      const geom = {
        left: tm ? Number(tm[1]) : Number(any?.__sceneLeft),
        top: tm ? Number(tm[2]) : Number(any?.__sceneTop),
        width: Number(any?.sceneWidth) || 0,
        height: Number(any?.sceneHeight) || 0,
      };
      const worldTf = cameraRoot?.getAttribute('transform') || '';
      const panM = /translate\(\s*([-.\d]+)[, ]+\s*([-.\d]+)/.exec(worldTf);
      const zM = /scale\(([^)]+)\)/.exec(worldTf);
      const panX = panM ? Number(panM[1]) : 0;
      const panY = panM ? Number(panM[2]) : 0;
      const z = zM ? Number(zM[1]) : 1;
      const stageR = stageEl!.getBoundingClientRect();
      const predicted = {
        left: stageR.left + geom.left * z + panX,
        top: stageR.top + geom.top * z + panY,
        w: geom.width * z,
        h: geom.height * z,
      };
      const ink = plate!.getBoundingClientRect();
      const chrome = chromeBox!.getBoundingClientRect();
      const plateCtm = plate?.getCTM() || null;
      const chromeCtm = chromeBox?.getCTM() || null;
      const plateBox = plate?.getBBox() || null;
      const exactGeometryError = plateCtm && chromeCtm && plateBox && chromeBox
        ? Math.max(
            Math.abs(plateCtm.a - chromeCtm.a),
            Math.abs(plateCtm.b - chromeCtm.b),
            Math.abs(plateCtm.c - chromeCtm.c),
            Math.abs(plateCtm.d - chromeCtm.d),
            Math.abs(plateCtm.e - chromeCtm.e),
            Math.abs(plateCtm.f - chromeCtm.f),
            Math.abs(plateBox.x - Number(chromeBox.getAttribute('x'))),
            Math.abs(plateBox.y - Number(chromeBox.getAttribute('y'))),
            Math.abs(plateBox.width - Number(chromeBox.getAttribute('width'))),
            Math.abs(plateBox.height - Number(chromeBox.getAttribute('height')))
          )
        : Number.POSITIVE_INFINITY;
      return {
        z,
        geom,
        dpr: typeof window !== 'undefined' ? String(window.devicePixelRatio || 1) : null,
        inkVsPred: {
          dx: ink.left - predicted.left,
          dy: ink.top - predicted.top,
          dw: ink.width - predicted.w,
          dh: ink.height - predicted.h,
        },
        chromeVsPred: {
          dx: chrome.left - predicted.left,
          dy: chrome.top - predicted.top,
          dw: chrome.width - predicted.w,
          dh: chrome.height - predicted.h,
        },
        inkVsChrome: {
          dx: ink.left - chrome.left,
          dy: ink.top - chrome.top,
          dw: ink.width - chrome.width,
          dh: ink.height - chrome.height,
        },
        exactGeometryError,
        sameSceneRoot:
          plate?.closest('[data-rcb-scene-root="1"]') ===
          chromeBox?.closest('[data-rcb-scene-root="1"]'),
        sameCameraRoot:
          plate?.closest('[data-rcb-scene-camera="1"]') ===
          chromeBox?.closest('[data-rcb-scene-camera="1"]'),
      };
    });

    // eslint-disable-next-line no-console
    console.log('[e2e:frame-chrome]', JSON.stringify(report, null, 2));

    expect(report.z).toBeGreaterThan(8);
    expect(report.sameSceneRoot).toBe(true);
    expect(report.exactGeometryError).toBe(0);
    // Plate / chrome screen boxes must stay glued (camera mount may differ by design).
    expect(Math.abs(report.inkVsChrome.dx)).toBeLessThan(2.5);
    expect(Math.abs(report.inkVsChrome.dy)).toBeLessThan(2.5);
    expect(Math.abs(report.inkVsChrome.dw)).toBeLessThan(2.5);
    expect(Math.abs(report.inkVsChrome.dh)).toBeLessThan(2.5);
  });
});
