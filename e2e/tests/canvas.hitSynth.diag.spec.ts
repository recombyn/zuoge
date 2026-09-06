import path from 'node:path';
import { test, expect } from '@playwright/test';
import { E2E_TOKEN_SKIP_REASON, resolveE2EToken } from './e2eAuth';
const ROOT = path.resolve(__dirname, '../..');
const TOKEN = resolveE2EToken(ROOT);
const API = (process.env.E2E_API || 'http://127.0.0.1:8000').replace(/\/$/, '');
test.setTimeout(90000);
test.skip(!TOKEN, E2E_TOKEN_SKIP_REASON);
test('dispatch hit on canvas', async ({ page }) => {
  await page.context().addInitScript((tok) => {
    localStorage.setItem('recombine-auth-token-v1', tok);
    localStorage.setItem('recombyn-editor-tour-v3', '1');
    localStorage.setItem('recombyn-editor-tour-v3:user_super_admin', '1');
  }, TOKEN);
  const me = await page.request.get(API + '/api/v1/auth/me', { headers: { Authorization: 'Bearer ' + TOKEN } });
  const body = await me.json();
  await page.goto('/home', { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ tok, user: u }) => {
    localStorage.setItem('recombine-auth-token-v1', tok);
    localStorage.setItem('resume-scene-auth-v1', JSON.stringify({ user: u }));
  }, { tok: TOKEN, user: body.user });
  const res = await page.request.put(API + '/api/v1/projects', {
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    data: { name: 'hit2-' + Date.now(), document: null },
  });
  const id = String((await res.json())?.project?.id || '');
  await page.goto('/editor/' + id, { waitUntil: 'domcontentloaded' });
  const stage = page.locator('[data-rcb-canvas=\"1\"]').first();
  await expect(stage).toBeVisible({ timeout: 45000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const box = await stage.boundingBox();
  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.45);
  await page.keyboard.press('r');
  await page.waitForTimeout(120);
  await page.mouse.move(box.x + box.width * 0.28, box.y + box.height * 0.28);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.42, { steps: 16 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  await page.keyboard.press('v');
  await page.waitForTimeout(150);
  await page.mouse.click(box.x + box.width * 0.12, box.y + box.height * 0.85);
  await page.waitForTimeout(200);

  const probe = await page.evaluate(() => {
    const canvas = document.querySelector('[data-rcb-canvas=\"1\"]') as HTMLElement;
    const el = document.querySelector('[data-scene-node-id]') as SVGGraphicsElement;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const world = document.querySelector('[data-rcb-world=\"1\"]') as HTMLElement;
    const tf = world?.style?.transform || '';
    // Parse translate(scale)
    const m = /translate\(([-0-9.]+)px,\s*([-0-9.]+)px\)\s*scale\(([-0-9.]+)\)/.exec(tf);
    const camX = m ? Number(m[1]) : 0;
    const camY = m ? Number(m[2]) : 0;
    const z = m ? Number(m[3]) : 1;
    const cr = canvas.getBoundingClientRect();
    const localX = cx - cr.left;
    const localY = cy - cr.top;
    const sceneX = (localX - camX) / z;
    const sceneY = (localY - camY) / z;
    // node scene attrs if present
    const nx = Number(el.getAttribute('data-x') || el.getAttribute('x') || NaN);
    const ny = Number(el.getAttribute('data-y') || el.getAttribute('y') || NaN);
    const peWorld = world ? getComputedStyle(world).pointerEvents : null;
    const peCanvas = getComputedStyle(canvas).pointerEvents;
    // Fire synthetic pointerdown on canvas at cx,cy
    const ev = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      clientX: cx,
      clientY: cy,
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      buttons: 1,
      view: window,
    });
    canvas.dispatchEvent(ev);
    const chromeAfter = document.querySelectorAll('[data-sel-box]').length;
    return {
      cx, cy, sceneX, sceneY, camX, camY, z, localX, localY,
      nodeId: el.getAttribute('data-scene-node-id'),
      nx, ny,
      peWorld, peCanvas,
      chromeAfter,
      bbox: { left: r.left, top: r.top, w: r.width, h: r.height },
    };
  });
  console.log(JSON.stringify(probe, null, 2));
  await page.waitForTimeout(300);
  console.log('chrome after wait', await page.locator('[data-sel-box]').count());
});
