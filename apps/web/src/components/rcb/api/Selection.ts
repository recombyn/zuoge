/**
 * RCB standard canvas API — Selection facade.
 */
export {
  listSingleSelectionPaintRaiseNodeIds,
  isSingleStackSelection,
  selectionPaintZIndex,
  nodePaintZIndex,
} from '@/components/rcb/scene/document/sceneDocument';

export {
  stackPaintZ,
  stackPaintMaxZ,
  stackPaintNaturalZ,
  syncStackPaintOrder,
} from '@/components/rcb/scene/document/sceneStackPainter';

export {
  setSelectionPaintRaiseIds,
  setSelectionPaintRaiseFrameIds,
  setFrameClipRevealOverflowIds,
  listSelectionRevealOverflowIds,
  selectionPaintRaises,
  selectionPaintRaisesFrame,
  frameClipRevealsOverflow,
  hasSelectionPaintRaise,
  hasFrameClipRevealOverflow,
  listSelectionPaintRaiseIds,
  listSelectionPaintRaiseFrameIds,
} from '@/components/rcb/selection/selectionPaintRaise';
