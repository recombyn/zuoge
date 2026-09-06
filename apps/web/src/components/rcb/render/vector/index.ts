/**
 * Vector ink barrel — WASM/JS geom + mesh cache (no shape atlas bake).
 */
export {
  type InkBackend,
  isShapeInkKey,
  shapeInkForbidsAtlas,
} from '@/components/rcb/render/vector/inkBackend';
export { shapeGeomFingerprint } from '@/components/rcb/render/vector/geomFingerprint';
export {
  type Vec2,
  type ShapeContour,
  densifyPathD,
  contourFromNode,
} from '@/components/rcb/render/vector/contour';
export { tessellateFill, type FillMesh } from '@/components/rcb/render/vector/tessellateFill';
export { tessellateStroke, type StrokeMesh } from '@/components/rcb/render/vector/tessellateStroke';
export {
  getOrBuildShapeMesh,
  invalidateShapeMesh,
  clearShapeMeshCache,
  getShapeMeshCacheSize,
  type CachedShapeMesh,
} from '@/components/rcb/render/vector/meshCache';
export {
  ensureTextOutlineMesh,
  getTextOutlineMesh,
  invalidateTextOutlineMesh,
  clearTextOutlineMeshCache,
  textOutlineGeomFingerprint,
  type CachedTextOutlineMesh,
} from '@/components/rcb/render/vector/textOutlineMesh';
export {
  appendMeshLocal,
  type AppendMeshLocalOpts,
} from '@/components/rcb/render/vector/appendMesh';
export {
  initWasmGeom,
  preloadWasmGeom,
  getWasmGeomBackend,
  isWasmGeomReady,
  setWasmGeomForceJs,
  densifyPathDWasm,
  tessellateFillWasm,
  tessellateStrokeWasm,
  tessellateFillWithHolesWasm,
  tessellateBatchFill,
  buildShapeMeshes,
  buildCompoundFillMeshes,
  booleanPolygonsWasm,
  offsetPolylineWasm,
  simplifyRdpWasm,
  simplifyRdpClosedWasm,
  traceRgbaContoursWasm,
} from '@/components/rcb/render/vector/wasmGeom';
export { tessellateBatchFillAsync } from '@/components/rcb/render/vector/wasm/geomWorkerClient';
export {
  setGeomProfileEnabled,
  getGeomProfileSnapshot,
  resetGeomProfile,
  type GeomProfileSnapshot,
} from '@/components/rcb/render/vector/geomProfile';
export { tessellateFillWithHoles } from '@/components/rcb/render/vector/tessellateFill';
