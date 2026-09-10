/**
 * One-shot browser probe: rect / pencil / pen / artboard after RCB draw re-enable.
 * Uses local auth seed (no live API required for createNew empty editor).
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page, type Locator } from '@playwright/test';
import { resolveE2EToken } from './e2eAuth';

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, '.tmp-e2e-rcb-draw');
const TOKEN = resolveE2EToken(ROOT) || 'local-probe-token';

test.setTimeout(3 * 60_000);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function seedLocalAuth(page: Page) {
  await page.context().addInitScript((tok) => {
    localStorage.setItem('recombine-auth-token-v1', tok);
    localStorage.setItem(
      'recombyn-auth-v1',
      JSON.stringify({
        user: {
          id: 'e2e-user',
          email: 'e2e@local.test',
          name: 'E2E Probe',
          provider: 'email',
          role: 'admin',
        },
      })
    );
    localStorage.setItem('recombyn-editor-tour-v3', '1');
    localStorage.setItem('recombyn-editor-tour-v3:user_super_admin', '1');
    localStorage.setItem('recombyn-editor-tour-v3:e2e-user', '1');
  }, TOKEN);
}

async function dismissBlockingDialogs(page: Page) {
  for (let i = 0; i < 12; i += 1) {
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

async function sceneStats(page: Page) {
  return page.evaluate(() => {
    const doc = (window as any).__RCB_E2E_SCENE_DOC__ as
      | { nodes?: unknown[]; frames?: unknown[] }
      | undefined
      | null;
    const reduxNodes = Array.isArray(doc?.nodes) ? doc!.nodes!.length : -1;
    const reduxFrames = Array.isArray(doc?.frames) ? doc!.frames!.length : -1;

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
    const shapesMount = document.querySelector('[data-rcb-shapes-mount="1"]');
    const shapeChildren = shapesMount ? shapesMount.childElementCount : -1;
    const inkPaths = document.querySelectorAll(
      '[data-rcb-shapes-mount="1"] path, [data-rcb-shapes-mount="1"] rect, [data-rcb-shapes-mount="1"] g[data-node-id]'
    ).length;
    const nodeHosts = document.querySelectorAll('[data-node-id], [data-rcb-node-id]').length;
    const framePlates = document.querySelectorAll(
      '[data-rcb-frame-id], [data-artboard-id], [data-frame-id]'
    ).length;
    const penPreview = document.querySelectorAll(
      '[data-pen-draw-preview], [data-pen-snap-tip]'
    ).length;
    const wBox = document.querySelector(
      '[role="textbox"][name="W"], input[aria-label="W"], [aria-label="W"]'
    ) as HTMLInputElement | null;
    const wVal = wBox ? Number((wBox as any).value ?? wBox.textContent ?? 0) : 0;
    const toolbarShape = Number.isFinite(wVal) && wVal > 0 ? 1 : 0;
    const inkSignal = Math.max(idle, visible, fullHost, hosts, svgNodes, toolbarShape, 0);
    const kit = document.querySelector('[data-rcb-kit-surface="1"]') as HTMLElement | null;
    const kitPe = kit ? getComputedStyle(kit).pointerEvents : null;
    const kitInteractive = kit?.getAttribute('style') || '';
    const canvas = Boolean(document.querySelector('[data-rcb-canvas="1"]'));
    const activeToolBtn =
      document.querySelector('[data-editor-tool][aria-pressed="true"], [data-tool][aria-pressed="true"]')
        ?.getAttribute('aria-label') ||
      document.querySelector('.bg-black [aria-label], [data-state="on"]')?.getAttribute('aria-label') ||
      '';
    const bodyText = (document.body?.innerText || '').slice(0, 600);
    const providerErr = /Provider|ErrorBoundary|Something went wrong/i.test(bodyText)
      ? bodyText.slice(0, 400)
      : '';
    return {
      reduxNodes,
      reduxFrames,
      idle,
      visible,
      fullHost,
      hosts,
      svgNodes,
      inkSignal,
      toolbarShape,
      wVal,
      shapeChildren,
      inkPaths,
      nodeHosts,
      framePlates,
      penPreview,
      kitPe,
      kitInteractive,
      canvas,
      activeToolBtn,
      url: location.href,
      title: document.title,
      providerErr,
    };
  });
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(OUT, { recursive: true });
  const p = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: p, fullPage: false });
  return p;
}

async function openCreateNewEditor(page: Page): Promise<Locator> {
  await page.goto('/editor?createNew=1', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await sleep(800);
  await dismissBlockingDialogs(page);
  // Login redirect?
  if (/\/login/i.test(page.url())) {
    throw new Error(`auth blocked → ${page.url()}`);
  }
  const stage = page.locator('[data-rcb-canvas="1"], [data-canvas-stage="1"]').first();
  await expect(stage).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press('Escape');
  await sleep(200);
  return stage;
}

async function focusStage(page: Page, stage: Locator) {
  const box = await stage.boundingBox();
  if (!box) throw new Error('no stage box');
  await page.mouse.click(box.x + Math.min(120, box.width * 0.2), box.y + Math.min(120, box.height * 0.2));
  await sleep(120);
  return box;
}

test.describe('RCB draw tools probe', () => {
  test.beforeEach(async ({ page }) => {
    await seedLocalAuth(page);
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        // eslint-disable-next-line no-console
        console.log('[console.error]', msg.text());
      }
    });
    page.on('pageerror', (err) => {
      // eslint-disable-next-line no-console
      console.log('[pageerror]', err.message);
    });
  });

  test('rect pencil pen artboard', async ({ page }) => {
    const report: Record<string, unknown> = {
      blockers: [] as string[],
      tools: {} as Record<string, unknown>,
      screenshots: [] as string[],
      kitPointerEvents: null as string | null,
      consoleNotes: [] as string[],
    };

    let stage: Locator;
    try {
      stage = await openCreateNewEditor(page);
    } catch (e) {
      (report.blockers as string[]).push(String(e));
      report.homeProbe = await page.goto('/home', { waitUntil: 'domcontentloaded' }).then(async () => {
        await shot(page, '00-home-or-login');
        return { url: page.url(), text: (await page.locator('body').innerText()).slice(0, 500) };
      });
      fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
      throw e;
    }

    const box = await focusStage(page, stage);
    const before = await sceneStats(page);
    report.before = before;
    report.kitPointerEvents = before.kitPe;
    (report.screenshots as string[]).push(await shot(page, '01-editor-ready'));

    const grew = (a: any, b: any) =>
      (a.inkSignal ?? 0) > (b.inkSignal ?? 0) ||
      (a.idle ?? 0) > (b.idle ?? 0) ||
      (a.reduxNodes >= 0 && b.reduxNodes >= 0 && a.reduxNodes > b.reduxNodes) ||
      (a.framePlates ?? 0) > (b.framePlates ?? 0) ||
      (a.reduxFrames >= 0 && b.reduxFrames >= 0 && a.reduxFrames > b.reduxFrames) ||
      ((a.wVal ?? 0) > 0 && (b.wVal ?? 0) === 0);

    // --- RECT (R) ---
    await page.keyboard.press('r');
    await sleep(200);
    {
      const x0 = box.x + box.width * 0.35;
      const y0 = box.y + box.height * 0.35;
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      await page.mouse.move(x0 + 140, y0 + 90, { steps: 12 });
      await page.mouse.up();
      await sleep(500);
    }
    await page.keyboard.press('v');
    await sleep(250);
    const afterRect = await sceneStats(page);
    const rectPass = grew(afterRect, before) || afterRect.inkSignal >= 1 || afterRect.wVal > 0;
    (report.tools as any).rect = { pass: rectPass, stats: afterRect };
    (report.screenshots as string[]).push(await shot(page, '02-after-rect'));

    // --- PENCIL (Shift+P) ---
    await page.keyboard.press('Shift+P');
    await sleep(250);
    {
      const x0 = box.x + box.width * 0.2;
      const y0 = box.y + box.height * 0.62;
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      for (let i = 1; i <= 16; i += 1) {
        await page.mouse.move(
          x0 + i * 14,
          y0 + Math.sin(i * 0.7) * 28,
          { steps: 3 }
        );
      }
      await page.mouse.up();
      await sleep(600);
    }
    await page.keyboard.press('v');
    await sleep(300);
    const afterPencil = await sceneStats(page);
    const pencilPass = grew(afterPencil, afterRect) || afterPencil.inkSignal > afterRect.inkSignal;
    (report.tools as any).pencil = { pass: pencilPass, stats: afterPencil };
    (report.screenshots as string[]).push(await shot(page, '03-after-pencil'));

    // --- PEN (P) ---
    await page.keyboard.press('Escape');
    await sleep(100);
    await page.keyboard.press('p');
    await sleep(200);
    {
      const x0 = box.x + box.width * 0.28;
      const y0 = box.y + box.height * 0.55;
      await page.mouse.click(x0, y0);
      await sleep(120);
      await page.mouse.click(x0 + 80, y0 - 40);
      await sleep(120);
      await page.mouse.click(x0 + 140, y0 + 20);
      await sleep(120);
      await page.keyboard.press('Enter');
      await sleep(400);
    }
    await page.keyboard.press('v');
    await sleep(250);
    const afterPen = await sceneStats(page);
    const penPass = grew(afterPen, afterPencil) || afterPen.inkSignal > afterPencil.inkSignal;
    (report.tools as any).pen = { pass: penPass, stats: afterPen };
    (report.screenshots as string[]).push(await shot(page, '04-after-pen'));

    // --- ARTBOARD / FRAME (F) ---
    await page.keyboard.press('Escape');
    await sleep(100);
    await page.keyboard.press('f');
    await sleep(200);
    {
      const x0 = box.x + box.width * 0.12;
      const y0 = box.y + box.height * 0.12;
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      await page.mouse.move(x0 + 240, y0 + 180, { steps: 14 });
      await page.mouse.up();
      await sleep(500);
    }
    await page.keyboard.press('v');
    await sleep(250);
    const afterFrame = await sceneStats(page);
    const framePass =
      grew(afterFrame, afterPen) ||
      afterFrame.reduxFrames > Math.max(0, afterPen.reduxFrames) ||
      afterFrame.framePlates > afterPen.framePlates;
    (report.tools as any).artboard = { pass: framePass, stats: afterFrame };
    (report.screenshots as string[]).push(await shot(page, '05-after-artboard'));

    report.afterAll = afterFrame;
    report.kitPointerEvents = afterFrame.kitPe ?? before.kitPe;
    report.kitPass = report.kitPointerEvents === 'none';
    report.kitPresent = Boolean(afterFrame.kitPe || before.kitPe);

    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    // eslint-disable-next-line no-console
    console.log('[rcb-draw-probe]', JSON.stringify(report, null, 2));

    // Soft assertions so report.json is always the source of truth for the parent agent.
    expect.soft(before.canvas || afterFrame.canvas, 'canvas mounted').toBe(true);
    if (report.kitPresent) {
      expect.soft(report.kitPass, 'kit pointer-events:none').toBe(true);
    }
    expect.soft((report.tools as any).rect.pass, 'rect').toBe(true);
    expect.soft((report.tools as any).pencil.pass, 'pencil').toBe(true);
    expect.soft((report.tools as any).pen.pass, 'pen').toBe(true);
    expect.soft((report.tools as any).artboard.pass, 'artboard').toBe(true);
  });
});
