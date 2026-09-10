<div align="center">
  <img src="docs/assets/zuoge-wordmark-en.png" alt="zuoge" height="140" style="margin-top: 20px; margin-bottom: 20px;" />

  <p>
    <a href="docs/self-hosting.md"><strong>Self Host</strong></a> ·
    <a href="https://recombyn.github.io/recombyn/"><strong>Docs</strong></a>
  </p>

  <p>
    <a href="docs/self-hosting.md"><img src="https://img.shields.io/badge/self--host-Docker%20Compose-2496ED?logo=docker&logoColor=white" alt="Self-host" /></a>
    <a href="apps/web"><img src="https://img.shields.io/badge/web-React%20%2B%20TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript" /></a>
    <a href="apps/api"><img src="https://img.shields.io/badge/api-FastAPI%20%2B%20Python-3776AB?logo=python&logoColor=white" alt="Python" /></a>
    <a href="SECURITY.md"><img src="https://img.shields.io/badge/security-policy-green.svg" alt="Security" /></a>
  </p>

  <p>
    <a href="README.md"><img src="docs/assets/lang-en.svg" alt="English" height="20" /></a>
    &nbsp;
    <a href="README.zh-CN.md"><img src="docs/assets/lang-zh-CN.svg" alt="简体中文" height="20" /></a>
    &nbsp;
    <a href="README.ja.md"><img src="docs/assets/lang-ja.svg" alt="日本語" height="20" /></a>
  </p>
</div>

# zuoge

An open-source AI design workspace. Document-backed infinite artboard (CanvasKit + SceneDocument), LangGraph Design Agent, and an MCP server so tools like Codex can read and edit the same projects — self-host with Docker Compose.

**Make it — design has never been this simple.**

🌐 Product: [recombyn.com](https://recombyn.com) · Docs: [recombyn.github.io/recombyn](https://recombyn.github.io/recombyn/) · Source: [github.com/recombyn/zuoge](https://github.com/recombyn/zuoge)

## ✨ Features

🎨 **Infinite artboard** — `SceneDocument` + CanvasKit idle ink (`KitCanvasHost` / `@rcb-vector`); zoom 5%–10000%. Geometry hit-test; DOM only for caret / media / SoftGlow / path edit.

🤖 **Design Agent** — Streaming chat on the same canvas: plan → Skills → `tool_ops` → apply. Fixed LangGraph kernel; behavior from AgentProfile YAML, stage prompts, Skills, and the tool registry.

🔌 **MCP canvas** — External clients use the same `tool_ops` contract as the built-in Agent. Live mode applies ops in the open editor; headless mode patches the project document via the API.

🧩 **Plugins** — Skill packs under `plugins/skills/` and canvas plugins under `plugins/canvas/`, packable as `.recombyn-plugin`.

👥 **Realtime collab** — Yjs WebSocket rooms for multiplayer editing.

🖥️ **Desktop** — Tauri v2 shell that talks to the same API as the browser.

🗄️ **Self-host stack** — Docker Compose with MySQL, Redis, MinIO, web, API, worker, and collab. `DATABASE_URL` must be MySQL or PostgreSQL.

## 🚀 Quick Start

### Prerequisites

- Docker & Docker Compose
- Node.js 20+ (for local web / collab scripts)
- An LLM API key (DeepSeek, Doubao, OpenRouter, …)

### Self-host with Compose

Clone the repository:

```bash
git clone https://github.com/recombyn/zuoge.git
cd recombyn
```

Copy API env and add provider keys:

```bash
cp apps/api/.env.example apps/api/.env
```

Start the stack:

```bash
docker compose up -d --build
```

Open your browser:

- Web editor → http://localhost:3000
- API docs → http://localhost:8000/docs
- MySQL (host) → `127.0.0.1:3306` · user/password `recombyn` / `recombyn`

Default database URL inside Compose: `mysql://recombyn:recombyn@mysql:3306/recombyn`. Change `MYSQL_PASSWORD` / `DATABASE_URL` before any public deploy.

Full env, LLM, production hardening: [docs/self-hosting.md](docs/self-hosting.md). Postgres: [docs/postgres-switch.md](docs/postgres-switch.md).

### Compose recipes

Base stack (web + api + collab + mysql + redis + worker):

```bash
docker compose -f docker-compose.yml up -d --build
```

Base + ClamAV upload scanning:

```bash
docker compose --profile av \
  -f docker-compose.yml \
  -f docker-compose.av.yml \
  up -d --build
```

Base from pre-built GHCR images (skip local builds):

```bash
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml up -d
```

Keep Compose variables in the repo-root `.env` (for example `RECOMBYN_TAG`). Keep API app variables in `apps/api/.env`. Avoid passing secrets inline in the shell.

### Local development

Infra only (MySQL + Redis + MinIO):

```bash
docker compose up -d mysql redis   # or: npm run dev:infra
npm install
cp apps/api/.env.example apps/api/.env
```

Set in `apps/api/.env`:

```env
DATABASE_URL=mysql://recombyn:recombyn@127.0.0.1:3306/recombyn
```

Run processes:

```bash
npm run dev:api              # requires MySQL DATABASE_URL
npm run dev:collab           # Yjs WS on :1234 (optional)
npm run dev:web
```

Canvas Live / WSS: [docs/self-hosting.md § Canvas multiplayer](docs/self-hosting.md#canvas-multiplayer-yjs--wss) · [apps/collab/README.md](apps/collab/README.md).

### Desktop (Tauri)

Needs Rust and the platform toolchain. See [docs/desktop.md](docs/desktop.md).

```bash
npm run dev:desktop
npm run build:desktop
# Optional: VITE_API_BASE_URL=https://your.host
```

Installers land under `apps/web/src-tauri/target/release/bundle/`; the main binary is `…/target/release/recombyn.exe`.

## 🔌 MCP Canvas

Enable on API and web:

```bash
# apps/api/.env
MCP_CANVAS_ENABLED=true
# apps/web/.env — live apply while editing
VITE_MCP_CANVAS_ENABLED=true
```

Codex — add to `.codex/config.toml`:

```toml
[mcp_servers.recombyn-canvas]
command = "node"
args = ["scripts/mcp/recombyn_canvas_stdio.mjs"]

[mcp_servers.recombyn-canvas.env]
RECOMBYN_API_URL = "http://127.0.0.1:8000"
RECOMBYN_TOKEN = "<token>"
RECOMBYN_PROJECT_ID = "<project-id>"
```

**Live** — editor open; ops apply in the browser.  
**Headless** — editor closed; API patches the project document.

Details: [docs/mcp-canvas.md](docs/mcp-canvas.md).

## 🏗️ Project Structure

```
recombyn/
├── apps/
│   ├── web/                 # React canvas + Agent UI + Yjs client
│   │   └── src-tauri/       # Tauri v2 desktop shell
│   ├── api/                 # FastAPI — Scene, Agent, plaza, wallet, MCP
│   └── collab/              # Yjs WebSocket server
├── plugins/
│   ├── skills/              # Skill pack extensions
│   └── canvas/              # Canvas plugins
├── packages/                # Shared builders & schemas
├── docs/                    # Self-host, agent, canvas, plugins, desktop
├── deploy/                  # Dockerfiles / Nginx / VPS
├── e2e/                     # Playwright
└── skills/                  # Built-in skill playbooks
```

## 🛠️ Technologies Used

- **React + TypeScript** — Web editor and Agent UI
- **FastAPI + Python** — API, Design Agent, billing, plaza
- **LangGraph** — Durable Design Agent graph (MySQL checkpointer → memory fallback)
- **MySQL 8** — Primary database (PostgreSQL optional)
- **Redis + Celery** — Queues and workers
- **MinIO** — S3-compatible object storage
- **Yjs** — Realtime collaboration
- **Vite** — Web bundler / dev server
- **Tauri v2** — Desktop shell
- **Docker Compose** — Self-host and local infra

## 🎨 Key Components

### Canvas

Infinite vector workspace with frames, shapes, text, images, pen/pencil, boolean ops, stroke align, and export. Scene protocol: [docs/scene-json-spec.md](docs/scene-json-spec.md). Architecture: [docs/canvas-architecture.md](docs/canvas-architecture.md).

### Design Agent

Streaming design turns on the canvas. Customize profiles in [`design.canvas.yaml`](apps/api/seeds/agents/profiles/design.canvas.yaml) and [`bindings.yaml`](apps/api/seeds/agents/bindings.yaml). Skills live in [`skills/`](skills/) and [`plugins/skills/`](plugins/skills/). Canvas ops seed: [`canvas_actions_seed.json`](apps/api/seeds/canvas_actions_seed.json). See [docs/agent-profile.md](docs/agent-profile.md) and [docs/agent-harness.md](docs/agent-harness.md).

### Plugins & extensions

Skill packs: [docs/skill-extensions.md](docs/skill-extensions.md). Canvas plugins: [docs/canvas-plugins.md](docs/canvas-plugins.md). Pack with `node scripts/pack-recombyn-plugin.mjs plugins/skills/festival_poster` — [docs/plugin-packs.md](docs/plugin-packs.md).

## 📚 Documentation

- User docs — [recombyn.github.io/recombyn](https://recombyn.github.io/recombyn/)
- Self-host / architecture — [docs/self-hosting.md](docs/self-hosting.md)
- MCP canvas — [docs/mcp-canvas.md](docs/mcp-canvas.md)
- Billing & credits — [docs/billing.md](docs/billing.md)
- Web data layer — [docs/web-frontend.md](docs/web-frontend.md)
- Desktop — [docs/desktop.md](docs/desktop.md)
- Postgres switch — [docs/postgres-switch.md](docs/postgres-switch.md)
- Contributing · Security · Code of Conduct — [CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

## 📄 License

Apache-2.0 — see [LICENSE](LICENSE).

## 📞 Support

- Issues: [GitHub Issues](https://github.com/recombyn/zuoge/issues)
- Docs: [recombyn.github.io/recombyn](https://recombyn.github.io/recombyn/)
- Site: [recombyn.com](https://recombyn.com)

## ⭐ Star

Open source takes time. If zuoge helps you, please hit **Star** on [github.com/recombyn/zuoge](https://github.com/recombyn/zuoge).
