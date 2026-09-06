# API seeds

First boot loads prompt packs, Skills, AgentProfile YAML, canvas tools, and catalogs from this tree. Prompt-pack body/meta follow git (Admin UI edits are overwritten on the next ensure).

Owner docs: [self-hosting.md](../../../docs/self-hosting.md) · AgentProfile: [agent-profile.md](../../../docs/agent-profile.md)

## Layout


| Path                                                                     | Contents                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------- |
| `agents/bindings.yaml`                                                   | product/surface → Profile id                      |
| `agents/profiles/*.yaml`                                                 | AgentProfile YAML (`design.canvas`)               |
| `design_prompt_packs/`                                                   | `_index.json` + `stages/*.md` + `snippets.md` (pack sections) |
| Private Skill packs                                                      | `<repo>/skills/foundation|domains/` + `<repo>/plugins/skills/<key>/` — [docs/skill-extensions.md](../../docs/skill-extensions.md) |
| `canvas_actions_seed.json`                                               | Canvas tool registry                              |
| `design_agent_stress_suite.json`                                         | Agent SSE / browser stress cases (not loaded at runtime) |
| `fonts_seed.json` · `design_tokens_seed.json` · `design_dicts_seed.json` | Fonts / tokens / dicts                            |
| `plaza_agent_docs/`                                                      | Optional official plaza boards (`npm run plaza:agent-showcase`); empty by default |
| `llm_models_seed.json`                                                   | Model catalog seed                                |
| `stage_rule_defaults.json` · `progress_stages.json`                      | Platform KV defaults / progress labels            |

### Design Agent stress suite

`design_agent_stress_suite.json` is an **eval seed**, not a prompt pack:

| Pool | Purpose | Failures usually mean |
|------|---------|------------------------|
| `cases` | Category craft (poster / banner / …) + `skill_expect` | Skills |
| `system_cases` | Vague / contradict / stop / tiny edit | Prompt packs / kernel routing |

Runner (API must be up; token via `STRESS_TOKEN` or repo-root `.tmp-token.txt`):

```bash
npm run test:agent:concurrency                 # all category cases
npm run test:agent:concurrency -- poster       # subset
npm run test:agent:concurrency -- --system     # system_cases pool
```

Writes `.tmp-design-agent-stress-result.json` (gitignored).


Helpers in code: `resolve_seed_dir` / `resolve_seed_file` / `api_seeds_dir`（原 `data/` 已迁到 `seeds/`）。