# ADR 0027: Scene + camera + layered render + independent hit

- **Status:** Accepted (paint path **partially superseded**)
- **Date:** 2026-08-15
- **Updated:** 2026-09-07 — **Retired product SoA buffer + world/artboard WebGL mesh ink.** Stage mounts CanvasKit via `rcb/canvas/KitCanvasHost` + `mountCore` (`@rcb-vector`). Authoring still commits `SceneDocument` through RCB draw features; Kit is underlayer (`pointer-events: none`) until scene sync lands. See [canvas-architecture.md](../canvas-architecture.md). Prior: 2026-09-06 plate-bound selection/reveal; 2026-09-05 ArtboardLayer WebGL blit; 2026-09-04 artboard small canvas + world WebGL unbound-only.
- **Supersedes (partial):** [ADR 0002](./0002-canvas-rcb-runtime.md) runtime paint/hit coupling — RCB ownership stays; SVG is no longer the editor runtime fact layer.

## Context

RCB already owns `SceneDocument`, camera math (`rcb/core/math.ts`), and `SceneSpatialRuntime`. Live editing previously coupled **paint, hit-testing, and selection chrome** through SVG/DOM:

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
   grid (Canvas2D) → Kit (CanvasKit underlayer) → stack by stackOrder (plates + FO hosts) → chrome
   ```

   - **Kit / CanvasKit** (`KitCanvasHost` / `mountCore`) is the product idle vector surface. Do **not** restore SoA typed-array buffers, world WebGL instancing, or `artboardInkSurface` WebGL blit.
   - **DOM hosts** for FO media, SoftGlow, editors, lottie/group, heavy paths, and stack promotion above plates.
   - **Grid** stays on a separate Canvas2D surface. Selection, guides, and drawing previews share the camera surface; screen UI stays in the HTML overlay.
   - SoftGlow/editors use `RenderDemotionScheduler` (`ACTIVE_SVG` → `CANDIDATE` → `DEPLOYED_IDLE`).
   - **Forbidden:** reintroducing `sceneRenderBuffer` / `webglSceneRenderer` / artboard WebGL ink as the product path.

4. **Independent hit** — root pointer capture → chrome hit → **one** `SceneSpatialRuntime` QT (`searchPoint`, nodes + `frame:id` plates) → permanent `stackOrder` top-first → first precise geometry or plate AABB (`hitTestUnifiedStackAtPoint`). Frame picks return `__frame__:id`. `sceneToSvg` stays an **export** path, not the live paint core.

SVG is not the editor runtime fact layer. Fact layer = `SceneDocument` + `CameraTransform` + `SceneSpatialRuntime`. Demotion host-release uses one shared wake over `lastActive` timestamps; TransformPreview uses dirty AABB + live filter + threshold rebuild (not per-frame QT upsert).

### Product layers (current)

| # | Layer | Role |
|---|--------|------|
| 1 | Kit underlayer | CanvasKit idle vector surface |
| 2 | Demotion + host viewport cull | DOM budget; who stays SVG host |
| 3 | Stack plates + FO hosts | Artboards + media/editors by `stackOrder` |
| 4 | Grid Canvas2D | Pixel grid only |
| 5 | Hit QT (`SceneQuadtree`) | Broad-phase for pick / cull |
| 6 | RCB draw tools | Authoring → SceneDocument |
| 7 | Export SVG | `sceneToSvg` / raster export |

### Historical (retired 2026-09-07)

Former default-on path used `sceneRenderBuffer`, `webglSceneRenderer`, `soaBakeLayer`, and `artboardInkSurface`. Those files are deleted. Do not implement new work against that stack.

## Consequences

- Authoring remains SceneDocument-first until Kit scene sync is productized.
- Density / sharpness targets move with CanvasKit, not SoA mesh restamp.
- Prefer [canvas-architecture.md](../canvas-architecture.md) for the live map; older paragraphs in sibling docs that still say “SoA canvas ink” are stale.

## References

- `apps/web/src/components/rcb/canvas/KitCanvasHost.tsx`
- `apps/web/src/components/rcb/canvas/mountCore.ts`
- `apps/web/src/components/rcb/render/sceneRenderer.ts`
- `apps/web/src/components/rcb/core/spatialIndex.ts` / `sceneQuadtree.ts`
- [canvas-architecture.md](../canvas-architecture.md)
