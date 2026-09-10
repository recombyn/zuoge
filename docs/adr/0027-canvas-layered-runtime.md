# ADR 0027: Scene + camera + layered render + independent hit

- **Status:** Accepted
- **Date:** 2026-08-15
- **Updated:** 2026-09-10 — Product idle ink is **CanvasKit** (`KitCanvasHost` / `mountCore` / `kitBridge`). Authoring commits `SceneDocument` through RCB draw features; Kit mirrors geometry, style, and selection. See [canvas-architecture.md](../canvas-architecture.md).
- **Supersedes (partial):** [ADR 0002](./0002-canvas-rcb-runtime.md) runtime paint/hit coupling — RCB ownership stays; SVG is no longer the editor runtime fact layer.

## Context

RCB already owns `SceneDocument` and camera math (`rcb/core/math.ts`). Live editing previously coupled **paint, hit-testing, and selection chrome** through SVG/DOM:

- One world layer drove SVG + HTML via CSS `translate + scale`.
- Selection chrome / path handles mirrored host `viewBox` and used `1/zoom` counter-scale.
- Frequent `querySelector` / `getBoundingClientRect` / multi-surface z-index sync drifted under pan, zoom (5%–10_000%), and dense scenes.

SVG remains fine for export and moderate static paint. It must not remain the interaction and control-box substrate.

## Decision

Treat the editor runtime as four facts (**this is the product architecture — do not invent a parallel one mid-fix**):

1. **`SceneDocument`** — unique document source of truth (store / collab patches write here).
2. **`CameraTransform`** — single pan/zoom matrix; only `worldToScreen` / `stageLocalToWorld` / `screenDeltaToWorldDelta` on hot paths. No DOM “correction” of coordinates during gestures.
3. **Layered render** — paint order is:

   ```text
   grid (optional) → Kit (CanvasKit underlayer) → stack by stackOrder (plates + FO hosts) → chrome
   ```

   - **Kit / CanvasKit** (`KitCanvasHost` / `mountCore` / `kitBridge`) is the product idle vector surface.
   - **DOM hosts** for FO media, SoftGlow, editors, lottie/group, and stack promotion above plates.
   - Selection, guides, and drawing previews share the camera surface; screen UI stays in the HTML overlay.
   - **Forbidden:** reintroducing typed-array bake buffers, world WebGL instancing, or artboard WebGL ink as the product path.

4. **Independent hit** — root pointer capture → chrome seats → Kit / plate AABB pick. `sceneToSvg` stays an **export** path, not the live paint core.

SVG is not the editor runtime fact layer. Fact layer = `SceneDocument` + `CameraTransform` + Kit scene.
### Product layers (current)

| # | Layer | Role |
|---|--------|------|
| 1 | Kit underlayer | CanvasKit idle vector surface + `kitBridge` mirror |
| 2 | Stack plates + FO hosts | Artboards + media/editors by `stackOrder` |
| 3 | Grid (optional) | Pixel lattice when zoomed in |
| 4 | RCB draw tools | Authoring → SceneDocument |
| 5 | Export SVG | `sceneToSvg` / Kit raster export |

## Consequences

- Kit ↔ document mirror (`kitBridge`) is the live sync path for vectors; FO hosts stay document-first.
- Density / sharpness targets move with CanvasKit.
- Prefer [canvas-architecture.md](../canvas-architecture.md) for the live map.

## References

- `apps/web/src/components/rcb/canvas/KitCanvasHost.tsx`
- `apps/web/src/components/rcb/canvas/mountCore.ts`
- `apps/web/src/components/rcb/canvas/kitBridge.ts`
- [canvas-architecture.md](../canvas-architecture.md)
