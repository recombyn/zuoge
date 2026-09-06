# RCB 画布架构与 API

> 目标：把「到处补丁」收成一套可推理的标准画布面：Document / Camera / Scene / Renderer / HitTest / Selection。  
> 代码根目录：`apps/web/src/components/rcb/`  
> **锐利 / Figma 对齐的完整调整方案（执行以该文档为准）：[`FIGMA_INK_PLAN.md`](./FIGMA_INK_PLAN.md)**

---

## 1. 先记住的一张图

```
Camera (zoom/pan) + Document (nodes, frames, stackOrder)
        │
        ▼
Scene spatial (谁在视口里 / 谁挡住谁)
        │
        ▼
PaintIntent（Figma 对齐后）
  ├─ gpu-instance   → 开线段（线/箭头），按屏像素画
  ├─ atlas-stamp    → 闭合形与富墨水，烤图+pad；zoomBucket 变化则 restamp
  ├─ artboard-tile  → 板内可见 tile，按 zoom×dpr 烤
  └─ dom-obligatory → 仅 video/audio/input/lottie/必须盖板等义务
        │
        ▼
HitTest 按同一套 stack / paint z 走（选中抬升不改 hit 遮挡）
        │
        ▼
Selection chrome（屏幕像素手柄，不进内容栈）
```

**合层顺序（由下到上）**

1. 像素网格 canvas（可选）  
2. 世界 SoA 墨水（WebGL 优先，失败回退 Canvas2D）  
3. 共享 SVG mount：`data-z` = 画板板面 + **义务** DOM hosts（统一 `stackOrder`）  
4. Selection / overlay chrome  

**两条铁律：**

1. 跨类型遮挡只认 `stackOrder`（再加临时 paint raise）。  
2. `displayPx > backingPx` → **重烤/分块**，禁止拉伸低清图；**不为锐利升 SVG**（见 FIGMA_INK_PLAN）。

---

## 2. 目录树（职责一眼看完）

```
rcb/
├── index.ts                 # 公共 barrel（偏大，内部模块勿再 import 它）
├── sceneNode.ts             # SceneDocument / SceneNode Zod + 类型
│
├── camera/                  # 相机
│   ├── context.tsx          # React 上下文、viewport/dpr、overlay portal
│   └── transform.ts         # world ↔ screen 纯函数
│
├── canvas/                  # 舞台壳
│   ├── RcbCanvas.tsx        # 网格 canvas + 墨水 canvas + renderer 接线
│   ├── RcbSvgDefs.tsx       # 共享 SVG defs
│   ├── svgBoardRegistry.ts  # SVG board 注册
│   └── useSvgBoard.ts
│
├── core/                    # 数学 / 空间 / 预览
│   ├── math.ts              # zoom、视口 AABB、fit
│   ├── spatialIndex.ts      # SceneSpatialRuntime（文档级 cull/hit）
│   ├── soaQuadtree.ts       # SoA 槽位宽相
│   ├── transformPreview.ts  # 拖动中的 live paint box
│   ├── dpr.ts / layout.ts / types.ts / geometry/
│
├── render/                  # 墨水后端（性能层）
│   ├── sceneRenderer.ts     # createSceneRenderer、canIdlePaintOnCanvas、2D idle
│   ├── webglSceneRenderer.ts
│   ├── webglInstanceAtlas.ts  # ~252px atlas + 锐利提升门闩
│   ├── sceneRenderBuffer.ts   # SoA slots / 脏区 / forEachVisibleInRect
│   ├── soaBakeLayer.ts        # 大规模 tile bake
│   ├── renderDemotionScheduler.ts  # ACTIVE_SVG ↔ DEPLOYED_SOA
│   ├── gpuDepthOfField.ts
│   └── vector/                # densify / tessellate / boolean / 轮廓化 geom
│       ├── wasmGeom.ts        # WASM 适配（JS fallback）
│       ├── meshCache.ts
│       └── wasm/              # geomWorker + pkg/rcb_wasm_geom*

├── shapes/                  # DOM/SVG host 层（清晰度层）
│   ├── RcbShapesLayer.tsx   # 视口裁剪 + pickFullAndCanvasIds + 挂 host
│   ├── RcbShapeHost.tsx
│   └── shapeHostRegistry.ts # 共享 mount、data-z 排序
│
├── frames/                  # 画板 / 动画工作台
│   ├── HtmlArtboardFrame.tsx
│   ├── artboardInkSurface.ts  # 板内 FO 墨水（共享 WebGL→blit；2D 回退）
│   ├── artboardWebglInk.ts    # 共享 WebGL2 + onlyFrameId
│   ├── frameContentClip.ts    # clipContent 几何 only
│   └── selection/selectionPaintRaise.ts  # raise / reveal 注册表
│   └── frameNodeBinding.ts / FrameDraw|MoveFeature …
│
├── scene/
│   ├── document/            # 文档语义（标准 API 的「Document」）
│   │   ├── sceneDocument.ts     # CRUD、stackOrder、nodePaintZIndex
│   │   ├── sceneHitBridge.ts    # 统一拾取 + 画板遮挡
│   │   ├── sceneStackPainter.ts # stackPaintZ / syncStackPaintOrder
│   │   ├── nodeCapabilities.ts  # 节点类型谓词
│   │   └── nodeFactories.ts / sceneEffects.ts / …
│   ├── paint/               # sceneToSvg、轮廓化 outlineToPath、导出
│   └── overlay/
│
├── selection/               # 选中、手柄、标题
├── tools/                   # 绘制工具
├── process/                 # SoftGlow 等过程板
└── docs/                    # 本目录
    ├── CANVAS.md
    ├── HOW_IT_WORKS.md      # 现状（含 §10 Vector WASM）
    ├── CANVAS_GUIDE.md
    └── FIGMA_INK_PLAN.md
```

---

## 3. 为什么会「又 Canvas 又 SVG」

| 表面 | 解决什么 | 放大时 |
|------|----------|--------|
| **WebGL / Canvas2D SoA** | 上千节点时的吞吐 | 位图/atlas 有分辨率上限 → 糊 |
| **画板 FO Canvas** | 板内子节点跟板一起裁剪、少占世界层 | `MAX_EDGE` 防 OOM；产品路径为共享 WebGL→FO |
| **SVG / DOM host** | 矢量边、Lucide 图标、需压住画板、编辑器 | CSS zoom 下仍清晰 |
| **HTML FO media** | video/audio/滚动文字原生能力 | 清晰取决于资源本身 |

这不是两套画布乱打，而是 **性能层 + 清晰度层** 的分层。乱的地方在于：路由规则散落在多个布尔函数里，改一个节点类型要改好多处。

### 放大不掉清晰、又要性能 —— 推荐策略

**不要**试图「全世界只用一张 Canvas 且永远锐利」：那等于每帧按屏幕分辨率重绘全场，5k 节点会崩。

**要**固化成产品策略：

1. **默认 SoA（糊一点可接受的 idle）**  
2. **屏幕边长超过 atlas 内径（~252px）或空生成器 / 编辑态 → 升 DomHost（锐利）**  
3. **相机停稳后再 stamp / promote，手势中用低清代理**（已有 `setSoaCameraGestureActive` / demotion）  
4. **永远不要把「必须锐利」的东西（空生成器图标、板描边）放进 atlas** —— 板边已改 SVG；空生成器已强制 host  

可选中期增强（不必一次做完）：

- 多档 atlas mip / 停稳后按 `zoom×dpr` 重 stamp  
- 闭合形（rect/ellipse/poly/star）走 Canvas 烤图 + pad → atlas 贴图；开线段可走 GPU 实例  
- 统一一个 `needsSharpHost(node, zoom, dpr) → reason`，删掉三个近似函数名  

---

## 4. 视口裁剪 / clip —— 有哪些、怎么知道有没有用

| 机制 | 文件 | 作用对象 | 肉眼怎么验证 |
|------|------|----------|--------------|
| Host 视口裁剪 | `RcbShapesLayer`（`CULL_PAD_SCREEN_PX`） | 卸载屏外 SVG host | 大量 host 时平移，屏外节点 DOM 消失；选中的 `keepVisibleIds` 仍在 |
| SoA 视口遍历 | `forEachVisibleInRect` / QT | 世界墨水只画可见槽 | 平移时屏外墨水不画；开调试统计可见 slot 数应变化 |
| 画板 `clipContent` | `frameContentClip` + SVG clipPath | 板内溢出裁切 | 板内大图超出边应被切；选中溢出时可 `revealOverflow` |
| 板内 canvas clip | `artboardInkSurface` | 板内 SoA | 同上，但看的是 FO canvas 像素 |
| WebGL per-slot clip | `resolveSoaWebglSlotClip` | 世界层误画的板内槽 | 板内节点不应再出现在世界 WebGL 上 |
| 更高画板遮挡 | `isOccludedByHigherArtboard` | **Hit**，不是 paint | 下层节点被上层白底画板盖住时应点不中 |
| Dirty AABB | `resolveSoaCanvasDirtyRegion` | 局部重绘 | 单点改动不应全屏闪 |

**感觉「裁了没效果」的常见原因：**

1. 裁的是 **host 挂载**，不是选择框（选中 chrome 永远在）  
2. 裁的是 **hit**，paint 仍画在下面（看起来在，点不着）  
3. `keepVisibleIds` / selection raise / revealOverflow 把例外打开了  
4. 节点其实在 **另一条 PaintRoute**（世界 SoA vs 板内 canvas vs SVG）上  

建议加一个开发开关（后续工作）：在 overlay 画「本帧 PaintRoute 统计 + 可见 cull 数」，比猜有没有生效快。

---

## 5. 标准画布 API（目标面）

实现已散在现有文件里；整理时按这六块 **只从门面导入**，内部实现可逐步搬家。

### 5.1 Document — 场景数据

来源：`scene/document/sceneDocument.ts`、`sceneNode.ts`

| API | 含义 |
|-----|------|
| `createBareDocument` / `normalizeDocument` | 空文档 / 规范化 |
| `addNodeToDocument` / `addNodesToDocument` | 追加节点（通常 append stack 顶） |
| `updateNodeInDocument` / `updateNodesInDocument` | 补丁；attrs 浅合并 |
| `removeNodesFromDocument` | 删除并 reconcile stack |
| `reorderNodesInDocument` | 改永久 `stackOrder` |
| `stackZIndex(doc, kind, id)` | 永久 z |
| `nodePaintZIndex(doc, id, raised)` | **绘制用 z**（空世界生成器可抬到画板之上，不改 stackOrder） |
| `selectionPaintZIndex(doc, kind, id, raised)` | 选中临时 max+1 |
| `worldNodeStacksAboveAnyFrame` | 世界节点是否需要离开 SoA 才能盖住板 |
| `maxDocumentStackZ` / `maxArtboardPlateStackZ` | 栈深 |

**约定**

- 永久层次只写 `stackOrder`。  
- 选中抬升、空生成器压板，只改 **paint z**，不写回文档。  

### 5.2 Camera — 视口

来源：`core/math.ts`、`camera/transform.ts`、`camera/context.tsx`

| API | 含义 |
|-----|------|
| `useRcbCamera` / `createCameraTransform` | 读相机 / 纯变换 |
| `rcbScreenToScene` / `rcbSceneToScreen` | 坐标互转 |
| `rcbViewportSceneBounds` | 当前可见场景 AABB（裁剪输入） |
| `rcbStepZoom` / `rcbClampZoom` / `rcbFitCamera*` | 缩放与适配 |
| `rcbCameraCssZoom` / `rcbCameraScreenOffset` | CSS 层相机 |

### 5.3 Scene — 空间索引

来源：`core/spatialIndex.ts`、`render/sceneRenderBuffer.ts`

| API | 含义 |
|-----|------|
| `SceneSpatialRuntime` / `RcbSpatialIndex` | 文档级宽相（节点 + `frame:id`） |
| `nodeSceneAabb` / `frameSceneAabb` | AABB |
| `forEachVisibleInRect` | SoA 可见槽 |
| `getSharedSceneRenderBuffer` / `syncSceneRenderBuffer*` | SoA 缓冲 |

**目标：** 文档空间索引为 SoT；SoA QT 只是缓冲衍生视图。

### 5.4 Renderer — 绘制路由

来源：`render/*`、`shapes/RcbShapesLayer.tsx`、`frames/artboardInkSurface.ts`

| API | 含义 |
|-----|------|
| `createSceneRenderer` / `createWebglSceneRenderer` | 世界墨水 |
| `canIdlePaintOnCanvas` | 能否走 SoA/idle 位图路径 |
| `pickFullAndCanvasIds` | 拆 `fullIds`(host) / `canvasIds`(SoA)；板内 raise/reveal → host |
| `idleMediaNeedsSharpHost` 等 | 放大后是否必须升 host |
| `applySoaHostInkFlags` | host 占用时关掉 SoA 槽，防双画 |
| `paintArtboardInkSurface`（frames） | 板内墨水；reveal id **不进** FO collect |
| `artboardWebglInk` / `onlyFrameId` | 共享 WebGL→FO；同样跳过 reveal |
| `syncStackPaintOrder` | 按 `data-z` 排共享 SVG |

**目标 API（建议新增，薄封装）：**

```ts
type PaintRoute = 'soa-world' | 'soa-artboard' | 'dom-host' | 'dom-media';

function resolvePaintRoute(doc, id, ctx: { zoom; dpr; raised; holdHost }): PaintRoute
function paintFrame(doc, camera, dirty): void  // 内部再分发三条后端
```

### 5.5 HitTest — 拾取

来源：`scene/document/sceneHitBridge.ts`、部分 SoA hit

| API | 含义 |
|-----|------|
| `hitTestSceneAtPoint` / `hitTestUnifiedStackAtPoint` | 统一点选 |
| `isNodePickableAtPoint` | 单节点可点？ |
| `isOccludedByHigherArtboard` | 是否被更高画板挡住（idle paint z） |
| `frameIdAtPoint` | 点到哪块板 |
| `hitTestSoaBuffer*` | SoA 槽命中 |

**约定：** hit 的遮挡用 idle `nodePaintZIndex(..., false)`；**不要**用选中 max+1 改变「理想 hit」。

### 5.6 Selection — 选中与临时抬升

来源：`selection/*`、`frames/frameContentClip.ts`（raise 注册表宜迁出）

| API | 含义 |
|-----|------|
| `listSingleSelectionPaintRaiseNodeIds` | 单选时哪些节点 paint raise |
| `setSelectionPaintRaiseIds` / Frame 变体 | 通知 paint/hit |
| Selection chrome / `NodeTitleLabel` | 屏幕 UI，z 跟 owner paint z |

---

## 6. 节点类型 → PaintRoute（决策表）

| 类型 | 默认 idle | 何时 DomHost |
|------|-----------|--------------|
| rect / ellipse / line（基础） | SoaWorld / SoaArtboard | 板内选中/reveal、需盖住画板、描边 atlas 糊、SoftGlow |
| path / poly / star / pencil | atlas / rich idle | 糊、抬升、盖板、过重 path、**板内选中/reveal** |
| text | outline mesh | 编辑态 FO；无 text atlas |
| image / video / audio | atlas stamp | 屏边 > atlas、空生成器、CORS、过程中、解码编辑 |
| 空生成器（图/视/音/Lottie） | **禁止 SoA** | **永远 DomHost**（图标清晰 + 可压板） |
| lottie / group | 禁止 SoA | 永远 DomHost |
| backdrop-blur / puppet-warp | 禁止 SoA | DomHost |

板绑定（`attrs.frameId`）：idle SoA → **SoaArtboard**，不进世界 WebGL。  
选中 / overflow reveal：FO 停画该 id → **升 SVG host（max+1）**；禁止 FO+世界各画一半。

---

## 7. 整理路线（保留必要、删补丁感）

按优先级，**可增量、不需重写**：

1. **加 `rcb/api/` 门面**  
   `Document.ts` / `Camera.ts` / `Scene.ts` / `Renderer.ts` / `HitTest.ts` / `Selection.ts` 只做 re-export + 短注释。新代码只从这里进。

2. **一个 `resolvePaintRoute`**  
   合并 `canIdlePaintOnCanvas` + sharp 三门闩 + `worldNodeStacksAboveAnyFrame` + demotion hold。`pickFullAndCanvasIds` 变薄。

3. **一个 `resolveNodeClipRect`**  
   SVG / Canvas2D / WebGL 都只调它（源头已是 `findClippingFrameForNode`）。

4. **z 三词定死**  
   - `naturalZ` = `stackZIndex`  
   - `paintZ` = `nodePaintZIndex` / frame 的 selection raise  
   - `hitZ` = idle paint z（无 selection raise）  

5. **raise/reveal 注册表迁出 `frameContentClip`**  
   归 Selection 服务；paint/hit 订阅。去掉「模块全局副作用」。

6. **禁止 `rcb/` 内部 `import from '@/components/rcb'`**  
   打断循环依赖（`A4_PORTRAIT` TDZ 一类问题）。

7. **开发可视化**  
   `?rcbDebug=paint`：每个节点角标 PaintRoute；统计 cull/host/soa 数。让「裁剪有没有用」可见。

8. **保留 demotion scheduler**  
   它是正确的事件模型；把 PaintRoute 接进去，少散落 `forceFullIds`。

**不要删的（必要）：**

- 双层墨水（世界 + 板内）—— 板裁剪与性能都靠它  
- DomHost 提升 —— 清晰度与压板  
- `stackOrder` 统一栈 —— 遮挡唯一真相  
- 视口 cull —— 否则 host DOM 爆炸  

**可以收的（补丁感来源）：**

- 三套近似的 sharp 函数名  
- 多处 eligibility 同义反复  
- 选中 raise 与 clip 揉在同一文件  
- barrel 过大导致隐式环依赖  

---

## 8. 改 bug 时的检查清单

1. **看不见？** 先查 PaintRoute：是 SoA 被板盖住，还是 host `data-z` 低于板，还是 cull 卸了。  
2. **选中才看见？** 多半是 selection paint raise；idle 应用 `nodePaintZIndex`，不是只靠 raise。  
3. **放大糊？** atlas / 板 ink 上限；该升 DomHost 还是提高 stamp 分辨率。  
4. **点不着？** hit 遮挡 vs paint 是否一致（`isOccludedByHigherArtboard`）。  
5. **弹一下 / 层级跳？** 抬升时生成器 **与板内绑定形** 是否升到 host；SoA 画在 SVG 下无法靠 max+1 盖住板面 / sibling host。板内拖出若仍见鬼影：FO 是否仍在 paint reveal。  
6. **TDZ / 循环依赖？** 不要从 `sceneDocument` 拉 editor chrome；常量放叶子模块。

---

## 9. 相关源文件速查

| 主题 | 路径 |
|------|------|
| 文档与 z | `scene/document/sceneDocument.ts` |
| 拾取 | `scene/document/sceneHitBridge.ts` |
| 栈绘制约定 | `scene/document/sceneStackPainter.ts` |
| Host 路由 | `shapes/RcbShapesLayer.tsx` → `pickFullAndCanvasIds` |
| Idle 资格 | `render/sceneRenderer.ts` → `canIdlePaintOnCanvas` |
| Atlas 锐利 | `render/webglInstanceAtlas.ts` |
| 板内墨水 | `frames/artboardInkSurface.ts` |
| 板裁剪 | `frames/frameContentClip.ts` |
| 相机 | `core/math.ts`, `camera/*` |
| 舞台 | `canvas/RcbCanvas.tsx` |

---

*文档版本：与当前代码库对齐的架构说明；实现搬家时可只改「目标 API」小节，保持这张总图稳定。*
