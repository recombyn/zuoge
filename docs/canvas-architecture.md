# Canvas architecture (RCB)

RCB is zuoge’s infinite vector canvas. Source of truth for code: `apps/web/src/components/rcb` + `apps/web/src/components/editor/canvas`.

**Current status (2026-09-10):** Live stage mounts **CanvasKit** via `KitCanvasHost` / `mountCore` (`vendor/vector-editor-ref` → `@rcb-vector`). Authoring tools write **`SceneDocument`** through RCB features (`ShapeDrawFeature`, `PenDrawFeature`, `PencilDrawFeature`, `FrameDrawFeature`, …). Kit is the idle vector underlayer; `kitBridge` mirrors geometry / style / selection between Kit and the document. FO media, SoftGlow, and live editors stay on DOM hosts.

## Stack

| Layer | Role | Primary paths |
|-------|------|----------------|
| Stage shell | Camera, frames, product canvas | `editor/page/EditorStageWorld.tsx` |
| Camera / pan-zoom | Infinite world (`zoom` ~0.05–100); **CameraTransform** is the sole world↔screen API | `rcb/canvas/RcbCanvas.tsx`, `rcb/core/math.ts`, `rcb/camera/transform.ts` |
| Kit underlayer | Rust/WASM + CanvasKit scene/render + doc mirror | `rcb/canvas/KitCanvasHost.tsx`, `mountCore.ts`, `kitBridge.ts`, `toolMap.ts` |
| Product canvas | Tools, media overlays, store writes | `editor/canvas/SvgCanvas.tsx` |
| Shape / FO hosts | Artboard plates + DOM hosts by `stackOrder` | `rcb/shapes/RcbShapesLayer.tsx`, `RcbShapeHost.tsx`, `frames/HtmlArtboardFrame.tsx` |
| Selection chrome | AABB, path silhouette, knobs, guides, draw previews | `rcb/selection/SelectionChrome.tsx`, `HostPathChrome.tsx` |
| Transform gestures | Live preview → commit SceneDocument | `core/transformPreview.ts`, `SelectionFeature`, `canvasSession` |
| Pointer hit | Kit hit + RCB chrome seats / plate AABB | `kitBridge` hit helpers, selection chrome |
| Document model | Types + Zod | `rcb/sceneNode.ts`, `packages/scene-schema` |
| Vector geom (WASM) | Densify / boolean / stroke offset / text contour | `packages/rcb-wasm-geom`, `outlineToPath.ts`, `shapeBoolean.ts` |
| Mutations | normalize / stack / CRUD | `rcb/scene/document/sceneDocument.ts` |
| Live state | `document`, selection, tools | `store/modules/editor.ts` |
| Undo / collab | History + Yjs | `store/modules/editorHistory.ts`, `editor/collab/*` |

**Fact layer (ADR 0027):** `SceneDocument` + `CameraTransform` + Kit scene. SVG/`sceneToSvg` is export + transitional FO/host paint — not the interaction substrate for basic vectors.

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

**Paint stack (current):**

```text
grid (when enabled) → Kit (CanvasKit underlayer) → stack by stackOrder (plates + FO hosts) → chrome
```

Kit host: `[data-rcb-kit-surface="1"]`. Product input is coordinated through Kit + RCB chrome; FO overlays remain HTML.

**Idle / hosts:** canvas-capable vectors paint via Kit. DOM hosts (`RcbShapeHost`) remain for FO media, SoftGlow, live editors, lottie/group, and stack promotion above plates.

### Do not restore

These product paths are **gone** — do not reintroduce typed-array bake buffers, world WebGL instancing, or artboard WebGL ink as the product path.

## Authoring tools

Enabled product writers (SceneDocument):

- `ShapeDrawFeature`, `PenDrawFeature`, `PencilDrawFeature`, `TextPlaceFeature`, `FrameDrawFeature`, …
- Wired from `SvgCanvas.tsx` / `EditorStageWorld.tsx`

Context-menu **Generators**: image / video / audio only (animation + Lottie are separate tools).

## Related docs

- [ADR 0027](./adr/0027-canvas-layered-runtime.md) — layered runtime
- [scene-json-spec.md](./scene-json-spec.md)
- [web-frontend.md](./web-frontend.md)
