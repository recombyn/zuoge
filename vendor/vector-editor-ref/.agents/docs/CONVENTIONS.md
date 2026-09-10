# Conventions & Patterns

> **Audience**: AI agents and developers working on this codebase.

---

## General Principles

1. **Engine is the source of truth** — All scene state lives in the Rust engine. The TypeScript side never stores its own copy of node data; it reads from the engine via `getSceneData()`.

2. **Mutations always go through `WasmScene`** — Never call `engine.xyz()` directly from UI or input code. The `WasmScene` class handles history snapshots, cache invalidation, and autosave.

3. **History before mutation** — Every mutating method in `WasmScene` calls `this.saveHistory()` *before* the mutation so undo restores the pre-mutation state.

4. **Cache invalidation** — After any mutation, call `this.invalidateCache()` to ensure the next `getSceneData()` re-parses from the engine.

---

## Naming Conventions

| Context | Convention | Example |
|---|---|---|
| Rust fields/methods | `snake_case` | `stroke_width`, `add_rect()` |
| TypeScript interfaces (mirroring Rust) | `snake_case` fields | `NodeStyle.stroke_width` |
| TypeScript classes/methods | `camelCase` methods, `PascalCase` classes | `WasmScene.addRect()` |
| Node names | `"Type ID"` pattern | `"Rect 3"`, `"Ellipse 7"` |
| CSS classes | `kebab-case` | `.layers-panel`, `.context-bar` |

---

## Common Patterns

### Adding a New Node Type

1. **Engine** (`lib.rs`):
   - Add variant to `NodeType` enum
   - Add variant to `Geometry` enum
   - Add `add_<type>()` method on `Engine`
   - Handle the new type in `hit_test()`, `get_node_bounds()`, `convert_to_path()`
   - Handle in `serialize_scene()` / `get_scene_json()`

2. **Protobuf** (`proto.rs`):
   - Add `Proto<Type>` struct
   - Add field to `ProtoGeometry`
   - Update `to_proto_geometry()` and `from_proto_geometry()`

3. **TypeScript** (`types.ts`):
   - Add geometry interface (e.g., `PolygonGeometry`)
   - Add optional key to `NodeGeometry` union

4. **WasmScene** (`wasm_scene.ts`):
   - Add `add<Type>()` wrapper method

5. **Renderer** (`renderer.ts`):
   - Add rendering case in the draw function

6. **Input** (`input.ts`):
   - Add tool state for creation if interactive

7. **SVG** (`svg_utils.ts`):
   - Add import/export conversion

### Modifying a Style Property

1. Add field to `Style` struct in `lib.rs` (with `#[serde(default)]` for backward compat)
2. Add field to `ProtoStyle` in `proto.rs` with a new tag number
3. Add field to `NodeStyle` interface in `types.ts`
4. Update the context bar in `context_bar.ts` to expose the UI control
5. Update the renderer if it affects drawing

### Pass Data Across WASM Boundary

- **Primitives** (`u32`, `f32`, `bool`): Pass directly
- **Arrays of primitives**: Use `Uint32Array` / `Float32Array`
- **Complex objects**: Serialize as JSON string on Rust side, parse on TS side
- **Style objects**: Pass as JSON string (`setNodeStyle(id, JSON.stringify(style))`)
- **Transforms**: Read via pointer into WASM memory, **always copy** (`new Float32Array(view)`)

### Adding a History-Tracked Operation

```typescript
// In WasmScene:
myOperation(id: number, param: string) {
    this.saveHistory();               // 1. Snapshot before
    this.engine!.my_operation(id, param);  // 2. Mutate
    this.invalidateCache();           // 3. Invalidate
    this.autosave?.trigger();         // 4. Debounced save
}
```

For operations where you want **live preview without history** (e.g., dragging a color picker), use the `NoHistory` variant pattern:

```typescript
myOperationNoHistory(id: number, param: string) {
    this.engine!.my_operation(id, param);
    this.invalidateCache();
    // No saveHistory, no autosave
}
```

Then call `saveMoveHistory()` on mouseUp to commit.

---

## Transform Conventions

| Property | Format | Notes |
|---|---|---|
| Internal (Rust) | Column-major `[f32; 9]` | glam `Mat3` layout |
| WASM → JS | Row-major `[f32; 9]` | Skia/CanvasKit layout |
| Translation | Column-major: `[6]` = tx, `[7]` = ty | |
| Composition | `global = parent_global * child_local` | Standard left-multiply |
| Reparenting | `new_local = new_parent_inv * old_global` | Preserves world position |

---

## Error Handling

- **Rust side**: Uses `unwrap_or_default()` liberally for deserialization. Panics are caught by `console_error_panic_hook`.
- **TypeScript side**: Engine calls are assumed to succeed. Errors surface as console warnings rather than exceptions.
- **Persistence**: Gracefully falls back to empty scene if deserialization fails.

---

## Performance Notes

- `getSceneData()` is cached per frame — only re-parsed when the scene is mutated.
- `moveNode()` skips history and autosave (too expensive per-frame). History is committed on mouseUp.
- The R-tree spatial index avoids O(n) hit-testing on every mouse event.
- CanvasKit `SkPicture` caching avoids re-recording draw commands for unchanged nodes.
- Dirty flags track which nodes need their rendered pictures invalidated.

---

## File Paths to Know

| What | Path |
|---|---|
| Entry point | [src/main.ts](packages/app/src/main.ts) |
| All type definitions | [src/types.ts](packages/editor/src/types.ts) |
| Engine facade | [src/wasm_scene.ts](packages/editor/src/wasm_scene.ts) |
| Core engine | [engine/src/lib.rs](packages/editor/engine/src/lib.rs) |
| Protobuf schema | [engine/src/proto.rs](packages/editor/engine/src/proto.rs) |
| Vector network | [engine/src/vector_network.rs](packages/editor/engine/src/vector_network.rs) |
| Renderer | [src/renderer.ts](packages/editor/src/renderer.ts) |
| Input & tools | [src/input.ts](packages/editor/src/input.ts) |
| UI panels | [src/ui.ts](packages/editor/src/ui.ts) |
| SVG utils | [src/svg_utils.ts](packages/editor/src/svg_utils.ts) |
| Global styles | [style.css](packages/editor/style.css) |
