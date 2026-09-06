import path from 'node:path';
import { test, expect } from '@playwright/test';
import { E2E_TOKEN_SKIP_REASON, resolveE2EToken } from './e2eAuth';
const ROOT = path.resolve(__dirname, '../..');
const TOKEN = resolveE2EToken(ROOT);
const API = (process.env.E2E_API || 'http://127.0.0.1:8000').replace(/\/$/, '');
test.setTimeout(90000);
test.skip(!TOKEN, E2E_TOKEN_SKIP_REASON);
test('stack at click', async ({ page }) => {
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
    data: { name: 'stack-' + Date.now(), document: null },
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
  await page.mouse.click(box.x + box.width * 0.12, box.y + box.height * 0.85);
  await page.waitForTimeout(200);
  const info = await page.evaluate(() => {
    const el = document.querySelector('[data-scene-node-id]');
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const stack = document.elementsFromPoint(cx, cy).slice(0, 12).map((n) => ({
      tag: n.tagName,
      id: n.id || undefined,
      cls: (n.className && String(n.className).slice?.(0, 80)) || undefined,
      pe: getComputedStyle(n).pointerEvents,
      attrs: {
        rcb: n.getAttribute('data-rcb-canvas') || n.getAttribute('data-rcb-world') || n.getAttribute('data-rcb-overlay') || n.getAttribute('data-rcb-hit-pad-layer') || n.getAttribute('data-scene-node-id') || n.getAttribute('data-rcb-sel-chrome-layer') || undefined,
      },
    }));
    return { cx, cy, r: { left: r.left, top: r.top, w: r.width, h: r.height }, stack };
  });
  console.log(JSON.stringify(info, null, 2));
  await page.mouse.click(info.cx, info.cy);
  await page.waitForTimeout(300);
  console.log('chrome after', await page.locator('[data-sel-box]').count());
});
