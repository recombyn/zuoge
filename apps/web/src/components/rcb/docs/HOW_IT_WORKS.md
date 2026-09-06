# 现在画布到底怎么跑（现状说明书）

> 讲 **当前代码真实逻辑**，不是 Figma 改造后的理想态。  
> 合订 API/目录/改造方案见 [`CANVAS_GUIDE.md`](./CANVAS_GUIDE.md)。

读完你应能回答：SoA 是啥、矩形怎么画、点一下怎么命中、为啥一会儿 Canvas 一会儿 SVG。

---

## 0. 一句话总览

```
SceneDocument（真相：节点 JSON + stackOrder）
        │
        ├─► SoA Buffer（派生：给批量画/批量点用的 typed 数组）
        │
        ▼
每帧/每次脏区唤醒：
  ① 世界墨水 canvas（WebGL 优先）画「可 idle 的世界节点」
  ② 画板 FO 里的 canvas 画「绑在板上的 idle 节点」
  ③ 共享 SVG 画「板面 + 必须挂 DOM/SVG 的 host」
  ④ Selection chrome 画手柄（不进内容栈）
```

**物理叠层（下→上，`RcbCanvas`）：**

1. 网格 canvas  
2. **世界 idle 墨水 canvas**（SoA / WebGL）← 在 SVG **下面**  
3. **共享 SVG**（画板板面 + DomHost，`data-z` 排序）  
4. Selection chrome SVG  

所以：**世界 SoA 墨水盖不住楼上的画板板面**。  
板内 **idle** 不靠升 SVG 压板（跟板 FO 同层）；**选中/reveal** 必须升 SVG host — 见 §0.1 / §4.4。

---

## 0.1 画板内（绑了 `frameId`）——和 SVG 的真实关系

板是一块 **SVG 小组**，里面套一张 canvas，不是「每个矩形变 SVG」：

```
共享 SVG mount
└─ g[data-rcb-frame-plate]     ← data-z = 这块板的 stack z
     ├─ rect 填充（板白底）      ← SVG
     ├─ foreignObject
     │    └─ <canvas>           ← 板内 idle 矩形/图/字画在这里（SoA → 共享 WebGL→FO）
     └─ rect 描边（板边框）      ← SVG
```

因此：

| 问题 | 答案 |
|------|------|
| 板内矩形是 SVG 画的吗？ | **不是。** 是板 FO 里的 canvas（`paintArtboardInkSurface` → 共享 WebGL SoA/mesh，失败时才 Canvas2D） |
| SVG 在板里干什么？ | 只提供 **板壳**（底、边、FO 容器、`data-z`、可选 clip） |
| 为啥看起来在板「上面」？ | 同一 `g` 里 FO/canvas 叠在 fill rect **之后**，跟板一个层级一起排 |
| 还要升 DomHost 吗？ | **idle 普通板内形不用。** 选中 / overflow reveal 时必须升 SVG host（世界 WebGL 在板下，靠 SoA raise 盖不住板） |
| 世界 WebGL 画板内节点吗？ | **idle 不画**（`skipFrameBound`）。reveal 瞬间若 SoA 未清 idle，可能短暂世界层 fallback；正式路径是 host |

**对比：**

```
世界未绑板矩形 → 世界墨水 canvas（WebGL）→ 物理上在所有 SVG 板之下
板内矩形（idle） → 板自己的 FO canvas     → 跟着板的 data-z 走，看起来就在板里
板内矩形（选中） → 升 SVG host（max+1）   → 压住板面；FO 停画防鬼影
世界要盖住某板   → 才需要升 SVG host（和板比 data-z）
```

---

## 1. 启动后谁在干活

| 角色 | 文件 | 干什么 |
|------|------|--------|
| 舞台壳 | `canvas/RcbCanvas.tsx` | 建双 canvas、相机、调 `inkRenderer.render` |
| 世界墨水 | `createSceneRenderer` → WebGL 或 Canvas2D | 画 SoA idle |
| Host 层 | `shapes/RcbShapesLayer.tsx` | 视口裁剪、决定谁进 SoA / 谁进 SVG、发布 idle 列表 |
| 画板 | `frames/HtmlArtboardFrame.tsx` + `artboardInkSurface.ts` | 板面 SVG + 板内 canvas 墨水 |
| 文档 | `scene/document/sceneDocument.ts` | CRUD、`stackOrder`、z |
| 点击 | `sceneHitBridge.ts` + spatial index | 统一栈拾取 |

**不是** 永远 `requestAnimationFrame` 空转。墨水在这些时候醒：

- 相机动了 / idle 列表变了（`subscribeSceneCanvasIdlePaint`）  
- 拖动预览、圆角预览等脏了  
- 画板自己 `scheduleArtboardInkPaint`

手势中：`setSoaCameraGestureActive(true)` → 暂停 Worker tile bake，世界仍可 live 画。

---

## 2. SoA 是干什么的

**SoA = Structure of Arrays（结构数组）**  
不是另一种文档，是文档的 **派生缓存**，专门给「成千上万个矩形」做：

- 连续内存：`positions[]`、`colors[]`、`flags[]`、`kinds[]`、`ids[]`…  
- 空间索引：`quadtree`，快速「这块屏幕有谁」  
- 标志位决定能不能进世界墨水

| 标志 | 意思 |
|------|------|
| `VISIBLE` | 在场景里 |
| `CANVAS_IDLE` | 允许走 SoA/WebGL/板内 canvas（挂了 DomHost 会清掉，防双画） |
| `BASIC_GEOM` | 开线段（线/箭头/笔路径）→ WebGL **实例化**画 |
| `ATLAS_STAMP` | 媒体等烤图贴 atlas（形状/文字不走这条） |
| `DIRTY` | 要重烤 / 重上传 |
| `FREE` | 槽位空了可回收 |

**和文档的关系：**

```
doc.deltaSetLike[id]  = 节点真相（attrs、frameId…）
SoA.ids[slot] = id     = 同一个节点在缓冲里的下标
```

同步：`syncSceneRenderBufferFromDocument` / `Incremental`。  
**改文档要记得让 SoA 跟上**，否则画的是旧几何。

**为啥要它：** 粘贴 500 个矩形时，不能每个都挂一个 SVG DOM；SoA + WebGL 一次画一批。

---

## 3. 一个节点「怎么画」——决策顺序（现状）

对每个可见节点，`RcbShapesLayer.pickFullAndCanvasIds` 大致这样：

```
if 义务必须 Dom（lottie / group / SoftGlow / 空生成器 / …）
   或 世界节点 stack 高于某块画板（盖不住板除非升 SVG）
   或 选中的生成器（raise 要靠 data-z）
   或 板内绑定 +（选中 paintRaise | overflow reveal）（同上：世界墨水在板下）
   或 放大后 atlas 糊 → **restamp（zoomBucket）**，禁止升 SVG 当锐利手段
   （历史：*NeedsSharpHost → 升 SVG；已废除）
→ fullIds → SVG DomHost

else
→ canvasIds → 保持 SoA，世界 WebGL 或板内 canvas 画
```

然后：

- 有 `attrs.frameId` 且仍 `CANVAS_IDLE` → **不进世界 WebGL**，进 **画板 FO canvas**  
- 无 `frameId` 且 `CANVAS_IDLE` → **世界 WebGL**

---

## 4. 矩形怎么绘制（最重要的例子）

### 4.1 世界里的普通闭合形（未绑画板、未选中）

```
文档 shape/rect|ellipse|polygon|star|triangle
  → canIdlePaintOnCanvas = true
  → 产品 WebGL：CANVAS_IDLE + 向量 mesh
  → collectSoaWebglInstances
       · tessellateFill / tessellateStroke → GPU triangles
       · WebGL mesh draw
  → 画在「世界墨水 canvas」上
```

闭合形走向量三角化，不再烤 atlas 格。

### 4.2 有渐变 / 大旋转 / 复杂填充

```
同样 ATLAS_STAMP
  → bake 成图 → stamp 进 atlas（~256px 格）
  → WebGL 画一个带纹理的 quad
```

放大后格不够 → 现状会 `idle*NeedsSharpHost` **改挂 SVG**（所以你会觉得「又 Canvas 又 SVG」）。

### 4.3 画板里面的矩形

```
attrs.frameId = 某板
  → 世界 WebGL 跳过（skipFrameBound）
  → HtmlArtboardFrame 的 foreignObject canvas
  → paintArtboardInkSurface
  → artboardWebglInk（共享 WebGL2 + onlyFrameId 收集 + mesh）
  → blit 到 FO canvas（板坐标；WebGL 不可用时才 paintSoaIdleSlot）
```

板的白底和描边是 **SVG**；板内图形是 **板里那张 canvas**（WebGL ink on FO）。  
Backing 仍随 `zoom×dpr` 变；`ARTBOARD_INK_MAX_EDGE` 防 OOM，不再靠 8× 永久发虚。

### 4.4 选中普通矩形

- **世界 unbound：** 仍走 SoA/WebGL（不升 SVG）；选中 raise 只在墨水排序里临时 `maxZ+1`
- **板内绑定（`frameId`）：** 必须升 **SVG host**，`data-z = max+1`，并 `revealOverflow` 清 clip  
  - FO / `onlyFrameId` **跳过** `frameClipRevealsOverflow`（否则板内留下 clip 鬼影，外面世界层再画一半）  
  - `applySoaHostInkFlags` 清掉 `CANVAS_IDLE`，防 FO+世界+host 三路双画  
  - 世界 WebGL 在板 SVG **下面**，只靠 SoA raise **盖不住**白底板
- 手柄在 chrome 层，不是内容墨水

### 4.5 要「盖在画板上面」的世界矩形

世界墨水在 SVG **下面**，SoA 画出来也压不住板。  
若 `stackOrder` 里节点高于板 → `worldNodeStacksAboveAnyFrame` → **升 SVG host**，用 `data-z` 和板比高低。

---

## 5. 其它元素现在怎么画

| 元素 | 现状路径 |
|------|----------|
| 矩形/椭圆/多边形/星/三角 | atlas 烤图 + stroke pad |
| 线/箭头 | BASIC_GEOM → WebGL 开线段或 atlas 笔触 |
| 铅笔 | 富路径 atlas（不是 BASIC 中心线） |
| 文字 | SoA TEXT → **字形 outline fill mesh**（无 text atlas；编辑时 FO） |
| 图片 | idle：atlas；CORS/过程/特殊 → DomHost |
| 视频 | idle 可 atlas；真正播常用 FO `<video>` |
| 空生成器 | **强制 SVG host**（图标清晰 + 可压板） |
| Lottie | **强制 DomHost** |
| SoftGlow / 过程中 | DomHost + 清掉 `CANVAS_IDLE` |

---

## 6. WebGL 怎么处理（世界墨水）

入口：`createWebglSceneRenderer` → `render(req)`。

```
1. 清屏 / 调尺寸（可走 DOF FBO）
2. 若开启 bake 且非手势：
     Worker 把远处内容烤成大 tile → 贴满视口则可跳过 live 实例
3. 否则 collectSoaWebglInstances(buf)：
     - 跳过非 VISIBLE / 非 CANVAS_IDLE / 绑了 frameId 的
     - IMAGE/TEXT/复杂 → atlas stamp（key 常带 zoomBucket）
     - BASIC_GEOM → 实例属性写入 GPU buffer
4. 按 stack + 选中 raise 排序后，一次（或分批）instanced draw
```

WebGL 挂了 → `createCanvasSceneRenderer` 回退（网格一直是 Canvas2D）。

**Atlas：** 一张大纹理切成很多 ~256 格；复杂节点烤进一格再贴。格固定 → 放大易糊（现状用升 SVG 补；方案要用 restamp）。

---

## 7. 点击怎么处理

指针 → 场景坐标 → 拾取：

```
1. 空间索引找出候选（节点 + frame:id）
2. 按永久 stackOrder 的 z 从高到低排（选中 raise 不参与「理想 hit」）
3. hitTestUnifiedStackAtPoint：
     先试更高的板/节点
4. 对某个节点 isNodePickableAtPoint：
     - 被更高不透明画板挡住？→ isOccludedByHigherArtboard（用 idle paintZ）
     - 有 SoA 槽？→ hitTestSoaSlot（几何/圆角/路径采样）
     - 否则 Path2D / AABB 等
5. 第一个精确命中的赢
```

**要点：**

- 你看见的 raise（选中跳到最前）**主要改 paint**；hit 仍按「没 raise 的层级 + 空生成器 paintZ」想。  
- 点到画板空白 = 命中 `frame`，不是板内某个 SoA 节点。

---

## 8. 层级：四个词别混

| 词 | 是什么 | 影响画？ | 影响点？ |
|----|--------|----------|----------|
| `stackOrder` | 文档里永久顺序 | 是 | 是 |
| `data-z` | SVG 上板/host 的排序值 | 仅 SVG 层 | 间接 |
| 选中 raise | 临时 max+1 | 是（墨水排序 / host z） | **理想上否** |
| `nodePaintZIndex` | 绘制用 z（空世界生成器可抬到板之上） | 是 | 遮挡检测用 idle |

**记忆：**  
SoA 世界墨水在地板下；SVG 板在楼上。楼下画得再欢也压不住楼上的板。

---

## 9. 用「写代码」的方式记流程

### 新增一种「简单矢量」

1. 能进 `canIdlePaintOnCanvas` 吗？  
2. 闭合形 → atlas 烤图+pad；开线段能 `BASIC_GEOM` → WebGL 实例；否则 atlas 或义务 Dom。  
3. 有 `frameId`？→ 板内 canvas，别指望世界 WebGL。  
4. 要压住画板？→ 必须能上共享 SVG（host），或将来板也进同一 GPU 层。

### 改「画出来不对」

1. 看 Intent：世界 SoA / 板内 canvas / SVG host？  
2. `CANVAS_IDLE` 是否被 host 清掉？双画或全没？  
3. `data-z` / `nodePaintZIndex` 和板谁高？  
4. 绑板了却在世界找？或反过来？

### 改「点不着」

1. 被更高板挡住了吗？  
2. SoA hit 几何和视觉 AABB 一致吗？  
3. 是不是点在 chrome/host 上被别的接住了？

### 改「放大糊」

1. atlas 格不够？还是画板 8× cap？  
2. 现状可能被升成 SVG（突然变清晰）——那是补丁，不是 Figma 做法。

---

## 10. Vector geom（WASM）

crate：`packages/rcb-wasm-geom` → `render/vector/wasm/pkg/`；TS：`wasmGeom.ts`；Worker：`geomWorker.ts`（batch fill + 文字 `text_glyph`）。

| 能力 | 主入口 | 不可用时 |
|------|--------|----------|
| densify / fill / stroke mesh | `meshCache` / `wasmGeom` | JS tessellate |
| 形状布尔 | `shapeBoolean.ts` | `polygon-clipping` |
| 笔 / 线 / 箭头轮廓化 | `outlineToPath` → `offset_polyline` | JS offset |
| 文字 canvas 轮廓化（CJK） | Worker trace + RDP | 主线程 WASM / JS Moore |
| 文字 fontkit（Latin） | `outlineTextFont.ts` | —（纯 JS） |
| 铅笔轮廓化 | `pencilInkPathFromPoints` | —（纯 JS） |

构建：`apps/web` 下 `npm run build:wasm`。关闭：`?rcb_wasm=0`。说明见 crate `README.md`。

---

## 11. 关键文件地图（写的时候打开谁）

```
舞台唤醒     → canvas/RcbCanvas.tsx
谁 SoA/谁 SVG → shapes/RcbShapesLayer.tsx → pickFullAndCanvasIds
SoA 缓冲     → render/sceneRenderBuffer.ts
WebGL 收集画 → render/webglSceneRenderer.ts → collectSoaWebglInstances
Atlas        → render/webglInstanceAtlas.ts
板内墨水     → frames/artboardInkSurface.ts
板面 SVG     → frames/HtmlArtboardFrame.tsx
文档/z       → scene/document/sceneDocument.ts
点击         → scene/document/sceneHitBridge.ts
idle 资格    → render/sceneRenderer.ts → canIdlePaintOnCanvas
向量几何     → render/vector/wasmGeom.ts + packages/rcb-wasm-geom
轮廓化       → scene/paint/outlineToPath.ts
布尔         → selection/shapeBoolean.ts
```

---

## 12. 和改造方案的关系（别混）

| | 现状 | 改造（FIGMA_INK_PLAN） |
|--|------|------------------------|
| 放大糊 | 升 SVG / 或糊着 | atlas restamp + 画板 tile |
| DomHost | 锐利 + 义务混用 | **仅义务** |
| 矩形简单 | WebGL 实例（已较锐） | 保持 |
| 板内 | 共享 WebGL→FO；`MAX_EDGE` 帽 | 可见 tile 全分辨率（显存优化） |

写新功能：先按 **本章现状** 接线；锐利相关新逻辑按 **改造方案** 走 restamp，不要再加第四种 `*NeedsSharpHost`。
