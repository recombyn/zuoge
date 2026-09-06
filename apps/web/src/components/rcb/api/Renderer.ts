/**
 * RCB standard canvas API — Renderer facade.
 *
 * Sharpness (Figma-aligned): restamp / artboard tiles at zoom×dpr.
 * DomHost is obligatory only — not the sharpness path.
 * See docs/FIGMA_INK_PLAN.md and docs/CANVAS_GUIDE.md.
 */
export {
  createSceneRenderer,
  createSvgSceneRenderer,
  createCanvasSceneRenderer,
  resolveIdleInkBackend,
  canIdlePaintOnCanvas,
  paintCanvasIdleNode,
  type SceneRenderer,
  type SceneRendererBackend,
  type InkBackend,
  shapeInkForbidsAtlas,
} from '@/components/rcb/render/sceneRenderer';

export {
  createWebglSceneRenderer,
  collectSoaWebglInstances,
} from '@/components/rcb/render/webglSceneRenderer';

export {
  SOA_ATLAS_CELL,
  SOA_ATLAS_INNER,
  atlasZoomBucket,
  atlasCoverageBucket,
  idleMediaScreenEdgePx,
} from '@/components/rcb/render/webglInstanceAtlas';

export {
  resolvePaintIntent,
  paintIntentNeedsDomHost,
  backingInsufficientForAtlas,
  getPaintIntentDebugStats,
  resetPaintIntentDebugStats,
  notePaintRestamp,
  noteArtboardTiles,
  type PaintIntent,
  type PaintIntentCtx,
} from '@/components/rcb/render/paintIntent';

export {
  shouldUseSoaBake,
  setSoaCameraGestureActive,
  isSoaCameraGestureActive,
  tilesForView,
  ensureSoaBake,
} from '@/components/rcb/render/soaBakeLayer';

export {
  pickFullAndCanvasIds,
  nodeNeedsDomShapeHost,
} from '@/components/rcb/shapes/RcbShapesLayer';
