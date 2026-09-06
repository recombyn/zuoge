# RCB 画布完整调整方案（Figma 对齐）

> **产品硬约束：** 放大不得糊（矢量/图标级内容）；**不为锐利升 SVG DomHost**。  
> **对标：** Figma = 按当前视口 `zoom × dpr` 把可见内容重新光栅化进 GPU/Canvas tile，旧分辨率作废。  
> **DomHost 仅用于：** 浏览器必须能力（`<video>` / `<audio>` / 输入框 / Lottie 运行时），以及 **层级必须与 SVG 板面交错** 的极少数情况——**不作为清晰度方案**。  
> **目录 + 方法 API + 本方案合订：** [`CANVAS_GUIDE.md`](./CANVAS_GUIDE.md) · 门面代码：`rcb/api/`

---

## 0. 一句话定调

| 旧思路（否决作锐利主路径） | 新思路（采用） |
|---------------------------|----------------|
| 屏上大于 atlas → 升 SVG host | 屏上大于当前 backing → **按 zoom 重烤 / 分块重画** |
| 画板 ink 顶 8× 后 `pixelated` 硬撑 | 超 cap → **可见 tile 按全分辨率烤**，禁止拉伸糊显示 |
| 三套 `*NeedsSharpHost` 当产品策略 | 改为 **`needsRestamp` / `backingInsufficient`**，输出 dirty，不输出「去挂 SVG」 |

---

## 1. 目标与非目标

### 目标

1. **矢量类**（形状、描边、字、空生成器图标、板描边）：任意 zoom 下屏上锐利，观感接近 Figma。  
2. **位图类**（照片/视频帧）：不低于源分辨率；源不够时允许糊（与 Figma 一致）。  
3. **大场景仍可交互**：手势中可用低清代理；**停稳后**补全分辨率。  
4. **API 可推理**：Document / Camera / Scene / Renderer / HitTest / Selection；PaintRoute 清晰。  
5. **改 bug 有清单**：看不见 / 糊 / 点不着 各查哪一层。

### 非目标（本方案不做）

- 推倒重写为原生引擎（C++/Skia）。  
- 全场景永久 SVG。  
- 手势每一帧都全分辨率重烤（会卡）。  
- 用 DomHost「骗」锐利。

---

## 2. 锐利契约（铁律）

```
displayPx(node) = sceneEdge(node) × zoom × dpr

if displayPx > backingPx(node, currentStamp):
  → 标记 REStamp / 分配更高分辨率 tile 并重绘
  → 禁止：CSS/相机拉伸低清 backing 当最终显示
```

| 内容类型 | backing 来源 | 不足时 |
|----------|--------------|--------|
| WebGL 基础几何（rect/ellipse/line 实例） | 每帧按屏像素画 | 通常已锐；保持 |
| Atlas stamp（path/text/media/图标） | 当前 cell 有效 texel | **restamp**（可更大 cell / 多 cell / 按 bucket） |
| 画板 Canvas ink | `min(cap, zoom×dpr) × 板尺寸` | **可见区分块**，每块按全 `zoom×dpr` |
| 世界 Canvas2D 回退 | 视口 backing | 随 zoom 重建视口缓冲 |
| 照片 | 解码分辨率 | 不够则糊（可接受）；勿再二次缩小后放大 |

**验收（人工）：**

- 空生成器图标从 25% → 400%：边缘不发虚。  
- 板内矩形描边 zoom 到 800%：不出现 pixelated 锯齿块。  
- 1080 照片放到屏上 2000px：允许略软；400px 照片放到 2000px：允许糊。  
- 5k 节点场景：捏合缩放跟手；松手 100–300ms 内锐化完成。

---

## 3. 目标架构（调整后）

```
Camera (zoom/pan + gestureActive + zoomBucket)
        │
        ▼
Scene spatial（可见集）
        │
        ▼
Renderer.resolvePaintIntent(node) →
  ├─ gpu-instance     基础几何，每帧矢量光栅化
  ├─ atlas-stamp      复杂填充/字/图，zoomBucket 驱动 restamp
  ├─ artboard-tiles   板内 idle，视口相交 tile 按 zoom×dpr 烤
  ├─ world-viewport   Canvas2D 回退，视口缓冲随 zoom 重建
  └─ dom- obligatory  仅 video/audio/input/lottie runtime
        │
        ▼
HitTest / Selection（不变：stackOrder + paintZ；raise 不改 hit 遮挡）
```

合层顺序保持：网格 → 世界墨水 → 共享 SVG（**仅板面 + 义务 DomHost**）→ selection chrome。

---

## 4. 分阶段执行（可排期）

### Phase A — 契约落地 + 去掉「糊着撑」（1–1.5 周）**【立刻做】**

**A1. 画板 ink：禁止超 cap 拉伸显示**

- 文件：`frames/artboardInkSurface.ts`、`HtmlArtboardFrame.tsx`
- 改动：
  - 导出 `ARTBOARD_INK_MAX_SCALE`、`artboardInkScale(zoom,dpr)`、`artboardInkBackingInsufficient(zoom,dpr)`。
  - **删除**（或仅手势中临时使用）`image-rendering: pixelated` 作为终态。
  - 当 `dpr×zoom > MAX`：改为 **tile 模式**（见 A2）；过渡期可先 **只烤与视口相交的板区域** 到临时高清 canvas，再 blit。
- 验收：zoom > 8/dpr 时板内矢量不糊。

**A2. 画板可见 tile（最小 Figma tile）**

- 新模块建议：`frames/artboardInkTiles.ts`
- 规则：
  - tile 世界边长固定（如 512 或 1024 scene px）。
  - 每 tile backing = `tileScene × min(zoom×dpr, hardCapPerTile)`；单 tile 像素上限（如 2048²）防爆显存。
  - 仅 `intersects(viewport, tile)` 的 tile 保留；出视口 LRU 释放。
  - `setSoaCameraGestureActive(true)` 时：复用低清或跳过新 tile；`false` 后补全。
- 接线：`paintArtboardInkSurface` 改为「清 + 画可见 tiles」。

**A3. 锐利门闩语义翻转**

- 文件：`render/webglInstanceAtlas.ts`、`shapes/RcbShapesLayer.tsx`
- 现状（已落地）：`backingInsufficientForAtlas` 驱动 restamp；DomHost 仅义务条件。历史别名 `idleMediaNeedsSharpHost` 已删除。
- 目标：
  - ~~新增 `backingInsufficientForAtlas`~~（已完成）。
  - 新增 `markAtlasRestampNeeded(id | '*', zoomBucket)`；由 WebGL 收集实例时 **force restamp**（更大有效分辨率或分格）。
  - `pickFullAndCanvasIds`：**不再**因「放大糊」把节点塞进 `fullIds`。
  - DomHost 仅保留：`lottie` / `group` / 过程编辑 / CORS 不安全 / SoftGlow 等 **义务** 条件 + `worldNodeStacksAboveAnyFrame`（层级，非锐利）。
- 空生成器：从「永远 SVG」改为「atlas 图标按 zoomBucket restamp」（图标路径矢量烤进 cell；cell 不够就多 cell 或提高 stamp 像素）。若短期图标 restamp 未就绪，**允许暂时保留 SVG**，但文档标为 **过渡债**，不写入长期契约。

**A4. Debug**

- `?rcbDebug=paint`：统计 `restampCount`、`artboardTiles`、`insufficientBacking`、`domObligatory`。
- 验收：放大时看到 restamp/tiles 上升，而不是 fullIds（SVG）暴涨。

---

### Phase B — 世界 Atlas 按 zoom 重烤（1 周）

**B1. 统一 zoomBucket 管道**

- 已有：`atlasZoomBucket`、部分 key 带 `z${bucket}`（text/img/audio）。
- 补齐：path / rounded / ellipse / generator icon / 所有 stamp 路径 key 必须含 bucket（或等价 fingerprint）。
- zoom 变化 → bucket 变 → cache miss → restamp（已有 restamp 统计）。

**B2. 动态 stamp 分辨率**

- 今日：固定 `SOA_ATLAS_CELL=256`。
- 调整：
  - 方案 B2a（推荐）：**多档 cell**（256 / 512），按 `displayPx` 选档；atlas 分页或第二 atlas。  
  - 方案 B2b：单 cell 但 `atlasBakePixelScale` 已 fill cell；不足时 **不升 SVG**，改为 **该实例改走 gpu-instance 或 path 三角化临时路径**。
- 手势中：`setSoaCameraGestureActive(true)` 跳过高档 restamp；停稳补。

**B3. 基础几何**

- 确认 WebGL `BASIC_GEOM` 每帧按变换画（非 atlas）；回归：无描边大矩形 800% 仍锐。
- 描边若走 atlas：纳入 B1/B2；或改为 shader 描边（更后）。

---

### Phase C — 世界层与板内统一「墨水意图」（1 周）

**C1. `render/paintIntent.ts`（新）**

```ts
type PaintIntent =
  | { kind: 'gpu-instance' }
  | { kind: 'atlas-stamp'; zoomBucket: number }
  | { kind: 'artboard-tile' }
  | { kind: 'dom-obligatory'; reason: string };

function resolvePaintIntent(doc, id, ctx: { zoom; dpr; gesture; raised }): PaintIntent
```

- `pickFullAndCanvasIds` / `collectSoaWebglInstances` / `artboardInk` **只读这一处**。
- ~~删并三套 `*NeedsSharpHost` 的「升 host」语义~~（已删；用 `backingInsufficientForAtlas`）。

**C2. 板绑定节点**

- idle + 有 `frameId` → `artboard-tile`（不进世界 WebGL）。
- 义务 DomHost 仍可板内（video）。

**C3. 层级**

- `nodePaintZIndex` / `worldNodeStacksAboveAnyFrame` 保留。
- 「盖住画板」若仍必须 SVG mount：仅这些节点 `dom-obligatory(reason:'stack-over-plate')`，与锐利无关；中长期评估 **板也进同一 WebGL 层** 以消灭该类义务（Phase E）。

---

### Phase D — API 门面与去补丁（并行，0.5–1 周）

```
rcb/api/
  Document.ts    # sceneDocument 再导出 + 注释
  Camera.ts
  Scene.ts
  Renderer.ts    # paintIntent + createSceneRenderer…
  HitTest.ts
  Selection.ts
```

- 新代码只从 `rcb/api/*` 进；禁止 `rcb/` 内部 `import '@/components/rcb'`。
- z 三词：`naturalZ` / `paintZ` / `hitZ`。
- raise/reveal 从 `frameContentClip` 迁到 Selection 服务（可第二迭代）。

---

### Phase E — 可选中长期（像 Figma 内核）（按需）

1. **画板板面也进 WebGL**，世界与板同一深度缓冲 → 减少 `stack-over-plate` DomHost。  
2. **文字 / 路径锐度**（atlas restamp，非 DomHost）。  
3. **Worker 烤 tile**（扩展现有 `soaBakeLayer`）。  
4. 照片解码按显示尺寸选 mip。

---

## 5. 文件级改动清单

| 优先级 | 文件 | 动作 |
|--------|------|------|
| P0 | `frames/artboardInkSurface.ts` | tile / 禁 pixelated 终态；导出 scale API |
| P0 | `frames/artboardInkTiles.ts` | **新建** tile 分配/释放/绘制 |
| P0 | `frames/HtmlArtboardFrame.tsx` | 接 tile 或去掉 pixelated |
| P0 | `render/webglInstanceAtlas.ts` | `backingInsufficient*` + restamp；弱化 SharpHost |
| P0 | `render/webglSceneRenderer.ts` | 全 stamp key 带 zoomBucket；insufficient → restamp |
| P0 | `shapes/RcbShapesLayer.tsx` | `pickFullAndCanvasIds` 不因锐利升 host |
| P1 | `render/paintIntent.ts` | **新建** 唯一路由 |
| P1 | `render/soaBakeLayer.ts` | 与 artboard tiles / gesture 对齐 |
| P1 | `canvas/RcbCanvas.tsx` | settle 后触发全可见 restamp |
| P1 | `rcb/api/*.ts` | 门面 |
| P2 | `docs/CANVAS.md` | 与本方案对齐（PaintRoute 改 Intent） |
| P2 | 测试 | 见下节 |

**明确不再做的「锐利补丁」：**

- 为空生成器 / 放大媒体 **永久** `canIdlePaintOnCanvas = false` 只为清晰（层级/义务除外）。  
- 新加第四个 `*NeedsSharpHost`。

---

## 6. 测试与验收

### 单测

- `artboardInkBackingInsufficient` 边界（zoom×dpr 与 MAX）。  
- tile：视口移动只保留相交 tile；释放后无泄漏（Map size）。  
- atlas：zoomBucket 变化 → restamp 计数 +1；**不**导致 `fullIds` 包含该 id。  
- `resolvePaintIntent`：video → dom-obligatory；板内 rect idle → artboard-tile；世界 basic → gpu-instance。

### 交互 / 视觉

| 用例 | 期望 |
|------|------|
| 板内描边 100%→800% | 不糊、无大块 pixelated |
| 空生成器图标同左 | 锐利（restamp 或过渡 SVG 债打标） |
| 世界 200 个 path，捏合再松开 | 跟手；松手后锐化 |
| 选中再取消 | 不「突然变清晰只因为升了 SVG」 |
| 高层画板压低层 | hit/paint 与 `nodePaintZIndex` 一致 |

### 性能预算（建议）

- 手势中：主线程 paint &lt; 8ms（p95）。  
- 停稳 restamp：可见 stamp &lt; 50/帧，多帧摊完。  
- 单画板 tile 显存：可见 tiles × max(tilePx) 有上限日志。

---

## 7. 风险与回退

| 风险 | 缓解 |
|------|------|
| Tile 显存爆 | 单 tile 像素帽 + LRU + 可见集 |
| Restamp 卡顿 | 仅 settle；bucket 粗粒度；分帧 |
| 去掉 SharpHost 后短暂更糊 | 先上 restamp 再关 SharpHost（开关 `rcbSharpHost=0`） |
| 层级依赖 SVG 的节点 | 保留 `stack-over-plate` 义务原因，与锐利分离 |
| 回归多 | feature flag：`rcbFigmaInk=1` 默认开，可关回旧路径 |

**回退开关建议：**

```ts
// localStorage / env
rcbFigmaInk=1       // 新 ink/tile/restamp
rcbSharpHost=0      // 1=恢复旧升 SVG 锐利（仅应急）
```

---

## 8. 推荐排期（最优可执行顺序）

```
Week 1
  ├─ A1 去 pixelated 终态 + insufficient API
  ├─ A2 artboard 可见 tile MVP
  ├─ A4 debug 开关
  └─ Flag 可回退

Week 2
  ├─ A3/B1 关「因锐利升 host」+ 全 stamp zoomBucket
  ├─ B2 多档 cell 或等价 restamp
  └─ 空生成器图标 restamp（清过渡债）

Week 3
  ├─ C1 paintIntent 统一
  ├─ D api 门面
  └─ 回归 + 文档 CANVAS.md 改 Intent
```

---

## 9. 决策摘要（给评审）

1. **像 Figma = 按 zoom 重光栅化，不是 SVG host。**  
2. **第一刀打在糊的根源：画板 8× pixelated + atlas 拉伸。**  
3. **DomHost 降级为义务通道；锐利与层级原因拆开。**  
4. **手势低清、停稳补锐** —— 性能与清晰兼得。  
5. **统一 paintIntent + api 门面** —— 后面少打补丁。

---

## 10. 与旧文档差异

| 项 | `CANVAS.md` 初版 | 本方案 |
|----|------------------|--------|
| 放大糊 | 升 DomHost | **restamp / tile 重画** |
| 空生成器 | 永 SVG | 优先 atlas restamp；SVG 仅过渡 |
| PaintRoute `dom-host` | 含锐利 | 仅 `dom-obligatory` |
| 画板 ink | 保留双表面 | 保留，但 **tile 全分辨率** |

`CANVAS.md` 应在 Phase C/D 后改写为与本方案一致；**执行以本文为准。**
