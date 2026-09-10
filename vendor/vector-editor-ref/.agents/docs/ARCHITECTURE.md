# Architecture Overview

> **Audience**: AI agents and developers working on this codebase.

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| **Engine** | Rust → WASM (wasm-bindgen) | Scene graph, transforms, hit-testing, serialization |
| **Rendering** | CanvasKit (Skia WASM) | GPU-accelerated 2D rendering |
| **Frontend** | TypeScript + Vite | UI, input handling, tools, panels |
| **Persistence** | IndexedDB + Protobuf | Local autosave/restore |
| **Package Manager** | pnpm | Dependency management |

### Key Dependencies

**Rust (engine)**:
- `glam` — 3×3 matrix math (transforms)
- `rstar` — R-tree spatial index
- `serde` / `serde_json` — JSON serialization
- `prost` — Protobuf encoding (persistence)
- `bincode` — Binary serialization
- `geo` — Geometric operations (boolean ops)
- `ordered-float` — Float ordering for spatial ops

**TypeScript**:
- `canvaskit-wasm 0.39.1` — Skia rendering
- `vite` — Build tool / dev server
- `vitest` — Test runner

---

## Module Map

```
vector-editor/
├── engine/                     # Rust WASM engine
│   ├── Cargo.toml
│   ├── src/
│   │   ├── lib.rs              # Core: Scene, Node, Engine, hit-testing, all mutations
│   │   ├── proto.rs            # Protobuf serialization for persistence
│   │   └── vector_network.rs   # Experimental vector network graph
│   └── pkg/                    # wasm-pack output (Engine, History classes)
│
├── src/                        # TypeScript frontend
│   ├── main.ts                 # Entry point — boots CanvasKit, inits WasmScene, starts render loop
│   ├── types.ts                # TypeScript mirrors of Rust types (SceneData, SceneNode, etc.)
│   ├── wasm_scene.ts           # Facade class over the WASM Engine (all mutations go through here)
│   ├── renderer.ts             # CanvasKit/Skia rendering pipeline
│   ├── input.ts                # Input handling & tool state machine (selection, pen, shapes, etc.)
│   ├── ui.ts                   # UI panels (layers, properties, toolbar, context menu)
│   ├── context_bar.ts          # Floating contextual toolbar for style editing
│   ├── context.ts              # Global editor context/state management
│   ├── file_io.ts              # SVG/JSON import/export
│   ├── svg_utils.ts            # SVG ↔ scene conversion utilities
│   ├── svg_utils.test.ts       # Tests for SVG utilities
│   ├── boolean_ops.ts          # Boolean path operations (union, intersect, difference, xor)
│   ├── align.ts                # Alignment operations (left, center, right, top, middle, bottom)
│   ├── icons.ts                # Lucide icon SVG strings for UI
│   └── persistence.ts          # IndexedDB save/load + autosave manager
│
├── index.html                  # Single-page app shell
├── style.css                   # Global styles
├── vite.config.ts              # Vite configuration
└── tsconfig.json               # TypeScript config
```

---

## Data Flow

### Rendering Pipeline

```
                    ┌─────────────┐
                    │ Engine      │
                    │ (Rust/WASM) │
                    └──────┬──────┘
                           │ getSceneData() → JSON
                           │ getTransform(id) → Float32Array
                           │ getVisibleNodes(viewport) → Uint32Array
                           ▼
                    ┌──────────────┐
                    │ WasmScene    │
                    │ (cache layer)│
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────────┐
                    │ Renderer         │
                    │ (CanvasKit/Skia) │
                    │                  │
                    │ 1. Clear canvas  │
                    │ 2. Apply camera  │
                    │ 3. For each node:│
                    │    - get global  │
                    │      transform   │
                    │    - draw shape  │
                    │    - cache as    │
                    │      SkPicture   │
                    │ 4. Draw overlays │
                    │    (selection,   │
                    │     guides, etc.)│
                    └──────────────────┘
```

### Mutation Flow

```
User Action (mouse/keyboard)
        │
        ▼
    input.ts (tool logic)
        │
        ▼
    wasm_scene.ts
        │
        ├─→ saveHistory()  (serialize scene → push to History)
        ├─→ engine.mutation()  (Rust side)
        ├─→ invalidateCache()  (mark SceneData stale)
        └─→ autosave.trigger()  (debounced 2s → IndexedDB)
```

### Input → Tool → Mutation Example

```
mouseDown on canvas
    │
    ▼
input.ts: handleMouseDown()
    │
    ├─ If SelectTool:
    │   ├─ wasm_scene.hitTest(x, y) → node ID
    │   ├─ wasm_scene.selectNode(id, shiftKey)
    │   └─ Start drag tracking
    │
    ├─ If RectTool:
    │   ├─ Record start point
    │   └─ On mousemove/mouseup: wasm_scene.addRect(x, y, w, h)
    │
    └─ If PenTool:
        ├─ Add point to in-progress path
        └─ On double-click/close: wasm_scene.addPath(pointsJson)
```

---

## Tool System

Tools are managed as an enum/state in [input.ts](packages/editor/src/input.ts):

| Tool | Description |
|---|---|
| Select | Click to select, drag to move, handles for resize/rotate |
| Rect | Click-drag to create rectangles |
| Ellipse | Click-drag to create ellipses |
| Pen/Bézier | Click to add corners, click-drag for smooth curves |
| Polygon | Create regular polygons |
| Star | Create star shapes |
| Text | Click to place text elements |
| Hand | Pan the canvas |

Each tool captures `mousedown`, `mousemove`, `mouseup`, and `keydown` events, with tool-specific state machines.

---

## UI Panels

[ui.ts](packages/editor/src/ui.ts) manages:

| Panel | Function |
|---|---|
| **Toolbar** | Tool selection (left sidebar) |
| **Layers Panel** | Tree view of scene graph with visibility/lock toggles |
| **Properties Panel** | Position, size, rotation, style editors |
| **Context Bar** | Floating bar with quick style actions for selected nodes |
| **Context Menu** | Right-click menu (copy, paste, delete, z-order, group, etc.) |

---

## Boolean Operations

[boolean_ops.ts](packages/editor/src/boolean_ops.ts) implements:

| Operation | Description |
|---|---|
| Union | Combine shapes into one |
| Difference | Subtract one shape from another |
| Intersect | Keep only overlapping region |
| XOR | Keep non-overlapping regions |

These extract path geometry from selected nodes, compute the boolean result using geometric algorithms, and call `wasm_scene.replaceNodesWithPath()` to atomically swap the source nodes for the result path.

---

## File I/O

[file_io.ts](packages/editor/src/file_io.ts) supports:

| Format | Import | Export |
|---|---|---|
| SVG | ✅ Parse SVG → scene nodes | ✅ Scene → SVG string |
| JSON | ✅ Raw scene JSON | ✅ `get_scene_json()` |
| PNG | ❌ | ✅ Canvas rasterization |

SVG conversion is handled by [svg_utils.ts](packages/editor/src/svg_utils.ts) which maps between SVG elements/attributes and the engine's node model.

---

## Alignment

[align.ts](packages/editor/src/align.ts) provides:

- Align Left / Center / Right
- Align Top / Middle / Bottom
- Distribute Horizontally / Vertically

All alignment operates on the current selection's bounding boxes and calls `wasm_scene.setNodePosition()` for each affected node.
