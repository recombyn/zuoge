/**
 * Shared helpers for canvas product stress E2E (ops + deep + tools).
 */
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { resolveE2EToken } from './e2eAuth';

export const ROOT = path.resolve(__dirname, '../..');
export const TOKEN = resolveE2EToken(ROOT);
export const API = (process.env.E2E_API || process.env.FUNC_API || 'http://127.0.0.1:8000').replace(
  /\/$/,
  ''
);

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function injectAuth(page: Page) {
  await page.context().addInitScript((tok) => {
    localStorage.setItem('recombine-auth-token-v1', tok);
    localStorage.setItem('recombyn-editor-tour-v3', '1');
    localStorage.setItem('recombyn-editor-tour-v3:user_super_admin', '1');
  }, TOKEN);
}

export async function seedAuthSession(page: Page) {
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

export async function dismissBlockingDialogs(page: Page) {
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

export async function createBlankProject(page: Page, namePrefix = 'canvas-product'): Promise<string> {
  const res = await page.request.put(`${API}/api/v1/projects`, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    data: { name: `${namePrefix}-${Date.now()}`, document: null },
    timeout: 30_000,
  });
  if (!res.ok()) throw new Error(`create project ${res.status()}`);
  const json = await res.json();
  const id = String(json?.project?.id || json?.id || '').trim();
  if (!id) throw new Error('missing project id');
  return id;
}

export async function openBlankEditor(page: Page, namePrefix = 'canvas-product') {
  await seedAuthSession(page);
  const id = await createBlankProject(page, namePrefix);
  await page.goto(`/editor/${id}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await expect(page).toHaveURL(/\/editor\//, { timeout: 45_000 });
  await dismissBlockingDialogs(page);
  if (
    await page
      .getByRole('heading', { name: /^Log in$|^登录$/i })
      .first()
      .isVisible({ timeout: 1_500 })
      .catch(() => false)
  ) {
    throw new Error('editor behind login');
  }
  await expect(
    page.getByRole('button', { name: /Image generator|图像生成�?i }).first()
  ).toBeVisible({ timeout: 45_000 });
  const stage = page.locator('[data-rcb-canvas="1"], [data-canvas-stage="1"]').first();
  await expect(stage).toBeVisible({ timeout: 45_000 });
  const skip = page.getByRole('button', { name: /^Skip$|^跳过$/i });
  if (await skip.first().isVisible({ timeout: 800 }).catch(() => false)) {
    await skip.first().click({ force: true });
  }
  await page.keyboard.press('Escape');
  await sleep(200);
  return stage;
}

export async function focusStage(page: Page, stage: Locator, interior = 0.35) {
  const box = await stage.boundingBox();
  if (!box) throw new Error('no stage box');
  await page.mouse.click(box.x + box.width * interior, box.y + box.height * interior);
  await sleep(interior >= 0.5 ? 120 : 100);
  return box;
}

export async function openLayers(page: Page) {
  const layersBtn = page.getByRole('button', { name: /^Layers$|^图层$/i }).first();
  if (await layersBtn.isVisible({ timeout: 4_000 }).catch(() => false)) {
    await layersBtn.click({ force: true });
    await sleep(200);
  }
}

export async function waitForEditorToolbar(page: Page) {
  await expect(
    page.getByRole('button', { name: /Smart frame|智能画板/i }).first()
  ).toBeVisible({ timeout: 45_000 });
  await sleep(300);
}

export function stageIdleCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const ink =
      document.querySelector('[data-rcb-idle-ink-canvas="1"]') ||
      document.querySelector('[data-rcb-shapes-layer="1"]') ||
      document.querySelector('[data-rcb-canvas="1"]');
    const raw = ink?.getAttribute('data-rcb-canvas-idle-count') || '0';
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  });
}

export function documentShapeCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const layer = document.querySelector('[data-rcb-shapes-layer="1"]');
    const idle = Number(
      document.querySelector('[data-rcb-idle-ink-canvas="1"]')?.getAttribute('data-rcb-canvas-idle-count') ||
        layer?.getAttribute('data-rcb-canvas-idle-count') ||
        '0'
    );
    const visible = Number(layer?.getAttribute('data-rcb-visible-count') || '0');
    const fullHost = Number(layer?.getAttribute('data-rcb-full-host-count') || '0');
    const hosts = document.querySelectorAll('[data-rcb-shape-host]').length;
    const svgNodes = document.querySelectorAll('[data-scene-node-id]').length;
    const wBox = document.querySelector('[role="textbox"][name="W"], input[aria-label="W"]') as
      | HTMLInputElement
      | null;
    const toolbarShape = wBox?.value && Number(wBox.value) > 0 ? 1 : 0;
    return Math.max(idle, visible, fullHost, hosts, svgNodes, toolbarShape);
  });
}

export async function shapeInkSignals(page: Page): Promise<number> {
  return documentShapeCount(page);
}

export async function expectShapeInk(page: Page, min = 1, timeout = 15_000) {
  await expect
    .poll(async () => shapeInkSignals(page), { timeout, intervals: [200, 400, 800, 1200] })
    .toBeGreaterThanOrEqual(min);
}

/** Selection chrome probes (current attrs). */
export const CHROME_SEL =
  '[data-sel-box], [data-rcb-sel-chrome], [data-rcb-screen-chrome="1"], [data-rcb-sel-knob], [data-sel-handle]';

export async function selectionChromeCount(page: Page): Promise<number> {
  return page.locator(CHROME_SEL).count();
}

export async function clearSelection(page: Page) {
  await page.keyboard.press('Escape');
  await sleep(120);
  await page.keyboard.press('Escape');
  await sleep(200);
}

export async function expectLayerLabel(page: Page, re: RegExp, timeout = 12_000) {
  await expect(page.getByText(re).first()).toBeAttached({ timeout });
}

export async function dragDraw(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
  fx0: number,
  fy0: number,
  fx1: number,
  fy1: number,
  steps = 10
) {
  const x0 = box.x + box.width * fx0;
  const y0 = box.y + box.height * fy0;
  const x1 = box.x + box.width * fx1;
  const y1 = box.y + box.height * fy1;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps });
  await page.mouse.up();
  await sleep(steps >= 12 ? 200 : 120);
}

export function toolBtn(page: Page, en: string, zh: string) {
  return page.locator(`[aria-label="${en}"], [aria-label="${zh}"]`).first();
}

export async function makePngBuffer(page: Page, w = 320, h = 240): Promise<Buffer> {
  const tmp = await page.context().newPage();
  try {
    await tmp.setContent(
      `<!doctype html><canvas id="c" width="${w}" height="${h}"></canvas>
       <script>
         const c = document.getElementById('c');
         const x = c.getContext('2d');
         x.fillStyle = '#94a3b8';
         x.fillRect(0, 0, ${w}, ${h});
         x.fillStyle = '#2563eb';
         x.fillRect(40, 40, 120, 80);
         x.fillStyle = '#f59e0b';
         x.beginPath(); x.arc(220, 140, 50, 0, Math.PI * 2); x.fill();
       </script>`,
      { waitUntil: 'domcontentloaded' }
    );
    return await tmp.locator('#c').screenshot({ type: 'png' });
  } finally {
    await tmp.close();
  }
}

export async function makeWebmBuffer(page: Page): Promise<Buffer | null> {
  const tmp = await page.context().newPage();
  try {
    const b64 = await tmp.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 320;
      c.height = 180;
      document.body.appendChild(c);
      const ctx = c.getContext('2d')!;
      const stream = c.captureStream(15);
      const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
      const chunks: BlobPart[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      const done = new Promise<Blob>((resolve) => {
        rec.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
      });
      rec.start(50);
      let i = 0;
      await new Promise<void>((resolve) => {
        const id = setInterval(() => {
          ctx.fillStyle = i % 2 ? '#1d4ed8' : '#ea580c';
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.fillStyle = '#fff';
          ctx.font = '28px sans-serif';
          ctx.fillText(`f${i}`, 20, 40);
          i += 1;
          if (i >= 12) {
            clearInterval(id);
            rec.stop();
            resolve();
          }
        }, 80);
      });
      const blob = await done;
      const buf = await blob.arrayBuffer();
      let s = '';
      const bytes = new Uint8Array(buf);
      for (let j = 0; j < bytes.length; j += 1) s += String.fromCharCode(bytes[j]!);
      return btoa(s);
    });
    if (!b64) return null;
    return Buffer.from(b64, 'base64');
  } catch {
    return null;
  } finally {
    await tmp.close();
  }
}

export async function uploadPngToCanvas(page: Page, filePrefix = 'product-mark') {
  const buf = await makePngBuffer(page);
  const input = page.locator('input[type="file"][accept*="image"]').first();
  await expect(input).toBeAttached({ timeout: 10_000 });
  await input.setInputFiles({
    name: `${filePrefix}-${Date.now()}.png`,
    mimeType: 'image/png',
    buffer: buf,
  });
  await expect(page.getByText(/^图片$|^Image$|上传中|Uploading/i).first()).toBeAttached({
    timeout: 30_000,
  });
  await sleep(1_200);
  const mark = page.getByRole('button', { name: /^标记$|^Mark$/i }).first();
  if (!(await mark.isVisible({ timeout: 8_000 }).catch(() => false))) {
    const stage = page.locator('[data-rcb-canvas="1"]').first();
    const box = await stage.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.45);
      await sleep(400);
    }
  }
  await expect(mark).toBeVisible({ timeout: 25_000 });
  return mark;
}

export async function uploadPng(page: Page, filePrefix = 'product-tools') {
  const buf = await makePngBuffer(page);
  const input = page.locator('input[type="file"][accept*="image"]').first();
  await expect(input).toBeAttached({ timeout: 10_000 });
  await input.setInputFiles({
    name: `${filePrefix}-${Date.now()}.png`,
    mimeType: 'image/png',
    buffer: buf,
  });
  await sleep(1_500);
  const mark = page.getByRole('button', { name: /^标记$|^Mark$/i }).first();
  if (!(await mark.isVisible({ timeout: 8_000 }).catch(() => false))) {
    const stage = page.locator('[data-rcb-canvas="1"]').first();
    const box = await stage.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.45);
      await sleep(400);
    }
  }
  await expect(page.getByRole('button', { name: /^标记$|^Mark$/i }).first()).toBeVisible({
    timeout: 25_000,
  });
}
