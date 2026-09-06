/**
 * @rcb — canvas UI: camera, tools, selection, frames.
 * Prefer `import { … } from '@/components/rcb'`.
 *
 * Layout: `rcbCenterOnPoint` / `rcbFitImageIntoViewport` / `rcbLayoutGeneratorPlate`.
 */

export type { RcbBox, RcbCamera, RcbVec } from './core/types';
export { RCB_DEFAULT_CAMERA } from './core/types';
export {
  RCB_MIN_ZOOM,
  RCB_MAX_ZOOM,
  rcbClampZoom,
  rcbCameraCssZoom,
  rcbCameraScreenOffset,
  rcbViewportMetrics,
  rcbClientToStageLocal,
  rcbSceneToScreen,
  rcbScreenToScene,
  rcbClientDeltaToScene,
  rcbResolveViewportEl,
  rcbScreenPxToScene,
  rcbZoomAtPoint,
  rcbFitCamera,
  rcbFitCameraInBand,
  rcbCenterCameraInBand,
  rcbViewportSceneBounds,
  rcbStepZoom,
} from './core/math';
export {
  createCameraTransform,
  worldToScreen,
  stageLocalToWorld,
  screenDeltaToWorldDelta,
  worldBoxToScreen,
  cameraZoom,
  cameraPan,
  type CameraTransform,
} from './camera/transform';
export {
  createSceneRenderer,
  createSvgSceneRenderer,
  createCanvasSceneRenderer,
  resolveIdleInkBackend,
  hitTestWithSpatialIndex,
  hitTestSceneTargetWithSpatialIndex,
  collectUnifiedHitCandidates,
  isFullDirty,
  isNoopSoaDirtyRegion,
  dirtyTouchesNode,
  sceneBoxToScreenRect,
  resolveSoaCanvasDirtyRegion,
  drawSceneGrid,
  paintBasicShapeFill,
  paintCanvasShapeInk,
  paintCanvasPathInk,
  paintCanvasTextInk,
  clearIdleTextOutlineCache,
  primeIdleTextOutlineCache,
  paintCanvasIdleNode,
  paintStrokeCanvasIdle,
  paintTextProxyLines,
  paintMediaProxyIcon,
  paintGeneratorEmptyInk,
  paintGeneratorEmptyPlateIcon,
  strokeCanvasIdleCenterline,
  canvasIdleIsStrokeOnly,
  canvasIdleStrokeWidth,
  canIdlePaintOnCanvas,
  sceneGridLineWidth,
  resolveNodeProxyFill,
  resolveCanvasFillStyle,
  createCanvasAngularGradient,
  fillCanvasShapeGeometry,
  drawFillImageInBox,
  getFillImageReady,
  setFillImageCacheEntry,
  clearFillImageCache,
  canvasPixelsReadable,
  isFillImageWebglUnsafe,
  setSceneCanvasIdlePaint,
  getSceneCanvasIdlePaint,
  clearSceneCanvasIdlePaint,
  bumpSceneCanvasIdlePaint,
  subscribeSceneCanvasIdlePaint,
  listSceneCanvasIdlePaintIds,
  CANVAS_IDLE_STROKE_MAX_PTS,
  type SceneCanvasIdlePaintSnapshot,
  type SceneRenderer,
  type SceneRendererBackend,
  type SceneRenderRequest,
  type DirtyRegion,
  type SceneRendererHitDeps,
  type CanvasSceneRendererDeps,
} from './render/sceneRenderer';
export {
  createSceneRenderBuffer,
  syncSceneRenderBufferFromDocument,
  syncSceneRenderBufferIncremental,
  getSharedSceneRenderBuffer,
  resetSharedSceneRenderBuffer,
  isSoaCanvasShapesEnabled,
  isSoaWebglEnvEnabled,
  setSoaCanvasShapesEnabledForTests,
  isSoaCanvasEligible,
  isSoaBasicGeomSufficient,
  soaStrokeWidth,
  SOA_DEFAULT_STROKE_WIDTH,
  hitTestSoaBuffer,
  hitTestSoaBufferOrdered,
  hitTestSoaSlot,
  hitSoaRoundedRectLocal,
  hitSoaPolylineFill,
  soaPointToLocalBox,
  forEachVisibleInRect,
  applySoaHostInkFlags,
  bulkRemoveSoaByIds,
  allocateSoaSlot,
  compactSoaFreeSlots,
  bulkUpsertSoaQuadtree,
  bulkInsertSoaFromDocument,
  markSoaDirty,
  markSoaDirtyById,
  upsertSoaGeom,
  paintSoaBufferBasic,
  markAllSoaDirty,
  packCssColor,
  unpackCssColor,
  SOA_FLAG_VISIBLE,
  SOA_FLAG_CANVAS_IDLE,
  SOA_FLAG_BASIC_GEOM,
  SOA_FLAG_ATLAS_STAMP,
  SOA_FLAG_FREE,
  SOA_KIND_RECT,
  SOA_KIND_ELLIPSE,
  SOA_KIND_LINE,
  SOA_KIND_PATH,
  rebuildSoaPathSamples,
  type SceneRenderBuffer,
} from './render/sceneRenderBuffer';
export {
  sampleSoaPathPolyline,
  densifySoaPathD,
  pathDLooksClosed,
  sampleSoaArc,
  SOA_PATH_MAX_PTS,
  SOA_PATH_CLOSED_MAX_PTS,
  SOA_PATH_CURVE_STEP,
} from './render/soaPathSamples';
export {
  createSoaWebglAtlas,
  stampImageToAtlas,
  evictSoaAtlasOldest,
  releaseSoaAtlasRegion,
  releaseSoaAtlasPrefix,
  pruneSoaAtlasForBuffer,
  getSoaAtlasStats,
  isSoaWebglAtlasEnabled,
  SOA_ATLAS_SEG_THRESHOLD,
  SOA_ATLAS_CELL,
  SOA_ATLAS_INNER,
  idleMediaNeedsSharpHost,
  idleMediaScreenEdgePx,
} from './render/webglInstanceAtlas';
export {
  resolvePaintIntent,
  paintIntentNeedsDomHost,
  backingInsufficientForAtlas,
  getPaintIntentDebugStats,
  resetPaintIntentDebugStats,
  type PaintIntent,
} from './render/paintIntent';
export {
  subscribeSoaBakeTileReady,
  collectReadySoaBakeTilesForView,
  SOA_BAKE_COUNT_THRESHOLD,
  SOA_BAKE_NEW_TILES_PER_FRAME,
  SOA_BAKE_ASYNC_MAX_INFLIGHT,
  SOA_BAKE_TILE_WORLD,
  getSoaBakeCountThreshold,
  getSoaBakeTileWorld,
  shouldUseSoaBake,
  countSoaBakeEligibleSlots,
  isSoaBakePathAllowed,
  setSoaCameraGestureActive,
  isSoaCameraGestureActive,
  ensureSoaBake,
  tilesForView,
  invalidateSoaBakeTilesForElements,
  bindSoaBakeElementTiles,
  unbindSoaBakeElement,
  resetSharedSoaBake,
} from './render/soaBakeLayer';
export {
  createRenderDemotionScheduler,
  type RenderDemotionScheduler,
  type RenderHint,
  type RenderDemotionSink,
} from './render/renderDemotionScheduler';
export {
  createWebglSceneRenderer,
  collectSoaWebglInstances,
} from './render/webglSceneRenderer';
export {
  getGpuDepthOfFieldParams,
  setGpuDepthOfFieldParams,
  resetGpuDepthOfFieldParams,
  subscribeGpuDepthOfField,
  isGpuDofEnvEnabled,
  shouldRunGpuDepthOfField,
  resolveGpuDofBackend,
  circleOfConfusionPx,
  buildNormalizedDepthLookup,
  gpuDofSkipsSoaTileBake,
  type GpuDepthOfFieldParams,
  type GpuDofBackend,
} from './render/gpuDepthOfField';
export {
  RcbSpatialIndex,
  SceneSpatialRuntime,
  boxesIntersect,
  nodeSceneAabb,
  getSharedSceneSpatialRuntime,
  setSharedSceneSpatialRuntime,
  type RcbSpatialItem,
} from './core/spatialIndex';
export { SoaQuadtree, type SoaQuadItem } from './core/soaQuadtree';
export {
  clearNodeTransformPreviews,
  effectivePaintBox,
  getNodeTransformPreview,
  hasNodeTransformPreviews,
  listNodeTransformPreviewIds,
  setNodeTransformAngles,
  setNodeTransformHidden,
  setNodeTransformPreviews,
  subscribeTransformPreview,
  type EffectivePaintBox,
  type NodeTransformPreview,
  type NodeTransformPreviewPatch,
} from './core/transformPreview';
export {
  rcbCenterOnPoint,
  rcbFitImageIntoViewport,
  rcbLayoutGeneratorPlate,
  generatorEmptyIconSize,
  generatorEmptyIconVisible,
  RCB_PLACE_TEXT_SCREEN_PX,
  RCB_PLACE_STROKE_SCREEN_PX,
  rcbDefaultPlaceFontSize,
  rcbPlaceTextFontSize,
  rcbPlaceStrokeWidth,
  GENERATOR_EMPTY_STROKE_OUTSET,
} from './core/layout';

export {
  RcbCameraContext,
  RcbCameraMotionContext,
  RcbOverlayRootContext,
  RcbViewportElContext,
  RcbDevicePixelRatioContext,
  useRcbCamera,
  useRcbCameraMotion,
  useRcbOverlayRoot,
  useRcbViewportEl,
  useRcbDevicePixelRatio,
  useRcbScreenToScene,
  useRcbScreenToolbarStyle,
  RcbOverlayPortal,
} from './camera/context';
export type { RcbCameraMotion } from './camera/context';

export {
  snapCssToDevicePixel,
  snapSceneStrokeAxis,
  toDomPrecision,
  readDevicePixelRatio,
  subscribeDevicePixelRatio,
} from './core/dpr';

export { default as RcbCanvas, zoomAtPoint } from './canvas/RcbCanvas';
export type { RcbCanvasProps } from './canvas/RcbCanvas';
export { default as RcbSvgDefs } from './canvas/RcbSvgDefs';
export { getSvgBoard, setSvgBoard, type SvgBoardHandle } from './canvas/svgBoardRegistry';
export { useSvgBoard } from './canvas/useSvgBoard';

// Per-shape SVG paint hosts (runtime — not document store)
export { default as RcbShapesLayer } from './shapes/RcbShapesLayer';
export { default as RcbShapeHost } from './shapes/RcbShapeHost';
export {
  getShapeHost,
  listShapeHosts,
  registerShapeHost,
  unregisterShapeHost,
  setSharedNodeEls,
  getSharedNodeEls,
  replaceShapePaint,
  shapeHostRevealsOverflow,
  type ShapeHostHandle,
  type SceneHostEl,
} from './shapes/shapeHostRegistry';

// Tools
export { default as ShapeDrawFeature } from './tools/ShapeDrawFeature';
export type { ShapeDrawCommit } from './tools/ShapeDrawFeature';
export { default as PenDrawFeature } from './tools/PenDrawFeature';
export { default as PenPathEditFeature } from './tools/PenPathEditFeature';
export { default as PencilDrawFeature } from './tools/PencilDrawFeature';
export { PENCIL_CURSOR, PEN_CURSOR, BUCKET_CURSOR } from './tools/PencilDrawFeature';
export { default as BucketFillFeature } from './tools/BucketFillFeature';
export { default as TextPlaceFeature } from './tools/TextPlaceFeature';
export { default as ImagePlaceFeature } from './tools/ImagePlaceFeature';
export * from './tools/penPath';
export * from './tools/pencilBrushes';

// Selection engine + chrome (toolbars/menus under selection/chrome/)
export { default as SelectionFeature } from './selection/SelectionFeature';
export { default as SelectionChrome, WorldSvgFrame } from './selection/SelectionChrome';
export { default as SelectionContextToolbar } from './selection/chrome/SelectionContextToolbar';
export { default as MultiSelectionToolbar } from './selection/chrome/MultiSelectionToolbar';
export { default as CanvasContextMenu } from './selection/chrome/CanvasContextMenu';
export { default as BrushOverlay } from './selection/chrome/BrushOverlay';
export {
  resizeFromHandle,
  rotateBoxesAround,
  scaleBoxesToUnion,
  unionOfBoxes,
  type ResizeHandle,
} from './selection/resizeGeometry';
export * from './selection/alignGuides';
export * from './selection/shapeBoolean';
export * from './selection/rotateCornerCursor';
export * from './selection/chrome/SelectionToolbarShell';

// Frames
export { default as HtmlArtboardFrame } from './frames/HtmlArtboardFrame';
export { default as FrameDrawFeature } from './frames/FrameDrawFeature';
export { default as FrameMoveFeature } from './frames/FrameMoveFeature';
export type { ArtboardFrame } from './frames/types';

// Document node types (persistent scene JSON)
export type {
  SceneNode,
  SceneNodeInput,
  SceneNodeKey,
  SceneNodeAttrs,
  SceneDocument,
  SceneDocumentParsed,
  SceneDeltaSet,
  ScenePage,
  CreatedSceneNode,
  ValidateSceneDocumentResult,
} from './sceneNode';
export {
  isSceneNode,
  SceneDocumentSchema,
  SceneNodeSchema,
  SceneDeltaSetSchema,
  SceneRootNodeSchema,
  validateSceneDocument,
  parseAndValidateSceneJson,
  coerceSceneDocumentInput,
} from './sceneNode';
export type { SceneNodeRef } from './scene/document/nodeCapabilities';
export {
  stackPaintZ,
  stackPaintMaxZ,
  stackPaintNaturalZ,
  syncStackPaintOrder,
} from './scene/document/sceneStackPainter';
