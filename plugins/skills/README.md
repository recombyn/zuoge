# Skill plugins (`plugins/skills`)

You can drop private Skill packs here. Same layout as shipped packs under
`skills/foundation` and `skills/domains`. Compose already mounts this folder.

## Canonical pack layout

```
my_poster_plugin/
├── _meta.json        # required — triggers, preferred_tools, id/version
├── SKILL.md          # required — Agent craft rules
├── schema.json       # optional — input / output JSON schema
├── handler.py        # optional — DESIGN_SKILL_OPS_RUNNER → tool_ops
├── assets/           # optional — icon.svg / logo (list + picker thumb)
└── examples/         # optional — reference images (docs only today)
```

Skills are **playbooks** by default (LLM paint). With the ops runner enabled, `handler.py` may return `tool_ops` first.

## Product roots

| Root | Who |
|------|-----|
| `skills/foundation/` | Shipped core craft (open) |
| `skills/domains/` | Shipped surfaces / deliverables (open) |
| `plugins/skills/` | Private deploy mount |

`.agents/skills/` is for Cursor/IDE agents only — **not** loaded by the Design Agent.

## Add a pack

1. Create the folder under `plugins/skills/<key>/` with at least `_meta.json` + `SKILL.md`.
2. Restart API, or wait for hot reload.
3. Chat with a trigger (sample: 「生成中秋红色海报」 → `festival_poster`).

## Docker

API images bake `skills/` + `plugins/skills/` (see `deploy/docker/Dockerfile.api`). Compose can still mount for hot-reload:

```yaml
volumes:
  - ./skills:/app/skills
  - ./plugins/skills:/app/plugins/skills
```

Extra roots: `DESIGN_SKILLS_PLUGIN_DIRS=...`

Pack for distribution: `node scripts/pack-recombyn-plugin.mjs plugins/skills/<key>` → see [docs/plugin-packs.md](../docs/plugin-packs.md).

See [docs/skill-extensions.md](../docs/skill-extensions.md).
