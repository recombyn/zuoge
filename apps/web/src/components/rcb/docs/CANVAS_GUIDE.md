# RCB 画布完整指南

> **目录 + 标准 API（方法）+ Figma 对齐调整方案** 合订本。  
> 代码根：`apps/web/src/components/rcb/`  
> **现状怎么跑（SoA/矩形/WebGL/点击）：[`HOW_IT_WORKS.md`](./HOW_IT_WORKS.md)**  
> 锐利细则：[`FIGMA_INK_PLAN.md`](./FIGMA_INK_PLAN.md) · 架构速览：[`CANVAS.md`](./CANVAS.md)  
> **API 门面已落地：** `import { … } from '@/components/rcb/api'`（`api/Document|Camera|Scene|Renderer|HitTest|Selection`）

**定调：** 放大不糊 = 按 `zoom×dpr` 重光栅化（像 Figma）。**不为锐利升 SVG DomHost。** DomHost 仅义务（video/audio/input/lottie/必须盖板）。

---

# 第一部分：目录

## 1.1 目标目录（调整后）

```
rcb/
├── docs/                      # 本文档
│   ├── CANVAS_GUIDE.md        # 合订本（目录 + API + 方案）★
│   ├── CANVAS.md              # 架构速览
│   └── FIGMA_INK_PLAN.md      # 锐利/tile/restamp 细则
│
├── api/                       # ★ 标准画布 API 门面（新代码只从这里进）
│   ├── index.ts               # 汇总导出
│   ├── Document.ts            # 文档 CRUD / stack / z
│   ├── Camera.ts              # 相机 / 坐标 / 视口
│   ├── Scene.ts               # 空间索引 / SoA buffer
│   ├── Renderer.ts            # paintIntent / 墨水 / atlas / 画板 tile
│   ├── HitTest.ts             # 拾取 / 遮挡
│   └── Selection.ts           # 选中 raise / chrome 相关
│
├── index.ts                   # 兼容 barrel（逐步瘦身，内部勿再 import）
├── sceneNode.ts               # SceneDocument / SceneNode 类型 + Zod
│
├── camera/                    # 相机实现
│   ├── context.tsx
│   └── transform.ts
├── canvas/                    # 舞台壳（双 canvas + SVG board）
│   ├── RcbCanvas.tsx
│   ├── RcbSvgDefs.tsx
│   ├── svgBoardRegistry.ts
│   └── useSvgBoard.ts
├── core/                      # 数学 / 空间 / DPR / 布局
│   ├── math.ts
│   ├── spatialIndex.ts
│   ├── soaQuadtree.ts
│   ├── transformPreview.ts
│   ├── dpr.ts
│   ├── layout.ts
│   ├── types.ts
│   └── geometry/
├── render/                    # 墨水后端（性能 + 锐利 restamp）
│   ├── paintIntent.ts         # ★ 唯一绘制意图（gpu-mesh / atlas-stamp / artboard-tile / dom-obligatory）
│   ├── sceneRenderer.ts
│   ├── webglSceneRenderer.ts
│   ├── webglInstanceAtlas.ts
│   ├── sceneRenderBuffer.ts
│   ├── soaBakeLayer.ts
│   ├── soaPathSamples.ts
│   ├── renderDemotionScheduler.ts
│   └── gpuDepthOfField.ts
├── shapes/                    # 义务 DomHost 层（非锐利主路径）
│   ├── RcbShapesLayer.tsx
│   ├── RcbShapeHost.tsx
│   └── shapeHostRegistry.ts
├── frames/                    # 画板
│   ├── HtmlArtboardFrame.tsx
│   ├── artboardInkSurface.ts
│   ├── artboardInkTiles.ts    # ★ 新建：可见 tile
│   ├── frameContentClip.ts
│   ├── frameNodeBinding.ts
│   ├── FrameDrawFeature.tsx
│   └── FrameMoveFeature.tsx
├── scene/
│   ├── document/              # Document / Hit / Stack 实现
│   │   ├── sceneDocument.ts
│   │   ├── sceneHitBridge.ts
│   │   ├── sceneStackPainter.ts
│   │   ├── nodeCapabilities.ts
│   │   ├── nodeFactories.ts
│   │   └── …
│   ├── paint/                 # sceneToSvg / 导出
│   └── overlay/
├── selection/                 # Selection 实现 + chrome/
├── tools/                     # 绘制工具
└── process/                   # SoftGlow 等
```

## 1.2 目录职责（一句话）

| 目录 | 职责 | 谁该 import |
|------|------|-------------|
| `api/` | 稳定对外方法面 | **应用 / 新功能优先** |
| `camera/` `core/math` | 视口与坐标 | 经 `api/Camera` |
| `scene/document/` | 文档真相 + 拾取 + z | 经 `api/Document` `HitTest` |
| `render/` | GPU/Canvas 墨水、atlas、bake | 经 `api/Renderer` |
| `frames/` | 画板板面 + 板内 tile 墨水 | 经 `api/Renderer` / Frames |
| `shapes/` | 义务 DOM/SVG host | Renderer 内部 |
| `selection/` | 选中与临时 raise | 经 `api/Selection` |
| `canvas/` | 舞台组装 | 编辑器壳 |
| `tools/` | 笔/形/字放置 | 编辑器工具条 |
| `docs/` | 人类可读契约 | — |

## 1.3 合层顺序

```
下 → 上
1. 像素网格 canvas
2. 世界 SoA 墨水（WebGL → Canvas2D）
3. 共享 SVG：画板板面 + 义务 DomHost（data-z = stackOrder）
4. Selection chrome
```

---

# 第二部分：标准画布 API（方法）

> 目标用法：`import { … } from '@/components/rcb/api'`  
> 下列「实现」列为今日源文件；门面为薄 re-export。

## 2.1 总览

| 门面 | 管什么 | 实现主文件 |
|------|--------|------------|
| **Document** | 节点/帧 CRUD、`stackOrder`、naturalZ/paintZ | `sceneDocument.ts` |
| **Camera** | zoom/pan、坐标、视口 AABB | `core/math.ts` `camera/*` |
| **Scene** | 空间索引、SoA buffer、可见集 | `spatialIndex.ts` `sceneRenderBuffer.ts` |
| **Renderer** | paintIntent、墨水、atlas restamp、画板 tile | `render/*` `frames/artboard*` |
| **HitTest** | 点选、板遮挡 | `sceneHitBridge.ts` |
| **Selection** | 临时 raise、chrome | `selection/*` `frameContentClip`（raise 将迁出） |

---

## 2.2 Document

```ts
// 创建 / 规范化
createBareDocument(): SceneDocument
createEmptyDocument(size?: { width?; height?; emptyWorld? }): SceneDocument
normalizeDocument(doc: unknown): SceneDocument
validateSceneDocument / parseAndValidateSceneJson  // sceneNode.ts

// CRUD
addNodeToDocument(doc, id, node): SceneDocument
addNodesToDocument(doc, entries): SceneDocument
updateNodeInDocument(doc, id, patch): SceneDocument
updateNodesInDocument(doc, patches): SceneDocument
removeNodesFromDocument(doc, ids): SceneDocument
reorderNodesInDocument(doc, orderedIds): SceneDocument
mergeImportedIntoDocument(doc, imported): SceneDocument
listSceneNodes(doc): SceneNode[]

// 画布 meta
setDocumentSize(doc, w, h)
setDocumentCanvasMeta(doc, patch)
getActivePage(doc)
syncRootChildren(doc)
ensureDocumentContentOnCanvas(doc)

// 栈 / z（永久 vs 绘制）
stackFrameKey(id) / stackNodeKey(id) / parseStackKey(key)
reconcileStackOrder(doc): string[]
stackZIndex(doc, 'frame'|'node', id): number          // naturalZ
maxDocumentStackZ(doc): number
maxArtboardPlateStackZ(doc): number
buildNodeStackZMap(doc, ids): Map<string, number>
buildUnifiedHitZMap(doc): Map<string, number>

selectionPaintZIndex(doc, kind, id, raised): number   // 选中临时 max+1
nodePaintZIndex(doc, id, raised): number              // 绘制用 z（含空生成器压板）
worldNodeStacksAboveAnyFrame(doc, nodeId): boolean
listSingleSelectionPaintRaiseNodeIds(doc, nodeIds, frameIds): string[]
isSingleStackSelection(doc, nodeIds, frameIds): boolean

// 约定名（文档层，实现可 alias）
// naturalZ  = stackZIndex
// paintZ    = nodePaintZIndex / selectionPaintZIndex(frame)
// hitZ      = idle paintZ（raised=false）
```

**常量：** `DEFAULT_CANVAS` / `A4_PORTRAIT` = `{ width: 794, height: 1123 }`

---

## 2.3 Camera

```ts
// 限制与步进
RCB_MIN_ZOOM / RCB_MAX_ZOOM
rcbClampZoom(z): number
rcbStepZoom(zoom, step?): number

// 坐标
rcbScreenToScene(camera, screen, viewportEl?): { x, y }
rcbSceneToScreen(camera, scene, viewportEl?): { x, y }
rcbClientToStageLocal(client, viewportEl)
rcbClientDeltaToScene(dx, dy, zoom)
rcbScreenPxToScene(px, zoom)
rcbZoomAtPoint(camera, screenPt, nextZoom)

// 视口
rcbViewportMetrics(viewportEl)
rcbViewportSceneBounds(camera, viewportW, viewportH): AABB  // cull 输入
rcbCameraCssZoom(camera)
rcbCameraScreenOffset(camera, …)
rcbFitCamera / rcbFitCameraInBand / rcbCenterCameraInBand

// 变换对象
createCameraTransform(camera, stage?): CameraTransform
worldToScreen(t, x, y)
stageLocalToWorld(t, x, y)
screenDeltaToWorldDelta(t, dx, dy)
worldBoxToScreen(t, box)
cameraZoom(t) / cameraPan(t)

// React
useRcbCamera() / useRcbCameraMotion() / useRcbViewportEl()
useRcbDevicePixelRatio() / useRcbScreenToScene()
RcbOverlayPortal
```

---

## 2.4 Scene

```ts
// 文档级空间
SceneSpatialRuntime / RcbSpatialIndex
getSharedSceneSpatialRuntime() / setSharedSceneSpatialRuntime()
nodeSceneAabb(doc, id) / boxesIntersect(a, b)
hitTestWithSpatialIndex / hitTestSceneTargetWithSpatialIndex
collectUnifiedHitCandidates

// SoA 缓冲
getSharedSceneRenderBuffer() / resetSharedSceneRenderBuffer()
createSceneRenderBuffer()
syncSceneRenderBufferFromDocument(doc)
syncSceneRenderBufferIncremental(doc, ids)
forEachVisibleInRect(buf, rect, fn)          // 可见槽
applySoaHostInkFlags(buf, hostIds)           // host 占用则关 SoA 双画
isSoaCanvasEligible / isSoaBasicGeomSufficient / isSoaRichFillAtlasStampable
markSoaDirty / markSoaDirtyById / markAllSoaDirty
allocateSoaSlot / bulkRemoveSoaByIds / …

// 拖动预览
setNodeTransformPreviews / getNodeTransformPreview / effectivePaintBox
clearNodeTransformPreviews / subscribeTransformPreview
```

---

## 2.5 Renderer（含锐利契约）

### PaintIntent（目标唯一路由）

```ts
type PaintIntent =
  | { kind: 'gpu-instance' }
  | { kind: 'atlas-stamp'; zoomBucket: number }
  | { kind: 'artboard-tile' }
  | { kind: 'dom-obligatory'; reason: string };

resolvePaintIntent(doc, id, ctx: {
  zoom: number;
  dpr: number;
  gesture: boolean;
  raised?: boolean;
}): PaintIntent
```

| kind | 含义 | 锐利手段 |
|------|------|----------|
| `gpu-instance` | 基础几何 | 每帧按屏像素画 |
| `atlas-stamp` | path/字/图/图标 | **zoomBucket 变则 restamp** |
| `artboard-tile` | 板内 idle | **可见 tile × zoom×dpr** |
| `dom-obligatory` | video/audio/input/lottie/盖板… | **非锐利**；浏览器义务 |

### 墨水与 atlas

```ts
createSceneRenderer / createWebglSceneRenderer / createCanvasSceneRenderer
resolveIdleInkBackend(): 'webgl' | 'canvas2d'
collectSoaWebglInstances(…)
paintCanvasIdleNode / canIdlePaintOnCanvas   // 资格；锐利不靠升 SVG
paintSoaBufferBasic

// Atlas
SOA_ATLAS_CELL / SOA_ATLAS_INNER
atlasZoomBucket(zoom): number
idleMediaScreenEdgePx(w, h, zoom, dpr)
// 调整后语义：
backingInsufficientForAtlas(node, zoom, dpr): boolean

// Bake / 手势
setSoaCameraGestureActive(active: boolean)
shouldUseSoaBake / ensureSoaBake / tilesForView
subscribeSoaBakeTileReady

// 画板 ink / tile
ARTBOARD_INK_MAX_SCALE                     // 导出
artboardInkScale(zoom, dpr)
artboardInkBackingInsufficient(zoom, dpr)  // ★
registerArtboardInkSurface / paintArtboardInkSurface
→ artboardWebglInk（共享 WebGL + onlyFrameId）→ FO blit；失败时 Canvas2D
// ★ 新建：artboardInkTiles — 可见分块全分辨率

// Host 拆分（义务）
pickFullAndCanvasIds(opts) → { fullIds, canvasIds }
// fullIds: 义务 + stack-over-plate + 选中生成器 + **板内 raise/reveal**
// （世界基础形 raise 仍 SoA；板内必须 host，因世界 GL 在板下）
nodeNeedsDomShapeHost(node, force?)
```

### 锐利铁律

```
displayPx = sceneEdge × zoom × dpr
if displayPx > backingPx → restamp / 开更高清 tile
禁止：拉伸低清 backing 当终态（含画板 pixelated 硬撑）
照片：源分辨率不够允许糊
```

---

## 2.6 HitTest

```ts
hitTestSceneAtPoint(opts): string | null
hitTestUnifiedStackAtPoint(opts): SceneStackHit | null  // node | frame
hitTestSceneNodeAt(opts): boolean
frameIdAtPoint(doc, x, y): string | null
isNodePickableAtPoint(doc, node, x, y): boolean

isOccludedByHigherArtboard(doc, node, x, y): boolean
listHigherArtboardOccluderBoxes(doc, node, opts?)
subtractHigherArtboardOccluders(…)
isNodeAabbFullyOccludedByHigherArtboard(…)

setSceneHitTestBridge(fn) / attachViewportToolPointers(…)
hitTestSoaBuffer / hitTestSoaBufferOrdered / hitTestSoaSlot
```

**约定：** hit 遮挡用 idle `nodePaintZIndex(..., false)`；选中 max+1 **不改变**理想 hit。

---

## 2.7 Selection

```ts
listSingleSelectionPaintRaiseNodeIds(doc, nodeIds, frameIds)
setSelectionPaintRaiseIds / setSelectionPaintRaiseFrameIds   // selection/selectionPaintRaise.ts
setFrameClipRevealOverflowIds
selectionPaintRaises(id) / selectionPaintRaisesFrame(id)

stackPaintZ / stackPaintMaxZ / stackPaintNaturalZ / syncStackPaintOrder

// UI（组件，非纯函数）
SelectionFeature / SelectionChrome / WorldSvgFrame
NodeTitleLabel（z = owner paintZ）
```

---

## 2.8 节点类型 → Intent（决策表）

| 类型 | 默认 Intent | DomHost？ |
|------|-------------|-----------|
| rect/ellipse/line 基础 | `gpu-instance` | 否（除非 stack-over-plate 义务） |
| path/poly/star/pencil/字 | `atlas-stamp` | 否；不够清 → restamp |
| 板内 idle | `artboard-tile` | 否 |
| image/video/audio 媒体 | `atlas-stamp` 或解码 | video/audio **义务** Dom 解码器 |
| 空生成器图标 | `atlas-stamp` + restamp | 过渡期可暂 SVG（债） |
| lottie / group / 输入框 | `dom-obligatory` | 是 |
| SoftGlow / 过程编辑 | `dom-obligatory` | 是 |

---

# 第三部分：完整调整方案（与 API/目录一体）

## 3.1 为什么改

| 现状问题 | 根因 | 方案手段 |
|----------|------|----------|
| 放大糊 | 固定 atlas / 画板 8× 拉伸 | restamp + 可见 tile |
| 乱打补丁 | 无统一 Intent / API | `api/` + `paintIntent` |
| 以为像 Figma 就升 SVG | 错把 DomHost 当锐利 | DomHost 仅义务 |
| 裁剪/路由看不见 | 无 debug | `?rcbDebug=paint` |

## 3.2 阶段与改哪些目录/API

### Phase A（1–1.5 周）— 去糊根因

| 目录/API | 动作 |
|----------|------|
| `frames/artboardInkSurface.ts` | 导出 scale API；禁 pixelated 终态 |
| `frames/artboardInkTiles.ts` | **新建**；`Renderer` 导出 tile API |
| `api/Renderer.ts` | 导出 `artboardInk*` / insufficient |
| `render/webglInstanceAtlas.ts` | `backingInsufficient*` + restamp |
| `shapes/RcbShapesLayer.tsx` | `pickFullAndCanvasIds` 不因锐利升 host |
| debug | `?rcbDebug=paint` |

### Phase B（1 周）— Atlas 按 zoom 重烤

| 目录/API | 动作 |
|----------|------|
| `webglSceneRenderer.ts` | 全 stamp key 带 `atlasZoomBucket` |
| `webglInstanceAtlas.ts` | 多档 cell 或等价 |
| `api/Renderer.ts` | 文档化 restamp / bucket |
| Camera gesture | 已有 `setSoaCameraGestureActive`；settle 触发补锐 |

### Phase C（1 周）— Intent 统一

| 目录/API | 动作 |
|----------|------|
| `render/paintIntent.ts` | **新建** `resolvePaintIntent` |
| `api/Renderer.ts` | 唯一对外路由入口 |
| 删除/弃用 | `*NeedsSharpHost` 升 host 语义 |

### Phase D（并行）— API 门面落地

| 目录/API | 动作 |
|----------|------|
| `api/Document.ts` … `Selection.ts` | 薄 re-export + JSDoc |
| `api/index.ts` | 汇总 |
| 规范 | 新代码 `from '@/components/rcb/api'`；`rcb/` 内禁 barrel |

### Phase E（可选）

板面进同一 WebGL 深度、Worker tile —— 进一步减少 `dom-obligatory(stack-over-plate)`。

## 3.3 Flag

```
rcbFigmaInk=1     # 新 tile/restamp（默认开）
rcbSharpHost=1    # 应急恢复「升 SVG 锐利」（默认关）
```

## 3.4 验收（与 API 对应）

| 验收项 | 看哪个 API / 层 |
|--------|-----------------|
| 板内 800% 不糊 | `artboard-tile` / `artboardInkTiles` |
| path 放大不糊 | `atlas-stamp` restamp，`fullIds` 不暴涨 |
| 点不着 | `HitTest.isOccludedByHigherArtboard` |
| 选中才出现 | `paintZ` vs idle Intent（不该靠 raise 才锐） |
| 5k 跟手 | `setSoaCameraGestureActive` + settle restamp |

## 3.5 排期一览

```
Week 1  A：tile + 去 pixelated + 关锐利升 host + debug + api/ 骨架
Week 2  B：zoomBucket 全覆盖 + 多档 cell + 空生成器 restamp
Week 3  C+D：paintIntent 唯一 + api 门面收口 + 文档/回归
```

---

# 附录：改 bug 速查

1. **看不见** → Intent 错表面？ / `paintZ` 低于板？ / cull？  
2. **糊** → backing 不足却在拉伸？缺 restamp？画板超 cap？  
3. **点不着** → hit 遮挡 vs paint 不一致？  
4. **弹层级** → raise 时义务 host 与 SoA 混用？  
5. **循环依赖** → 勿从 `sceneDocument` 拉 editor chrome；走 `api/` 叶子常量。

---

*本文 = 目录 + 方法 API + 调整方案合订。执行锐利细节以 `FIGMA_INK_PLAN.md` 为准；对外方法以第二部分与 `rcb/api/` 为准。*
