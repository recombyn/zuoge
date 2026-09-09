# Scene JSON spec

Scene JSON is the document on the canvas. This spec matches the Web editor runtime and `packages/scene-schema`.

Canvas paint / Path2D / viewport cull + Kit underlayer: **[canvas-architecture.md](./canvas-architecture.md)**.

```json
{
  "width": 794,
  "height": 1123,
  "deltaSetLike": {
    "ROOT": { "key": "root", "children": ["nodeId1"] },
    "nodeId1": {
      "key": "text",
      "x": 80,
      "y": 80,
      "width": 240,
      "height": 24,
      "attrs": {
        "ORIGIN_DATA": "Sample text",
        "DATA": { "chars": [] }
      }
    }
  }
}
```

Also common on saved projects:

- `frames` — artboards (`kind`: `'artboard'` | `'animation'` for 动画工作台; load rewrites leftover `'lottie'` plate kinds to `'animation'`)
- `stackOrder` — unified paint order (`frame:id` | `node:id`, bottom → top)
- `pages` / `activePageId` — page children when used
- Shape fill/stroke attrs use **`'fill-color'`** and **`'border-color'`** (not parallel `fill` / `strokeColor` keys)
- Animation workbench invisible host nodes use **`attrs.animationFrameHost`** (not `lottieFrameHost`)
- Node `key: 'lottie'` is still the Lottie **asset** node type (distinct from frame `kind`)

`normalizeDocument` may heal leftover plate fills / text-frame radii and strip ephemeral frame process chrome; AI SoftGlow for frames lives in editor `aiOperationState`, not persisted `frames[].processStatus`.

Types: `apps/web/src/components/rcb/sceneNode.ts`.  
Full JSON Schema: `packages/scene-schema/schema/scene-document.schema.json`.
