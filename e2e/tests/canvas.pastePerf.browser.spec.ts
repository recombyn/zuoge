/**
 * Browser paste/select at scale across node kinds (rects / text / media / generators).
 *
 * Env:
 *   PASTE_PERF_SEED=5000
 *   PASTE_PERF_CLIP=64
 *   PASTE_PERF_PASTES=4
 *   PASTE_PERF_KIND=rect|text|image|video|audio|imageGen|videoGen|audioGen|mixed|all
 *   (default mixed — set all for the full matrix)
 */
import { test, expect, type Page } from '@playwright/test';
import { E2E_TOKEN_SKIP_REASON } from './e2eAuth';
import {
  TOKEN,
  injectAuth,
  openBlankEditor,
  focusStage,
  sleep,
  stageIdleCount,
} from './canvasStressHelpers';

type PastePerfReport = {
  kind?: string;
  label?: string;
  totalMs: number;
  slowest?: { name: string; ms: number };
  stages?: Array<{ name: string; ms: number; detail?: Record<string, unknown> }>;
};

type StressKind =
  | 'rect'
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'imageGen'
  | 'videoGen'
  | 'audioGen'
  | 'mixed';

const ALL_KINDS: StressKind[] = [
  'rect',
  'text',
  'image',
  'video',
  'audio',
  'imageGen',
  'videoGen',
  'audioGen',
  'mixed',
];

const SEED = Math.max(150, Number(process.env.PASTE_PERF_SEED || 5_000) || 5_000);
const CLIP = Math.max(8, Number(process.env.PASTE_PERF_CLIP || 64) || 64);
const PASTES = Math.max(2, Number(process.env.PASTE_PERF_PASTES || 4) || 4);
const KIND_RAW = String(process.env.PASTE_PERF_KIND || 'mixed').trim();

function resolveKinds(): StressKind[] {
  const key = KIND_RAW.toLowerCase();
  if (key === 'all') return ALL_KINDS;
  const match = ALL_KINDS.find((k) => k.toLowerCase() === key);
  if (match) return [match];
  throw new Error(`PASTE_PERF_KIND=${KIND_RAW} not in ${ALL_KINDS.join('|')}|all`);
}

const KINDS = resolveKinds();

/** Frame-hosted grid — same inject path as canvas density browser specs. */
async function injectStressNodes(page: Page, n: number, kind: StressKind) {
  return page.evaluate(
    async ({ n: count, kind: stressKind }) => {
      const editorMod = await import('/src/store/modules/editor.ts');
      const { setDocument } = editorMod as { setDocument: (doc: unknown) => void };
      const cols = Math.ceil(Math.sqrt(count));
      const cell = 28;
      const boardW = cols * cell + 64;
      const boardH = Math.ceil(count / cols) * cell + 64;
      const children: string[] = [];
      const deltaSetLike: Record<string, unknown> = {
        ROOT: {
          id: 'ROOT',
          key: 'entry',
          children,
          attrs: {},
          x: 0,
          y: 0,
          width: 0,
          height: 0,
        },
      };

      // Inline node factory — page.evaluate cannot close over Node helpers.
      function nodeFor(id: string, i: number): Record<string, unknown> {
        const x = (i % cols) * cell;
        const y = Math.floor(i / cols) * cell;
        const pick =
          stressKind === 'mixed'
            ? (['rect', 'text', 'image', 'video', 'audio', 'imageGen', 'videoGen', 'audioGen'] as const)[
                i % 8
              ]!
            : stressKind;
        if (pick === 'text') {
          return {
            id,
            key: 'text',
            x,
            y,
            z: 0,
            width: 72,
            height: 22,
            attrs: {
              fontSize: 12,
              frameId: 'board',
              frameOrder: i,
              ORIGIN_DATA: JSON.stringify([{ children: [{ text: `T${i}` }] }]),
            },
            children: [],
          };
        }
        if (pick === 'image' || pick === 'imageGen') {
          return {
            id,
            key: 'image',
            x,
            y,
            z: 0,
            width: 40,
            height: 40,
            attrs: {
              src: '',
              name: pick === 'imageGen' ? 'Image Generator' : 'Image',
              assetKind: 'image',
              mode: 'FIT',
              frameId: 'board',
              frameOrder: i,
              ...(pick === 'imageGen' ? { imageGenerator: true } : {}),
            },
            children: [],
          };
        }
        if (pick === 'video' || pick === 'videoGen') {
          return {
            id,
            key: 'video',
            x,
            y,
            z: 0,
            width: 48,
            height: 28,
            attrs: {
              src: '',
              poster: '',
              name: pick === 'videoGen' ? 'Video Generator' : 'Video',
              assetKind: 'video',
              mode: 'FIT',
              frameId: 'board',
              frameOrder: i,
              ...(pick === 'videoGen' ? { videoGenerator: true } : {}),
            },
            children: [],
          };
        }
        if (pick === 'audio' || pick === 'audioGen') {
          return {
            id,
            key: 'audio',
            x,
            y,
            z: 0,
            width: 56,
            height: 32,
            attrs: {
              src: '',
              name: pick === 'audioGen' ? 'Audio Generator' : 'Audio',
              assetKind: 'audio',
              mode: 'FIT',
              'fill-color': 'var(--gen-empty)',
              frameId: 'board',
              frameOrder: i,
              ...(pick === 'audioGen' ? { audioGenerator: true } : {}),
            },
            children: [],
          };
        }
        return {
          id,
          key: 'shape',
          x,
          y,
          z: 0,
          width: 20,
          height: 20,
          attrs: {
            shapeType: 'rect',
            'fill-color': '#ffffff',
            'border-color': '#c62828',
            'border-width': 1,
            frameId: 'board',
            frameOrder: i,
          },
          children: [],
        };
      }

      for (let i = 0; i < count; i += 1) {
        const id = `s${i}`;
        children.push(id);
        deltaSetLike[id] = nodeFor(id, i);
      }
      const t0 = performance.now();
      setDocument({
        x: 0,
        y: 0,
        width: boardW,
        height: boardH,
        backgroundColor: '',
        frames: [
          {
            id: 'board',
            name: 'Board',
            x: 0,
            y: 0,
            width: boardW,
            height: boardH,
            clipContent: true,
            kind: 'artboard',
          },
        ],
        activeFrameId: 'board',
        pages: [{ id: 'page1', name: 'Page 1', children: children.slice() }],
        activePageId: 'page1',
        deltaSetLike,
        stackOrder: ['frame:board'],
      });
      return {
        setDocumentMs: Number((performance.now() - t0).toFixed(1)),
        count,
        kind: stressKind,
      };
    },
    { n, kind }
  );
}

async function pasteClipViaStore(page: Page, clipIds: string[], offset: number) {
  return page.evaluate(
    async ({ ids, offset: nudge }) => {
      const editorMod = await import('/src/store/modules/editor.ts');
      const { commitPastedDocument } = editorMod as {
        commitPastedDocument: (p: {
          document: unknown;
          patchedNodeIds: string[];
          addedFrameIds?: string[];
          selectedNodeIds: string[];
          selectedFrameIds: string[];
        }) => void;
      };
      const clipMod = await import('/src/components/rcb/scene/document/sceneClipboard.ts');
      const {
        snapshotNodesForClipboard,
        pasteClipboardIntoDocument,
        selectionAfterClipboardPaste,
      } = clipMod as {
        snapshotNodesForClipboard: (
          doc: unknown,
          ids: string[]
        ) => { nodes: unknown[] } | null;
        pasteClipboardIntoDocument: (
          doc: unknown,
          clip: unknown,
          opts: { offsetX: number; offsetY: number; trusted: boolean }
        ) => { document: unknown; ids: string[]; frameIds: string[] };
        selectionAfterClipboardPaste: (
          doc: unknown,
          ids: string[],
          frames: string[]
        ) => { nodeIds: string[]; frameIds: string[] };
      };
      const eventsMod = await import('/src/components/editor/sceneEvents.ts');
      const { beginPastePerf, markPastePerf, endPastePerfAfterPaint } = eventsMod as {
        beginPastePerf: (label: string) => void;
        markPastePerf: (name: string, detail?: Record<string, unknown>) => void;
        endPastePerfAfterPaint: () => void;
      };

      const idleDoc = (window as Window & { __RCB_E2E_SCENE_DOC__?: unknown }).__RCB_E2E_SCENE_DOC__;
      if (!idleDoc) throw new Error('no __RCB_E2E_SCENE_DOC__ — inject/sync first');
      const liveN = Object.keys(
        (idleDoc as { deltaSetLike?: Record<string, unknown> }).deltaSetLike || {}
      ).length;
      const clip = snapshotNodesForClipboard(idleDoc, ids);
      if (!clip?.nodes?.length) throw new Error('empty clipboard snapshot');
      beginPastePerf(`paste clip=${clip.nodes.length} live≈${liveN}`);
      const tPaste0 = performance.now();
      const { document: next, ids: newIds, frameIds: newFrameIds } = pasteClipboardIntoDocument(
        idleDoc,
        clip,
        { offsetX: nudge, offsetY: nudge, trusted: true }
      );
      const pasteMs = Number((performance.now() - tPaste0).toFixed(1));
      markPastePerf('pasteClipboardIntoDocument', {
        newIds: newIds.length,
        newFrames: newFrameIds.length,
        nextNodes: Object.keys((next as { deltaSetLike?: object }).deltaSetLike || {}).length,
        pasteMs,
      });
      if (!newIds.length) {
        endPastePerfAfterPaint();
        return { ok: false, newIds: 0, liveBefore: liveN, pasteMs };
      }
      const sel = selectionAfterClipboardPaste(next, newIds, newFrameIds);
      const deferSelect = newIds.length + newFrameIds.length >= 24;
      const tCommit0 = performance.now();
      commitPastedDocument({
        document: next,
        patchedNodeIds: newIds,
        addedFrameIds: newFrameIds,
        selectedNodeIds: deferSelect ? [] : sel.nodeIds,
        selectedFrameIds: deferSelect ? [] : sel.frameIds,
      });
      const commitMs = Number((performance.now() - tCommit0).toFixed(1));
      markPastePerf('commitPastedDocument', {
        patched: newIds.length,
        selectedNodes: deferSelect ? 0 : sel.nodeIds.length,
        selectedFrames: deferSelect ? 0 : sel.frameIds.length,
        deferSelect,
        commitMs,
      });
      endPastePerfAfterPaint();
      return { ok: true, newIds: newIds.length, liveBefore: liveN, pasteMs, commitMs };
    },
    { ids: clipIds, offset }
  );
}

function summarizePaste(r: PastePerfReport, idx: number) {
  const kitSync = r.stages?.find(
    (s) => s.name === 'reveal-kit' || s.name === 'kit-sync' || s.name === 'idle-paint'
  );
  const layout = r.stages?.find((s) => s.name === 'react-layout-enter');
  const live = Number(String(r.label || '').match(/live≈(\d+)/)?.[1] || 0);
  const clip = Number(String(r.label || '').match(/clip=(\d+)/)?.[1] || 0);
  return {
    i: idx + 1,
    label: r.label,
    live,
    clip,
    totalMs: r.totalMs,
    layoutMs: layout?.ms ?? null,
    kitBodyMs: (kitSync?.detail?.bodyMs as number | undefined) ?? kitSync?.ms ?? null,
    kitBranch: (kitSync?.detail?.branch as string | undefined) ?? null,
    insertMs: (kitSync?.detail?.insertMs as number | undefined) ?? null,
    spatialMs: (kitSync?.detail?.spatialMs as number | undefined) ?? null,
    bufCount: (kitSync?.detail?.bufCount as number | undefined) ?? null,
    missing: (kitSync?.detail?.missing as number | undefined) ?? null,
    slowest: r.slowest?.name,
    stageNames: (r.stages || []).map((s) => `${s.name}:${s.ms}`).slice(0, 16),
  };
}

async function readLastPaste(page: Page): Promise<PastePerfReport | null> {
  return page.evaluate(() => {
    const w = window as Window & { __RCB_PASTE_PERF_LAST?: PastePerfReport };
    const last = w.__RCB_PASTE_PERF_LAST;
    w.__RCB_PASTE_PERF_LAST = undefined;
    return last || null;
  });
}

async function readLastSelect(page: Page): Promise<PastePerfReport | null> {
  return page.evaluate(() => {
    return (
      (window as Window & { __RCB_SELECT_PERF_LAST?: PastePerfReport }).__RCB_SELECT_PERF_LAST ||
      null
    );
  });
}

test.describe('canvas paste perf (browser)', () => {
  test.describe.configure({ timeout: 8 * 60_000 });
  test.skip(!TOKEN, E2E_TOKEN_SKIP_REASON);

  test.beforeEach(async ({ page }) => {
    await injectAuth(page);
  });

  for (const kind of KINDS) {
    test(`kind=${kind} at ${SEED} nodes, paste clip=${CLIP} x${PASTES}`, async ({ page }) => {
      const tag = `paste-perf-${kind}`;
      // eslint-disable-next-line no-console
      console.log(`[${tag}] open editor…`);
      const stage = await openBlankEditor(page, tag);
      if (!page.url().includes('collab=0')) {
        const next = new URL(page.url());
        next.searchParams.set('collab', '0');
        await page.goto(next.toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await expect(
          page.locator('[data-rcb-canvas="1"], [data-canvas-stage="1"]').first()
        ).toBeVisible({ timeout: 45_000 });
      }
      const box = await focusStage(page, stage, 0.55);

      await page.evaluate(() => {
        (window as Window & { __RCB_PASTE_PERF?: boolean }).__RCB_PASTE_PERF = true;
        (window as Window & { __RCB_SELECT_PERF?: boolean }).__RCB_SELECT_PERF = true;
        (window as Window & { __RCB_SKIP_PROJECT_FLUSH__?: boolean }).__RCB_SKIP_PROJECT_FLUSH__ =
          true;
      });

      // eslint-disable-next-line no-console
      console.log(`[${tag}] inject ${SEED}…`);
      const seeded = await injectStressNodes(page, SEED, kind);
      // eslint-disable-next-line no-console
      console.log(`[${tag}] injected`, seeded);
      await expect
        .poll(async () => stageIdleCount(page), { timeout: 90_000, intervals: [300, 600, 1200] })
        .toBeGreaterThan(0);

      await focusStage(page, stage, 0.55);
      await page.mouse.click(box.x + box.width * 0.05, box.y + box.height * 0.05);
      await sleep(150);
      await page.waitForFunction(
        () =>
          Boolean(
            (window as Window & { __RCB_SELECT_PERF_LAST?: PastePerfReport }).__RCB_SELECT_PERF_LAST
          ),
        undefined,
        { timeout: 30_000 }
      );
      const selectBlankAtSeed = await readLastSelect(page);

      const clipIds = Array.from({ length: CLIP }, (_, i) => `s${i}`);
      // eslint-disable-next-line no-console
      console.log(`[${tag}] paste clip=${CLIP} via store x${PASTES}…`);

      const pasteReports: PastePerfReport[] = [];
      for (let i = 0; i < PASTES; i += 1) {
        // eslint-disable-next-line no-console
        console.log(`[${tag}] paste ${i + 1}/${PASTES}…`);
        const t0 = Date.now();
        const pasted = await pasteClipViaStore(page, clipIds, 12 * (i + 1));
        // eslint-disable-next-line no-console
        console.log(`[${tag}] commit returned`, pasted, `${Date.now() - t0}ms`);
        await page.waitForFunction(
          () => {
            const last = (window as Window & { __RCB_PASTE_PERF_LAST?: PastePerfReport })
              .__RCB_PASTE_PERF_LAST;
            return Boolean(last && typeof last.totalMs === 'number');
          },
          undefined,
          { timeout: 90_000 }
        );
        const report = await readLastPaste(page);
        expect(report, `paste #${i + 1} missing perf report`).toBeTruthy();
        pasteReports.push(report!);
        // eslint-disable-next-line no-console
        console.log(
          `[${tag}] paste ${i + 1} done`,
          report!.label,
          `${report!.totalMs.toFixed(1)}ms`
        );
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              const ric = (
                window as Window & {
                  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
                }
              ).requestIdleCallback;
              if (typeof ric === 'function') {
                ric(() => resolve(), { timeout: 500 });
                return;
              }
              window.setTimeout(() => resolve(), 100);
            })
        );
      }

      await page.evaluate(async () => {
        const editorMod = await import('/src/store/modules/editor.ts');
        const { touchDocumentRevision } = editorMod as { touchDocumentRevision: () => void };
        touchDocumentRevision();
      });
      await page.evaluate(
        ({ idleTimeout }) =>
          new Promise<void>((resolve) => {
            const ric = (
              window as Window & {
                requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
              }
            ).requestIdleCallback;
            if (typeof ric === 'function') {
              ric(() => resolve(), { timeout: idleTimeout });
              return;
            }
            window.setTimeout(() => resolve(), Math.min(800, idleTimeout / 5));
          }),
        { idleTimeout: SEED >= 5000 ? 4000 : 2000 }
      );

      const idleAfter = await stageIdleCount(page);
      const inkPixels = await page.evaluate(() => {
        const canvas = document.querySelector(
          '[data-rcb-idle-ink-canvas="1"]'
        ) as HTMLCanvasElement | null;
        if (!canvas) return { ok: false, reason: 'no-ink-canvas' };
        const ctx = canvas.getContext('2d');
        if (!ctx) return { ok: false, reason: 'no-ctx' };
        const { width, height } = canvas;
        if (width < 2 || height < 2) return { ok: false, reason: 'tiny' };
        const sample = ctx.getImageData(0, 0, width, height).data;
        let opaque = 0;
        for (let i = 3; i < sample.length; i += 32) {
          if (sample[i]! > 8) opaque += 1;
        }
        return { ok: opaque > 40, opaque, width, height };
      });

      await page.mouse.click(box.x + box.width * 0.06, box.y + box.height * 0.06);
      await sleep(120);
      await page.waitForFunction(
        () =>
          Boolean(
            (window as Window & { __RCB_SELECT_PERF_LAST?: PastePerfReport }).__RCB_SELECT_PERF_LAST
          ),
        undefined,
        { timeout: 30_000 }
      );
      const selectBlankAfter = await readLastSelect(page);

      await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.2);
      await sleep(120);
      await page.waitForFunction(
        () => {
          const last = (window as Window & { __RCB_SELECT_PERF_LAST?: PastePerfReport })
            .__RCB_SELECT_PERF_LAST;
          return Boolean(last && String(last.label || '').includes('select n='));
        },
        undefined,
        { timeout: 30_000 }
      );
      const selectOneAfter = await readLastSelect(page);

      const summary = pasteReports.map(summarizePaste);
      const lastLive = summary[summary.length - 1]?.live || 0;

      // eslint-disable-next-line no-console
      console.log(
        `[${tag}]`,
        JSON.stringify(
          {
            kind,
            seeded,
            seed: SEED,
            clip: CLIP,
            pastes: summary.length,
            lastLive,
            idleAfter,
            inkPixels,
            selectBlankAtSeed,
            selectBlankAfter,
            selectOneAfter,
            summary,
            worstTotal: summary.reduce((m, r) => Math.max(m, r.totalMs), 0),
            worstKit: summary.reduce((m, r) => Math.max(m, Number(r.kitBodyMs) || 0), 0),
            worstLayout: summary.reduce((m, r) => Math.max(m, Number(r.layoutMs) || 0), 0),
          },
          null,
          2
        )
      );

      expect(inkPixels.ok, JSON.stringify(inkPixels)).toBe(true);
      expect(lastLive).toBeGreaterThanOrEqual(SEED);

      for (const row of summary) {
        expect(
          row.totalMs,
          `paste #${row.i} totalMs=${row.totalMs} ${row.label}`
        ).toBeLessThan(2500);
        if (row.kitBodyMs != null) {
          expect(
            row.kitBodyMs,
            `paste #${row.i} kit bodyMs=${row.kitBodyMs} ${row.label}`
          ).toBeLessThan(400);
        }
      }
      expect(selectBlankAtSeed?.totalMs ?? 9999, 'blank select @seed').toBeLessThan(
        SEED >= 5000 ? 900 : 300
      );
      expect(selectBlankAfter?.totalMs ?? 9999, 'blank select after paste').toBeLessThan(
        SEED >= 5000 ? 900 : 300
      );
      expect(selectOneAfter?.totalMs ?? 9999, 'select one after paste').toBeLessThan(
        SEED >= 5000 ? 1200 : 500
      );
    });
  }
});
