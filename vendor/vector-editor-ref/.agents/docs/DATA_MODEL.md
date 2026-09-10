# Data Model Reference

> **Audience**: AI agents and developers working on this codebase.
> **Source of truth**: [engine/src/lib.rs](packages/editor/engine/src/lib.rs)

---

## High-Level Overview

The vector editor uses a **Rust/WASM engine** as the authoritative data store, with a **TypeScript frontend** that renders via CanvasKit (Skia) and manages UI/input. All scene data lives in the engine; the frontend reads it via JSON serialization and mutates it through imperative WASM-bindgen calls.

```
┌──────────────────────────────────────────────────────┐
│  TypeScript Frontend                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │ input.ts │  │  ui.ts   │  │  renderer.ts     │   │
│  │ (tools)  │  │ (panels) │  │  (CanvasKit/Skia)│   │
│  └────┬─────┘  └────┬─────┘  └───────┬──────────┘   │
│       │              │                │              │
│       └──────┬───────┘                │              │
│              ▼                        │              │
│        wasm_scene.ts ─────────────────┘              │
│        (facade over Engine)                          │
└──────────┬───────────────────────────────────────────┘
           │ wasm-bindgen FFI
           ▼
┌──────────────────────────────────────────────────────┐
│  Rust Engine (engine/src/lib.rs)                     │
│  ┌───────┐  ┌──────────┐  ┌──────────────────────┐  │
│  │ Scene │  │ Engine   │  │ History (undo/redo)  │  │
│  │       │  │          │  │                      │  │
│  │ nodes │  │ next_id  │  │ states: Vec<String>  │  │
│  │ root_ │  │ global_  │  │ current: usize       │  │
│  │ nodes │  │ transforms│ │ max_size: usize      │  │
│  │ selec │  │ spatial_ │  └──────────────────────┘  │
│  │ tion  │  │ index    │                             │
│  └───────┘  └──────────┘                             │
└──────────────────────────────────────────────────────┘
```

---

## Core Structs

### `Scene`
[Source](packages/editor/engine/src/lib.rs#L240-L251)

The top-level document container.

| Field | Type | Description |
|---|---|---|
| `nodes` | `HashMap<u32, Node>` | All nodes keyed by ID. Flat storage — hierarchy encoded via `parent`/`children`. |
| `root_nodes` | `Vec<u32>` | Ordered list of top-level node IDs. **Order = z-order** (last = frontmost). |
| `selection` | `Vec<u32>` | Currently selected node IDs. |
| `vector_network` | `VectorNetwork` | Experimental vector-network graph (see below). |
| `document_width` | `f32` | Document canvas width (default: 1000.0). |
| `document_height` | `f32` | Document canvas height (default: 1000.0). |

### `Node`
[Source](packages/editor/engine/src/lib.rs#L191-L203)

A single element in the scene graph.

| Field | Type | Description |
|---|---|---|
| `id` | `u32` | Unique node identifier. |
| `name` | `String` | Display name (e.g., `"Rect 3"`). |
| `node_type` | `NodeType` | Discriminator: `Path`, `Rect`, `Ellipse`, `Group`, `Text`. |
| `transform` | `[f32; 9]` | **Local** transform as a column-major 3×3 matrix (glam `Mat3`). |
| `style` | `Style` | Fill, stroke, opacity, blend mode, etc. |
| `geometry` | `Geometry` | Shape-specific data (dimensions, subpaths, text content). |
| `children` | `Vec<u32>` | Child node IDs (only meaningful for `Group` nodes). **Order = z-order**. |
| `parent` | `Option<u32>` | Parent node ID (`None` for root-level nodes). |
| `visible` | `bool` | Visibility toggle. |
| `locked` | `bool` | Prevents selection and editing. |

### `NodeType` (enum)
[Source](packages/editor/engine/src/lib.rs#L17-L25)

```rust
pub enum NodeType {
    Path,      // 0 — Arbitrary Bézier paths
    Rect,      // 1 — Rectangle
    Ellipse,   // 2 — Ellipse/circle
    Group,     // 3 — Container for child nodes
    Text,      // 4 — Text element
}
```

### `Geometry` (enum)
[Source](packages/editor/engine/src/lib.rs#L169-L175)

```rust
pub enum Geometry {
    Rect { width: f32, height: f32 },
    Ellipse { radius_x: f32, radius_y: f32 },
    Path { subpaths: Vec<Subpath> },
    Text { content: String, font_size: f32 },
}
```

> **Note**: `Group` nodes use `Geometry::Rect { width: 0, height: 0 }` as a placeholder — the group's bounds are computed dynamically from children.

### `Style`
[Source](packages/editor/engine/src/lib.rs#L35-L59)

| Field | Type | Default | Description |
|---|---|---|---|
| `fill` | `Option<Color>` | varies | Fill color (RGBA 0–1). `None` = no fill. |
| `stroke` | `Option<Color>` | varies | Stroke color. `None` = no stroke. |
| `stroke_width` | `f32` | `2.0` | Stroke width in document units. |
| `opacity` | `f32` | `1.0` | Node-level opacity (0–1). |
| `fill_opacity` | `f32` | `1.0` | Separate fill opacity (0–1). |
| `stroke_cap` | `u8` | `0` | `0`: butt, `1`: round, `2`: square. |
| `stroke_join` | `u8` | `0` | `0`: miter, `1`: round, `2`: bevel. |
| `dash_array` | `Vec<f32>` | `[]` | Dash pattern (empty = solid). |
| `dash_offset` | `f32` | `0.0` | Dash offset. |
| `corner_radius` | `f32` | `0.0` | Corner radius for rects. |
| `blend_mode` | `u8` | `0` | See blend mode table below. |
| `fill_rule` | `u8` | `0` | `0`: nonzero, `1`: evenodd. |
| `miter_limit` | `f32` | `4.0` | SVG miter limit for miter joins. |

#### Blend Modes

| Value | Name | Value | Name |
|---|---|---|---|
| 0 | Normal | 8 | Hard Light |
| 1 | Multiply | 9 | Soft Light |
| 2 | Screen | 10 | Difference |
| 3 | Overlay | 11 | Exclusion |
| 4 | Darken | 12 | Hue |
| 5 | Lighten | 13 | Saturation |
| 6 | Color Dodge | 14 | Color |
| 7 | Color Burn | 15 | Luminosity |

### `Color`
[Source](packages/editor/engine/src/lib.rs#L27-L33)

```rust
pub struct Color {
    pub r: f32,  // 0.0–1.0
    pub g: f32,
    pub b: f32,
    pub a: f32,
}
```

### `PathPoint`
[Source](packages/editor/engine/src/lib.rs#L177-L183)

```rust
pub struct PathPoint {
    pub x: f32,     // Anchor X (local space)
    pub y: f32,     // Anchor Y (local space)
    pub cp1: Vec2,  // Incoming control point
    pub cp2: Vec2,  // Outgoing control point
}
```

> When `cp1 == (x, y)` and `cp2 == (x, y)`, the point is a **corner** (no smooth curve). Otherwise it's a smooth Bézier anchor.

### `Subpath`
[Source](packages/editor/engine/src/lib.rs#L185-L189)

```rust
pub struct Subpath {
    pub points: Vec<PathPoint>,
    pub closed: bool,
}
```

A `Path` geometry contains one or more subpaths. Each subpath is a sequence of cubic Bézier segments defined by consecutive `PathPoint` pairs. The curve from point `i` to point `i+1` uses `points[i].cp2` as the first control point and `points[i+1].cp1` as the second.

---

## Scene Graph & Hierarchy

### Flat Storage with Parent/Children Links

The scene graph is **not a tree of nested structs**. All nodes live in a flat `HashMap<u32, Node>`. Hierarchy is encoded through:

- `Node.parent: Option<u32>` — points to parent node (or `None` for roots)
- `Node.children: Vec<u32>` — ordered list of child IDs
- `Scene.root_nodes: Vec<u32>` — ordered list of top-level node IDs

```
Scene.root_nodes: [1, 5, 2]
                   │  │  │
                   ▼  ▼  ▼
            Node 1   Node 5 (Group)   Node 2
                     │ children: [3, 4]
                     ├── Node 3  (parent: 5)
                     └── Node 4  (parent: 5)
```

### Z-Order

Z-order is determined by **position in ordered lists**:
- For root nodes: index in `Scene.root_nodes` (higher index = drawn later = on top)
- For children: index in parent's `Node.children` (higher index = on top)

Operations like `bring_to_front`, `send_to_back`, `bring_forward`, `send_backward` reorder elements within these arrays.

### Grouping

- `group_nodes(ids)` → creates a new `Group` node, reparents the given nodes under it, and inserts the group at the position of the first given node in `root_nodes`.
- `ungroup_node(id)` → moves the group's children back to the parent scope and removes the group node.
- Groups have `NodeType::Group` and `Geometry::Rect { 0, 0 }`. Their bounds are computed dynamically.

---

## ID Allocation

IDs are simple incrementing `u32` values starting from `1`:

```rust
let id = self.next_id;  // Engine field
self.next_id += 1;
```

On deserialization, `next_id` is recalculated as `max(existing_ids) + 1` to avoid collisions.

> **Important**: IDs are **not** reused. Deleting node 5 doesn't free ID 5 for future use.

---

## Transform Model

### Local vs. Global Transforms

Each node stores a **local** transform as `[f32; 9]` (column-major `Mat3`):

```
┌          ┐       Memory layout (column-major):
│ a  c  tx │       [a, b, 0, c, d, 0, tx, ty, 1]
│ b  d  ty │       indices: [0, 1, 2, 3, 4, 5, 6, 7, 8]
│ 0  0  1  │
└          ┘
```

The **global** transform is computed by composing parent transforms:

```
global(node) = global(parent) * local(node)
```

Global transforms are cached in `Engine.global_transforms` and recomputed when nodes move. The engine exposes them to JS in **Skia row-major** format for direct use with CanvasKit:

```
Skia format: [a, c, tx, b, d, ty, 0, 0, 1]
```

### Translation Extraction

Position is extracted from the transform: `tx = transform[6]`, `ty = transform[7]` (column-major).

---

## Spatial Index

The engine maintains an R-tree (`rstar::RTree<SpatialNode>`) for efficient hit-testing and viewport culling:

| Field | Type | Purpose |
|---|---|---|
| `spatial_index` | `RTree<SpatialNode>` | R-tree for spatial queries |
| `node_to_spatial` | `HashMap<u32, SpatialNode>` | Current AABB per node (for removal/update) |

Nodes are indexed by their axis-aligned bounding box (AABB) in world space. Updated after any transform or geometry change.

### Hit-Testing

1. **`hit_test(x, y)`** — R-tree query for nearby nodes, then precise per-shape test:
   - **Rect**: point-in-rectangle (in local space)
   - **Ellipse**: point-in-ellipse formula
   - **Path**: stroke distance check (`stroke_width/2 + tolerance`) followed by fill containment (winding/even-odd ray casting)
   - **Group**: recursive hit-test on children (deepest match wins)
   - Returns the **deepest** (leaf) node at the point.

2. **`hit_test_grouped(x, y)`** — Same as hit_test but returns the **top-level group** if the hit node is inside a group.

3. **`get_visible_nodes(minX, minY, maxX, maxY)`** — viewport culling query against R-tree.

Hit tolerance is `HIT_TOLERANCE = 4.0` document pixels.

---

## Selection Model

- `Scene.selection: Vec<u32>` — list of currently selected node IDs.
- `select_node(id, multi)` — if `multi` is false, replaces selection; if true, toggles.
- `clear_selection()` — empties the list.
- `get_selection()` → `Uint32Array` at the JS boundary.
- `dedup_selection(ids)` — removes descendants when an ancestor is also selected (prevents double-moves).

---

## Undo/Redo (History)

[Source](packages/editor/engine/src/lib.rs) — `History` struct

The history system uses **full scene snapshots** (JSON strings from `serialize_scene()`):

```
History {
    states: Vec<String>,   // stack of serialized scenes
    current: usize,        // pointer into states
    max_size: usize,       // default: 50
}
```

- `push_state(state)` — push before mutation (truncates any redo states)
- `undo(current_state)` → `Option<String>` — returns previous state
- `redo(current_state)` → `Option<String>` — returns next state

`WasmScene` calls `saveHistory()` before each mutation, which serializes the scene and pushes it.

---

## Serialization Formats

### JSON (runtime interchange)

`Engine.get_scene_json()` returns the scene as JSON matching the TypeScript [SceneData](packages/editor/src/types.ts#L95-L98) interface:

```json
{
  "nodes": {
    "1": {
      "name": "Rect 1",
      "node_type": "Rect",
      "geometry": { "Rect": { "width": 100, "height": 50 } },
      "style": { "fill": { "r": 0.5, "g": 0.5, "b": 1.0, "a": 1.0 }, ... },
      "visible": true,
      "locked": false,
      "children": [],
      "transform": [1, 0, 0, 0, 1, 0, 200, 150, 1]
    }
  },
  "root_nodes": [1, 2, 3]
}
```

> **Note**: The JSON export omits `parent` and `selection` (they're internal engine state). The TypeScript `SceneNode` interface maps `geometry` as a discriminated union with optional keys (`Rect?`, `Ellipse?`, `Path?`, `Text?`).

### Protobuf/Bincode (persistence)

[Source](packages/editor/engine/src/proto.rs)

For IndexedDB persistence, the engine uses a custom binary format:

- `serialize_proto()` → `Uint8Array` (protobuf-encoded scene wrapped in a versioned container)
- `deserialize_proto(data)` → `bool` (success/failure)
- Includes a `FORMAT_VERSION` constant for migration support.
- Uses `prost` for protobuf encoding and `bincode` as a secondary format.

### JSON (undo/redo)

`serialize_scene()` / `deserialize_scene()` use `serde_json` for full scene snapshots (including selection state). Used exclusively by the History system.

---

## Persistence

[Source](packages/editor/src/persistence.ts)

- **Storage**: IndexedDB (`VectorEditorDB` → `scenes` store → `current_scene` key)
- **Format**: Protobuf binary (via `engine.serialize_proto()`)
- **Autosave**: Debounced at 2-second intervals after mutations
- **Load**: On app startup via `PersistenceManager.loadScene(engine)`

---

## Vector Network (Experimental)

[Source](packages/editor/engine/src/vector_network.rs)

A graph-based alternative to the traditional subpath model:

| Struct | Fields | Description |
|---|---|---|
| `VectorNetwork` | `vertices`, `edges`, `dirty` | Top-level graph container |
| `VNVertex` | `position: Vec2` | A point in the network |
| `VNEdge` | `start`, `end`, `cp1`, `cp2` | Cubic Bézier edge between vertices |

The vector network can compute **faces** (closed regions) from the edge graph. It has a `dirty` flag that triggers recomputation. Currently marked as default/experimental — the primary path model uses `Subpath`s.

---

## TypeScript ↔ WASM Boundary

The `WasmScene` class ([wasm_scene.ts](packages/editor/src/wasm_scene.ts)) is the **sole facade** between TypeScript and the Rust engine. Key patterns:

1. **Mutations**: Call engine method → invalidate cache → trigger autosave
2. **History**: `saveHistory()` called before each mutation (serializes full scene)
3. **Scene Data**: `getSceneData()` returns cached `SceneData` (re-parsed only when dirty)
4. **Transforms**: Returned via shared WASM memory pointer, **must be copied** immediately
5. **ID passing**: Numbers cross directly; arrays cross as `Uint32Array` or JSON strings
6. **Style updates**: Passed as JSON strings (`setNodeStyle(id, styleJson)`)

### `WasmScene` method categories:

| Category | Methods |
|---|---|
| **Create** | `addRect`, `addEllipse`, `addPath`, `addPolygon`, `addStar`, `addText` |
| **Transform** | `moveNode`, `setNodePosition`, `setNodeTransform`, `rotateNode`, `resizeNode` |
| **Style** | `setNodeStyle`, `setNodeStyleNoHistory` |
| **Hierarchy** | `groupNodes`, `ungroupNode`, `duplicateNode`, `removeNode`, `removeNodes` |
| **Z-order** | `bringToFront`, `sendToBack`, `bringForward`, `sendBackward` |
| **Query** | `hitTest`, `hitTestGrouped`, `getSceneData`, `getTransform`, `getNodeBounds`, `getVisibleNodes` |
| **Visibility** | `setNodeVisible`, `setNodeLocked` |
| **Path** | `updatePathPoints`, `convertToPath` |
| **Boolean** | `replaceNodesWithPath` |
| **History** | `undo`, `redo`, `saveMoveHistory` |
