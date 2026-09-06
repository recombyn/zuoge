/**
 * Live repro: click select + marquee select (measured, not guessed).
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
  shapeInkSignals,
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
    data: { name: `hit-select-${Date.now()}`, document: null },
    timeout: 30_000,
  });
  if (!res.ok()) throw new Error(`create project ${res.status()}`);
  const json = await res.json();
  const id = String(json?.project?.id || json?.id || '').trim();
  if (!id) throw new Error('missing project id');
  await page.goto(`/editor/${id}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await expect(page).toHaveURL(new RegExp(`/editor/${id}`), { timeout: 45_000 });
  await dismissBlockingDialogs(page);
  const stage = page.locator('[data-rcb-canvas="1"], [data-canvas-stage="1"]').first();
  await expect(stage).toBeVisible({ timeout: 45_000 });
  await page.keyboard.press('Escape');
  await sleep(400);
  await waitForEditorToolbar(page);
  return stage;
}

/** Stage bbox is often full viewport �?never click the left rail. */
async function focusStage(page: Page, stage: Locator) {
  const box = await stage.boundingBox();
  if (!box) throw new Error('no stage box');
  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.45);
  await sleep(120);
  return box;
}

async function dragDrawRect(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
  x0r: number,
  y0r: number,
  x1r: number,
  y1r: number
) {
  await dragDraw(page, box, x0r, y0r, x1r, y1r, 18);
}

function rectCenter(
  box: { x: number; y: number; width: number; height: number },
  x0r: number,
  y0r: number,
  x1r: number,
  y1r: number
) {
  const x0 = box.x + box.width * x0r;
  const y0 = box.y + box.height * y0r;
  const x1 = box.x + box.width * x1r;
  const y1 = box.y + box.height * y1r;
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, x0, y0, x1, y1 };
}

async function hasActiveSelection(page: Page) {
  return page.locator('[data-sel-box]').count();
}

async function chromeCount(page: Page) {
  return selectionChromeCount(page);
}

async function sceneProbe(page: Page) {
  return page.evaluate(() => {
    const world = document.querySelector('[data-rcb-world="1"]') as HTMLElement | null;
    const nodes = Array.from(document.querySelectorAll('[data-scene-node-id]'));
    const hitPads = document.querySelectorAll('[data-rcb-hit-pad], [data-rcb-hit-dom]');
    const hitLayer = document.querySelector('[data-rcb-hit-pad-layer]');
    return {
      url: location.href,
      hasCanvas: Boolean(document.querySelector('[data-rcb-canvas="1"]')),
      worldTf: world?.style?.transform || '',
      sceneNodeDom: nodes.length,
      sceneNodeIds: nodes.map((n) => n.getAttribute('data-scene-node-id')).slice(0, 12),
      hitPadCount: hitPads.length,
      hitLayerAlive: Boolean(hitLayer),
      hitLayerUnderWorld: Boolean(hitLayer?.closest('[data-rcb-world="1"]')),
      chrome: {
        selBox: document.querySelectorAll('[data-sel-box]').length,
        selChrome: document.querySelectorAll('[data-rcb-sel-chrome]').length,
        screenChrome: document.querySelectorAll('[data-rcb-screen-chrome]').length,
      },
    };
  });
}

test.describe('canvas hit / marquee (live)', () => {
  test.skip(!TOKEN, E2E_TOKEN_SKIP_REASON);

  test.beforeEach(async ({ page }) => {
    await injectAuth(page);
  });

  test('click + marquee select two rects', async ({ page }) => {
    const stage = await openBlankEditor(page);
    const box = await focusStage(page, stage);
    await openLayers(page);

    const rect1 = { fx0: 0.28, fy0: 0.28, fx1: 0.42, fy1: 0.42 };
    const rect2 = { fx0: 0.5, fy0: 0.3, fx1: 0.64, fy1: 0.44 };

    await page.keyboard.press('r');
    await sleep(120);
    await dragDrawRect(page, box, rect1.fx0, rect1.fy0, rect1.fx1, rect1.fy1);
    const afterDraw1 = await sceneProbe(page);
    console.log('[e2e:hit] after draw1', JSON.stringify(afterDraw1));
    expect(afterDraw1.url).toMatch(/\/editor\//);
    await expectShapeInk(page, 1);
    await expect.poll(async () => chromeCount(page), { timeout: 8_000 }).toBeGreaterThan(0);

    await page.keyboard.press('r');
    await sleep(120);
    await dragDrawRect(page, box, rect2.fx0, rect2.fy0, rect2.fx1, rect2.fy1);
    const afterDraw2 = await sceneProbe(page);
    console.log('[e2e:hit] after draw2', JSON.stringify(afterDraw2));
    await expectShapeInk(page, 2);

    await page.keyboard.press('v');
    await sleep(100);
    await page.mouse.click(box.x + box.width * 0.06, box.y + box.height * 0.06);
    await sleep(300);
    await expect.poll(async () => hasActiveSelection(page), { timeout: 5_000 }).toBe(0);

    const r1 = rectCenter(box, rect1.fx0, rect1.fy0, rect1.fx1, rect1.fy1);
    const domTarget = await page.evaluate(() => {
      const el = document.querySelector('[data-scene-node-id]') as SVGGraphicsElement | null;
      if (!el || typeof el.getBoundingClientRect !== 'function') return null;
      const r = el.getBoundingClientRect();
      return {
        id: el.getAttribute('data-scene-node-id'),
        cx: r.left + r.width / 2,
        cy: r.top + r.height / 2,
        w: r.width,
        h: r.height,
      };
    });
    const target = domTarget && domTarget.w > 2 && domTarget.h > 2
      ? domTarget
      : { id: '', cx: r1.cx, cy: r1.cy, w: Math.abs(r1.x1 - r1.x0), h: Math.abs(r1.y1 - r1.y0) };
    console.log('[e2e:hit] click target', JSON.stringify(target));

    await page.mouse.click(target.cx, target.cy);
    await sleep(400);
    const afterClick = await sceneProbe(page);
    console.log('[e2e:hit] after click', JSON.stringify(afterClick));

    await page.mouse.click(box.x + box.width * 0.12, box.y + box.height * 0.85);
    await sleep(200);

    const r2 = rectCenter(box, rect2.fx0, rect2.fy0, rect2.fx1, rect2.fy1);
    const marqueeBox = {
      x0: Math.min(r1.x0, r2.x0) - 30,
      y0: Math.min(r1.y0, r2.y0) - 30,
      x1: Math.max(r1.x1, r2.x1) + 30,
      y1: Math.max(r1.y1, r2.y1) + 30,
      count: await shapeInkSignals(page),
    };
    console.log('[e2e:hit] marquee box', JSON.stringify(marqueeBox));
    expect(marqueeBox.count).toBeGreaterThanOrEqual(2);

    await page.mouse.move(marqueeBox.x0, marqueeBox.y0);
    await page.mouse.down();
    await page.mouse.move(marqueeBox.x1, marqueeBox.y1, { steps: 28 });
    await page.mouse.up();
    await sleep(450);
    const afterMarquee = await sceneProbe(page);
    console.log('[e2e:hit] after marquee', JSON.stringify(afterMarquee));

    const clickOk = afterClick.chrome.selBox + afterClick.chrome.selChrome + afterClick.chrome.screenChrome > 0;
    const marqueeOk =
      afterMarquee.chrome.selBox > 0 ||
      afterMarquee.chrome.screenChrome >= 1 ||
      afterMarquee.chrome.selChrome >= 2;

    console.log('[e2e:hit] RESULT', { clickOk, marqueeOk, afterClick: afterClick.chrome, afterMarquee: afterMarquee.chrome });

    expect(clickOk, 'click-select should show selection chrome').toBe(true);
    expect(marqueeOk, 'marquee-select should show selection chrome').toBe(true);
  });
});
