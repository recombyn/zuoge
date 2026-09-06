import { chromium } from 'playwright';

async function main() {
  const TOKEN = process.env.E2E_TOKEN;
  const API = (process.env.E2E_API || 'http://127.0.0.1:8000').replace(/\/$/, '');
  const BASE = (process.env.E2E_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript((tok) => {
    localStorage.setItem('recombine-auth-token-v1', tok);
    localStorage.setItem('recombyn-editor-tour-v3', '1');
  }, TOKEN);
  const me = await page.request.get(`${API}/api/v1/auth/me`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const user = (await me.json()).user;
  await page.goto(`${BASE}/home`);
  await page.evaluate(
    ({ tok, user: u }) => {
      localStorage.setItem('recombine-auth-token-v1', tok);
      localStorage.setItem('resume-scene-auth-v1', JSON.stringify({ user: u }));
    },
    { tok: TOKEN, user }
  );
  const res = await page.request.put(`${API}/api/v1/projects`, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    data: { name: `probe-${Date.now()}`, document: null },
  });
  const id = (await res.json()).project?.id;
  await page.goto(`${BASE}/editor/${id}`);
  await page.waitForSelector('[data-rcb-canvas="1"]', { timeout: 45000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const box = await page.locator('[data-rcb-canvas="1"]').boundingBox();
  if (!box) throw new Error('no stage');
  await page.mouse.click(box.x + 100, box.y + 100);
  await page.keyboard.press('r');
  await page.waitForTimeout(150);
  const x0 = box.x + box.width * 0.35;
  const y0 = box.y + box.height * 0.35;
  const x1 = box.x + box.width * 0.55;
  const y1 = box.y + box.height * 0.55;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(700);

  const report = await page.evaluate(() => {
    const world = document.querySelector('[data-rcb-world]');
    const chromeBox = document.querySelector('[data-sel-box]');
    const baseline = document.querySelector('[data-baseline="1"]');
    const node = document.querySelector('[data-scene-node-id]');
    const grid = document.querySelector('[data-rcb-scene-canvas]');
    const gbr = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { l: +r.left.toFixed(2), t: +r.top.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) };
    };
    const host = node?.closest?.('g[data-scene-node-id]') || node;
    const tf = host?.getAttribute?.('transform') || '';
    const chromeBody = document.querySelector('[data-rcb-sel-chrome="body"]');
    return {
      nodeCount: document.querySelectorAll('[data-scene-node-id]').length,
      hasChrome: Boolean(chromeBox),
      worldTf: world?.style?.transform || '',
      hostTf: tf,
      chromeBodyTf: chromeBody?.getAttribute?.('transform') || '',
      ink: gbr(baseline || node),
      chrome: gbr(chromeBox),
      gridAttr: {
        size: grid?.getAttribute('data-rcb-grid-size'),
        left: grid?.getAttribute('data-rcb-grid-left'),
        top: grid?.getAttribute('data-rcb-grid-top'),
        show: grid?.getAttribute('data-rcb-pixel-grid'),
      },
      selChrome: document.querySelectorAll('[data-rcb-screen-chrome]').length,
      hitPads: document.querySelectorAll('[data-rcb-hit-pad]').length,
    };
  });

  let afterClick = null;
  if (report.ink) {
    await page.mouse.click(report.ink.l + report.ink.w / 2, report.ink.t + report.ink.h / 2);
    await page.waitForTimeout(400);
    afterClick = await page.evaluate(() => ({
      selectedChrome: document.querySelectorAll('[data-sel-box]').length,
      screenChrome: document.querySelectorAll('[data-rcb-screen-chrome]').length,
    }));
  }

  // deselect then reselect
  await page.mouse.click(box.x + 40, box.y + 40);
  await page.waitForTimeout(200);
  const afterDeselect = await page.evaluate(
    () => document.querySelectorAll('[data-sel-box]').length
  );
  if (report.ink) {
    await page.mouse.click(report.ink.l + report.ink.w / 2, report.ink.t + report.ink.h / 2);
    await page.waitForTimeout(400);
  }
  const afterReselect = await page.evaluate(
    () => document.querySelectorAll('[data-sel-box]').length
  );

  console.log(
    JSON.stringify(
      { report, afterClick, afterDeselect, afterReselect, delta: report.chrome && report.ink
        ? {
            dx: +(report.chrome.l - report.ink.l).toFixed(2),
            dy: +(report.chrome.t - report.ink.t).toFixed(2),
            dw: +(report.chrome.w - report.ink.w).toFixed(2),
            dh: +(report.chrome.h - report.ink.h).toFixed(2),
          }
        : null },
      null,
      2
    )
  );
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
