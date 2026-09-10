<div align="center">
  <img src="apps/web/public/brand/zuoge-wordmark.png" alt="左格" height="140" style="margin-top: 48px; margin-bottom: 40px;" />

  <p>
    <a href="docs/self-hosting.md"><strong>自托管</strong></a> ·
    <a href="https://recombyn.github.io/recombyn/"><strong>文档</strong></a>
  </p>

  <p>
    <a href="docs/self-hosting.md"><img src="https://img.shields.io/badge/self--host-Docker%20Compose-2496ED?logo=docker&logoColor=white" alt="Self-host" /></a>
    <a href="apps/web"><img src="https://img.shields.io/badge/web-React%20%2B%20TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript" /></a>
    <a href="apps/api"><img src="https://img.shields.io/badge/api-FastAPI%20%2B%20Python-3776AB?logo=python&logoColor=white" alt="Python" /></a>
  </p>

  <p>
    <a href="README.md"><img src="docs/assets/lang-en.svg" alt="English" height="20" /></a>
    &nbsp;
    <a href="README.zh-CN.md"><img src="docs/assets/lang-zh-CN.svg" alt="简体中文" height="20" /></a>
    &nbsp;
    <a href="README.ja.md"><img src="docs/assets/lang-ja.svg" alt="日本語" height="20" /></a>
  </p>
</div>

# 左格（zuoge）

开源 AI 设计工作台：文档驱动的无限画板（CanvasKit + SceneDocument）、LangGraph Design Agent，以及 MCP 服务——Codex 等外部工具可读写同一项目。用 Docker Compose 自托管。

**做个，设计从未如此简单。**

🌐 官网：[recombyn.com](https://recombyn.com) · 文档：[recombyn.github.io/recombyn](https://recombyn.github.io/recombyn/) · 源码：[github.com/recombyn/zuoge](https://github.com/recombyn/zuoge)

## ✨ 功能

🎨 **无限画板** — `SceneDocument` + CanvasKit 闲时墨水（`KitCanvasHost` / `@rcb-vector`）。几何命中；DOM 仅用于光标 / 媒体 / SoftGlow / 路径编辑。

🤖 **Design Agent** — 同一张画布上的流式对话：规划 → 挂 Skill → 产出 `tool_ops` → 落笔。LangGraph 内核固定；行为由 AgentProfile YAML、阶段提示词、Skills 与工具注册表配置。

🔌 **MCP 画布** — 外部客户端使用与内置 Agent 相同的 `tool_ops` 合约。Live：编辑器打开时浏览器 apply；Headless：基础 CRUD/画板 API 直接 patch；含 boolean 等 live-only 时离线排队（`queued_offline`，不静默丢弃）。

🧩 **插件** — Skill 包在 `plugins/skills/`，画布插件在 `plugins/canvas/`，可打包为 `.recombyn-plugin`。

👥 **实时协作** — Yjs WebSocket 多端同编。

🖥️ **桌面端** — Tauri v2，与浏览器共用同一套 API。

🗄️ **自托管栈** — Compose 提供 MySQL、Redis、MinIO、Web、API、Worker、Collab。`DATABASE_URL` 必须为 MySQL 或 PostgreSQL。

## 🚀 快速开始

### 环境要求

- Docker 与 Docker Compose
- Node.js 20+（本地跑 Web / Collab 脚本时）
- 至少一个 LLM API Key（DeepSeek、豆包、OpenRouter 等）

### Compose 自托管

克隆仓库：

```bash
git clone https://github.com/recombyn/zuoge.git
cd recombyn
```

复制 API 环境变量并填入模型密钥：

```bash
cp apps/api/.env.example apps/api/.env
```

启动：

```bash
docker compose up -d --build
```

浏览器打开：

- 编辑器 → http://localhost:3000
- API 文档 → http://localhost:8000/docs
- 宿主机 MySQL → `127.0.0.1:3306` · 用户/密码 `recombyn` / `recombyn`

Compose 内默认库地址：`mysql://recombyn:recombyn@mysql:3306/recombyn`。对外部署前请修改 `MYSQL_PASSWORD` / `DATABASE_URL`。

完整说明：[docs/self-hosting.md](docs/self-hosting.md)。切 Postgres：[docs/postgres-switch.md](docs/postgres-switch.md)。

### Compose 配方

基础栈（web + api + collab + mysql + redis + worker）：

```bash
docker compose -f docker-compose.yml up -d --build
```

基础栈 + ClamAV 上传扫描：

```bash
docker compose --profile av \
  -f docker-compose.yml \
  -f docker-compose.av.yml \
  up -d --build
```

使用预构建 GHCR 镜像：

```bash
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml up -d
```

Compose 变量放仓库根 `.env`；API 应用变量放 `apps/api/.env`。不要在 shell 里内联密钥。

### 本地开发

只起基础设施：

```bash
docker compose up -d mysql redis   # 或: npm run dev:infra
npm install
cp apps/api/.env.example apps/api/.env
```

在 `apps/api/.env` 中设置：

```env
DATABASE_URL=mysql://recombyn:recombyn@127.0.0.1:3306/recombyn
```

分别启动：

```bash
npm run dev:api              # 需要 MySQL DATABASE_URL
npm run dev:collab           # Yjs WS :1234（可选）
npm run dev:web
```

协作 WSS：[docs/self-hosting.md § Canvas multiplayer](docs/self-hosting.md#canvas-multiplayer-yjs--wss) · [apps/collab/README.md](apps/collab/README.md)。

### 桌面端（Tauri）

需要 Rust 与平台工具链，详见 [docs/desktop.md](docs/desktop.md)。

```bash
npm run dev:desktop
npm run build:desktop
# 有公网部署时再设 VITE_API_BASE_URL
```

安装包：`apps/web/src-tauri/target/release/bundle/`；主程序：`…/target/release/recombyn.exe`。

## 🔌 MCP 画布

在 API 与 Web 启用：

```bash
# apps/api/.env
MCP_CANVAS_ENABLED=true
# apps/web/.env — 编辑时 Live apply
VITE_MCP_CANVAS_ENABLED=true
```

Codex — 写入 `.codex/config.toml`：

```toml
[mcp_servers.recombyn-canvas]
command = "node"
args = ["scripts/mcp/recombyn_canvas_stdio.mjs"]

[mcp_servers.recombyn-canvas.env]
RECOMBYN_API_URL = "http://127.0.0.1:8000"
RECOMBYN_TOKEN = "<token>"
RECOMBYN_PROJECT_ID = "<project-id>"
```

**Live**：编辑器打开，浏览器实时 apply（`queued_live`）。  
**Headless**：编辑器关闭时，基础 CRUD/画板由 API patch（`applied_headless`）。  
**离线排队**：含 boolean/align 等 live-only 时整批排队，打开项目后再 apply（`queued_offline`，不静默丢弃）。

详情：[docs/mcp-canvas.md](docs/mcp-canvas.md)。

## 🏗️ 仓库结构

```
recombyn/
├── apps/
│   ├── web/                 # React 画布 + Agent UI + Yjs 客户端
│   │   └── src-tauri/       # Tauri v2 桌面壳
│   ├── api/                 # FastAPI — Scene、Agent、广场、钱包、MCP
│   └── collab/              # Yjs WebSocket 服务
├── plugins/
│   ├── skills/              # Skill 扩展包
│   └── canvas/              # 画布插件
├── packages/                # 共享协议与构建器
├── docs/                    # 自托管、Agent、画布、插件、桌面端
├── deploy/                  # Dockerfile / Nginx / VPS
├── e2e/                     # Playwright
└── skills/                  # 内置 Skill 剧本
```

## 🛠️ 技术栈

- **React + TypeScript** — Web 编辑器与 Agent UI
- **FastAPI + Python** — API、Design Agent、计费、广场
- **LangGraph** — Design Agent 图（MySQL checkpointer，失败则 memory）
- **MySQL 8** — 主库（可选 Postgres）
- **Redis + Celery** — 队列与 Worker
- **MinIO** — S3 兼容对象存储
- **Yjs** — 实时协作
- **Vite** — Web 构建与开发服务器
- **Tauri v2** — 桌面壳
- **Docker Compose** — 自托管与本地基础设施

## 🎨 核心模块

### 画布

无限矢量工作区：画板、形状、文字、图片、钢笔/铅笔、布尔运算、描边对齐、导出。协议：[docs/scene-json-spec.md](docs/scene-json-spec.md)。架构：[docs/canvas-architecture.md](docs/canvas-architecture.md)。

### Design Agent

画布上的流式设计回合。Profile 见 [`design.canvas.yaml`](apps/api/seeds/agents/profiles/design.canvas.yaml) 与 [`bindings.yaml`](apps/api/seeds/agents/bindings.yaml)。Skills 在 [`skills/`](skills/) 与 [`plugins/skills/`](plugins/skills/)。画布 ops 种子：[`canvas_actions_seed.json`](apps/api/seeds/canvas_actions_seed.json)。文档：[docs/agent-profile.md](docs/agent-profile.md) · [docs/agent-harness.md](docs/agent-harness.md)。

### 插件与扩展

Skill 扩展：[docs/skill-extensions.md](docs/skill-extensions.md)。画布插件：[docs/canvas-plugins.md](docs/canvas-plugins.md)。打包：`node scripts/pack-recombyn-plugin.mjs plugins/skills/festival_poster` — [docs/plugin-packs.md](docs/plugin-packs.md)。

## 📚 文档

- 用户文档 — [recombyn.github.io/recombyn](https://recombyn.github.io/recombyn/)
- 自托管 / 架构 — [docs/self-hosting.md](docs/self-hosting.md)
- MCP 画布 — [docs/mcp-canvas.md](docs/mcp-canvas.md)
- 积分与计费 — [docs/billing.md](docs/billing.md)
- Web 数据层 — [docs/web-frontend.md](docs/web-frontend.md)
- 桌面端 — [docs/desktop.md](docs/desktop.md)
- 切 Postgres — [docs/postgres-switch.md](docs/postgres-switch.md)
- 贡献 · 安全 · 行为准则 — [CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## 🤝 贡献

1. Fork 本仓库
2. 新建分支（`git checkout -b feature/amazing-feature`）
3. 提交修改（`git commit -m 'Add amazing feature'`）
4. 推送分支（`git push origin feature/amazing-feature`）
5. 打开 Pull Request

详见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。

## 📄 许可证

Apache-2.0 — 见 [LICENSE](LICENSE)。

## 📞 支持

- Issues：[GitHub Issues](https://github.com/recombyn/zuoge/issues)
- 文档：[recombyn.github.io/recombyn](https://recombyn.github.io/recombyn/)
- 官网：[recombyn.com](https://recombyn.com)

## ⭐ Star

开源不易。如果左格对你有帮助，欢迎在 [github.com/recombyn/zuoge](https://github.com/recombyn/zuoge) 点个 Star。
