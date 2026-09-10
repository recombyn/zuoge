"""Unit tests for MCP canvas headless dispatch, live queue, and tool registry."""
from __future__ import annotations

from unittest.mock import patch

import pytest

from app.services.mcp.apply_headless import ops_to_document_patch
from app.services.mcp.dispatch import McpCanvasError, call_mcp_canvas_tool
from app.services.mcp.scene import scene_frames_from_document, scene_nodes_from_document, summarize_scene
from app.services.mcp.tool_registry import (
    clear_mcp_tool_caches,
    exposed_tool_names,
    is_canvas_write_tool,
    is_live_only_tool,
    list_mcp_tool_definitions,
)


def _empty_doc() -> dict:
    return {
        "pageChildren": [],
        "frames": [],
        "deltaSetLike": {"ROOT": {"id": "ROOT", "key": "entry", "children": []}},
    }


@pytest.fixture(autouse=True)
def _clear_tool_registry_cache():
    clear_mcp_tool_caches()
    yield
    clear_mcp_tool_caches()


def test_expose_all_canvas_ops_in_registry():
    names = exposed_tool_names()
    assert "create_shape" in names
    assert "create_frame" in names
    assert "boolean_op" in names
    assert "get_scene_summary" in names
    defs = list_mcp_tool_definitions()
    assert len(defs) >= 30
    assert any(d["function"]["name"] == "create_text" for d in defs)


def test_live_only_tools_flagged():
    assert is_live_only_tool("set_viewport")
    assert is_live_only_tool("image_process")
    assert is_live_only_tool("boolean_op")
    assert is_live_only_tool("align_nodes")
    assert not is_live_only_tool("create_shape")
    assert not is_live_only_tool("create_text")
    assert not is_live_only_tool("update_node")
    assert is_canvas_write_tool("update_node")
    assert not is_canvas_write_tool("get_scene_summary")


def test_ops_to_document_patch_create_shape():
    doc = _empty_doc()
    patch = ops_to_document_patch(
        doc,
        [
            {
                "name": "create_shape",
                "args": {
                    "shapeType": "rect",
                    "x": 10,
                    "y": 20,
                    "width": 100,
                    "height": 50,
                    "fill": "#3366FF",
                },
            }
        ],
    )
    upsert = patch.get("upsertNodes") or {}
    assert len(upsert) >= 2
    shape = next(v for k, v in upsert.items() if k != "ROOT")
    assert shape["key"] == "shape"
    assert patch.get("pageChildren")


def test_ops_to_document_patch_create_frame():
    doc = _empty_doc()
    patch = ops_to_document_patch(
        doc,
        [{"name": "create_frame", "args": {"x": 0, "y": 0, "width": 375, "height": 812, "name": "Artboard"}}],
    )
    assert patch.get("frames")
    assert len(patch["frames"]) == 1
    assert patch["frames"][0]["width"] == 375


def test_ops_to_document_patch_create_shape_in_frame():
    doc = _empty_doc()
    doc["frames"] = [{"id": "f1", "x": 100, "y": 50, "width": 400, "height": 600, "name": "Board"}]
    doc["deltaSetLike"]["f1"] = {
        "id": "f1",
        "key": "frame",
        "x": 0,
        "y": 0,
        "width": 400,
        "height": 600,
        "attrs": {"name": "Board"},
        "children": [],
    }
    doc["deltaSetLike"]["ROOT"]["children"] = ["f1"]
    doc["pageChildren"] = ["f1"]
    patch = ops_to_document_patch(
        doc,
        [
            {
                "name": "create_shape",
                "args": {
                    "frameId": "f1",
                    "shapeType": "rect",
                    "x": 10,
                    "y": 20,
                    "width": 80,
                    "height": 40,
                    "fill": "#3366FF",
                },
            }
        ],
    )
    upsert = patch.get("upsertNodes") or {}
    shape = next(v for k, v in upsert.items() if k not in ("ROOT", "f1"))
    assert shape["attrs"]["frameId"] == "f1"
    assert shape["attrs"]["frameOrder"] == 0
    assert shape["x"] == 110
    assert shape["y"] == 70
    root_children = upsert["ROOT"]["children"]
    assert shape["id"] in root_children
    frame_children = upsert["f1"]["children"]
    assert shape["id"] in frame_children
    assert shape["id"] in (patch.get("pageChildren") or [])


def test_ops_to_document_patch_auto_groups_multiple_frame_nodes():
    doc = _empty_doc()
    doc["frames"] = [{"id": "f1", "x": 0, "y": 0, "width": 400, "height": 600, "name": "Board"}]
    doc["deltaSetLike"]["f1"] = {
        "id": "f1",
        "key": "frame",
        "x": 0,
        "y": 0,
        "width": 400,
        "height": 600,
        "attrs": {"name": "Board"},
        "children": [],
    }
    doc["deltaSetLike"]["ROOT"]["children"] = ["f1"]
    doc["pageChildren"] = ["f1"]
    patch = ops_to_document_patch(
        doc,
        [
            {
                "name": "create_shape",
                "args": {
                    "frameId": "f1",
                    "shapeType": "rect",
                    "x": 0,
                    "y": 0,
                    "width": 100,
                    "height": 80,
                    "fill": "#111111",
                },
            },
            {
                "name": "create_text",
                "args": {
                    "frameId": "f1",
                    "text": "Title",
                    "x": 10,
                    "y": 10,
                    "width": 80,
                    "fontSize": 24,
                    "fill": "#ffffff",
                },
            },
        ],
    )
    upsert = patch.get("upsertNodes") or {}
    created = [v for k, v in upsert.items() if k not in ("ROOT", "f1")]
    assert len(created) == 2
    group_ids = {node["attrs"].get("groupId") for node in created}
    assert len(group_ids) == 1
    assert None not in group_ids
    orders = sorted(int(node["attrs"]["frameOrder"]) for node in created)
    assert orders == [0, 1]


def test_ops_to_document_patch_skips_live_only():
    doc = _empty_doc()
    patch = ops_to_document_patch(doc, [{"name": "set_viewport", "args": {"action": "fit"}}])
    assert patch == {}
    patch2 = ops_to_document_patch(
        doc,
        [
            {"name": "boolean_op", "args": {"op": "unite", "nodeIds": ["a", "b"]}},
            {
                "name": "create_shape",
                "args": {
                    "shapeType": "rect",
                    "x": 0,
                    "y": 0,
                    "width": 10,
                    "height": 10,
                    "fill": "#000",
                },
            },
        ],
    )
    assert patch2.get("upsertNodes")


def test_summarize_scene_empty():
    summary = summarize_scene(_empty_doc())
    assert summary["nodeCount"] == 0
    assert summary["frameCount"] == 0


def test_scene_nodes_from_document_with_shape():
    doc = {
        "pageChildren": ["n1"],
        "frames": [],
        "deltaSetLike": {
            "ROOT": {"id": "ROOT", "key": "entry", "children": ["n1"]},
            "n1": {
                "id": "n1",
                "key": "shape",
                "x": 5,
                "y": 6,
                "width": 40,
                "height": 30,
                "attrs": {"shapeType": "rect", "fill-color": "#111"},
            },
        },
    }
    nodes = scene_nodes_from_document(doc)
    assert len(nodes) == 1
    assert nodes[0]["id"] == "n1"
    frames = scene_frames_from_document(doc)
    assert frames == []


@patch("app.services.mcp.dispatch.has_live_session", return_value=False)
@patch("app.services.mcp.dispatch.publish_pending_ops")
@patch("app.services.mcp.dispatch.publish_project_revision")
@patch("app.services.mcp.dispatch.project_store.patch_project")
@patch("app.services.mcp.dispatch.load_writable_project")
def test_call_create_shape_headless(mock_load, mock_patch, _pub_rev, _pub_pending, _live):
    mock_load.return_value = {"id": "p1", "revision": 3, "document": _empty_doc()}
    mock_patch.return_value = {"id": "p1", "revision": 4}

    out = call_mcp_canvas_tool(
        user_id="u1",
        tool="create_shape",
        arguments={
            "project_id": "p1",
            "shapeType": "rect",
            "x": 0,
            "y": 0,
            "width": 80,
            "height": 40,
            "fill": "#000",
        },
    )
    assert out["status"] == "applied_headless"
    assert out["applied"] == 1
    mock_patch.assert_called_once()


@patch("app.services.mcp.dispatch.has_live_session", return_value=True)
@patch("app.services.mcp.dispatch.publish_pending_ops", return_value="batch123")
@patch("app.services.mcp.dispatch.load_writable_project")
def test_call_create_shape_live_queue(mock_load, mock_pending, _live):
    mock_load.return_value = {"id": "p1", "revision": 2, "document": _empty_doc()}
    out = call_mcp_canvas_tool(
        user_id="u1",
        tool="create_shape",
        arguments={
            "project_id": "p1",
            "shapeType": "rect",
            "x": 0,
            "y": 0,
            "width": 80,
            "height": 40,
            "fill": "#000",
        },
    )
    assert out["status"] == "queued_live"
    assert out["batchId"] == "batch123"
    mock_pending.assert_called_once()


@patch("app.services.mcp.dispatch.load_writable_project")
def test_list_frames(mock_load):
    doc = _empty_doc()
    doc["frames"] = [{"id": "f1", "x": 0, "y": 0, "width": 100, "height": 200, "name": "A"}]
    mock_load.return_value = {"id": "p1", "revision": 1, "document": doc}
    out = call_mcp_canvas_tool(
        user_id="u1",
        tool="list_frames",
        arguments={"project_id": "p1"},
    )
    assert out["frames"][0]["id"] == "f1"


def test_call_requires_project_id():
    with pytest.raises(McpCanvasError) as exc:
        call_mcp_canvas_tool(user_id="u1", tool="list_nodes", arguments={})
    assert exc.value.code == "bad_request"


@patch("app.services.mcp.dispatch.has_live_session", return_value=False)
@patch("app.services.mcp.dispatch.publish_pending_ops", return_value="batch-off")
@patch("app.services.mcp.dispatch.load_writable_project")
def test_call_live_only_op_queues_offline(mock_load, mock_pending, _live):
    mock_load.return_value = {"id": "p1", "revision": 2, "document": _empty_doc()}
    out = call_mcp_canvas_tool(
        user_id="u1",
        tool="boolean_op",
        arguments={
            "project_id": "p1",
            "op": "unite",
            "nodeIds": ["n1", "n2"],
        },
    )
    assert out["status"] == "queued_offline"
    assert out["batchId"] == "batch-off"
    assert "boolean_op" in (out.get("liveOnly") or [])
    mock_pending.assert_called_once()


@patch("app.services.mcp.dispatch.has_live_session", return_value=False)
@patch("app.services.mcp.dispatch.publish_pending_ops", return_value="batch-mix")
@patch("app.services.mcp.dispatch.project_store.patch_project")
@patch("app.services.mcp.dispatch.load_writable_project")
def test_mixed_batch_with_live_only_queues_all_offline(
    mock_load, mock_patch, mock_pending, _live
):
    mock_load.return_value = {"id": "p1", "revision": 2, "document": _empty_doc()}
    out = call_mcp_canvas_tool(
        user_id="u1",
        tool="apply_tool_ops",
        arguments={
            "project_id": "p1",
            "ops": [
                {
                    "name": "create_shape",
                    "args": {
                        "shapeType": "rect",
                        "x": 0,
                        "y": 0,
                        "width": 40,
                        "height": 40,
                        "fill": "#000",
                    },
                },
                {"name": "align_nodes", "args": {"nodeIds": ["a", "b"], "align": "left"}},
            ],
        },
    )
    assert out["status"] == "queued_offline"
    mock_pending.assert_called_once()
    mock_patch.assert_not_called()


@patch("app.core.config.settings")
def test_mcp_agent_tools_when_disabled(mock_settings):
    mock_settings.mcp_canvas_enabled = False
    from app.services.llm.mcp_canvas_tools import mcp_canvas_langchain_tools

    assert mcp_canvas_langchain_tools(user_id="u1", project_id="p1") == []


@patch("app.core.config.settings")
def test_mcp_agent_tools_when_enabled(mock_settings):
    mock_settings.mcp_canvas_enabled = True
    from app.services.llm.mcp_canvas_tools import mcp_canvas_langchain_tools

    tools = mcp_canvas_langchain_tools(user_id="u1", project_id="p1")
    names = {getattr(t, "name", "") for t in tools}
    assert "canvas_get_scene_summary" in names
    assert "canvas_list_nodes" in names
    assert "canvas_list_frames" in names
    assert "canvas_apply_tool_ops" in names
    assert "canvas_create_shape" in names
    assert "canvas_create_text" in names
    assert "canvas_update_node" in names
    assert "canvas_delete_nodes" in names
