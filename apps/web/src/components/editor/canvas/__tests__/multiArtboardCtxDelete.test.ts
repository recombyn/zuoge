import { describe, expect, it } from 'vitest';
import type { ContextMenuState } from '@/components/rcb/selection/chrome/CanvasContextMenu';

/**
 * Multi artboard context-menu delete must prefer the selection snapshot captured
 * at menu open — not a single ctxMenu.frameId after chrome/activeFrame churn.
 */
function resolveCtxDeleteTargets(opts: {
  ctxMenu: ContextMenuState | null;
  selectedNodeIds: string[];
  selectedFrameIds: string[];
  activeFrameId: string | null;
}): { nodeIds: string[]; frameIds: string[] } {
  const ctxMenu = opts.ctxMenu;
  let ids = opts.selectedNodeIds;
  if (ctxMenu?.selectionNodeIds?.length) {
    ids = [...ctxMenu.selectionNodeIds];
  } else if (!ids.length && ctxMenu?.nodeId) {
    ids = [ctxMenu.nodeId];
  }
  let frameIds = ctxMenu?.selectionFrameIds?.length
    ? [...ctxMenu.selectionFrameIds]
    : [...opts.selectedFrameIds];
  if (!frameIds.length && !ids.length) {
    const fid = ctxMenu?.frameId || opts.activeFrameId;
    if (fid) frameIds = [String(fid)];
  }
  return { nodeIds: ids, frameIds };
}

describe('multi artboard context menu delete targets', () => {
  it('keeps all selectionFrameIds from the menu snapshot', () => {
    const { frameIds, nodeIds } = resolveCtxDeleteTargets({
      ctxMenu: {
        clientX: 0,
        clientY: 0,
        sceneX: 0,
        sceneY: 0,
        nodeId: null,
        frameId: 'anim-a',
        selectionFrameIds: ['anim-a', 'anim-b'],
      },
      selectedNodeIds: [],
      // Live selection collapsed to one plate after menu open (regression).
      selectedFrameIds: ['anim-a'],
      activeFrameId: 'anim-a',
    });
    expect(nodeIds).toEqual([]);
    expect(frameIds).toEqual(['anim-a', 'anim-b']);
  });

  it('falls back to live selection when snapshot is absent', () => {
    const { frameIds } = resolveCtxDeleteTargets({
      ctxMenu: {
        clientX: 0,
        clientY: 0,
        sceneX: 0,
        sceneY: 0,
        nodeId: null,
        frameId: 'anim-a',
      },
      selectedNodeIds: [],
      selectedFrameIds: ['anim-a', 'anim-b'],
      activeFrameId: 'anim-a',
    });
    expect(frameIds).toEqual(['anim-a', 'anim-b']);
  });
});
