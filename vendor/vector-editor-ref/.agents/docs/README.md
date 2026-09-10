# Technical Documentation

This folder contains reference documentation for the **vector-editor** project, written for AI agents and developers.

## Contents

| Document | Description |
|---|---|
| [DATA_MODEL.md](./DATA_MODEL.md) | Core data structures, scene graph, transforms, IDs, serialization formats, and the WASM boundary |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Tech stack, module map, data flow diagrams, tool system, UI panels, and feature overview |
| [CONVENTIONS.md](./CONVENTIONS.md) | Coding patterns, recipes for adding features, naming conventions, and performance notes |

## Quick Reference

- **Engine source of truth**: All scene state lives in `engine/src/lib.rs` (Rust → WASM)
- **TypeScript facade**: All mutations go through `src/wasm_scene.ts`
- **Rendering**: CanvasKit/Skia via `src/renderer.ts`
- **Input/Tools**: State machine in `src/input.ts`
- **Persistence**: IndexedDB + Protobuf in `src/persistence.ts` + `engine/src/proto.rs`
- **Type definitions**: `src/types.ts` mirrors the Rust structs
