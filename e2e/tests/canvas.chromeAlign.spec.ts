/**
 * Live editor: selection chrome vs shape ink + visual-outer vs grid at high zoom.
 * Stays on ADR 0027 (overlay CameraTransform) â€?measures product alignment bugs.
 */
import path from 'node:path';
import { test, expect, type Page, type Locator } from '@playwright/test';
import { E2E_TOKEN_SKIP_REASON, resolveE2EToken } from './e2eAuth';

const ROOT = path.resolve(__dirname, '../..');
const TOKEN = resolveE2EToken(ROOT);
const API = (process.env.E2E_API || process.env.FUNC_API || 'http://127.0.0.1:8000').replace(
  /\/$/,
  ''
);

test.setTimeout(3 * 60_000);

import {
  dragDraw,
  expectShapeInk,
  openLayers,
  sleep,
  waitForEditorToolbar,
  selectionChromeCount,
} from './canvasStressHelpers';

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
    const skip = page.getByRole('button', { name: /^Skip$|^è·³è¿‡$/i });
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
    data: { name: `chrome-align-${Date.now()}`, document: null },
    timeout: 30_000,
  });
  if (!res.ok()) throw new Error(`create project ${res.status()}`);
  const json = await res.json();
  const id = String(json?.project?.id || json?.id || '').trim();
  if (!id) throw new Error('missing project id');
  await page.goto(`/editor/${id}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await expect(page).toHaveURL(/\/editor\//, { timeout: 45_000 });
  await dismissBlockingDialogs(page);
  const stage = page.locator('[data-rcb-canvas="1"], [data-canvas-stage="1"]').first();
  await expect(stage).toBeVisible({ timeout: 45_000 });
  await page.keyboard.press('Escape');
  await sleep(200);
  await waitForEditorToolbar(page);
  return stage;
}

async function focusStage(page: Page, stage: Locator) {
  const box = await stage.boundingBox();
  if (!box) throw new Error('no stage box');
  await page.mouse.click(box.x + 80, box.y + 80);
  await sleep(120);
  return box;
}

test.describe('canvas chrome â†?ink align (high zoom)', () => {
  test.skip(!TOKEN, E2E_TOKEN_SKIP_REASON);

  test.beforeEach(async ({ page }) => {
    await injectAuth(page);
  });

  test('drawn rect: chrome box tracks path; visual outer on grid @ ~4000%', async ({ page }) => {
    const stage = await openBlankEditor(page);
    const box = await focusStage(page, stage);
    await openLayers(page);

    await page.keyboard.press('r');
    await sleep(150);

    await dragDraw(page, box, 0.35, 0.35, 0.55, 0.55, 16);
    await sleep(500);
    await expectShapeInk(page, 1);

    // Draw commit auto-selects â€?chrome should mount before we leave select.
    await expect
      .poll(async () => selectionChromeCount(page), {
        timeout: 12_000,
      })
      .toBeGreaterThan(0);

    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    for (let i = 0; i < 48; i += 1) {
      await page.evaluate(({ x, y }) => {
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
      }, { x: cx, y: cy });
    }
    await sleep(500);

    // Keep selection: click predicted ink if chrome vanished after zoom.
    const still = await selectionChromeCount(page);
    if (still === 0) {
      const layersBtn = page.getByRole('button', { name: /^Layers$|^å›¾å±‚$/i }).first();
      if (await layersBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await layersBtn.click({ force: true });
        await sleep(200);
      }
      const layerHit = page.getByText(/^çŸ©å½¢$|^Rectangle$/i).first();
      await expect(layerHit).toBeAttached({ timeout: 10_000 });
      await layerHit.click({ force: true });
      await sleep(500);
    }

    const probe = await page.evaluate(() => {
      const overlay = document.querySelector('[data-rcb-overlay="1"]');
      return {
        sceneNodes: Array.from(document.querySelectorAll('[data-scene-node-id]')).map((el) =>
          el.getAttribute('data-scene-node-id')
        ),
        overlayKids: overlay?.childElementCount ?? -1,
        chromeLayer: Boolean(document.querySelector('[data-rcb-sel-chrome-layer]')),
        screenChrome: document.querySelectorAll('[data-rcb-screen-chrome]').length,
        selBox: document.querySelectorAll('[data-sel-box]').length,
        selChromeAttr: document.querySelectorAll('[data-rcb-sel-chrome]').length,
        toolbar: Boolean(document.querySelector('[data-rcb-selection-toolbar], [data-selection-toolbar]')),
      };
    });
    // eslint-disable-next-line no-console
    console.log('[e2e:chrome-probe]', JSON.stringify(probe, null, 2));

    await expect
      .poll(async () => selectionChromeCount(page), {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);

    const report = await page.evaluate(() => {
      const canvas = document.querySelector('[data-rcb-canvas="1"]') as HTMLElement | null;
      const cameraRoot = document.querySelector('[data-rcb-scene-camera="1"]') as SVGGElement | null;
      const overlay = document.querySelector('[data-rcb-overlay="1"]') as HTMLElement | null;
      const chromeSvg = document.querySelector('[data-rcb-scene-root="1"]') as SVGSVGElement | null;
      const chromeBox = document.querySelector(
        '[data-sel-box]'
      ) as SVGGraphicsElement | null;
      const knob = document.querySelector('[data-rcb-sel-knob="se"]') as SVGGraphicsElement | null;
      const baseline = document.querySelector(
        '[data-baseline="1"]'
      ) as SVGGraphicsElement | null;
      const nodeEl = document.querySelector(
        '[data-scene-node-id]'
      ) as SVGGraphicsElement | null;

      const zoomAttr = cameraRoot?.getAttribute('transform') || '';
      const zoomMatch = /scale\(([^)]+)\)/.exec(zoomAttr);
      const cssZoom = zoomMatch ? Number(zoomMatch[1]) : NaN;

      function gbr(el: Element | null) {
        if (!el || typeof (el as HTMLElement).getBoundingClientRect !== 'function') return null;
        const r = (el as HTMLElement).getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
      }

      const ink = gbr(baseline || nodeEl);
      const chrome = gbr(chromeBox);
      const se = gbr(knob);
      const stageR = gbr(canvas);

      const anyEl = (baseline || nodeEl) as unknown as {
        __sceneLeft?: number;
        __sceneTop?: number;
        sceneWidth?: number;
        sceneHeight?: number;
        getAttribute?: (n: string) => string | null;
      } | null;
      const hostG =
        (nodeEl?.closest?.('g[data-scene-node-id]') as SVGGraphicsElement | null) || nodeEl;
      const tf =
        hostG?.getAttribute?.('transform') ||
        anyEl?.getAttribute?.('transform') ||
        '';
      const tm = /translate\(\s*([-\d.eE+]+)\s*[, ]\s*([-\d.eE+]+)/.exec(tf);
      const geom = {
        left: tm ? Number(tm[1]) : Number(anyEl?.__sceneLeft),
        top: tm ? Number(tm[2]) : Number(anyEl?.__sceneTop),
        width: Number(anyEl?.sceneWidth) || Number((hostG as { sceneWidth?: number } | null)?.sceneWidth),
        height:
          Number(anyEl?.sceneHeight) || Number((hostG as { sceneHeight?: number } | null)?.sceneHeight),
      };

      // Predicted chrome TL from CameraTransform on **visual outer** (chrome outset).
      const panM = /translate\(\s*([-.\d]+)[, ]+\s*([-.\d]+)/.exec(zoomAttr);
      const panX = panM ? Number(panM[1]) : 0;
      const panY = panM ? Number(panM[2]) : 0;
      const z = cssZoom > 0 ? cssZoom : 1;
      const outset = 0.5; // center stroke 1 â€?matches strokeChromeOutset
      const chromeGeom = {
        left: geom.left - outset,
        top: geom.top - outset,
        width: geom.width + outset * 2,
        height: geom.height + outset * 2,
      };
      const predicted = {
        left: chromeGeom.left * z + panX,
        top: chromeGeom.top * z + panY,
        right: (chromeGeom.left + chromeGeom.width) * z + panX,
        bottom: (chromeGeom.top + chromeGeom.height) * z + panY,
      };
      // Overlay is stage-local; convert predicted to client via stage rect.
      const stage = stageR;
      const predictedClient = stage
        ? {
            left: stage.left + predicted.left,
            top: stage.top + predicted.top,
            right: stage.left + predicted.right,
            bottom: stage.top + predicted.bottom,
          }
        : null;

      const gridSize = Number(
        document.querySelector('[data-rcb-grid-size]')?.getAttribute('data-rcb-grid-size') || 1
      );
      const onLattice = (v: number) => {
        const g = gridSize > 0 ? gridSize : 1;
        return Math.abs(v - Math.round(v / g) * g) < 1e-6;
      };
      const visual = {
        left: geom.left - 0.5,
        top: geom.top - 0.5,
        right: geom.left + geom.width + 0.5,
        bottom: geom.top + geom.height + 0.5,
      };

      let dx = null as number | null;
      let dy = null as number | null;
      let dw = null as number | null;
      let dh = null as number | null;
      if (chrome && predictedClient) {
        dx = chrome.left - predictedClient.left;
        dy = chrome.top - predictedClient.top;
        dw = chrome.w - (predictedClient.right - predictedClient.left);
        dh = chrome.h - (predictedClient.bottom - predictedClient.top);
      }

      let inkVsPred = null as { dx: number; dy: number; dw: number; dh: number } | null;
      if (ink && predictedClient) {
        inkVsPred = {
          dx: ink.left - predictedClient.left,
          dy: ink.top - predictedClient.top,
          dw: ink.w - (predictedClient.right - predictedClient.left),
          dh: ink.h - (predictedClient.bottom - predictedClient.top),
        };
      }

      const baselineCtm = baseline?.getCTM() || null;
      const chromeCtm = chromeBox?.getCTM() || null;
      const matrixKeys = ['a', 'b', 'c', 'd', 'e', 'f'] as const;
      const matrixError =
        baselineCtm && chromeCtm
          ? Math.max(...matrixKeys.map((key) => Math.abs(baselineCtm[key] - chromeCtm[key])))
          : Number.POSITIVE_INFINITY;
      const baselineBox = baseline?.getBBox() || null;
      const chromeX = Number(chromeBox?.getAttribute('x'));
      const chromeY = Number(chromeBox?.getAttribute('y'));
      const chromeW = Number(chromeBox?.getAttribute('width'));
      const chromeH = Number(chromeBox?.getAttribute('height'));
      const chromeOutset = Number.isFinite(chromeX) ? -chromeX : Number.NaN;
      const localEdgeError = baselineBox
        ? Math.max(
            Math.abs(baselineBox.x - chromeOutset - chromeX),
            Math.abs(baselineBox.y - chromeOutset - chromeY),
            Math.abs(baselineBox.width + chromeOutset * 2 - chromeW),
            Math.abs(baselineBox.height + chromeOutset * 2 - chromeH)
          )
        : Number.POSITIVE_INFINITY;
      const sameSceneRoot =
        Boolean(baseline?.closest('[data-rcb-scene-root="1"]')) &&
        baseline?.closest('[data-rcb-scene-root="1"]') ===
          chromeBox?.closest('[data-rcb-scene-root="1"]');
      const sameCameraRoot =
        Boolean(baseline?.closest('[data-rcb-scene-camera="1"]')) &&
        baseline?.closest('[data-rcb-scene-camera="1"]') ===
          chromeBox?.closest('[data-rcb-scene-camera="1"]');

      const canvasIdle = Number(
        document.querySelector('[data-rcb-idle-ink-canvas="1"]')?.getAttribute(
          'data-rcb-canvas-idle-count'
        ) ||
          document.querySelector('[data-rcb-shapes-layer="1"]')?.getAttribute('data-rcb-visible-count') ||
          '0'
      );
      const soaInk = canvasIdle > 0;
      const hasSvgShape = Boolean(baseline || nodeEl);
      return {
        cssZoom,
        gridSize,
        geom,
        visual,
        chromeGeom,
        soaInk,
        hasSvgShape,
        visualOnGrid: {
          left: onLattice(visual.left),
          top: onLattice(visual.top),
          right: onLattice(visual.right),
          bottom: onLattice(visual.bottom),
        },
        chromeOnGrid: {
          left: onLattice(chromeGeom.left),
          top: onLattice(chromeGeom.top),
          right: onLattice(chromeGeom.left + chromeGeom.width),
          bottom: onLattice(chromeGeom.top + chromeGeom.height),
        },
        pathOnGrid: {
          left: onLattice(geom.left),
          top: onLattice(geom.top),
        },
        ink,
        chrome,
        se,
        stageR,
        predictedClient,
        dx,
        dy,
        dw,
        dh,
        inkVsPred,
        exactGeometryError: Math.max(matrixError, localEdgeError),
        sameSceneRoot,
        sameCameraRoot,
        hasChrome: Boolean(chromeBox || chromeSvg || document.querySelector('[data-rcb-sel-knob]')),
        hasShape: hasSvgShape || soaInk,
        worldTf: zoomAttr.slice(0, 120),
        overlayKids: overlay?.childElementCount ?? 0,
        chromeLayer: Boolean(document.querySelector('[data-rcb-sel-chrome-layer]')),
        hostCount: document.querySelectorAll('[data-scene-node-id]').length,
        selChromeCount: document.querySelectorAll('[data-rcb-screen-chrome="1"]').length,
        selBoxCount:
          document.querySelectorAll('[data-sel-box], [data-rcb-sel-knob]').length,
      };
    });

    // eslint-disable-next-line no-console
    console.log('[e2e:chrome-align]', JSON.stringify(report, null, 2));

    expect(report.hasShape).toBe(true);
    if (report.hasSvgShape) {
      expect(report.hostCount).toBeGreaterThan(0);
    }
    expect(report.cssZoom).toBeGreaterThan(8);
    expect(report.hasChrome).toBe(true);
    expect(report.selBoxCount).toBeGreaterThan(0);
    if (report.hasSvgShape) {
      expect(report.sameSceneRoot).toBe(true);
      expect(report.sameCameraRoot).toBe(true);
      expect(report.exactGeometryError).toBe(0);

      // Visual outer + chrome AABB must sit on the 1px grid after draw settle.
      expect(report.visualOnGrid.left).toBe(true);
      expect(report.visualOnGrid.top).toBe(true);
      expect(report.visualOnGrid.right).toBe(true);
      expect(report.visualOnGrid.bottom).toBe(true);
      expect(report.chromeOnGrid.left).toBe(true);
      expect(report.chromeOnGrid.top).toBe(true);
      expect(report.chromeOnGrid.right).toBe(true);
      expect(report.chromeOnGrid.bottom).toBe(true);

      // Overlay chrome TL/size must match CameraTransform(visual outer) within 2 CSS px.
      expect(report.dx).not.toBeNull();
      expect(Math.abs(report.dx || 0)).toBeLessThan(2.5);
      expect(Math.abs(report.dy || 0)).toBeLessThan(2.5);
      expect(Math.abs(report.dw || 0)).toBeLessThan(3);
      expect(Math.abs(report.dh || 0)).toBeLessThan(3);

      const z = Number(report.cssZoom) || 1;
      const outsetScreen = 0.5 * z;
      expect(report.inkVsPred).not.toBeNull();
      expect(Math.abs((report.inkVsPred?.dx || 0) - outsetScreen)).toBeLessThan(0.5);
      expect(Math.abs((report.inkVsPred?.dy || 0) - outsetScreen)).toBeLessThan(0.5);
    } else {
      // SoA ink: chrome knobs + high zoom smoke only (no SVG baseline to compare).
      expect(report.se).toBeTruthy();
    }

    if (!report.hasSvgShape) {
      return;
    }

    const zoomDrift: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      await page.evaluate(({ x, y, deltaY }) => {
        const stage = document.querySelector('[data-rcb-canvas="1"]');
        stage?.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            deltaY,
            ctrlKey: true,
          })
        );
      }, { x: cx, y: cy, deltaY: i % 2 === 0 ? 120 : -90 });
      await page.waitForTimeout(60);
      zoomDrift.push(
        await page.evaluate(() => {
          const baseline = document.querySelector('[data-baseline="1"]');
          const chrome = document.querySelector('[data-sel-box]');
          if (!(baseline instanceof SVGGraphicsElement) || !(chrome instanceof SVGGraphicsElement)) {
            return Number.POSITIVE_INFINITY;
          }
          if (
            baseline.closest('[data-rcb-scene-camera="1"]') !==
            chrome.closest('[data-rcb-scene-camera="1"]')
          ) return Number.POSITIVE_INFINITY;
          const a = baseline.getCTM();
          const b = chrome.getCTM();
          if (!a || !b) return Number.POSITIVE_INFINITY;
          const matrixError = Math.max(
            Math.abs(a.a - b.a), Math.abs(a.b - b.b), Math.abs(a.c - b.c),
            Math.abs(a.d - b.d), Math.abs(a.e - b.e), Math.abs(a.f - b.f)
          );
          const ink = baseline.getBBox();
          const x = Number(chrome.getAttribute('x'));
          const y = Number(chrome.getAttribute('y'));
          const w = Number(chrome.getAttribute('width'));
          const h = Number(chrome.getAttribute('height'));
          const outset = -x;
          const localError = Math.max(
            Math.abs(ink.x - outset - x),
            Math.abs(ink.y - outset - y),
            Math.abs(ink.width + outset * 2 - w),
            Math.abs(ink.height + outset * 2 - h)
          );
          return Math.max(matrixError, localError);
        })
      );
    }
    const maxZoomDrift = Math.max(...zoomDrift);
    // eslint-disable-next-line no-console
    console.log('[e2e:rect-zoom-stress]', JSON.stringify({ maxZoomDrift, zoomDrift }));
    expect(maxZoomDrift).toBe(0);
  });
});
