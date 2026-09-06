# Self-hosting zuoge

You can run the full product on your own machine or server: web canvas, Design Agent, API, collab, and a database.

**Deployment modes (self-host / local dev / desktop):** [deployment-modes.md](./deployment-modes.md)

**Two supported paths (same stack: MySQL + MinIO + Redis):**

| | Command |
|--|---------|
| **Local** | `npm run setup:local` → `npm run dev:api` / `dev:worker` / `dev:web` |
| **Production** | `bash deploy/vps/deploy.sh` — see [deploy/vps/README.zh-CN.md](../deploy/vps/README.zh-CN.md) |

Docker Compose is the infra for both. Desktop (Tauri): **[desktop.md](./desktop.md)** — same API as browser; separate from web deploy.

## What you get

| Piece | Default |
|-------|---------|
| Web editor | http://localhost:3000 |
| API | http://localhost:8000 (`/docs`, **`/metrics`**) |
| Collab (Yjs WS) | compose `collab` · browser via `ws://localhost:3000/collab/…` (prod: `wss://`) |
| Prometheus | http://localhost:9090 (`docker compose --profile obs up -d`) |
| Grafana | http://localhost:3001 (obs profile · default `admin` / `recombyn`) |
| Alertmanager | http://localhost:9093 (obs profile · default no-op receiver) |
| ClamAV (optional) | `docker compose --profile av -f docker-compose.yml -f docker-compose.av.yml up -d --build` |
| Agent seeds | prompt packs + skills + **AgentProfile** YAML from `apps/api/seeds/` |
| **MySQL 8** | compose service + volume `mysql_data` |
| **MinIO** (S3 API) | compose service + volume `minio_data` · console http://127.0.0.1:9001 |
| Redis | Celery / queues |
| Design agent floors | Always **BasicLocal** in-process (`packages/intelligence-client`) — no remote Intelligence service |

Default DB URL inside compose:

`mysql://recombyn:recombyn@mysql:3306/recombyn`

Host tools can reach MySQL at `127.0.0.1:3306` (same user/password). Change via `MYSQL_PASSWORD` / `DATABASE_URL` before first boot.

**Quality gates (Pytest / Playwright / k6 / Prometheus):** [quality-gates.md](./quality-gates.md).

**Local:** `npm run setup:local` (MySQL + Redis + MinIO). Env: `apps/api/.env.selfhost.example` → Local block.

Object storage is **MinIO** (`S3_ENABLED=true`). Bucket `recombyn` is created on first boot. Do not use Tencent COS for new deploys.

Default config loads from seed JSON under `apps/api/seeds/` on first API start.

| Seed | Shipped in `apps/api/seeds/` | Notes |
|------|------------------------------|--------|
| Prompt packs | `design_prompt_packs/` (`_index.json` + `stages/*.md` + `snippets.md`) | `type=system` stage protocols; `type=template` inject lines — git seed upserts DB on boot |
| AgentProfile | `agents/profiles/*.yaml` + `agents/bindings.yaml` | Topology / roles / subagents — see [agent-profile.md](./agent-profile.md) |
| Skills | `skills/foundation|domains/` + `plugins/skills/` | Deliverable/tool playbooks only: `poster_craft`, `image_gen`, `banner_ad`, … — not vision/edit/taste system protocols (those live in prompt packs). Also Admin zip / folders |
| Tokens / models | Shipped | Expand further via Admin after install |
| Canvas actions, fonts, dicts, stages | Shipped | |

Layout of files under `apps/api/seeds/`: [seeds/README.md](../apps/api/seeds/README.md).  
AgentProfile / sub-agents: [agent-profile.md](./agent-profile.md).

## Architecture

### Repository

| Path | Role |
|------|------|
| `apps/web` | React editor, home, Agent chat, Yjs collab client |
| `apps/web/src-tauri` | Tauri v2 desktop shell |
| `apps/api` | FastAPI: import, projects/plaza, Design Agent, collab tokens |
| `apps/collab` | Yjs WebSocket (`/collab/`) |
| `packages/scene-schema` · `packages/scene-builder-py` | Scene JSON protocol / builders |

Desktop app: [desktop.md](./desktop.md). Postgres switch: [postgres-switch.md](./postgres-switch.md).

### API layers

```text
HTTP     app/api/routes/* + deps.py
Domain   app/services/*          (design / plaza / wallet / …)
Data     models.py + crud.py     SQLModel Session
DDL      app/services/db         init_schema / ensure_*
Seeds    apps/api/seeds/**        INSERT missing on boot (do not overwrite Admin rows)
Design   services.design.runtime → design_stream → LangGraph
         services.design.prompts → Skill / prompt pack / system prompts
         services.design.ops     → tool_ops contract
```

```text
apps/api/app/
  main.py · api/ · core/ · models.py · crud.py · services/ · schemas/
  worker/   # Celery
```

| Auth case | Status |
|-----------|--------|
| Missing Bearer | **401** |
| Bad / revoked token | **403** |
| Not admin | **403** |

URL prefix: `/api/v1`. `/import/*` requires login.

### Design Agent — call chain

```text
POST /api/v1/design/run
  → orchestrator.run_design_job          # auth, hold, BYOK, rules
      → design_run.design_stream
          → graph.build.run_agent_graph  # LangGraph driver (Profile template)
              → bootstrap
                   ├─ apply_ops? → apply_confirm → observe → …
                   └─ memory → intent → decide|paint → …
                        ├─ Ask + ops → propose → settle    # Confirm = new run
                        └─ Agent → action → observe
                             ├─ critique fail → paint_ops
                             ├─ Review auto gate? → review (forked) → settle
                             │      └─ must_fix → paint_ops (budget from Profile loops)
                             └─ else → settle
```

Details: [agent-profile.md](./agent-profile.md).

| HTTP | Role |
|------|------|
| `POST /design/run` | SSE main run (`locale`, `design_intensity` — [agent-profile.md](./agent-profile.md#run-request-locale--design-intensity)) |
| `POST /design/run/{taskId}/scene` | FE scene → resume interrupt |
| `POST …/pause` · `/cancel` · `/resume` | Durable lifecycle |
| `GET /design/catalog` · `/canvas-tools` | Catalogs |

### LC / LG stack (LangChain + LangGraph)

Two layers — do not mix product routing with model I/O:

| Layer | Library | Owns |
|-------|---------|------|
| **Outer graph** | **LangGraph** `StateGraph` | Node order, `Command(goto=…)`, checkpointer, `interrupt` / resume, run lease |
| **Inside nodes** | **LangChain** (+ optional `create_agent`) | Chat I/O, structured output, tool schemas |
| **Host** | `runtime/host/` | Assemble packs, validate ops, placement, lazy `need_*` |

```text
  HTTP / SSE     orchestrator → design_stream → run_agent_graph
                         │ astream + interrupt bridge
                         ▼
               LangGraph outer graph (checkpointer)
               bootstrap → … → paint → observe → [Review auto?] → settle
                         │ per-node
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
   host.prompts/ops   LangChain LLM   scene_feedback
   (packs, validate)  (+ structured)  + interrupt()
```

Outer graph (dynamic `Command(goto=…)`):

```text
START → bootstrap
          ├─ apply_ops? → apply_confirm → observe → …
          └─ memory → intent_classify → design_agent (decide) | paint_ops (canvas_op)
                           ├─ chat / clarify only → settle
                           └─ needs paint → paint_ops
                                  ├─ Ask → propose → settle
                                  └─ Agent → action → observe
                                         ├─ critique fail → paint_ops
                                         ├─ Review auto gate? → review (forked subagent)
                                         │      ├─ must_fix → paint_ops
                                         │      └─ pass → settle → END
                                         └─ else → settle → END
```

| Node | Role |
|------|------|
| `design_agent` | Decide: reply / `need_tools` / `need_skills` / `need_subagents` / **design_brief** — **no** canvas ops |
| `paint_ops` | Structured `tool_ops` only |
| `observe` | Wait FE scene (`interrupt`); structural critique only — see [agent-profile.md](./agent-profile.md#observe--scene-feedback-do-not-infinite-repaint) |
| `review` | Forked craft gate when auto/always; may force paint retry |
| `propose` | Ask preview → Confirm as **new** run |

**Scene feedback contract:** FE must POST inventory after applying `tool_ops`. Timeout or create-ok + empty inventory must **not** loop paint forever (settle / lag-tolerant). Placement truth prefers **artboard (`frames`)** over FE **viewport** (camera). Glossary and guards: [agent-profile.md](./agent-profile.md#artboard-vs-viewport-placement).

Inside a node: assemble pack → LangChain stream/structured → validate ops → `Command(update, goto)`.  
`create_agent` is an **inner** helper; durable pause/resume is always the **outer** graph + checkpointer.

Lifecycle: `queued → running ⇄ waiting_client → success` (also `paused` / `error` / `cancelled`).  
Checkpointer: `thread_id = design:{task_id}` — prod refuses memory; see [postgres-switch.md](./postgres-switch.md#langgraph-checkpointer-design-agent--create_agent).

### Package map (design)

| Path | Role |
|------|------|
| `runtime/orchestrator.py` | Gate + `design_stream` |
| `runtime/agent_profile.py` | AgentProfile load / contracts / `$kv` policy |
| `runtime/subagent.py` | Forked sub-agent spawn + Redis job results |
| `runtime/graph/build.py` | StateGraph + lease + interrupt driver |
| `runtime/graph/nodes/` | bootstrap / decide / paint / observe / review / … |
| `runtime/host/` | prompts, placement, ops_gate, resources (`need_*`) |
| `prompts/prompt_pack_store.py` · `skill_store/` | Packs + skills |
| `ops/tool_ops_contract.py` | Canvas tool registry |

Env knobs: `AGENT_PROFILE_ID`, `DESIGN_GRAPH_REQUIRE_DURABLE_CHECKPOINT`, `DESIGN_RUN_LEASE_TTL_SEC`, `DESIGN_CRITIQUE_ENABLED`, `DESIGN_REVIEW_AGENT_ENABLED`, `DESIGN_GRAPH_NODE_TIMEOUT_SEC`.  
Profile / sub-agents: [agent-profile.md](./agent-profile.md).

## Database options

| URL | Backend |
|-----|---------|
| `mysql://…` | MySQL pool; optional `DATABASE_READONLY_URL` |
| `postgresql://…` | psycopg pool — **migrate schema first**; see [postgres-switch.md](./postgres-switch.md) |

`DATABASE_URL` is **required**. Local default: compose MySQL `mysql://recombyn:recombyn@127.0.0.1:3306/recombyn`.

Periodic backups (default on): MySQL/Postgres write a dump hint under `DB_BACKUP_DIR` (`storage/backups/`). Celery beat: `run_db_backup_job`.

LangGraph checkpoints: [postgres-switch.md](./postgres-switch.md#langgraph-checkpointer-design-agent--create_agent).

## Agent content: skills & prompt packs

Prompt packs are the engine **protocol**. Skills are job **playbooks**. AgentProfile YAML wires stages and sub-agents. Packs **route**, skills **teach**, Profile **wires**.

LC/LG call chain: [Architecture · Design Agent](#design-agent--call-chain) above.  
Profile YAML: [agent-profile.md](./agent-profile.md).

```text
User turn
  → Decide (need_tools_overlay)
      · intent / need_skills / need_tools / design_brief — no long craft text
      · look at attachments yourself (design process); no auto scout/research
  → Lazy-load Skill bodies
  → Paint (paint_system)
      · tool_ops + FOCUS / size; craft from loaded skills + design_brief
  → Observe → [Review auto?] → settle | paint retry
```

| Layer | Owns | Does not own |
|-------|------|----------------|
| AgentProfile | Stages, roles, subagent catalog, `$kv` policy | Pack prose / skill steps |
| `type=system` packs | JSON contract, Ask/Agent gates, FOCUS/size, when to `need_*` | Poster layout, brush args, Animation playbook |
| `type=template` packs | One-line inject strings (headers, empty states) | “How to use” / `format_*` / code-path notes |
| Skills | How a class of work is done | Stage JSON / HITL `choice_ui` |
| Sub-agents | Forked specialist turns (`ReviewTurn`) | Parent chat history; look-at-image (Decide) |

### Skills namespaces

| Namespace | Source | Notes |
|-----------|--------|--------|
| `core` | File packs under `skills/foundation` | Bare keys; prefer file packs |
| `ext` | **`skills/foundation|domains`** + `plugins/skills/` | Same canonical layout; `.agents/skills` is IDE-only |
| `user` | Admin API | Always `user.<local>`; cannot claim core keys |

Env: `DESIGN_SKILLS_HOT_RELOAD` (default true), `DESIGN_SKILLS_HOT_RELOAD_INTERVAL_SEC`, `DESIGN_SKILLS_PLUGIN_DIRS` (extra roots). Manual: Admin `POST /api/v1/admin/design/skills/resync`.

Canonical layout: `_meta.json` + `SKILL.md` (+ optional `schema.json`, `handler.py`, `assets/`, `examples/`). Authoring: [skill-extensions.md](./skill-extensions.md) · sample [`plugins/skills/festival_poster/`](../plugins/skills/festival_poster/).

**Cloud / image builds:** `deploy/docker/Dockerfile.api` must `COPY skills` and `COPY plugins/skills` into `/app` (repo root as seen by `_repo_root()`). Compose also mounts `./skills` + `./plugins/skills` for local hot-reload. If the image omits `skills/`, the toolbox only shows whatever is under the plugins mount (e.g. a single demo pack).

### Prompt packs

- Seed: `seeds/design_prompt_packs/_index.json` + `stages/*.md` + `snippets.md` (bodies marked `<!-- pack:<kind> -->`).
- `when_to_use` on **skills** → model catalog; on **templates** → Admin short label only (`注入模板 · …`).
- API start **upserts** pack rows from seed (body / title / used_by / when / scenes / pack_type / sort_order). Git seed wins over Admin UI edits on the next ensure.

### Where to edit

| Change | Edit |
|--------|------|
| Stage must-follow rules | `stages/*.md` section for that kind (e.g. `decide.md` → `ask_system`, `paint.md` → `paint_system`) |
| How a design job is done | Skill pack `SKILL.md` under `skills/` or `plugins/skills/` |
| One inject line | `snippets.md` section — keep short |

Do not duplicate craft into `paint_system` / `react_system`. Brush / Animation → ext skills `brush_ops` / `motion_animation`; core skills only route to them.

## BYOK / secrets

User OpenAI-style endpoints (custom LLM providers) store API keys encrypted (AES-GCM). Set a dedicated `BYOK_AES_KEY` (32+ chars) in production; empty falls back to a derive-from-`CARD_KEY_SALT` path for local only.

## Quick path (Docker — production / full stack)

From the repo root on a server (or see [deploy/vps/README.zh-CN.md](../deploy/vps/README.zh-CN.md)):

```bash
cp apps/api/.env.selfhost.example apps/api/.env
# fill Production block + LLM keys; set root .env from deploy/vps/.env.production.example

docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
# or: bash deploy/vps/deploy.sh
```

- Web: http://localhost:3000  
- API: http://localhost:8000  
- MySQL: `127.0.0.1:3306` / db `recombyn`

Design agent floors always use **BasicLocal** in-process (`packages/intelligence-client`). There is no separate Intelligence HTTP compose profile.

On first API start, schema + seed data are applied automatically.

### Pre-built images (GHCR)

Tagged releases (`vMAJOR.MINOR.PATCH`) publish `api` / `web` / `collab` to GitHub Container Registry via [`.github/workflows/release-docker.yml`](../.github/workflows/release-docker.yml). Worker reuses the `api` image.

```bash
# after: git tag v0.1.0 && git push origin v0.1.0  (and the workflow succeeds)
export RECOMBYN_TAG=v0.1.0
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml up -d
```

Images: `ghcr.io/<owner>/<repo>/{api,web,collab}` (default `ghcr.io/recombyn/recombyn/...`). Private packages need `docker login ghcr.io`. Compose override needs **Compose ≥ 2.24** (`build: !reset`).

### Email login (configure SES)

Email OTP requires Tencent Cloud SES (or compatible mail setup via the same env vars):

```bash
TENCENT_SECRET_ID=…
TENCENT_SECRET_KEY=…
SES_REGION=ap-hongkong
SES_FROM_EMAIL=no-reply@your.domain
SES_FROM_NAME=YourApp
SES_TEMPLATE_ID=…
SES_ACTIVATE_BASE_URL=https://your.domain/activate
```

Without SES, email login returns **503** with a configuration hint — use **Google OAuth** (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`) as an alternative.

Bring your own LLM keys. Without keys, Agent features will not call models.

### Credits & membership (self-host)

Platform credits are controlled by **`WALLET_BILLING_ENABLED`** (API env; **default on**):

| Value | Behavior |
|-------|----------|
| `true` (default) | SaaS-style wallet (plans, card keys, daily free quota, credit estimates in the editor). |
| `false` | No holds/charges. UI hides balance chip, Plans, redeem, Usage & billing, and send-button credit chips. |

Set `WALLET_BILLING_ENABLED=false` only when you explicitly want billing off.

**UI visibility:** the web app reads `GET /api/v1/auth/config` → `billingEnabled` only. A failing `/wallet` request does **not** hide credits — see [deployment-modes.md](./deployment-modes.md#credits--billing-all-modes).

Optional when billing is on:

- Raise or remove daily free quota (`FREE_DAILY_LIMIT` in `services/wallet/db.py`)
- Issue card keys (admin + `CARD_KEY_SALT` / `CARD_KEY_OPS_PASSWORD`)


## Dev path (MySQL + MinIO)

```bash
npm run setup:local   # mysql + redis + minio (+ bucket init; waits for MySQL)
# apps/api/.env — Local block from .env.selfhost.example
npm install
npm run dev:api
npm run dev:worker
npm run dev:web
```

MinIO console: http://127.0.0.1:9001 (`minioadmin` / `minioadmin`).

(`npm run dev:infra` is the same compose up without the wait helper.)

Use MySQL (or Postgres) for production and local dev — see [Dev path](#dev-path-mysql--minio) below.

## Canvas multiplayer (Yjs / WSS)

Compose runs `apps/collab` and nginx proxies `/collab/` → the WS server. Browsers connect with the URL from API `COLLAB_PUBLIC_WS_URL`.

| Env | Where | Example |
|-----|--------|---------|
| `COLLAB_TOKEN_SECRET` | api + collab (same value) | long random string |
| `COLLAB_PUBLIC_WS_URL` | api | local: `ws://localhost:3000/collab` · prod: `wss://your.domain/collab` |
| `VITE_COLLAB_ENABLED` | web **build arg** | `true` to ship Live UI |

**Local compose (HTTP):** leave defaults — Live uses `ws://localhost:3000/collab`.

**Public HTTPS:** terminate TLS in front of port 3000 (Caddy / cloud LB). Example: [deploy/caddy/Caddyfile.example](../deploy/caddy/Caddyfile.example) (also sets CSP / `nosniff` / frame headers). Then set:

```bash
COLLAB_TOKEN_SECRET='…strong…'
COLLAB_PUBLIC_WS_URL=wss://your.domain/collab
```

Rebuild web if you change `VITE_COLLAB_ENABLED`. Dev without Docker: `npm run dev:collab` + API `COLLAB_PUBLIC_WS_URL=ws://127.0.0.1:1234`.

## Public HTTPS (Caddy)

Compose web listens on `:3000` (nginx already proxies `/api/` and `/collab/`).  
For a public host, terminate TLS in front — example: [deploy/caddy/Caddyfile.example](../deploy/caddy/Caddyfile.example).

```bash
# after compose is up, and DNS points here:
export COLLAB_TOKEN_SECRET='…strong…'
export COLLAB_PUBLIC_WS_URL=wss://your.domain/collab
docker compose up -d  # recreate api/collab with the new env
caddy run --config deploy/caddy/Caddyfile.example
```

## Public host checklist

Do this **before** exposing port 3000 / 8000 to the internet:

1. Never commit `apps/api/.env`.
2. Replace `CARD_KEY_SALT` / `CARD_KEY_OPS_PASSWORD` placeholders.
3. Set `BYOK_AES_KEY` (dedicated AES key for user LLM vaults).
4. Override `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_BOOTSTRAP_PASSWORD` (defaults are for local bootstrap only).
5. Change `MYSQL_ROOT_PASSWORD` / `MYSQL_PASSWORD` (and matching `DATABASE_URL`).
6. Set a long random `COLLAB_TOKEN_SECRET` (same value for api + collab).
7. Set `COLLAB_PUBLIC_WS_URL=wss://your.domain/collab` (not `ws://`).
8. Restrict CORS (`CORS_ORIGINS`) to your real origins.
9. Confirm Redis/MySQL are host-only (`127.0.0.1:…` in compose — do not publish them publicly).
10. Confirm DB backups (`DB_BACKUP_*`) or cloud automated backups.
11. Configure SES (see above) or Google OAuth before exposing email login publicly.

API startup logs **warnings** if admin password, collab secret, default MySQL password, card salt, or BYOK key look like local defaults.

## Schema & deploy (Alembic)

**Code image ≠ database.** Replacing the API container only updates Python; MySQL schema lives in the `mysql_data` volume and must be migrated.

| Piece | Where |
|-------|--------|
| Models | `apps/api/app/models.py` — long text must use `sa_column=Column(Text)` (bare `str` → MySQL `VARCHAR(255)`) |
| Migrations | `apps/api/app/alembic/versions/*.py` (SQLAlchemy `op.execute` / `ALTER`) |
| Apply | API container **entrypoint** runs `alembic upgrade head` before uvicorn; startup also calls `init_schema()` |

### One-shot update (compose / GHCR)

```bash
# 1) Pull (or build) new images — do not wipe mysql_data
export RECOMBYN_TAG=sha-xxxxxxx   # or vX.Y.Z
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml up -d

# 2) Confirm migrate logged on api start
docker compose logs api --tail=80 | grep -E 'entrypoint|alembic|migrations'

# 3) Health
curl -fsS http://127.0.0.1:8000/api/v1/health || curl -fsS http://127.0.0.1:8000/docs >/dev/null
```

If migrate fails, the API process **exits** (do not ignore). Fix the migration / column types, ship a new image, restart — do not hand-patch production as the long-term path.

### New column / type change checklist

1. Edit `models.py` with the real SQL type (`Text` / `LONGTEXT`, not bare `str` for long JSON).
2. Add Alembic revision under `app/alembic/versions/` (keep `revision` id ≤ 32 chars until `alembic_version.version_num` is widened).
3. Local: `cd apps/api && alembic upgrade head` (or restart `npm run dev:api`).
4. CI / merge → build image → deploy as above.

Optional seed after schema is healthy (catalog empty): Admin sync, or run `ensure_llm_catalog_seed(force=True)` once inside the API container — seeds are data, not a substitute for migrations.

## Rollback (Docker Compose)

Prefer **image tags** (or digest) over floating `latest`. When a release misbehaves:

1. Note the previously known-good tag (from your registry or `docker compose images`).
2. Pin with `docker-compose.ghcr.yml` and `RECOMBYN_TAG=vX.Y.Z`.
3. Redeploy without wiping volumes:

```bash
export RECOMBYN_TAG=v0.1.0   # last known-good
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml up -d
```

4. Confirm `/api/v1/health` (or `/metrics`) and a smoke open of the editor.
5. Do **not** delete `mysql_data` / Redis volumes unless you intend a destructive restore from backup.

Local `--build` deploys: check out the last good git tag, then `docker compose up -d --build`.

See [ADR 0009](./adr/0009-unified-ci-rollback.md). Semver notes live in root [CHANGELOG.md](../CHANGELOG.md).

## License

**Apache License 2.0** — full terms in root [`LICENSE`](../LICENSE); copyright / attribution in [`NOTICE`](../NOTICE).

Third-party images you may run alongside (Redis, MySQL, …) keep **their own** licenses. Hosted Cloud / support / enterprise add-ons are separate commercial offerings.

## Related

- [recombyn.github.io/recombyn](https://recombyn.github.io/recombyn/) · [Deployment modes](./deployment-modes.md) · [Desktop](./desktop.md) · [Billing](./billing.md) · [Postgres](./postgres-switch.md)
