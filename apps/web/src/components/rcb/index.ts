/**
 * @rcb — canvas UI: camera, tools, selection, frames.
 * Prefer `import { … } from '@/components/rcb'`.
 *
 * Layout: `rcbCenterOnPoint` / `rcbFitImageIntoViewport` / `rcbLayoutGeneratorPlate`.
 * Kit owns ink hit / select / marquee / move / resize.
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
  getFillImageReady,
  setFillImageCacheEntry,
  clearFillImageCache,
  canvasPixelsReadable,
  isFillImageCorsUnsafe,
  imageSourceSize,
} from './scene/media/fillImageCache';
export {
  resolvePaintIntent,
  paintIntentNeedsDomHost,
  type PaintIntent,
} from './shapes/paintIntent';
export {
  boxesIntersect,
  nodeSceneAabb,
  frameSceneAabb,
  buildIdRankMap,
  sortIdsByRank,
  type SceneAabb,
} from './scene/layout/nodeAabb';
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
export {
  default as KitCanvasHost,
  getCanvasEngine,
  setEngineToolFromRcb,
} from './canvas/KitCanvasHost';
export {
  rcbToolToEngine,
  resolveEngineTool,
  ENGINE_DRAW_TOOLS,
  kitOwnsStagePointer,
  PENCIL_CURSOR,
  PEN_CURSOR,
  BUCKET_CURSOR,
} from './canvas/toolMap';
export type { CanvasEngineHandle } from './canvas/mountCore';
export { getDomHostBoard, setDomHostBoard, type DomHostBoardHandle } from './canvas/domHostBoardRegistry';
export { useDomHostBoard } from './canvas/useDomHostBoard';
export { hitTestRcbIdFromKit } from './canvas/kitBridge';
export {
  enterKitPathEditForRcbId,
  exitKitPathEdit,
  kitRcbIdBeingPathEdited,
  placeKitImageFromUrl,
  syncKitLivePaintFromBucketFill,
  runKitBooleanOp,
  undoKit,
  redoKit,
  groupKitSelection,
  ungroupKitSelection,
  rcbIdsAllKitMapped,
  selectionUsesKitClipboard,
} from './canvas/kitBridge';

// Per-shape DomHost mounts (runtime — not document store)
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

// Selection chrome (HTML toolbars/menus). Kit owns handles / marquee / move / resize.
export { default as SelectionFeature } from './selection/SelectionFeature';
export { CHROME_STROKE_PX } from './selection/chromeMetrics';
export { liveShapeGeomBox } from './selection/hostGeom';
export { default as SelectionContextToolbar } from './selection/chrome/SelectionContextToolbar';
export { default as MultiSelectionToolbar } from './selection/chrome/MultiSelectionToolbar';
export { default as CanvasContextMenu } from './selection/chrome/CanvasContextMenu';
export {
  unionOfBoxes,
  type ResizeHandle,
} from './selection/resizeGeometry';
export * from './selection/alignGuides';
export * from './selection/shapeBoolean';
export * from './selection/chrome/SelectionToolbarShell';

// Frames
export { default as HtmlArtboardFrame } from './frames/HtmlArtboardFrame';
export type { ArtboardFrame } from './frames/types';
export {
  frameIdAtPoint,
  frameForFullBleedPlate,
  FRAME_SEL_PREFIX,
  frameSelId,
  parseFrameSelId,
} from './frames/frameSceneQuery';

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
