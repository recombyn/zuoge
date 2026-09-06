import { describe, expect, it, afterEach, vi } from 'vitest';
import {
  createSceneRenderBuffer,
  refreshSoaOverlayVisibilityFromDocument,
  SOA_FLAG_VISIBLE,
  syncSceneRenderBufferFromDocument,
} from '@/components/rcb/render/sceneRenderBuffer';
import { createEmptyDocument, addNodeToDocument } from '@/components/rcb/scene/document/sceneDocument';
import {
  WORKBENCH_SURROUND_ATTR,
  CANVAS_MEDIA_FILE_ACCEPT,
  canBindToArtboard,
  finalizeNodeForAnimationWorkbenchFocus,
  getWorkbenchToolPolicy,
  isAnimationWorkbenchPreviewChild,
  isAnimationWorkbenchFrameInPreview,
  isArtboardVisibleInDocument,
  isAvBlockedByAnimationWorkbenchFocus,
  isHiddenByAnimationWorkbenchFocus,
  isBoundOutsideOwningClipPlate,
  isInactiveAtAnimationPlayhead,
  isLottieJsonFile,
  mediaFileAcceptForWorkbenchTimeline,
  setAnimationWorkbenchPlayheadSec,
  setAnimationWorkbenchTimelineFocus,
  shouldShowArtboardInWorkbenchFocus,
  warnIfAvBlockedByAnimationWorkbenchFocus,
  WORKBENCH_IMAGE_JSON_FILE_ACCEPT,
} from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';

afterEach(() => {
  setAnimationWorkbenchTimelineFocus(null);
  setAnimationWorkbenchPlayheadSec(0);
});

function docWithPlateAndNode(opts: {
  frameId: string;
  fps?: number;
  node: Record<string, unknown>;
}) {
  return {
    width: 800,
    height: 600,
    frames: [
      {
        id: opts.frameId,
        kind: 'animation',
        x: 100,
        y: 100,
        width: 400,
        height: 300,
        fps: opts.fps ?? 30,
      },
    ],
    deltaSetLike: {
      ROOT: { id: 'ROOT', key: 'root' },
      [String(opts.node.id)]: opts.node,
    },
  };
}

describe('finalizeNodeForAnimationWorkbenchFocus', () => {
  it('binds intersecting image into focused plate (visible under focus)', () => {
    setAnimationWorkbenchTimelineFocus('af1');
    const raw = docWithPlateAndNode({
      frameId: 'af1',
      node: {
        id: 'img1',
        key: 'image',
        x: 120,
        y: 120,
        width: 80,
        height: 80,
        attrs: {},
      },
    });
    const next = finalizeNodeForAnimationWorkbenchFocus(raw, 'img1');
    const node = next.deltaSetLike.img1;
    expect(node.attrs.frameId).toBe('af1');
    expect(node.attrs[WORKBENCH_SURROUND_ATTR]).toBeUndefined();
    expect(isHiddenByAnimationWorkbenchFocus(node)).toBe(false);
  });

  it('tags surround when image is outside the plate (still visible under focus)', () => {
    setAnimationWorkbenchTimelineFocus('af1');
    const raw = docWithPlateAndNode({
      frameId: 'af1',
      node: {
        id: 'img2',
        key: 'image',
        x: 700,
        y: 700,
        width: 80,
        height: 80,
        attrs: {},
      },
    });
    const next = finalizeNodeForAnimationWorkbenchFocus(raw, 'img2');
    const node = next.deltaSetLike.img2;
    expect(node.attrs.frameId).toBeUndefined();
    expect(node.attrs[WORKBENCH_SURROUND_ATTR]).toBe('af1');
    expect(isHiddenByAnimationWorkbenchFocus(node)).toBe(false);
  });

  it('binds overlapping unbound shape into focused workbench (not surround behind plate)', () => {
    setAnimationWorkbenchTimelineFocus('af1');
    const raw = docWithPlateAndNode({
      frameId: 'af1',
      node: {
        id: 'rect1',
        key: 'shape',
        x: 450,
        y: 150,
        width: 120,
        height: 80,
        attrs: {},
      },
    });
    // Plate is 100,100,400×300 — rect overlaps right edge.
    const next = finalizeNodeForAnimationWorkbenchFocus(raw, 'rect1');
    const node = next.deltaSetLike.rect1;
    expect(node.attrs.frameId).toBe('af1');
    expect(node.attrs[WORKBENCH_SURROUND_ATTR]).toBeUndefined();
  });

  it('hides unowned nodes that were never finalized', () => {
    setAnimationWorkbenchTimelineFocus('af1');
    const node = {
      id: 'img3',
      key: 'image',
      x: 120,
      y: 120,
      width: 80,
      height: 80,
      attrs: {},
    };
    expect(isHiddenByAnimationWorkbenchFocus(node)).toBe(true);
  });

  it('tags surround for image generators (pasteboard, not timeline layer)', () => {
    setAnimationWorkbenchTimelineFocus('af1');
    const raw = docWithPlateAndNode({
      frameId: 'af1',
      node: {
        id: 'gen1',
        key: 'image',
        x: 120,
        y: 120,
        width: 80,
        height: 80,
        attrs: { imageGenerator: true },
      },
    });
    const next = finalizeNodeForAnimationWorkbenchFocus(raw, 'gen1');
    const node = next.deltaSetLike.gen1;
    expect(node.attrs.frameId).toBeUndefined();
    expect(node.attrs[WORKBENCH_SURROUND_ATTR]).toBe('af1');
    expect(isHiddenByAnimationWorkbenchFocus(node)).toBe(false);
  });

  it('tags surround for video plates (never bind into workbench plate)', () => {
    setAnimationWorkbenchTimelineFocus('af1');
    const raw = docWithPlateAndNode({
      frameId: 'af1',
      node: {
        id: 'vid1',
        key: 'video',
        x: 120,
        y: 120,
        width: 80,
        height: 80,
        attrs: {},
      },
    });
    const next = finalizeNodeForAnimationWorkbenchFocus(raw, 'vid1');
    const node = next.deltaSetLike.vid1;
    expect(node.attrs.frameId).toBeUndefined();
    expect(node.attrs[WORKBENCH_SURROUND_ATTR]).toBe('af1');
  });
});

describe('AV blocked under workbench focus', () => {
  it('isAvBlocked when focus is set', () => {
    expect(isAvBlockedByAnimationWorkbenchFocus()).toBe(false);
    setAnimationWorkbenchTimelineFocus('af1');
    expect(isAvBlockedByAnimationWorkbenchFocus()).toBe(true);
  });

  it('warnIfAvBlocked warns once and returns true under focus', () => {
    const warn = vi.fn();
    expect(warnIfAvBlockedByAnimationWorkbenchFocus(warn)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    setAnimationWorkbenchTimelineFocus('af1');
    expect(warnIfAvBlockedByAnimationWorkbenchFocus(warn)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('exposes image+JSON accept for timeline attach', () => {
    expect(WORKBENCH_IMAGE_JSON_FILE_ACCEPT).toContain('image/png');
    expect(WORKBENCH_IMAGE_JSON_FILE_ACCEPT).toContain('application/json');
    expect(WORKBENCH_IMAGE_JSON_FILE_ACCEPT).toContain('.lot');
    expect(WORKBENCH_IMAGE_JSON_FILE_ACCEPT).not.toContain('video/');
  });

  it('isLottieJsonFile accepts .json / .lot and rejects .lottie zip', () => {
    expect(isLottieJsonFile({ name: 'a.json', type: 'application/json' })).toBe(true);
    expect(isLottieJsonFile({ name: 'a.lot', type: '' })).toBe(true);
    expect(isLottieJsonFile({ name: 'a.lottie', type: 'application/zip' })).toBe(false);
  });

  it('mediaFileAcceptForWorkbenchTimeline switches canvas vs workbench accept', () => {
    expect(mediaFileAcceptForWorkbenchTimeline(false)).toBe(CANVAS_MEDIA_FILE_ACCEPT);
    expect(mediaFileAcceptForWorkbenchTimeline(true)).toBe(WORKBENCH_IMAGE_JSON_FILE_ACCEPT);
    expect(CANVAS_MEDIA_FILE_ACCEPT).toContain('video/*');
  });
});

describe('isAnimationWorkbenchPreviewChild', () => {
  it('true for bound children when timeline closed; false when focused', () => {
    const doc = docWithPlateAndNode({
      frameId: 'af1',
      node: {
        id: 'img1',
        key: 'image',
        x: 120,
        y: 120,
        width: 80,
        height: 80,
        attrs: { frameId: 'af1' },
      },
    });
    const node = doc.deltaSetLike.img1;
    expect(isAnimationWorkbenchPreviewChild(doc, node)).toBe(true);
    setAnimationWorkbenchTimelineFocus('af1');
    expect(isAnimationWorkbenchPreviewChild(doc, node)).toBe(false);
  });

  it('never treats host as preview child', () => {
    const doc = docWithPlateAndNode({
      frameId: 'af1',
      node: {
        id: 'host',
        key: 'lottie',
        x: 100,
        y: 100,
        width: 400,
        height: 300,
        attrs: { frameId: 'af1', animationFrameHost: true },
      },
    });
    expect(isAnimationWorkbenchPreviewChild(doc, doc.deltaSetLike.host)).toBe(false);
  });
});

describe('isAnimationWorkbenchFrameInPreview', () => {
  it('true for animation plate when timeline closed; false when editing', () => {
    const doc = docWithPlateAndNode({
      frameId: 'af1',
      node: {
        id: 'img1',
        key: 'image',
        x: 120,
        y: 120,
        width: 80,
        height: 80,
        attrs: { frameId: 'af1' },
      },
    });
    expect(isAnimationWorkbenchFrameInPreview(doc, 'af1')).toBe(true);
    setAnimationWorkbenchTimelineFocus('af1');
    expect(isAnimationWorkbenchFrameInPreview(doc, 'af1')).toBe(false);
  });

  it('false for non-animation frames', () => {
    const doc = {
      frames: [{ id: 'f1', kind: 'artboard', x: 0, y: 0, width: 100, height: 100 }],
      deltaSetLike: { ROOT: { id: 'ROOT', key: 'root' } },
    };
    expect(isAnimationWorkbenchFrameInPreview(doc, 'f1')).toBe(false);
  });
});

describe('isInactiveAtAnimationPlayhead', () => {
  it('skips hit when playhead is before layer in-frame', () => {
    setAnimationWorkbenchTimelineFocus('af1');
    setAnimationWorkbenchPlayheadSec(0.2);
    const doc = docWithPlateAndNode({
      frameId: 'af1',
      fps: 30,
      node: {
        id: 'img',
        key: 'image',
        x: 120,
        y: 120,
        width: 80,
        height: 80,
        attrs: {
          frameId: 'af1',
          // 0.35s * 30fps ≈ 10.5 → 11
          lottieInFrame: 11,
          lottieOutFrame: 36,
        },
      },
    });
    expect(isInactiveAtAnimationPlayhead(doc, doc.deltaSetLike.img)).toBe(true);
  });

  it('allows hit when playhead is inside layer range', () => {
    setAnimationWorkbenchTimelineFocus('af1');
    setAnimationWorkbenchPlayheadSec(0.5);
    const doc = docWithPlateAndNode({
      frameId: 'af1',
      fps: 30,
      node: {
        id: 'img',
        key: 'image',
        x: 120,
        y: 120,
        width: 80,
        height: 80,
        attrs: {
          frameId: 'af1',
          lottieInFrame: 11,
          lottieOutFrame: 36,
        },
      },
    });
    expect(isInactiveAtAnimationPlayhead(doc, doc.deltaSetLike.img)).toBe(false);
  });

  it('trims animation-plate children when timeline focus is cleared', () => {
    setAnimationWorkbenchTimelineFocus(null);
    setAnimationWorkbenchPlayheadSec(0);
    const doc = docWithPlateAndNode({
      frameId: 'af1',
      fps: 30,
      node: {
        id: 'img',
        key: 'image',
        x: 120,
        y: 120,
        width: 80,
        height: 80,
        attrs: {
          frameId: 'af1',
          lottieInFrame: 11,
          lottieOutFrame: 36,
        },
      },
    });
    expect(isInactiveAtAnimationPlayhead(doc, doc.deltaSetLike.img)).toBe(true);
    expect(isInactiveAtAnimationPlayhead(doc, doc.deltaSetLike.img, 0.5)).toBe(false);
  });
});

/** Same hide rules EditorMinimap uses for edit vs preview isolation. */
describe('workbench focus isolation (minimap / canvas)', () => {
  it('edit: only focused artboard stays visible; other plates hide', () => {
    expect(shouldShowArtboardInWorkbenchFocus({ id: 'main' })).toBe(true);
    expect(shouldShowArtboardInWorkbenchFocus({ id: 'af1' })).toBe(true);
    setAnimationWorkbenchTimelineFocus('af1');
    expect(shouldShowArtboardInWorkbenchFocus({ id: 'af1' })).toBe(true);
    expect(shouldShowArtboardInWorkbenchFocus({ id: 'main' })).toBe(false);
  });

  it('edit: nodes on other plates hide; focused plate + surround stay', () => {
    setAnimationWorkbenchTimelineFocus('af1');
    expect(
      isHiddenByAnimationWorkbenchFocus({ attrs: { frameId: 'af1' } })
    ).toBe(false);
    expect(
      isHiddenByAnimationWorkbenchFocus({
        attrs: { [WORKBENCH_SURROUND_ATTR]: 'af1' },
      })
    ).toBe(false);
    expect(
      isHiddenByAnimationWorkbenchFocus({ attrs: { frameId: 'main' } })
    ).toBe(true);
  });

  it('preview: surround hides; unbound / plate children without surround show', () => {
    setAnimationWorkbenchTimelineFocus(null);
    expect(
      isHiddenByAnimationWorkbenchFocus({
        attrs: { [WORKBENCH_SURROUND_ATTR]: 'af1' },
      })
    ).toBe(true);
    expect(
      isHiddenByAnimationWorkbenchFocus({ attrs: { frameId: 'af1' } })
    ).toBe(false);
    expect(shouldShowArtboardInWorkbenchFocus({ id: 'main' })).toBe(true);
  });

  it('hides clip-bound nodes whose AABB is fully outside the plate', () => {
    const doc = {
      frames: [
        {
          id: 'af1',
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          clipContent: true,
        },
      ],
    };
    expect(
      isBoundOutsideOwningClipPlate(doc, {
        x: 200,
        y: 0,
        width: 40,
        height: 40,
        attrs: { frameId: 'af1' },
      })
    ).toBe(true);
    expect(
      isBoundOutsideOwningClipPlate(doc, {
        x: 20,
        y: 20,
        width: 40,
        height: 40,
        attrs: { frameId: 'af1' },
      })
    ).toBe(false);
  });

  it('frameLocal compares plate-local children against world plate AABB', () => {
    const doc = {
      coordSpace: 'frameLocal',
      frames: [
        {
          id: 'af1',
          x: 400,
          y: 300,
          width: 200,
          height: 160,
          clipContent: true,
        },
      ],
    };
    // Local (20,20) → world (420,320) still on-plate.
    expect(
      isBoundOutsideOwningClipPlate(doc, {
        x: 20,
        y: 20,
        width: 40,
        height: 40,
        attrs: { frameId: 'af1' },
      })
    ).toBe(false);
    // Local far outside plate → world off-plate.
    expect(
      isBoundOutsideOwningClipPlate(doc, {
        x: 900,
        y: 900,
        width: 40,
        height: 40,
        attrs: { frameId: 'af1' },
      })
    ).toBe(true);
  });

  it('refreshSoaOverlayVisibilityFromDocument hides other plates on canvas idle', () => {
    let doc = createEmptyDocument({ emptyWorld: true });
    doc = addNodeToDocument(doc, 'mainShape', {
      id: 'mainShape',
      key: 'shape',
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      attrs: { shapeType: 'rect', fill: '#ffffff', frameId: 'main', 'stroke-enabled': false },
      children: [],
    } as any);
    doc = addNodeToDocument(doc, 'afShape', {
      id: 'afShape',
      key: 'shape',
      x: 400,
      y: 0,
      width: 80,
      height: 80,
      attrs: { shapeType: 'rect', fill: '#ffffff', frameId: 'af1', 'stroke-enabled': false },
      children: [],
    } as any);

    const buf = createSceneRenderBuffer(4);
    syncSceneRenderBufferFromDocument(buf, doc);
    const mainIdx = buf.indexById.get('mainShape')!;
    const afIdx = buf.indexById.get('afShape')!;
    expect(buf.flags[mainIdx] & SOA_FLAG_VISIBLE).toBeTruthy();
    expect(buf.flags[afIdx] & SOA_FLAG_VISIBLE).toBeTruthy();

    setAnimationWorkbenchTimelineFocus('af1');
    const changed = refreshSoaOverlayVisibilityFromDocument(buf, doc);
    expect(changed).toBeGreaterThan(0);
    expect(buf.flags[mainIdx] & SOA_FLAG_VISIBLE).toBe(0);
    expect(buf.flags[afIdx] & SOA_FLAG_VISIBLE).toBeTruthy();
  });
});

describe('WorkbenchIsolationPolicy', () => {
  it('isArtboardVisibleInDocument: focus on/off + frame.hidden', () => {
    expect(isArtboardVisibleInDocument({ id: 'main' })).toBe(true);
    expect(isArtboardVisibleInDocument({ id: 'main', hidden: true })).toBe(false);
    setAnimationWorkbenchTimelineFocus('af1');
    expect(isArtboardVisibleInDocument({ id: 'af1' })).toBe(true);
    expect(isArtboardVisibleInDocument({ id: 'main' })).toBe(false);
    expect(isArtboardVisibleInDocument({ id: 'af1', hidden: true })).toBe(false);
  });

  it('canBindToArtboard: animation plate only while focused', () => {
    const anim = { id: 'af1', kind: 'animation' as const };
    const board = { id: 'main', kind: 'artboard' as const };
    expect(canBindToArtboard(anim)).toBe(false);
    expect(canBindToArtboard(board)).toBe(true);
    setAnimationWorkbenchTimelineFocus('af1');
    expect(canBindToArtboard(anim)).toBe(true);
    expect(canBindToArtboard(board)).toBe(false);
  });

  it('getWorkbenchToolPolicy: AV / new plate / file accept', () => {
    expect(getWorkbenchToolPolicy()).toMatchObject({
      timelineOpen: false,
      avBlocked: false,
      newPlateBlocked: false,
      fileAccept: CANVAS_MEDIA_FILE_ACCEPT,
    });
    setAnimationWorkbenchTimelineFocus('af1');
    expect(getWorkbenchToolPolicy()).toMatchObject({
      timelineOpen: true,
      avBlocked: true,
      newPlateBlocked: true,
      fileAccept: WORKBENCH_IMAGE_JSON_FILE_ACCEPT,
    });
  });
});
