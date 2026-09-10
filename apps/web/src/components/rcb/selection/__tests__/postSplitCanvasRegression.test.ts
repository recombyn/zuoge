/**
 * Post-split regression: exercise modules extracted from SelectionFeature /
 * editor / SvgCanvas so import + behavior stay wired.
 */
import { describe, expect, it } from 'vitest';
import {
  FRAME_SEL_PREFIX,
  frameSelId,
  parseFrameSelId,
} from '@/components/rcb/frames/frameSceneQuery';
import {
  computeMovedUnion,
  shiftConstrainedMoveDelta,
  resolveMeasureBox,
  resolveClippedMeasureBox,
  smartGuideTargetsForDrag,
} from '../selectionLogic';
import { inflateBoxByVisualOutset } from '@/components/rcb/scene/document/sceneEffects';
import { computeShapeBoolean, type ShapeBox } from '../shapeBoolean';
import { smartSnapThreshold } from '../alignGuides';
import { setAnimationWorkbenchTimelineFocus } from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import {
  asHistoryEntry,
  cloneDocument,
  pushHistory,
  pushNodePatchHistory,
  restoreNodesIntoDocument,
  scrubNodeIdsFromHistory,
  type EditorHistoryHost,
} from '@/store/modules/editorHistory';
import {
  createEmptyDocument,
  addNodeToDocument,
} from '@/components/rcb/scene/document/sceneDocument';
import { createShapeNode } from '@/components/rcb/scene/document/nodeFactories';
import type { SceneDocument } from '@/components/rcb/sceneNode';

describe('frameSelId helpers', () => {
  it('round-trips frame ids and rejects plain node ids', () => {
    const id = frameSelId('frame_abc');
    expect(id.startsWith(FRAME_SEL_PREFIX)).toBe(true);
    expect(parseFrameSelId(id)).toBe('frame_abc');
    expect(parseFrameSelId('node_1')).toBeNull();
    expect(parseFrameSelId('')).toBeNull();
  });
});

describe('selectionLogic shift axis move', () => {
  it('shiftConstrainedMoveDelta locks axis while Shift held', () => {
    const drag: { moveAxisLock?: 'h' | 'v' } = {};
    expect(shiftConstrainedMoveDelta(drag, 20, 5, true)).toEqual({ dx: 20, dy: 0 });
    expect(drag.moveAxisLock).toBe('h');
    expect(shiftConstrainedMoveDelta(drag, 20, 80, true)).toEqual({ dx: 20, dy: 0 });
    expect(shiftConstrainedMoveDelta(drag, 20, 80, false)).toEqual({ dx: 20, dy: 80 });
    expect(drag.moveAxisLock).toBeUndefined();
  });
});

describe('selectionLogic computeMovedUnion (grid + guide paint, no magnets)', () => {
  it('pins to grid and returns finite deltas', () => {
    const moving = { left: 98.4, top: 2.2, width: 40, height: 40 };
    const { nextUnion, sdx, sdy, guides } = computeMovedUnion({
      union: moving,
      origins: [{ nodeId: 'm', box: moving }],
      document: {
        x: 0,
        y: 0,
        width: 400,
        height: 400,
        deltaSetLike: {
          m: { id: 'm', key: 'rect', x: 98.4, y: 2.2, width: 40, height: 40, attrs: {}, children: [] },
          s: { id: 's', key: 'rect', x: 0, y: 0, width: 100, height: 80, attrs: {}, children: [] },
        },
      } as unknown as SceneDocument,
      dx: 2,
      dy: -2,
      disableSnap: false,
      gridSize: 1,
      targets: [{ left: 0, top: 0, width: 100, height: 80 }],
      threshold: smartSnapThreshold(1),
    });
    expect(Number.isFinite(sdx)).toBe(true);
    expect(Number.isFinite(sdy)).toBe(true);
    expect(nextUnion.width).toBe(40);
    expect(nextUnion.height).toBe(40);
    expect(Array.isArray(guides)).toBe(true);
  });

  it('resolveClippedMeasureBox drops fully frame-clipped overflow', () => {
    const doc = {
      x: 0,
      y: 0,
      width: 800,
      height: 800,
      frames: [{ id: 'f1', x: 0, y: 0, width: 200, height: 400, clipContent: true }],
      deltaSetLike: {
        outside: {
          id: 'outside',
          key: 'shape',
          x: 261,
          y: 100,
          width: 80,
          height: 80,
          attrs: { shapeType: 'path', frameId: 'f1' },
          children: [],
        },
        partial: {
          id: 'partial',
          key: 'shape',
          x: 150,
          y: 50,
          width: 100,
          height: 60,
          attrs: { shapeType: 'rect', frameId: 'f1' },
          children: [],
        },
      },
    } as unknown as SceneDocument;
    const boxes: Record<string, { left: number; top: number; width: number; height: number }> = {
      outside: { left: 261, top: 100, width: 80, height: 80 },
      partial: { left: 150, top: 50, width: 100, height: 60 },
    };
    expect(resolveClippedMeasureBox('outside', doc, (id) => boxes[id] ?? null)).toBeNull();
    expect(resolveMeasureBox('outside', doc, (id) => boxes[id] ?? null)).toEqual(boxes.outside);
    expect(resolveClippedMeasureBox('partial', doc, (id) => boxes[id] ?? null)).toEqual({
      left: 150,
      top: 50,
      width: 50,
      height: 60,
    });
  });

  it('smartGuideTargetsForDrag skips fully clipped peers; resolveClippedMeasureBox too', () => {
    const doc = {
      x: 0,
      y: 0,
      width: 800,
      height: 800,
      frames: [{ id: 'f1', x: 0, y: 0, width: 200, height: 400, clipContent: true }],
      deltaSetLike: {
        inside: {
          id: 'inside',
          key: 'shape',
          x: 20,
          y: 20,
          width: 40,
          height: 40,
          attrs: { shapeType: 'rect', frameId: 'f1' },
          children: [],
        },
        outside: {
          id: 'outside',
          key: 'shape',
          x: 261,
          y: 100,
          width: 80,
          height: 80,
          attrs: { shapeType: 'path', frameId: 'f1' },
          children: [],
        },
      },
    } as unknown as SceneDocument;
    const boxes: Record<string, { left: number; top: number; width: number; height: number }> = {
      inside: { left: 20, top: 20, width: 40, height: 40 },
      outside: { left: 261, top: 100, width: 80, height: 80 },
    };
    const targets = smartGuideTargetsForDrag({
      document: doc,
      listNodeIds: () => ['inside', 'outside'],
      getNodeBox: (id) => boxes[id] ?? null,
      excludeIds: new Set(['inside']),
      nearBox: { left: 0, top: 0, width: 400, height: 400 },
      threshold: 8,
    });
    expect(targets.some((t) => t.left === 261)).toBe(false);
    expect(targets.some((t) => t.guideKind === 'frame')).toBe(true);
    expect(resolveMeasureBox('outside', doc, (id) => boxes[id] ?? null)).toEqual(boxes.outside);
    expect(resolveClippedMeasureBox('outside', doc, (id) => boxes[id] ?? null)).toBeNull();
    expect(resolveClippedMeasureBox('inside', doc, (id) => boxes[id] ?? null)).toEqual(
      boxes.inside
    );
  });

  it('smartGuideTargetsForDrag skips artboards hidden by animation workbench focus', () => {
    setAnimationWorkbenchTimelineFocus('anim');
    try {
      const doc = {
        x: 0,
        y: 0,
        width: 800,
        height: 800,
        frames: [
          { id: 'anim', kind: 'animation', x: 0, y: 0, width: 200, height: 200 },
          { id: 'other', kind: 'artboard', x: 300, y: 0, width: 200, height: 120 },
        ],
        deltaSetLike: {},
      } as unknown as SceneDocument;
      const targets = smartGuideTargetsForDrag({
        document: doc,
        listNodeIds: () => [],
        getNodeBox: () => null,
        excludeIds: new Set(),
        nearBox: { left: 0, top: 0, width: 800, height: 800 },
        threshold: 8,
      });
      expect(targets.filter((t) => t.guideKind === 'frame')).toHaveLength(1);
      expect(targets.some((t) => t.left === 300)).toBe(false);
      expect(targets.some((t) => t.left === 0 && t.width === 200)).toBe(true);
    } finally {
      setAnimationWorkbenchTimelineFocus(null);
    }
  });

  it('resolveClippedMeasureBox keeps overflow when clipContent is false', () => {
    const doc = {
      x: 0,
      y: 0,
      width: 800,
      height: 800,
      frames: [{ id: 'f1', x: 0, y: 0, width: 200, height: 400, clipContent: false }],
      deltaSetLike: {
        outside: {
          id: 'outside',
          key: 'shape',
          x: 261,
          y: 100,
          width: 80,
          height: 80,
          attrs: { shapeType: 'rect', frameId: 'f1' },
          children: [],
        },
      },
    } as unknown as SceneDocument;
    const chrome = { left: 261, top: 100, width: 80, height: 80 };
    expect(resolveClippedMeasureBox('outside', doc, () => chrome)).toEqual(chrome);
  });

  it('align guides follow mover path top (not outer ink, not a fixed y)', () => {
    const pathTop = 20;
    const pathLeft = 100;
    const centerStroke = {
      id: 'm',
      key: 'shape',
      x: pathLeft,
      y: pathTop,
      width: 40,
      height: 40,
      attrs: {
        shapeType: 'rect',
        'border-width': 2,
        'border-color': '#333',
        strokeAlign: 'center',
        'stroke-enabled': 'true',
        'stroke-visible': 'true',
      },
      children: [],
    };
    const sibling = {
      id: 's',
      key: 'shape',
      x: 10,
      y: pathTop,
      width: 50,
      height: 80,
      attrs: { ...centerStroke.attrs },
      children: [],
    };
    const chrome = { left: pathLeft, top: pathTop, width: 40, height: 40 };
    const doc = {
      x: 0,
      y: 0,
      width: 400,
      height: 400,
      deltaSetLike: { m: centerStroke, s: sibling },
    } as unknown as SceneDocument;
    const targetPath = { left: 10, top: pathTop, width: 50, height: 80 };

    const { guides, sdy } = computeMovedUnion({
      union: chrome,
      origins: [{ nodeId: 'm', box: chrome }],
      document: doc,
      dx: 0,
      dy: 0,
      disableSnap: false,
      gridSize: 0,
      targets: [targetPath],
      threshold: 8,
    });
    expect(sdy).toBe(0);
    const topAlign = guides.find(
      (g) => g.kind === 'align' && g.axis === 'y' && Math.abs(g.at - pathTop) < 1e-9
    );
    expect(topAlign).toBeTruthy();
    const outerInkTop = pathTop - 1;
    expect(guides.some((g) => g.kind === 'align' && g.axis === 'y' && g.at === outerInkTop)).toBe(
      false
    );
  });

  it('near-miss edge gap auto-snaps flush', () => {
    const left = { left: 0, top: 0, width: 100, height: 80 };
    const rightChrome = { left: 102, top: 0, width: 40, height: 40 };
    const { guides, sdx, nextUnion } = computeMovedUnion({
      union: rightChrome,
      origins: [{ nodeId: 'm', box: rightChrome }],
      document: {
        x: 0,
        y: 0,
        width: 400,
        height: 400,
        deltaSetLike: {
          m: {
            id: 'm',
            key: 'shape',
            x: 102,
            y: 0,
            width: 40,
            height: 40,
            attrs: {
              shapeType: 'rect',
              'border-width': 0,
              'stroke-enabled': 'false',
              'stroke-visible': 'false',
            },
            children: [],
          },
        },
      } as unknown as SceneDocument,
      dx: 0,
      dy: 0,
      disableSnap: false,
      gridSize: 1,
      targets: [left],
      threshold: 8,
    });
    expect(sdx).toBe(-2);
    expect(nextUnion.left).toBe(100);
    expect(guides.some((g) => g.kind === 'align' && g.axis === 'x' && g.at === 100)).toBe(true);
  });

  it('top edges within threshold auto-snap and paint a horizontal guide', () => {
    const left = { left: 0, top: 20, width: 100, height: 80 };
    const rightChrome = { left: 120, top: 24, width: 60, height: 50 };
    const { guides, sdy, nextUnion } = computeMovedUnion({
      union: rightChrome,
      origins: [{ nodeId: 'm', box: rightChrome }],
      document: {
        x: 0,
        y: 0,
        width: 400,
        height: 400,
        deltaSetLike: {
          m: {
            id: 'm',
            key: 'shape',
            x: 120,
            y: 24,
            width: 60,
            height: 50,
            attrs: {
              shapeType: 'rect',
              'border-width': 0,
              'stroke-enabled': 'false',
              'stroke-visible': 'false',
            },
            children: [],
          },
        },
      } as unknown as SceneDocument,
      dx: 0,
      dy: 0,
      disableSnap: false,
      gridSize: 1,
      targets: [left],
      threshold: 8,
    });
    expect(sdy).toBe(-4);
    expect(nextUnion.top).toBe(20);
    expect(guides.some((g) => g.kind === 'align' && g.axis === 'y' && g.at === 20)).toBe(true);
  });

  it('visual-outer grid can land flush on a neighbor edge', () => {
    const left = { left: 0, top: 0, width: 100, height: 80 };
    const rightChrome = { left: 100.4, top: 0, width: 40, height: 40 };
    const { nextUnion, guides } = computeMovedUnion({
      union: rightChrome,
      origins: [{ nodeId: 'm', box: rightChrome }],
      document: {
        x: 0,
        y: 0,
        width: 400,
        height: 400,
        deltaSetLike: {
          m: {
            id: 'm',
            key: 'shape',
            x: 100.4,
            y: 0,
            width: 40,
            height: 40,
            attrs: {
              shapeType: 'rect',
              'border-width': 0,
              'stroke-enabled': 'false',
              'stroke-visible': 'false',
            },
            children: [],
          },
        },
      } as unknown as SceneDocument,
      dx: 0,
      dy: 0,
      disableSnap: false,
      gridSize: 1,
      targets: [left],
      threshold: 8,
    });
    expect(nextUnion.left).toBe(100);
    expect(guides.some((g) => g.kind === 'align' && g.axis === 'x' && g.at === 100)).toBe(true);
  });

  it('center-stroke move keeps outer ink on grid (not path integers)', () => {
    const chrome = { left: 100.5, top: 20.5, width: 40, height: 40 };
    const node = {
      id: 'm',
      key: 'shape',
      x: 100.5,
      y: 20.5,
      width: 40,
      height: 40,
      attrs: {
        shapeType: 'rect',
        'border-width': 1,
        'border-color': '#333',
        strokeAlign: 'center',
        'stroke-enabled': 'true',
        'stroke-visible': 'true',
      },
      children: [],
    };
    const { nextUnion, sdx } = computeMovedUnion({
      union: chrome,
      origins: [{ nodeId: 'm', box: chrome }],
      document: {
        x: 0,
        y: 0,
        width: 400,
        height: 400,
        deltaSetLike: { m: node },
      } as unknown as SceneDocument,
      dx: 2.3,
      dy: 0,
      disableSnap: false,
      gridSize: 1,
      targets: [],
      threshold: 8,
    });
    const visual = inflateBoxByVisualOutset(nextUnion, node);
    expect(Number.isInteger(visual.left)).toBe(true);
    expect(sdx).toBe(nextUnion.left - chrome.left);
    expect(Math.abs(sdx - 2.3)).toBeLessThan(0.6);
  });

  it('re-applies axis lock after smart snap nudge', () => {
    const moving = { left: 0, top: 0, width: 40, height: 40 };
    const { sdx, sdy } = computeMovedUnion({
      union: moving,
      origins: [{ nodeId: 'm', box: moving }],
      document: {
        x: 0,
        y: 0,
        width: 400,
        height: 400,
        deltaSetLike: {
          m: { id: 'm', key: 'rect', x: 0, y: 0, width: 40, height: 40, attrs: {}, children: [] },
          s: { id: 's', key: 'rect', x: 200, y: 0, width: 100, height: 80, attrs: {}, children: [] },
        },
      } as unknown as SceneDocument,
      dx: 50,
      dy: 8,
      disableSnap: false,
      gridSize: 1,
      axisLock: 'h',
      targets: [{ left: 200, top: 0, width: 100, height: 80 }],
      threshold: smartSnapThreshold(1),
    });
    expect(sdy).toBe(0);
    expect(Math.abs(sdx)).toBeGreaterThan(0);
  });
});

describe('boolean ops (all modes)', () => {
  const a: ShapeBox = {
    left: 0,
    top: 0,
    width: 100,
    height: 100,
    shapeType: 'rect',
  };
  const b: ShapeBox = {
    left: 50,
    top: 50,
    width: 100,
    height: 100,
    shapeType: 'rect',
  };

  it.each(['union', 'subtract', 'intersect', 'exclude'] as const)('%s two overlapping rects', (mode) => {
    const { result, usedFallback } = computeShapeBoolean([a, b], mode);
    expect(result).not.toBeNull();
    expect(usedFallback).toBe(false);
    expect(result!.width).toBeGreaterThan(0);
    expect(result!.height).toBeGreaterThan(0);
    expect(String(result!.path || '').length).toBeGreaterThan(4);
  });
});

describe('editorHistory post-split', () => {
  it('push/scrub/restore node patches', () => {
    let doc = createEmptyDocument({ emptyWorld: true });
    const { id, node } = createShapeNode({
      x: 0,
      y: 0,
      width: 40,
      height: 40,
      shapeType: 'rect',
      fill: '#111',
    });
    doc = addNodeToDocument(doc, id, node);
    const host: EditorHistoryHost = {
      document: doc,
      historyPast: [],
      historyFuture: [],
    };
    pushHistory(host);
    expect(asHistoryEntry(host.historyPast[0]!).kind).toBe('snap');
    expect(cloneDocument(doc)?.deltaSetLike?.[id]).toBeTruthy();

    pushNodePatchHistory(host, [id]);
    const last = asHistoryEntry(host.historyPast[host.historyPast.length - 1]!);
    expect(last.kind).toBe('nodes');

    const patched = {
      ...doc,
      deltaSetLike: {
        ...doc.deltaSetLike,
        [id]: {
          ...doc.deltaSetLike[id],
          attrs: { ...doc.deltaSetLike[id].attrs, 'fill-color': '#f00' },
        },
      },
    };
    const restored = restoreNodesIntoDocument(patched, (last as any).before);
    expect(restored.deltaSetLike[id].attrs['fill-color']).not.toBe('#f00');

    scrubNodeIdsFromHistory(host, [id]);
    for (const raw of host.historyPast) {
      const e = asHistoryEntry(raw);
      if (e.kind === 'nodes') expect(id in e.before).toBe(false);
      if (e.kind === 'snap') expect(e.doc?.deltaSetLike?.[id]).toBeFalsy();
    }
  });
});
