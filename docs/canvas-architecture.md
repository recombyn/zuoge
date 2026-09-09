# Canvas architecture (RCB)

RCB is zuoge’s infinite vector canvas. Source of truth for code: `apps/web/src/components/rcb` + `apps/web/src/components/editor/canvas`.

**Current status (2026-09-07):** Product idle-ink **SoA / WebGL mesh path is removed**. Live stage mounts **CanvasKit** via `KitCanvasHost` / `mountCore` (`vendor/vector-editor-ref` → `@rcb-vector`). Authoring tools still write **`SceneDocument`** through RCB features (`ShapeDrawFeature`, `PenDrawFeature`, `PencilDrawFeature`, `FrameDrawFeature`, …). Kit is the paint underlayer; full Kit ↔ SceneDocument sync is **not** the product SoT yet. Kit surface uses `pointer-events: none` so RCB tools own input.

## Stack

| Layer | Role | Primary paths |
|-------|------|----------------|
| Stage shell | Camera, frames, product canvas | `editor/page/EditorStageWorld.tsx` |
| Camera / pan-zoom | Infinite world (`zoom` ~0.05–100); **CameraTransform** is the sole world↔screen API | `rcb/canvas/RcbCanvas.tsx`, `rcb/core/math.ts`, `rcb/camera/transform.ts` |
| Kit underlayer | Rust/WASM + CanvasKit scene/render (idle vector surface) | `rcb/canvas/KitCanvasHost.tsx`, `mountCore.ts`, `toolMap.ts` |
| SceneRenderer | Hit + Canvas2D **grid** / Vitest helpers (not product SoA ink) | `rcb/render/sceneRenderer.ts` |
| Product canvas | Tools, media overlays, store writes; hit via SceneRenderer | `editor/canvas/SvgCanvas.tsx` |
| Pixel grid | Grid on `[data-rcb-scene-canvas]` | `RcbCanvas` + `createCanvasSceneRenderer` |
| Shape / FO hosts | Artboard plates + DOM hosts by `stackOrder` | `rcb/shapes/RcbShapesLayer.tsx`, `RcbShapeHost.tsx`, `frames/HtmlArtboardFrame.tsx`, `scene/document/sceneStackPainter.ts` |
| Demotion | DOM host hold vs idle (`ACTIVE_SVG` → `CANDIDATE` → `DEPLOYED_IDLE`) | `render/renderDemotionScheduler.ts` |
| Selection chrome | Shared scene SVG camera group for AABB, path silhouette, knobs, guides, draw previews | `rcb/selection/SelectionChrome.tsx`, `HostPathChrome.tsx` |
| Transform gestures | Live preview → commit SceneDocument | `core/transformPreview.ts`, `SelectionFeature`, `canvasSession` |
| Pointer hit | QT → permanent `stackOrder` → Path2D/AABB/plate | `hitTestWithSpatialIndex`, `sceneHitBridge.ts`, `SceneSpatialRuntime` (`SceneQuadtree`) |
| Document model | Types + Zod | `rcb/sceneNode.ts`, `packages/scene-schema` |
| Vector geom (WASM) | Densify / boolean / stroke offset / text contour (mesh tessellate retired for product ink) | `packages/rcb-wasm-geom`, `rcb/render/vector/wasmGeom.ts`, `outlineToPath.ts`, `shapeBoolean.ts` |
| Mutations | normalize / stack / CRUD | `rcb/scene/document/sceneDocument.ts` |
| Live state | `document`, selection, tools | `store/modules/editor.ts` |
| Undo / collab | History + Yjs | `store/modules/editorHistory.ts`, `editor/collab/*` |

**Fact layer (ADR 0027):** `SceneDocument` + `CameraTransform` + `SceneSpatialRuntime`. SVG/`sceneToSvg` is export + transitional FO/host paint — not the interaction substrate for basic vectors.

**Normative constraints (hit / camera):** [ADR 0027](./adr/0027-canvas-layered-runtime.md) — one CameraTransform, one hit pipeline (QT → permanent stackOrder → precise), visual = hit = lattice.

## Document shape

`SceneDocument` (see also [scene-json-spec.md](./scene-json-spec.md)):

- **`deltaSetLike`**: flat `id → SceneNode` map; `ROOT.children` (or page children) lists top-level nodes
- **`frames`**: **artboards** (fixed design plates). Not the camera **viewport**. Paint order unified in **`stackOrder`** (`frame:id` | `node:id`, bottom → top)
- Node fields: `id`, `key`, `x/y/width/height`, `attrs`, `children[]`
- **Canonical attrs (current writers):** `'fill-color'`, `'border-color'` / stroke via `resolveStroke`; blend via `blendMode`; skew via `skewX` + `skewAxis`
- **Frame `kind`:** `'artboard'` | `'animation'`
- **`coordSpace: 'frameLocal'`**: nodes with `attrs.frameId` store plate-local `x/y`

There is **no hard max node count** on the document. Capacity is governed by paint/hit budgets.

## Paint model (what you see)

### Pixel grid → Canvas2D grid surface

At ≥ `PIXEL_GRID_MIN_ZOOM` (~800%), `RcbCanvas` paints the lattice on `[data-rcb-scene-canvas]` via `createCanvasSceneRenderer` / `drawSceneGrid`.

**Paint stack (current):**

```text
grid (Canvas2D) → Kit (CanvasKit underlayer) → stack by stackOrder (plates + FO hosts) → chrome
```

Kit host: `[data-rcb-kit-surface="1"]`, `pointer-events: none` until Kit owns product input + SceneDocument sync.

**Idle / hosts:** canvas-capable vectors are intended for Kit idle ink. DOM hosts (`RcbShapeHost`) remain for FO media, SoftGlow, live editors, lottie/group, heavy paths, and stack promotion above plates. SoftGlow/editors use `RenderDemotionScheduler` (`ACTIVE_SVG` → `CANDIDATE` → `DEPLOYED_IDLE`).

### Retired (do not restore)

These modules and product paths are **gone** — do not reintroduce:

- `sceneRenderBuffer.ts`, `soaBakeLayer.ts`, `webglSceneRenderer.ts`, `webglInstanceAtlas.ts`
- `artboardWebglInk.ts`, `artboardInkTiles.ts`, `artboardInkSurface.ts`
- WebGL mesh pipeline (`meshCache`, product `tessellateFill`/`Stroke` ink path, `gpuDepthOfField`)

Spatial index remains as `SceneQuadtree` (renamed from SoA QT) inside `SceneSpatialRuntime` for **hit/cull only**.

## Hit model

Ideal product hit (ADR 0027):

1. Overlay / chrome seats
2. `SceneSpatialRuntime` QT (`searchPoint`, nodes + `frame:id`)
3. Permanent `stackOrder` top-first
4. Precise Path2D / AABB / plate

## Authoring tools

Enabled product writers (SceneDocument):

- `ShapeDrawFeature`, `PenDrawFeature`, `PencilDrawFeature`, `TextPlaceFeature`, `FrameDrawFeature`, …
- Wired from `SvgCanvas.tsx` / `EditorStageWorld.tsx`

## Related docs

- [ADR 0027](./adr/0027-canvas-layered-runtime.md) — layered runtime (historical WebGL/SoA sections superseded by this note)
- [scene-json-spec.md](./scene-json-spec.md)
- [web-frontend.md](./web-frontend.md)
