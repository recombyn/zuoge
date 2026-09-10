"""MCP-exposed canvas tool catalog."""
from __future__ import annotations

from functools import lru_cache
from typing import Any

import yaml

from app.core.config import resolve_seed_file
from app.services.design.ops.action_registry import default_canvas_actions
from app.services.llm.design_tools import (
    _openai_fn_def,
    _parameters_from_pydantic,
    pydantic_model_from_args_schema,
)
from app.services.mcp.apply_headless import HEADLESS_OP_NAMES

_META_READ = frozenset({"get_scene_summary", "list_nodes", "list_frames"})
_META_BATCH = frozenset({"apply_tool_ops"})


def _load_canvas_tools_yaml() -> dict[str, Any]:
    path = resolve_seed_file("mcp", "canvas_tools.yaml")
    if not path.is_file():
        return {}
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


def _yaml_force_live_only() -> frozenset[str]:
    cfg = _load_canvas_tools_yaml()
    raw = cfg.get("live_only")
    if isinstance(raw, list):
        return frozenset(str(x).strip() for x in raw if str(x or "").strip())
    return frozenset()


@lru_cache(maxsize=1)
def headless_tool_names() -> frozenset[str]:
    """Ops the API can patch into the project document without an open editor."""
    return frozenset(HEADLESS_OP_NAMES)


@lru_cache(maxsize=1)
def live_only_tool_names() -> frozenset[str]:
    """
    Write ops that must run in a live editor (FE designTools).

    Auto: every exposed canvas op_key minus headless-capable names.
    Plus any names listed under YAML `live_only` (force list).
    """
    names: set[str] = set(_yaml_force_live_only())
    for row in default_canvas_actions():
        key = str(row.get("op_key") or "").strip()
        if key and key not in HEADLESS_OP_NAMES:
            names.add(key)
    # Never treat meta tools as live-only writes.
    names -= _META_READ | _META_BATCH
    return frozenset(names)


def live_session_ttl_sec() -> int:
    cfg = _load_canvas_tools_yaml()
    try:
        return max(5, int(cfg.get("live_session_ttl_sec") or 15))
    except (TypeError, ValueError):
        return 15


def max_ops_per_call() -> int:
    cfg = _load_canvas_tools_yaml()
    try:
        return max(1, int(cfg.get("max_ops_per_call") or 32))
    except (TypeError, ValueError):
        return 32


def is_live_only_tool(name: str) -> bool:
    return str(name or "").strip() in live_only_tool_names()


def is_headless_tool(name: str) -> bool:
    return str(name or "").strip() in headless_tool_names()


def is_canvas_write_tool(name: str) -> bool:
    key = str(name or "").strip()
    if not key or key in _META_READ:
        return False
    if key in _META_BATCH:
        return True
    return key in {str(r.get("op_key") or "").strip() for r in default_canvas_actions()}


@lru_cache(maxsize=1)
def exposed_tool_names() -> frozenset[str]:
    cfg = _load_canvas_tools_yaml()
    names: set[str] = set()
    if cfg.get("expose_all_canvas_ops"):
        for row in default_canvas_actions():
            key = str(row.get("op_key") or "").strip()
            if key:
                names.add(key)
    expose = cfg.get("expose") if isinstance(cfg.get("expose"), dict) else {}
    for block in ("read", "write", "batch"):
        raw = expose.get(block)
        if isinstance(raw, list):
            names.update(str(x).strip() for x in raw if str(x or "").strip())
    if not names:
        names.update(
            {
                "get_scene_summary",
                "list_nodes",
                "list_frames",
                "apply_tool_ops",
                "create_shape",
                "create_text",
                "update_node",
                "delete_nodes",
            }
        )
    return frozenset(names)


def clear_mcp_tool_caches() -> None:
    """Test helper — drop lru caches after YAML / seed changes."""
    exposed_tool_names.cache_clear()
    live_only_tool_names.cache_clear()
    headless_tool_names.cache_clear()


def _meta_tool_defs() -> list[dict[str, Any]]:
    return [
        _openai_fn_def(
            "get_scene_summary",
            "Summarize the current project canvas (node/frame counts and inventory).",
            {
                "type": "object",
                "properties": {"project_id": {"type": "string"}},
                "required": ["project_id"],
            },
        ),
        _openai_fn_def(
            "list_nodes",
            "List scene node inventory for the project canvas.",
            {
                "type": "object",
                "properties": {
                    "project_id": {"type": "string"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 200},
                },
                "required": ["project_id"],
            },
        ),
        _openai_fn_def(
            "list_frames",
            "List artboard frames on the project canvas.",
            {
                "type": "object",
                "properties": {"project_id": {"type": "string"}},
                "required": ["project_id"],
            },
        ),
        _openai_fn_def(
            "apply_tool_ops",
            "Apply a batch of canvas tool_ops after server-side validation. "
            "Basic create/update/delete/frame ops apply headless; others need a live editor.",
            {
                "type": "object",
                "properties": {
                    "project_id": {"type": "string"},
                    "ops": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "args": {"type": "object"},
                            },
                            "required": ["name"],
                        },
                    },
                },
                "required": ["project_id", "ops"],
            },
        ),
    ]


def list_mcp_tool_definitions() -> list[dict[str, Any]]:
    expose = exposed_tool_names()
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    actions_by_key = {
        str(row.get("op_key") or "").strip(): row
        for row in default_canvas_actions()
        if str(row.get("op_key") or "").strip()
    }

    for item in _meta_tool_defs():
        name = str((item.get("function") or {}).get("name") or "").strip()
        if name in expose:
            out.append(item)
            seen.add(name)

    for key in sorted(expose):
        if key in seen:
            continue
        row = actions_by_key.get(key)
        if not row:
            continue
        hint = str(row.get("model_hint") or row.get("label") or key).strip()
        if is_live_only_tool(key):
            hint = f"[live editor] {hint}"
        else:
            hint = f"[headless ok] {hint}"
        model = pydantic_model_from_args_schema(key, row.get("args_schema"))
        params = _parameters_from_pydantic(model)
        props = dict(params.get("properties") or {})
        props["project_id"] = {"type": "string", "description": "Recombyn project id"}
        required = list(params.get("required") or [])
        if "project_id" not in required:
            required.insert(0, "project_id")
        out.append(
            _openai_fn_def(key, hint, {**params, "properties": props, "required": required})
        )
        seen.add(key)
    return out
