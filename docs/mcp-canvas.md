# MCP canvas control

zuoge exposes a **Model Context Protocol** server so external AI clients (Codex, Claude Desktop, custom agents) can inspect and edit design projects using the same `tool_ops` contract as the built-in Design Agent.

## Enable

```bash
# apps/api/.env
MCP_CANVAS_ENABLED=true

# apps/web/.env — required for live apply while the editor is open
VITE_MCP_CANVAS_ENABLED=true
```

Restart API and web after changing env vars.

## Modes

| Mode | When | What happens |
|------|------|----------------|
| **Live** (`queued_live`) | Editor open + heartbeat | Ops queue to Redis → `McpCanvasBridge` applies via `designTools` (full op set) |
| **Headless** (`applied_headless`) | Editor closed + only headless-capable ops | API validates and patches the project document |
| **Offline queue** (`queued_offline`) | Editor closed + any live-only op | Entire batch is queued until the project is opened in the web editor — **never silently dropped** |

### Headless-capable ops

These apply without an open editor (`apps/api/.../apply_headless.py`):

- `create_shape`, `create_path`, `create_text`
- `update_node`, `delete_nodes`, `hide_nodes`
- `create_frame`, `update_frame`, `delete_frame`
- `set_canvas_background`

### Live-only ops

Everything else in the canvas catalog (e.g. `boolean_op`, `align_nodes`, `image_process`, `set_viewport`, `export_canvas`, …) is **live-only**. Catalog tool descriptions are prefixed with `[live editor]` or `[headless ok]`.

Seed / force list: `apps/api/seeds/mcp/canvas_tools.yaml` (`live_only` ∪ auto-derived non-headless op keys).

## API

| Endpoint | Purpose |
|----------|---------|
| `GET /api/v1/mcp/canvas/tools` | Tool catalog (OpenAI function schema) |
| `POST /api/v1/mcp/canvas/call` | Invoke a tool |
| `POST /api/v1/mcp/canvas/session/heartbeat` | Editor live session (FE) |
| `GET /api/v1/mcp/canvas/pending` | Fetch queued ops (FE) |
| `POST /api/v1/mcp/canvas/pending/ack` | Ack applied batch (FE) |

Auth: Bearer token (same as web API). Every call needs `project_id` in tool arguments (or `RECOMBYN_PROJECT_ID` in the stdio bridge env).

## Codex

Add to project `.codex/config.toml` (or `~/.codex/config.toml`):

```toml
[mcp_servers.recombyn-canvas]
command = "node"
args = ["scripts/mcp/recombyn_canvas_stdio.mjs"]

[mcp_servers.recombyn-canvas.env]
RECOMBYN_API_URL = "http://127.0.0.1:8000"
RECOMBYN_TOKEN = "<your-access-token>"
RECOMBYN_PROJECT_ID = "<project-id>"
```

Restart Codex (or run `codex mcp list`) after saving so the server is picked up.

**Get a token** (local dev):

```bash
SUPER_ADMIN_TEST_CODE=888888 node scripts/ci-mint-token.mjs
# → writes .tmp-token.txt
```

**Project id**: open a project in the editor — id is in the URL, or list via `GET /api/v1/projects`.

## Key tools

| Tool | Purpose |
|------|---------|
| `get_scene_summary` | Node/frame inventory + counts |
| `list_nodes` / `list_frames` | Scene detail |
| `apply_tool_ops` | Batch apply validated ops |
| `create_shape`, `create_text`, … | Single op shortcuts (same as Agent) |

Full catalog: `GET /api/v1/mcp/canvas/tools` or MCP `tools/list` via the stdio bridge.

## Design Agent integration

When `MCP_CANVAS_ENABLED=true`, the LangGraph agent also gets server-side canvas tools (same dispatch):

- `canvas_get_scene_summary`, `canvas_list_nodes`, `canvas_list_frames`
- `canvas_apply_tool_ops`
- `canvas_create_shape`, `canvas_create_text`, `canvas_update_node`, `canvas_delete_nodes`

The primary Agent paint path remains SSE `tool_ops` → FE `applyAgentToolOps`. MCP tools are an optional react-mode side channel (useful when the editor is closed or for read-back).

## Related

- Tool registry seed: `apps/api/seeds/mcp/canvas_tools.yaml`
- Headless patch: `apps/api/app/services/mcp/apply_headless.py`
- Dispatch: `apps/api/app/services/mcp/dispatch.py`
- Stdio bridge: `scripts/mcp/recombyn_canvas_stdio.mjs`
- FE bridge: `apps/web/src/components/editor/mcp/McpCanvasBridge.tsx`
- Agent react tools: `apps/api/app/services/llm/mcp_canvas_tools.py`
