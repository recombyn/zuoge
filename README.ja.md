<div align="center">
  <img src="docs/assets/zuoge-wordmark-en.png" alt="zuoge" height="140" style="margin-top: 48px; margin-bottom: 40px;" />

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

オープンソースの AI デザインワークスペース。ドキュメント駆動の無限アートボード（CanvasKit + SceneDocument）、LangGraph Design Agent、Codex などから同じプロジェクトを編集できる MCP サーバー。Docker Compose でセルフホストできます。

**作ろう、デザインがこんなに簡単だったことはない。**

🌐 サイト: [recombyn.com](https://recombyn.com) · Docs: [recombyn.github.io/recombyn](https://recombyn.github.io/recombyn/) · Source: [github.com/recombyn/zuoge](https://github.com/recombyn/zuoge)

## ✨ Features

🎨 **無限アートボード** — `SceneDocument` + CanvasKit アイドルインク（`KitCanvasHost` / `@rcb-vector`）。幾何ヒット；DOM はキャレット / メディア / SoftGlow / パス編集のみ。

🤖 **Design Agent** — 同一キャンバス上のストリーミング会話：計画 → Skill → `tool_ops` → 適用。LangGraph カーネル固定；挙動は AgentProfile YAML、段階プロンプト、Skills、ツール登録で設定。

🔌 **MCP キャンバス** — 外部クライアントは内蔵 Agent と同じ `tool_ops` 契約。Live：エディタ起動中にブラウザで apply。Headless：基本 CRUD/フレームは API がドキュメントを patch。live-only を含む場合はオフライン待ち行列（`queued_offline`、黙って破棄しない）。

🧩 **プラグイン** — Skill パックは `plugins/skills/`、キャンバスプラグインは `plugins/canvas/`。`.recombyn-plugin` にパック可能。

👥 **リアルタイムコラボ** — Yjs WebSocket による共同編集。

🖥️ **デスクトップ** — Tauri v2。ブラウザと同じ API を利用。

🗄️ **セルフホスト構成** — Compose で MySQL、Redis、MinIO、web、api、worker、collab。`DATABASE_URL` は MySQL または PostgreSQL 必須。

## 🚀 Quick Start

### 前提条件

- Docker と Docker Compose
- Node.js 20+（ローカルで web / collab を動かす場合）
- LLM API キー（DeepSeek、Doubao、OpenRouter など）

### Compose でセルフホスト

リポジトリをクローン：

```bash
git clone https://github.com/recombyn/zuoge.git
cd recombyn
```

API の env をコピーし、プロバイダキーを設定：

```bash
cp apps/api/.env.example apps/api/.env
```

起動：

```bash
docker compose up -d --build
```

ブラウザで開く：

- Web エディタ → http://localhost:3000
- API docs → http://localhost:8000/docs
- ホスト側 MySQL → `127.0.0.1:3306` · ユーザー/パスワード `recombyn` / `recombyn`

Compose 内のデフォルト DB：`mysql://recombyn:recombyn@mysql:3306/recombyn`。公開前に `MYSQL_PASSWORD` / `DATABASE_URL` を変更してください。

詳細：[docs/self-hosting.md](docs/self-hosting.md)。Postgres：[docs/postgres-switch.md](docs/postgres-switch.md)。

### Compose レシピ

ベース構成（web + api + collab + mysql + redis + worker）：

```bash
docker compose -f docker-compose.yml up -d --build
```

ベース + ClamAV：

```bash
docker compose --profile av \
  -f docker-compose.yml \
  -f docker-compose.av.yml \
  up -d --build
```

GHCR の事前ビルドイメージ：

```bash
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml up -d
```

Compose 変数はリポジトリ直下の `.env`、API アプリ変数は `apps/api/.env` に置きます。

### ローカル開発

インフラのみ：

```bash
docker compose up -d mysql redis   # または: npm run dev:infra
npm install
cp apps/api/.env.example apps/api/.env
```

`apps/api/.env` に設定：

```env
DATABASE_URL=mysql://recombyn:recombyn@127.0.0.1:3306/recombyn
```

プロセス起動：

```bash
npm run dev:api              # MySQL の DATABASE_URL 必須
npm run dev:collab           # Yjs WS :1234（任意）
npm run dev:web
```

Canvas Live / WSS：[docs/self-hosting.md § Canvas multiplayer](docs/self-hosting.md#canvas-multiplayer-yjs--wss) · [apps/collab/README.md](apps/collab/README.md)。

### デスクトップ（Tauri）

Rust と OS ビルドツールが必要です。[docs/desktop.md](docs/desktop.md) を参照。

```bash
npm run dev:desktop
npm run build:desktop
# 公開時は VITE_API_BASE_URL
```

インストーラ：`apps/web/src-tauri/target/release/bundle/`。本体：`…/target/release/recombyn.exe`。

## 🔌 MCP キャンバス

API と Web で有効化：

```bash
# apps/api/.env
MCP_CANVAS_ENABLED=true
# apps/web/.env — 編集中の Live apply
VITE_MCP_CANVAS_ENABLED=true
```

Codex — `.codex/config.toml` に追加：

```toml
[mcp_servers.recombyn-canvas]
command = "node"
args = ["scripts/mcp/recombyn_canvas_stdio.mjs"]

[mcp_servers.recombyn-canvas.env]
RECOMBYN_API_URL = "http://127.0.0.1:8000"
RECOMBYN_TOKEN = "<token>"
RECOMBYN_PROJECT_ID = "<project-id>"
```

**Live** — エディタ起動中、ブラウザで apply（`queued_live`）。  
**Headless** — 未起動時、基本 CRUD/フレームは API が patch（`applied_headless`）。  
**オフライン待ち** — live-only（boolean など）を含むとエディタ起動まで待ち行列（`queued_offline`）。

詳細：[docs/mcp-canvas.md](docs/mcp-canvas.md)。

## 🏗️ リポジトリ構成

```
recombyn/
├── apps/
│   ├── web/                 # React キャンバス + Agent UI + Yjs
│   │   └── src-tauri/       # Tauri v2 シェル
│   ├── api/                 # FastAPI — Scene, Agent, plaza, wallet, MCP
│   └── collab/              # Yjs WebSocket
├── plugins/
│   ├── skills/              # Skill 拡張
│   └── canvas/              # Canvas プラグイン
├── packages/                # 共有スキーマ / ビルダー
├── docs/                    # セルフホスト、Agent、キャンバス、プラグイン
├── deploy/                  # Dockerfile / Nginx / VPS
├── e2e/                     # Playwright
└── skills/                  # 内蔵 Skill プレイブック
```

## 🛠️ Technologies Used

- **React + TypeScript** — Web エディタと Agent UI
- **FastAPI + Python** — API、Design Agent、課金、plaza
- **LangGraph** — Design Agent グラフ（MySQL checkpointer → memory）
- **MySQL 8** — メイン DB（Postgres 可）
- **Redis + Celery** — キューとワーカー
- **MinIO** — S3 互換ストレージ
- **Yjs** — リアルタイムコラボ
- **Vite** — Web バンドラ / 開発サーバー
- **Tauri v2** — デスクトップシェル
- **Docker Compose** — セルフホストとローカルインフラ

## 🎨 Key Components

### Canvas

フレーム、図形、テキスト、画像、ペン/鉛筆、ブール演算、ストローク揃え、エクスポート。[docs/scene-json-spec.md](docs/scene-json-spec.md) · [docs/canvas-architecture.md](docs/canvas-architecture.md)。

### Design Agent

キャンバス上のストリーミング設計ターン。Profile：[`design.canvas.yaml`](apps/api/seeds/agents/profiles/design.canvas.yaml)、[`bindings.yaml`](apps/api/seeds/agents/bindings.yaml)。Skills：[`skills/`](skills/)、[`plugins/skills/`](plugins/skills/)。[docs/agent-profile.md](docs/agent-profile.md) · [docs/agent-harness.md](docs/agent-harness.md)。

### プラグイン

Skill 拡張：[docs/skill-extensions.md](docs/skill-extensions.md)。Canvas プラグイン：[docs/canvas-plugins.md](docs/canvas-plugins.md)。パック：`node scripts/pack-recombyn-plugin.mjs plugins/skills/festival_poster` — [docs/plugin-packs.md](docs/plugin-packs.md)。

## 📚 Documentation

- ユーザー向け — [recombyn.github.io/recombyn](https://recombyn.github.io/recombyn/)
- セルフホスト — [docs/self-hosting.md](docs/self-hosting.md)
- MCP キャンバス — [docs/mcp-canvas.md](docs/mcp-canvas.md)
- 課金 — [docs/billing.md](docs/billing.md)
- デスクトップ — [docs/desktop.md](docs/desktop.md)
- Postgres — [docs/postgres-switch.md](docs/postgres-switch.md)
- Contributing · Security · CoC — [CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## 🤝 Contributing

1. リポジトリをフォーク
2. 機能ブランチを作成（`git checkout -b feature/amazing-feature`）
3. コミット（`git commit -m 'Add amazing feature'`）
4. プッシュ（`git push origin feature/amazing-feature`）
5. Pull Request を作成

詳細は [CONTRIBUTING.md](CONTRIBUTING.md)。セキュリティ報告は [SECURITY.md](SECURITY.md)。

## 📄 License

Apache-2.0 — [LICENSE](LICENSE) を参照。

## 📞 Support

- Issues: [GitHub Issues](https://github.com/recombyn/zuoge/issues)
- Docs: [recombyn.github.io/recombyn](https://recombyn.github.io/recombyn/)
- Site: [recombyn.com](https://recombyn.com)

## ⭐ Star

オープンソースは時間がかかります。zuoge が役に立ったら [github.com/recombyn/zuoge](https://github.com/recombyn/zuoge) で Star をお願いします。
