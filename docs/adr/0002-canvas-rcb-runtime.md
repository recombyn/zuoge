# ADR 0002: Custom RCB canvas runtime

- **Status:** Accepted (runtime layering refined by [ADR 0027](./0027-canvas-layered-runtime.md))
- **Date:** 2026-08-12

## Context

The product needs an infinite multi-artboard canvas with dense vector ink, freehand paths, media nodes, and AI tool-ops — not a generic whiteboard SDK.

## Decision

Own a **Resume Canvas Backend (RCB)** runtime under `apps/web/src/components/rcb` + `editor/canvas`, with document model in `rcb/scene` / `packages/scene-schema`. The Zustand editor store (`store/modules/editor.ts`) is the live document owner; SvgCanvas hosts tools and media overlays.

**Runtime fact layer** (paint / hit / chrome) is specified in [ADR 0027](./0027-canvas-layered-runtime.md): `SceneDocument` + `CameraTransform` + spatial index — SVG is export and transitional host paint (text / media / editors); basic vectors paint via CanvasKit (`KitCanvasHost`).

Detailed behavior: [docs/canvas-architecture.md](../canvas-architecture.md).

## Consequences

### Positive

- Full control of paint/hit budgets, selection chrome, and agent apply-ops.
- Can evolve without upstream whiteboard SDK constraints.

### Negative / trade-offs

- Higher maintenance vs adopting an off-the-shelf whiteboard SDK.
- New contributors need the canvas architecture doc.

## Alternatives considered

1. **Fork a generic whiteboard SDK** — rejected for product-specific artboards, generators, and agent ops.
2. **Pure SVG without RCB layer** — insufficient for dense canvas ink budgets and collab bridge.

## References

- `docs/canvas-architecture.md`
- `docs/scene-json-spec.md`
