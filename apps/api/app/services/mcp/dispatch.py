"""MCP canvas tool dispatch — validate tool_ops and persist or queue for live editor."""
from __future__ import annotations

from typing import Any

from app.services.design.ops.tool_ops_contract import extract_and_validate_tool_ops
from app.services.mcp.apply_headless import ops_to_document_patch
from app.services.design.ops.text_node_attrs import validate_headless_patch
from app.services.mcp.auth import load_writable_project, project_revision
from app.services.mcp.push.channel import publish_pending_ops, publish_project_revision
from app.services.mcp.scene import (
    scene_frames_from_document,
    scene_nodes_from_document,
    summarize_scene,
)
from app.services.mcp.session import has_live_session
from app.services.mcp.tool_registry import (
    exposed_tool_names,
    is_canvas_write_tool,
    is_live_only_tool,
    max_ops_per_call,
)
from app.services import projects as project_store
from app.services.projects import ProjectConflictError, ProjectForbiddenError, ProjectNotFoundError


class McpCanvasError(Exception):
    def __init__(self, message: str, *, code: str = "mcp_error") -> None:
        super().__init__(message)
        self.code = code


def _ensure_tool_allowed(name: str) -> None:
    if name not in exposed_tool_names():
        raise McpCanvasError(f"tool {name!r} is not exposed via MCP", code="tool_not_allowed")


def _project_document(row: dict[str, Any]) -> dict[str, Any]:
    doc = row.get("document")
    return doc if isinstance(doc, dict) else {}


def _validate_ops_for_document(
    doc: dict[str, Any],
    ops: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    validated, errors = extract_and_validate_tool_ops(
        ops,
        scene_nodes=scene_nodes_from_document(doc),
        scene_frames=scene_frames_from_document(doc),
        rules={},
        paint_lane="edit",
        classified_intent="edit",
    )
    if errors:
        raise McpCanvasError("; ".join(errors[:8]), code="validation_failed")
    if not validated:
        raise McpCanvasError("no valid ops after validation", code="validation_failed")
    if len(validated) > max_ops_per_call():
        raise McpCanvasError(
            f"too many ops ({len(validated)} > {max_ops_per_call()})",
            code="ops_limit",
        )
    return validated


def _persist_ops(user_id: str, project_id: str, ops: list[dict[str, Any]]) -> dict[str, Any]:
    row = load_writable_project(user_id, project_id)
    doc = _project_document(row)
    validated = _validate_ops_for_document(doc, ops)
    live = has_live_session(project_id)
    live_required = [o for o in validated if is_live_only_tool(str(o.get("name") or ""))]
    headless_ok = [o for o in validated if not is_live_only_tool(str(o.get("name") or ""))]
    op_summaries = [{"name": o.get("name"), "args": o.get("args")} for o in validated]
    live_names = [str(o.get("name") or "") for o in live_required]

    # Open editor: full designTools parity via FE bridge.
    if live:
        batch_id = publish_pending_ops(project_id, validated)
        return {
            "status": "queued_live",
            "applied": 0,
            "queued": len(validated),
            "batchId": batch_id,
            "revision": project_revision(row),
            "liveOnly": live_names,
            "ops": op_summaries,
        }

    # No editor: never silently drop live-only ops — queue until the project opens.
    if live_required:
        batch_id = publish_pending_ops(project_id, validated)
        return {
            "status": "queued_offline",
            "applied": 0,
            "queued": len(validated),
            "batchId": batch_id,
            "revision": project_revision(row),
            "message": (
                "Some ops require a live editor session. "
                "Open this project in the web editor to apply "
                f"({', '.join(sorted({n for n in live_names if n})[:8])})."
            ),
            "liveOnly": live_names,
            "ops": op_summaries,
        }

    patch = ops_to_document_patch(doc, headless_ok)
    if not patch:
        raise McpCanvasError(
            "ops produced no document changes (check node ids / args)",
            code="empty_patch",
        )

    schema_errors = validate_headless_patch(patch)
    if schema_errors:
        raise McpCanvasError(
            "; ".join(schema_errors[:8]),
            code="schema_invalid",
        )
    patch.pop("schemaWarnings", None)

    try:
        updated = project_store.patch_project(
            user_id,
            project_id,
            patch=patch,
            base_revision=project_revision(row),
        )
    except ProjectConflictError as exc:
        raise McpCanvasError(
            f"revision conflict (server={exc.revision})",
            code="revision_conflict",
        ) from exc
    except ProjectForbiddenError as exc:
        raise McpCanvasError("forbidden", code="forbidden") from exc
    except ProjectNotFoundError as exc:
        raise McpCanvasError("project not found", code="not_found") from exc

    rev = int(updated.get("revision") or project_revision(row) + 1)
    publish_project_revision(project_id, rev)
    return {
        "status": "applied_headless",
        "applied": len(headless_ok),
        "queued": 0,
        "revision": rev,
        "ops": [{"name": o.get("name"), "args": o.get("args")} for o in headless_ok],
    }


def call_mcp_canvas_tool(
    *,
    user_id: str,
    tool: str,
    arguments: dict[str, Any] | None,
) -> Any:
    name = str(tool or "").strip()
    if not name:
        raise McpCanvasError("missing tool name", code="bad_request")
    _ensure_tool_allowed(name)
    args = dict(arguments or {})
    project_id = str(args.pop("project_id", None) or args.pop("projectId", "") or "").strip()
    if not project_id:
        raise McpCanvasError("project_id is required", code="bad_request")

    if name == "get_scene_summary":
        row = load_writable_project(user_id, project_id)
        summary = summarize_scene(_project_document(row))
        summary["projectId"] = project_id
        summary["revision"] = project_revision(row)
        summary["liveSession"] = has_live_session(project_id)
        return summary

    if name == "list_nodes":
        row = load_writable_project(user_id, project_id)
        nodes = scene_nodes_from_document(_project_document(row))
        limit = int(args.get("limit") or 120)
        return {
            "projectId": project_id,
            "revision": project_revision(row),
            "nodes": nodes[: max(1, min(limit, 200))],
        }

    if name == "list_frames":
        row = load_writable_project(user_id, project_id)
        frames = scene_frames_from_document(_project_document(row))
        return {
            "projectId": project_id,
            "revision": project_revision(row),
            "frames": frames,
        }

    if name == "apply_tool_ops":
        raw_ops = args.get("ops")
        if not isinstance(raw_ops, list) or not raw_ops:
            raise McpCanvasError("ops must be a non-empty array", code="bad_request")
        return _persist_ops(user_id, project_id, raw_ops)

    if is_canvas_write_tool(name):
        return _persist_ops(user_id, project_id, [{"name": name, "args": args}])

    raise McpCanvasError(f"unsupported tool {name!r}", code="unsupported_tool")
