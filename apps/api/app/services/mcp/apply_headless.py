"""Convert validated canvas tool_ops into project document patches (headless apply)."""
from __future__ import annotations

import copy
import secrets
from typing import Any

from app.services.design.ops.text_node_attrs import (
    build_markdown_text_attrs,
    merge_text_node_attrs,
    normalize_text_font_size,
    style_from_create_text_args,
    validate_headless_patch,
)

_TEXT_UPDATE_KEYS = (
    "text",
    "fill",
    "fontSize",
    "fontWeight",
    "fontFamily",
    "fontStyle",
    "textAlign",
    "lineHeight",
    "textDecoration",
)

# Ops that `ops_to_document_patch` can apply without a live editor.
# Everything else in the canvas catalog is live-only (queued for FE apply).
HEADLESS_OP_NAMES = frozenset(
    {
        "create_shape",
        "create_path",
        "create_text",
        "update_node",
        "delete_nodes",
        "hide_nodes",
        "create_frame",
        "update_frame",
        "delete_frame",
        "set_canvas_background",
    }
)


def is_headless_op(name: str) -> bool:
    return str(name or "").strip() in HEADLESS_OP_NAMES


def _bool_attr(value: Any) -> str:
    return "true" if value in (True, "true", 1) else "false"


def _transparent_fill(fill: str) -> bool:
    return fill == "transparent"


def _new_node_id(prefix: str = "") -> str:
    base = secrets.token_hex(5)
    return f"{prefix}{base}" if prefix else base


def _num(value: Any, default: float = 0) -> float:
    try:
        n = float(value)
        return n if n == n else default
    except (TypeError, ValueError):
        return default


def _pick_num(args: dict[str, Any], *keys: str, default: float = 0) -> float:
    for key in keys:
        if key in args and args[key] is not None:
            return _num(args[key], default)
    return default


def _shape_node_from_args(args: dict[str, Any], node_id: str) -> dict[str, Any]:
    shape_type = str(args.get("shapeType") or "rect").strip() or "rect"
    fill = str(args.get("fill") or "#FFFFFF").strip() or "#FFFFFF"
    stroke = str(args.get("stroke") or "#333333").strip() or "#333333"
    border_w = _pick_num(args, "borderWidth", "border-width", default=1)
    x = _pick_num(args, "x", default=40)
    y = _pick_num(args, "y", default=40)
    width = max(1, _pick_num(args, "width", "w", default=120))
    height = max(1, _pick_num(args, "height", "h", default=80))
    transparent = _transparent_fill(fill)
    fill_visible = _bool_attr(not transparent)
    attrs: dict[str, Any] = {
        "shapeType": shape_type,
        "fill-color": fill,
        "fill-type": str(args.get("fillType") or args.get("fill-type") or "solid"),
        "border-color": stroke,
        "border-width": border_w,
        "strokeAlign": str(args.get("strokeAlign") or "center"),
        "stroke-enabled": "true",
        "stroke-visible": "true",
        "fill-enabled": fill_visible,
        "fill-visible": fill_visible,
    }
    for k in ("path", "name", "brushStyle", "pathPressure"):
        if args.get(k) is not None:
            attrs[k] = args[k]
    if args.get("rotation") is not None:
        attrs["angle"] = _num(args["rotation"])
    if args.get("closed") is not None:
        attrs["closed"] = _bool_attr(args["closed"])
    return {
        "id": node_id,
        "key": "shape",
        "x": x,
        "y": y,
        "z": 0,
        "width": width,
        "height": height,
        "attrs": attrs,
        "children": [],
    }


def _text_node_from_args(args: dict[str, Any], node_id: str) -> dict[str, Any]:
    text = str(args.get("text") or "")
    x = _pick_num(args, "x", default=40)
    y = _pick_num(args, "y", default=40)
    box_mode = args.get("width") is not None and args.get("height") is not None
    width = max(1, _pick_num(args, "width", "w", default=max(80, len(text) * 12)))
    height = max(1, _pick_num(args, "height", "h", default=32))
    style = style_from_create_text_args(args, box_mode=box_mode)

    attrs: dict[str, Any] = {
        **build_markdown_text_attrs(text, style),
        "autoSize": _bool_attr(not box_mode),
    }
    if args.get("name"):
        attrs["name"] = str(args["name"])

    if not box_mode and text:
        font_size = normalize_text_font_size(style.get("fontSize") or args.get("fontSize"))
        line_height = float(style.get("lineHeight") or 1.15)
        height = max(height, int(font_size * line_height))

    return {
        "id": node_id,
        "key": "text",
        "x": x,
        "y": y,
        "z": 0,
        "width": width,
        "height": height,
        "attrs": attrs,
        "children": [],
    }


def _merge_update_node(existing: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(existing)
    attrs = dict(out.get("attrs") or {}) if isinstance(out.get("attrs"), dict) else {}
    is_text = out.get("key") == "text"

    if args.get("x") is not None:
        out["x"] = _num(args["x"], float(out.get("x") or 0))
    if args.get("y") is not None:
        out["y"] = _num(args["y"], float(out.get("y") or 0))
    if args.get("width") is not None or args.get("w") is not None:
        out["width"] = max(1, _pick_num(args, "width", "w", default=float(out.get("width") or 1)))
    if args.get("height") is not None or args.get("h") is not None:
        out["height"] = max(1, _pick_num(args, "height", "h", default=float(out.get("height") or 1)))

    if is_text and any(args.get(k) is not None for k in _TEXT_UPDATE_KEYS):
        attrs = merge_text_node_attrs(attrs, args)
    else:
        shape_mapping = {
            "text": "text",
            "fill": "fill-color",
            "stroke": "border-color",
            "borderWidth": "border-width",
            "shapeType": "shapeType",
            "name": "name",
            "rotation": "angle",
            "opacity": "opacity",
            "path": "path",
            "hidden": "hidden",
            "locked": "locked",
        }
        for src, dst in shape_mapping.items():
            if args.get(src) is None:
                continue
            val = args[src]
            if src in ("hidden", "locked"):
                attrs[dst] = _bool_attr(val)
            else:
                attrs[dst] = val
        if args.get("text") is not None:
            attrs["content"] = str(args["text"])

    out["attrs"] = attrs
    return out


def _ensure_delta(doc: dict[str, Any]) -> dict[str, Any]:
    delta = doc.setdefault("deltaSetLike", {})
    if not isinstance(delta, dict):
        delta = {}
        doc["deltaSetLike"] = delta
    if "ROOT" not in delta or not isinstance(delta.get("ROOT"), dict):
        delta["ROOT"] = {"id": "ROOT", "key": "entry", "children": []}
    return delta


def _append_root_child(doc: dict[str, Any], node_id: str) -> None:
    delta = _ensure_delta(doc)
    root = delta["ROOT"]
    children = list(root.get("children") or [])
    pages = doc.get("pages")
    if isinstance(pages, list) and pages and isinstance(pages[0], dict):
        page_children = list(pages[0].get("children") or [])
    else:
        page_children = list(doc.get("pageChildren") or children)
    if node_id not in children:
        children.append(node_id)
    if node_id not in page_children:
        page_children.append(node_id)
    root["children"] = children
    doc["pageChildren"] = page_children
    if isinstance(pages, list) and pages and isinstance(pages[0], dict):
        pages[0] = {**pages[0], "children": page_children}
        doc["pages"] = pages


def _frame_by_id(doc: dict[str, Any], frame_id: str) -> dict[str, Any] | None:
    for frame in doc.get("frames") or []:
        if isinstance(frame, dict) and str(frame.get("id") or "") == frame_id:
            return frame
    return None


def _next_frame_order(doc: dict[str, Any], frame_id: str) -> int:
    orders: list[int] = []
    for node in (_ensure_delta(doc).values()):
        if not isinstance(node, dict):
            continue
        attrs = node.get("attrs") if isinstance(node.get("attrs"), dict) else {}
        if str(attrs.get("frameId") or "") != frame_id:
            continue
        try:
            orders.append(int(attrs.get("frameOrder")))
        except (TypeError, ValueError):
            continue
    return max(orders) + 1 if orders else 0


def _fit_into_frame(
    frame: dict[str, Any] | None,
    x: float,
    y: float,
    width: float,
    height: float,
) -> tuple[float, float, float, float]:
    """Promote frame-local coords to world coords (mirrors FE designTools.fitIntoFrame)."""
    if not frame:
        return x, y, max(1.0, width), max(1.0, height)
    fx = _num(frame.get("x"))
    fy = _num(frame.get("y"))
    fw = max(1.0, _num(frame.get("width"), 1))
    fh = max(1.0, _num(frame.get("height"), 1))
    w = max(1.0, min(width, fw))
    h = max(1.0, min(height, fh))
    wx, wy = x, y
    if x >= 0 and x <= fw and y >= 0 and y <= fh:
        wx = fx + x
        wy = fy + y
    max_x = fx + fw - w
    max_y = fy + fh - h
    nx = min(max(wx, fx), max(fx, max_x))
    ny = min(max(wy, fy), max(fy, max_y))
    return nx, ny, w, h


def _place_node_args_for_frame(doc: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
    frame_id = str(args.get("frameId") or "").strip()
    if not frame_id:
        return args
    frame = _frame_by_id(doc, frame_id)
    if not frame:
        return args
    x = _pick_num(args, "x", default=40)
    y = _pick_num(args, "y", default=40)
    width = max(1, _pick_num(args, "width", "w", default=120))
    height = max(1, _pick_num(args, "height", "h", default=80))
    px, py, pw, ph = _fit_into_frame(frame, x, y, width, height)
    return {**args, "x": px, "y": py, "width": pw, "height": ph}


def _append_frame_child(
    doc: dict[str, Any],
    frame_id: str,
    node_id: str,
    *,
    frame_order: int | None = None,
) -> None:
    if node_id == frame_id:
        return
    delta = _ensure_delta(doc)
    frame_node = delta.get(frame_id)
    if not isinstance(frame_node, dict):
        _append_root_child(doc, node_id)
        return
    # Frame-bound nodes still live in page/ROOT children for rendering (see addNodeToDocument).
    _append_root_child(doc, node_id)
    children = [c for c in list(frame_node.get("children") or []) if str(c) != frame_id]
    if node_id not in children:
        children.append(node_id)
    frame_node = dict(frame_node)
    frame_node["children"] = children
    delta[frame_id] = frame_node
    node = delta.get(node_id)
    if isinstance(node, dict):
        node = dict(node)
        attrs = dict(node.get("attrs") or {})
        attrs["frameId"] = frame_id
        attrs["frameOrder"] = (
            frame_order if frame_order is not None else _next_frame_order(doc, frame_id)
        )
        node["attrs"] = attrs
        delta[node_id] = node


def _assign_group_id(doc: dict[str, Any], node_ids: list[str]) -> str:
    group_id = _new_node_id("g_")
    delta = _ensure_delta(doc)
    for node_id in node_ids:
        node = delta.get(node_id)
        if not isinstance(node, dict):
            continue
        patched = dict(node)
        attrs = dict(patched.get("attrs") or {})
        attrs["groupId"] = group_id
        patched["attrs"] = attrs
        delta[node_id] = patched
    return group_id


def _reindex_frame_children(doc: dict[str, Any], frame_id: str) -> None:
    delta = _ensure_delta(doc)
    frame_node = delta.get(frame_id)
    if not isinstance(frame_node, dict):
        return
    siblings = [
        nid
        for nid, node in delta.items()
        if nid not in ("ROOT", frame_id)
        and isinstance(node, dict)
        and str((node.get("attrs") or {}).get("frameId") or "") == frame_id
    ]

    def _order_key(nid: str) -> tuple[int, int]:
        node = delta.get(nid)
        if not isinstance(node, dict):
            return (0, 0)
        attrs = node.get("attrs") if isinstance(node.get("attrs"), dict) else {}
        try:
            explicit = int(attrs.get("frameOrder"))
        except (TypeError, ValueError):
            explicit = 0
        try:
            listed = list(frame_node.get("children") or []).index(nid)
        except ValueError:
            listed = 0
        return (explicit, listed)

    siblings.sort(key=_order_key)
    for index, node_id in enumerate(siblings):
        node = delta.get(node_id)
        if not isinstance(node, dict):
            continue
        patched = dict(node)
        attrs = dict(patched.get("attrs") or {})
        attrs["frameId"] = frame_id
        attrs["frameOrder"] = index
        patched["attrs"] = attrs
        delta[node_id] = patched
    frame_node = dict(frame_node)
    frame_node["children"] = siblings
    delta[frame_id] = frame_node


def _finalize_frame_batches(
    doc: dict[str, Any],
    *,
    created_by_frame: dict[str, list[str]],
    upsert: dict[str, Any],
) -> None:
    for frame_id, created_ids in created_by_frame.items():
        unique_ids = [nid for nid in dict.fromkeys(created_ids) if nid]
        _reindex_frame_children(doc, frame_id)
        if len(unique_ids) >= 2:
            _assign_group_id(doc, unique_ids)
        delta = _ensure_delta(doc)
        upsert[frame_id] = delta[frame_id]
        for node_id in unique_ids:
            if node_id in delta:
                upsert[node_id] = delta[node_id]
        for node_id in list(delta.get(frame_id, {}).get("children") or []):
            if node_id in delta and node_id not in upsert:
                upsert[node_id] = delta[node_id]


def _create_frame(doc: dict[str, Any], args: dict[str, Any]) -> str:
    fid = str(args.get("frameId") or args.get("id") or _new_node_id("f_"))
    width = max(1, _pick_num(args, "width", "w", default=375))
    height = max(1, _pick_num(args, "height", "h", default=812))
    x = _pick_num(args, "x", default=0)
    y = _pick_num(args, "y", default=0)
    name = str(args.get("name") or "Frame")
    delta = _ensure_delta(doc)
    delta[fid] = {
        "id": fid,
        "key": "frame",
        "x": 0,
        "y": 0,
        "width": width,
        "height": height,
        "attrs": {"name": name},
        "children": [],
    }
    frames = list(doc.get("frames") or [])
    frames.append(
        {
            "id": fid,
            "x": x,
            "y": y,
            "width": width,
            "height": height,
            "name": name,
            "clipContent": args.get("clipContent") not in (False, "false", 0),
        }
    )
    doc["frames"] = frames
    _append_root_child(doc, fid)
    if not doc.get("activeFrameId"):
        doc["activeFrameId"] = fid
    return fid


def _update_frame(doc: dict[str, Any], args: dict[str, Any]) -> None:
    fid = str(args.get("frameId") or args.get("id") or "").strip()
    if not fid:
        return
    frames = list(doc.get("frames") or [])
    for i, f in enumerate(frames):
        if not isinstance(f, dict) or str(f.get("id")) != fid:
            continue
        nf = dict(f)
        if args.get("x") is not None:
            nf["x"] = _num(args["x"], float(nf.get("x") or 0))
        if args.get("y") is not None:
            nf["y"] = _num(args["y"], float(nf.get("y") or 0))
        if args.get("width") is not None or args.get("w") is not None:
            nf["width"] = max(1, _pick_num(args, "width", "w", default=float(nf.get("width") or 1)))
        if args.get("height") is not None or args.get("h") is not None:
            nf["height"] = max(1, _pick_num(args, "height", "h", default=float(nf.get("height") or 1)))
        if args.get("name") is not None:
            nf["name"] = str(args["name"])
        if args.get("clipContent") is not None:
            nf["clipContent"] = args["clipContent"] not in (False, "false", 0)
        frames[i] = nf
        break
    doc["frames"] = frames
    delta = _ensure_delta(doc)
    if fid in delta and isinstance(delta[fid], dict):
        fn = dict(delta[fid])
        if args.get("width") is not None or args.get("w") is not None:
            fn["width"] = max(1, _pick_num(args, "width", "w", default=float(fn.get("width") or 1)))
        if args.get("height") is not None or args.get("h") is not None:
            fn["height"] = max(1, _pick_num(args, "height", "h", default=float(fn.get("height") or 1)))
        delta[fid] = fn


def _delete_frame(doc: dict[str, Any], frame_id: str) -> None:
    fid = str(frame_id or "").strip()
    if not fid:
        return
    doc["frames"] = [f for f in (doc.get("frames") or []) if str((f or {}).get("id")) != fid]
    delta = _ensure_delta(doc)
    delta.pop(fid, None)
    root = delta.get("ROOT")
    if isinstance(root, dict):
        root["children"] = [c for c in (root.get("children") or []) if str(c) != fid]
    doc["pageChildren"] = [c for c in (doc.get("pageChildren") or []) if str(c) != fid]
    if str(doc.get("activeFrameId") or "") == fid:
        frames = doc.get("frames") or []
        doc["activeFrameId"] = str(frames[0].get("id")) if frames else None


def _register_created_node(
    working: dict[str, Any],
    upsert: dict[str, Any],
    created_by_frame: dict[str, list[str]],
    next_frame_order,
    *,
    node: dict[str, Any],
    frame_id: str,
) -> None:
    node_id = node["id"]
    delta = working["deltaSetLike"]
    delta[node_id] = node
    if frame_id:
        _append_frame_child(working, frame_id, node_id, frame_order=next_frame_order(frame_id))
        created_by_frame.setdefault(frame_id, []).append(node_id)
        upsert[frame_id] = delta[frame_id]
    else:
        _append_root_child(working, node_id)
    upsert[node_id] = delta[node_id]
    upsert["ROOT"] = delta["ROOT"]


def _node_id_list(args: dict[str, Any]) -> list[str]:
    raw = args.get("nodeIds") or args.get("ids") or []
    if not isinstance(raw, list):
        return []
    return [str(item).strip() for item in raw if str(item or "").strip()]


def _collect_schema_warnings(upsert: dict[str, Any]) -> list[str]:
    return validate_headless_patch({"upsertNodes": upsert})


def _assemble_patch(
    working: dict[str, Any],
    *,
    upsert: dict[str, Any],
    remove: list[str],
    frames_patch: list[Any] | None,
    canvas_patch: dict[str, Any] | None,
) -> dict[str, Any]:
    patch: dict[str, Any] = {}
    if upsert:
        patch["upsertNodes"] = upsert
    if remove:
        patch["removeNodeIds"] = remove
    if frames_patch is not None:
        patch["frames"] = frames_patch
    if canvas_patch is not None:
        patch["canvas"] = canvas_patch
    if working.get("pageChildren") is not None:
        patch["pageChildren"] = working.get("pageChildren")
    if working.get("activeFrameId") is not None:
        patch["activeFrameId"] = working.get("activeFrameId")
    schema_warnings = _collect_schema_warnings(upsert)
    if schema_warnings:
        patch["schemaWarnings"] = schema_warnings[:8]
    return patch


def ops_to_document_patch(
    doc: dict[str, Any],
    ops: list[dict[str, Any]],
) -> dict[str, Any]:
    """Map validated tool_ops to incremental project patch."""
    working = copy.deepcopy(doc) if isinstance(doc, dict) else {}
    delta = _ensure_delta(working)
    upsert: dict[str, Any] = {}
    remove: list[str] = []
    frames_patch: list[Any] | None = None
    canvas_patch: dict[str, Any] | None = None
    touched = False
    frame_order_next: dict[str, int] = {}
    created_by_frame: dict[str, list[str]] = {}

    def _next_batch_frame_order(frame_id: str) -> int:
        order = frame_order_next.get(frame_id, _next_frame_order(working, frame_id))
        frame_order_next[frame_id] = order + 1
        return order

    for op in ops or []:
        if not isinstance(op, dict):
            continue
        name = str(op.get("name") or "").strip()
        if not is_headless_op(name):
            continue
        args = op.get("args") if isinstance(op.get("args"), dict) else {}

        frame_id = str(args.get("frameId") or "").strip()

        if name in ("create_shape", "create_path"):
            shape_type = args.get("shapeType") or ("path" if name == "create_path" else "rect")
            placed_args = _place_node_args_for_frame(working, {**args, "shapeType": shape_type})
            node = _shape_node_from_args(placed_args, _new_node_id())
            _register_created_node(
                working,
                upsert,
                created_by_frame,
                _next_batch_frame_order,
                node=node,
                frame_id=frame_id,
            )
            touched = True
        elif name == "create_text":
            placed_args = _place_node_args_for_frame(working, args)
            node = _text_node_from_args(placed_args, _new_node_id())
            _register_created_node(
                working,
                upsert,
                created_by_frame,
                _next_batch_frame_order,
                node=node,
                frame_id=frame_id,
            )
            touched = True
        elif name == "update_node":
            nid = str(args.get("nodeId") or args.get("id") or "").strip()
            existing = delta.get(nid)
            if nid and isinstance(existing, dict):
                upsert[nid] = _merge_update_node(existing, args)
                touched = True
        elif name == "delete_nodes":
            ids = _node_id_list(args)
            if ids:
                remove.extend(ids)
                touched = True
        elif name == "hide_nodes":
            for sid in _node_id_list(args):
                existing = delta.get(sid)
                if isinstance(existing, dict):
                    upsert[sid] = _merge_update_node(existing, {"hidden": True})
                    touched = True
        elif name == "create_frame":
            fid = _create_frame(working, args)
            upsert[fid] = working["deltaSetLike"][fid]
            upsert["ROOT"] = working["deltaSetLike"]["ROOT"]
            frames_patch = list(working.get("frames") or [])
            touched = True
        elif name == "update_frame":
            _update_frame(working, args)
            frames_patch = list(working.get("frames") or [])
            touched = True
        elif name == "delete_frame":
            _delete_frame(working, str(args.get("frameId") or args.get("id") or ""))
            frames_patch = list(working.get("frames") or [])
            touched = True
        elif name == "set_canvas_background":
            canvas_patch = dict(working.get("canvas") or {}) if isinstance(working.get("canvas"), dict) else {}
            for key in ("background", "backgroundColor"):
                if args.get(key) is not None:
                    canvas_patch[key] = args[key]
            touched = True

    if not touched:
        return {}

    _finalize_frame_batches(working, created_by_frame=created_by_frame, upsert=upsert)
    if "ROOT" in working.get("deltaSetLike", {}):
        upsert["ROOT"] = working["deltaSetLike"]["ROOT"]

    return _assemble_patch(
        working,
        upsert=upsert,
        remove=remove,
        frames_patch=frames_patch,
        canvas_patch=canvas_patch,
    )
