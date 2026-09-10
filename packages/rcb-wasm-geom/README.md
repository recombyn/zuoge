# rcb-wasm-geom

RCB vector geometry kernel (Rust → WASM). Loaded by `apps/web/.../vector/wasmGeom.ts`.

## Exports

| Export | Role |
|--------|------|
| `densify_path_d` | Path → polyline |
| `tessellate_fill` / `_with_holes` / `_stroke` / `_batch_fill` | Mesh helpers (export / offline; not product Kit ink) |
| `boolean_polygons` | Union / difference / intersection / xor (`i_overlay`) |
| `offset_polyline` | Stroke centerline → filled outline |
| `simplify_rdp` / `simplify_rdp_closed` | Ramer–Douglas–Peucker |
| `trace_rgba_contours` | Moore walk on RGBA (CJK canvas 轮廓化) |

## Call sites

| Path | Prefer WASM | Fallback |
|------|-------------|----------|
| Mesh densify / tessellate | `wasmGeom` | JS in `densifyPathDJs` / `tessellate*` |
| Shape boolean | `shapeBoolean.ts` | `polygon-clipping` |
| Pen / line / arrow 轮廓化 | `offset_polyline` via `outlineToPath.ts` | JS stroke offset |
| Fill holes | boolean difference | `polygon-clipping` |
| Text canvas 轮廓化 | Worker `text_glyph` (trace + RDP) | Main-thread WASM / JS Moore |
| Text Latin (fontkit) | — | JS `outlineTextFont.ts` |
| Pencil 轮廓化 | — | JS `pencilInkPathFromPoints` |

Rect / circle / polygon 轮廓化 use formula path `d` (no offset/boolean).

## Build

From `apps/web`:

```bash
npm run build:wasm
```

Output: `apps/web/src/components/rcb/render/vector/wasm/pkg/`.  
Missing Rust / stub pkg → JS fallback. Runtime off: `?rcb_wasm=0`.

Release: `opt-level = "z"` + `strip`. `wasm-opt` is off (binaryen can hang on Windows).
