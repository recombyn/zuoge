"""LangChain tools — MCP canvas control for Design Agent (react mode)."""
from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


def mcp_canvas_langchain_tools(*, user_id: str, project_id: str | None = None) -> list[Any]:
    """Server-side canvas read/write via MCP dispatch when enabled."""
    from app.core.config import settings

    if not settings.mcp_canvas_enabled:
        return []

    from langchain_core.tools import StructuredTool

    from app.services.mcp.dispatch import McpCanvasError, call_mcp_canvas_tool

    uid = str(user_id or "").strip()
    default_pid = str(project_id or "").strip()

    def _run(tool: str, arguments: dict[str, Any] | None = None) -> str:
        args = dict(arguments or {})
        if default_pid and not args.get("project_id") and not args.get("projectId"):
            args["project_id"] = default_pid
        try:
            result = call_mcp_canvas_tool(user_id=uid, tool=tool, arguments=args)
            return json.dumps(result, ensure_ascii=False)
        except McpCanvasError as exc:
            return json.dumps({"error": str(exc), "code": exc.code}, ensure_ascii=False)

    def _pid(project_id: str | None = None) -> str:
        return str(project_id or default_pid or "").strip()

    class ProjectIdArgs(BaseModel):
        model_config = ConfigDict(extra="forbid")
        project_id: str | None = Field(default=None, description="Recombyn project id")

    class ListNodesArgs(BaseModel):
        model_config = ConfigDict(extra="forbid")
        project_id: str | None = Field(default=None)
        limit: int | None = Field(default=120, ge=1, le=200)

    class ApplyOpsArgs(BaseModel):
        model_config = ConfigDict(extra="forbid")
        project_id: str | None = Field(default=None)
        ops: list[dict[str, Any]] = Field(description="Canvas tool_ops batch")

    class CreateShapeArgs(BaseModel):
        model_config = ConfigDict(extra="allow")
        project_id: str | None = Field(default=None)
        shapeType: str = Field(default="rect")
        x: float = 40
        y: float = 40
        width: float = 120
        height: float = 80
        fill: str | None = None
        stroke: str | None = None
        frameId: str | None = None

    class CreateTextArgs(BaseModel):
        model_config = ConfigDict(extra="allow")
        project_id: str | None = Field(default=None)
        text: str = Field(default="Text")
        x: float = 40
        y: float = 40
        width: float = 200
        fontSize: float | None = None
        fill: str | None = None
        frameId: str | None = None

    class UpdateNodeArgs(BaseModel):
        model_config = ConfigDict(extra="allow")
        project_id: str | None = Field(default=None)
        nodeId: str = Field(description="Scene node id")

    class DeleteNodesArgs(BaseModel):
        model_config = ConfigDict(extra="forbid")
        project_id: str | None = Field(default=None)
        nodeIds: list[str] = Field(description="Node ids to delete")

    tools: list[Any] = [
        StructuredTool.from_function(
            func=lambda project_id=None: _run(
                "get_scene_summary", {"project_id": _pid(project_id)}
            ),
            name="canvas_get_scene_summary",
            description="Read Recombyn canvas summary for a project (frames, nodes, types).",
            args_schema=ProjectIdArgs,
        ),
        StructuredTool.from_function(
            func=lambda project_id=None, limit=120: _run(
                "list_nodes",
                {"project_id": _pid(project_id), "limit": limit},
            ),
            name="canvas_list_nodes",
            description="List scene nodes on a Recombyn project canvas.",
            args_schema=ListNodesArgs,
        ),
        StructuredTool.from_function(
            func=lambda project_id=None: _run(
                "list_frames", {"project_id": _pid(project_id)}
            ),
            name="canvas_list_frames",
            description="List artboard frames on a Recombyn project canvas.",
            args_schema=ProjectIdArgs,
        ),
        StructuredTool.from_function(
            func=lambda project_id=None, ops=None: _run(
                "apply_tool_ops",
                {"project_id": _pid(project_id), "ops": ops or []},
            ),
            name="canvas_apply_tool_ops",
            description=(
                "Apply validated canvas tool_ops. "
                "Basic create/update/delete/frame ops apply headless; "
                "boolean/align/image_process/viewport and similar need a live editor "
                "(status queued_live or queued_offline)."
            ),
            args_schema=ApplyOpsArgs,
        ),
        StructuredTool.from_function(
            func=lambda project_id=None, **kwargs: _run(
                "create_shape",
                {"project_id": _pid(project_id), **kwargs},
            ),
            name="canvas_create_shape",
            description="Create a shape on the project canvas (headless-capable).",
            args_schema=CreateShapeArgs,
        ),
        StructuredTool.from_function(
            func=lambda project_id=None, **kwargs: _run(
                "create_text",
                {"project_id": _pid(project_id), **kwargs},
            ),
            name="canvas_create_text",
            description="Create a text node on the project canvas (headless-capable).",
            args_schema=CreateTextArgs,
        ),
        StructuredTool.from_function(
            func=lambda project_id=None, nodeId="", **kwargs: _run(
                "update_node",
                {"project_id": _pid(project_id), "nodeId": nodeId, **kwargs},
            ),
            name="canvas_update_node",
            description="Update a scene node (headless-capable).",
            args_schema=UpdateNodeArgs,
        ),
        StructuredTool.from_function(
            func=lambda project_id=None, nodeIds=None: _run(
                "delete_nodes",
                {"project_id": _pid(project_id), "nodeIds": nodeIds or []},
            ),
            name="canvas_delete_nodes",
            description="Delete scene nodes (headless-capable).",
            args_schema=DeleteNodesArgs,
        ),
    ]
    return tools
