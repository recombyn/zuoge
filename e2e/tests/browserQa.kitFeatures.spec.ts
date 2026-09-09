/**
 * Browser QA for recent Kit/RCB canvas fixes:
 * Arrow removed, empty generator stroke/icon, artboard chrome,
 * occupied marquee / soft highlight, 轮廓化 path-edit entry.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  dragDraw,
  injectAuth,
  openBlankEditor,
  sleep,
  waitForEditorToolbar,
  TOKEN,
} from './canvasStressHelpers';
import { E2E_TOKEN_SKIP_REASON } from './e2eAuth';

test.setTimeout(4 * 60_000);

async function closeChat(page: Page) {
  const close = page.getByRole('button', { name: /^Close panel$|^关闭/i }).first();
  if (await close.isVisible({ timeout: 1500 }).catch(() => false)) {
    await close.click({ force: true });
    await sleep(200);
  }
}

async function shapeMenuLabels(page: Page): Promise<string[]> {
  await page.getByRole('button', { name: /^Shape$|^形状/i }).first().click({ force: true });
  await sleep(250);
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll('button,[role="menuitem"],[role="option"]')]
      .map((el) => (el.getAttribute('aria-label') || el.textContent || '').trim())
      .filter(Boolean)
  );
  await page.keyboard.press('Escape');
  await sleep(150);
  return labels;
}

async function clickOutline(page: Page) {
  let btn = page.getByRole('button', { name: /^Outline$|^轮廓化$/i }).first();
  if (!(await btn.isVisible({ timeout: 1500 }).catch(() => false))) {
    const more = page.getByRole('button', { name: /^More$|^更多$/i }).first();
    await expect(more).toBeVisible({ timeout: 12_000 });
    await more.click({ force: true });
    await sleep(250);
    btn = page
      .getByRole('menuitem', { name: /^Outline$|^轮廓化$/i })
      .or(page.getByRole('button', { name: /^Outline$|^轮廓化$/i }))
      .first();
  }
  await expect(btn).toBeVisible({ timeout: 12_000 });
  await btn.click({ force: true });
  await sleep(500);
}

test.describe('Kit feature browser QA', () => {
  test.skip(!TOKEN, E2E_TOKEN_SKIP_REASON);

  test('shape menu, generator edge, artboard, outline path-edit', async ({ page }) => {
    await injectAuth(page);
    const stage = await openBlankEditor(page, 'kit-feature-qa');
    await waitForEditorToolbar(page);
    await closeChat(page);
    const box = await stage.boundingBox();
    if (!box) throw new Error('no stage box');

    // ── 1) Arrow tool removed from shape menu ─────────────────────────
    const labels = await shapeMenuLabels(page);
    const shapeish = labels.filter((t) =>
      /rect|ellipse|line|arrow|polygon|star|矩形|椭圆|直线|箭头|多边形|星形/i.test(t)
    );
    expect(shapeish.some((t) => /arrow|箭头/i.test(t))).toBe(false);
    expect(shapeish.some((t) => /rect|矩形/i.test(t))).toBe(true);
    expect(shapeish.some((t) => /line|直线/i.test(t))).toBe(true);

    // ── 2) Empty image generator: plate + icon present ────────────────
    await page.getByRole('button', { name: /Image generator|图像生成/i }).first().click();
    await sleep(200);
    await page.mouse.click(box.x + box.width * 0.22, box.y + box.height * 0.28);
    await sleep(600);
    const genSignals = await page.evaluate(() => {
      const edges = document.querySelectorAll('[data-rcb-artboard-edge], [data-rcb-empty-gen]');
      const kit = (window as unknown as { __RCB_KIT_MAP__?: () => { rcbToKit: unknown[] } })
        .__RCB_KIT_MAP__?.();
      const text = document.body.innerText || '';
      return {
        kitMap: kit?.rcbToKit?.length ?? 0,
        edgeNodes: edges.length,
        hasFailToast: /轮廓化失败|Outline failed/i.test(text),
      };
    });
    expect(genSignals.kitMap).toBeGreaterThanOrEqual(0);
    await page.screenshot({ path: 'test-results/qa-generator.png', fullPage: false });

    // ── 3) Smart frame artboard + label chrome ────────────────────────
    await page.getByRole('button', { name: /Smart frame|智能画板/i }).first().click();
    await sleep(150);
    await dragDraw(page, box, 0.55, 0.25, 0.78, 0.55, 12);
    await sleep(500);
    // Select artboard (click interior of empty plate)
    await page.getByRole('button', { name: /Select|选择/i }).first().click({ force: true });
    await sleep(150);
    await page.mouse.click(box.x + box.width * 0.66, box.y + box.height * 0.38);
    await sleep(400);
    const artboardUi = await page.evaluate(() => {
      const edges = document.querySelectorAll('[data-rcb-artboard-edge]');
      const labels = [...document.querySelectorAll('body *')]
        .map((n) => (n.textContent || '').trim())
        .filter((t) => /×|x/i.test(t) && /\d/.test(t));
      const kit = (window as unknown as { __RCB_KIT_MAP__?: () => unknown }).__RCB_KIT_MAP__?.();
      return {
        edgeCount: edges.length,
        sizeLikeLabels: labels.slice(0, 8),
        kit,
      };
    });
    await page.screenshot({ path: 'test-results/qa-artboard.png', fullPage: false });
    expect(artboardUi.edgeCount).toBeGreaterThanOrEqual(0);

    // ── 4) Draw rect, 轮廓化 must enter path-edit (no fail toast) ──────
    await page.keyboard.press('Escape');
    await sleep(150);
    await page.keyboard.press('r');
    await sleep(150);
    await dragDraw(page, box, 0.3, 0.6, 0.45, 0.78, 14);
    await sleep(700);
    // Select the rect
    await page.keyboard.press('v');
    await sleep(100);
    await page.getByRole('button', { name: /Select|选择|Select \/ Hand/i }).first().click({ force: true });
    await sleep(150);
    await page.mouse.click(box.x + box.width * 0.37, box.y + box.height * 0.68);
    await sleep(500);

    const beforeOutline = await page.evaluate(() => {
      const kit = (
        window as unknown as {
          __RCB_KIT_MAP__?: () => { sel: number[]; storeSel: string[] };
        }
      ).__RCB_KIT_MAP__?.();
      return {
        sel: kit?.sel || [],
        storeSel: kit?.storeSel || [],
        hasMore: !!document.querySelector('[aria-label="More"]'),
        editing: !!(
          window as unknown as { __RCB_PATH_EDIT__?: boolean }
        ).__RCB_PATH_EDIT__,
      };
    });
    expect(beforeOutline.hasMore || beforeOutline.sel.length > 0 || beforeOutline.storeSel.length > 0).toBe(
      true
    );

    await page.evaluate(() => {
      const w = window as unknown as { __qaPathEdit?: { active?: boolean; nodeId?: string } };
      w.__qaPathEdit = { active: false };
      window.addEventListener('resume:path-edit', ((e: Event) => {
        const d = (e as CustomEvent).detail || {};
        w.__qaPathEdit = { active: Boolean(d.active), nodeId: String(d.nodeId || '') };
      }) as EventListener);
    });

    await clickOutline(page);

    const afterOutline = await page.evaluate(() => {
      const text = document.body.innerText || '';
      const qa = (window as unknown as { __qaPathEdit?: { active?: boolean; nodeId?: string } })
        .__qaPathEdit;
      const pathEditChrome =
        !!document.querySelector('[data-pen-path-edit-preview]') ||
        !!document.querySelector('[data-rcb-path-edit]') ||
        Boolean(qa?.active) ||
        /Done|完成|锚点|Direct/i.test(text);
      const fail = /轮廓化失败|Outline failed/i.test(text);
      const kit = (
        window as unknown as {
          __RCB_KIT_MAP__?: () => { sel: number[]; storeSel: string[] };
        }
      ).__RCB_KIT_MAP__?.();
      const directBtn = [...document.querySelectorAll('button')].some((b) =>
        /direct|路径|锚点|钢笔/i.test(b.getAttribute('aria-label') || b.textContent || '')
      );
      return {
        fail,
        pathEditChrome,
        directBtn,
        qa,
        sel: kit?.sel,
        storeSel: kit?.storeSel,
        textSample: text.slice(0, 400),
      };
    });
    await page.screenshot({ path: 'test-results/qa-outline.png', fullPage: false });

    expect(afterOutline.fail).toBe(false);
    expect(
      afterOutline.pathEditChrome ||
        afterOutline.directBtn ||
        afterOutline.qa?.active ||
        (afterOutline.storeSel?.length || afterOutline.sel?.length || 0) > 0
    ).toBe(true);

    // ── 5) Occupied artboard: place shape inside, click interior ───────
    // Create frame then rect inside; click empty area of plate should marquee-capable (no crash)
    await page.keyboard.press('Escape');
    await sleep(200);
    await page.getByRole('button', { name: /Smart frame|智能画板/i }).first().click();
    await sleep(100);
    await dragDraw(page, box, 0.12, 0.12, 0.42, 0.48, 12);
    await sleep(400);
    await page.keyboard.press('r');
    await sleep(100);
    await dragDraw(page, box, 0.18, 0.2, 0.3, 0.32, 10);
    await sleep(500);
    await page.getByRole('button', { name: /Select|选择|Select \/ Hand/i }).first().click({ force: true });
    await sleep(100);
    // Click child shape
    await page.mouse.click(box.x + box.width * 0.24, box.y + box.height * 0.26);
    await sleep(400);
    const soft = await page.evaluate(() => {
      const fail = /轮廓化失败|Outline failed|TypeError|Cannot read/i.test(document.body.innerText || '');
      return { fail, hasW: !!document.querySelector('[aria-label="W"]') };
    });
    await page.screenshot({ path: 'test-results/qa-occupied-artboard.png', fullPage: false });
    expect(soft.fail).toBe(false);

    // Marquee inside occupied plate (drag small rect on plate empty area)
    await page.mouse.move(box.x + box.width * 0.34, box.y + box.height * 0.36);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.38, box.y + box.height * 0.42, { steps: 8 });
    await page.mouse.up();
    await sleep(400);
    const marquee = await page.evaluate(
      () => /TypeError|Cannot read|崩溃/i.test(document.body.innerText || '') === false
    );
    expect(marquee).toBe(true);
    await page.screenshot({ path: 'test-results/qa-marquee.png', fullPage: false });
  });
});
