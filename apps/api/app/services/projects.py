"""User projects — metadata in DB, large documents in COS when enabled."""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from typing import Any

from app.services.db import init_schema
from app.services.storage import get_storage, put_bytes, get_bytes, delete_object

_MAX_INLINE_BYTES = 512 * 1024  # store in DB if small; else COS

_CANVAS_META_KEYS = (
    "x",
    "y",
    "width",
    "height",
    "backgroundColor",
    "backgroundFillType",
    "backgroundGradient",
    "backgroundOpacity",
    "backgroundImageSrc",
    "backgroundImageFit",
    "backgroundImageRotate",
    "backgroundImageAdjust",
)


class ProjectConflictError(Exception):
    """Optimistic concurrency failure — client baseRevision != server revision."""

    def __init__(self, *, project_id: str, revision: int, updated_at_ms: int):
        super().__init__("project_revision_conflict")
        self.project_id = project_id
        self.revision = revision
        self.updated_at_ms = updated_at_ms


class ProjectNotFoundError(Exception):
    def __init__(self, project_id: str):
        super().__init__("project_not_found")
        self.project_id = project_id


class ProjectForbiddenError(Exception):
    def __init__(self, project_id: str = "", *, code: str = "project_forbidden"):
        super().__init__(code)
        self.project_id = project_id
        self.code = code


def _can_write_project(*, user_id: str, row: Any) -> bool:
    if str(getattr(row, "user_id", "") or "") == str(user_id or ""):
        return True
    oid = str(getattr(row, "org_id", None) or "").strip()
    if not oid:
        return False
    from types import SimpleNamespace

    from app.api.deps import user_has_org_permission
    from app.services.auth.orgs import get_org_member_role

    role = get_org_member_role(org_id=oid, user_id=user_id)
    user = SimpleNamespace(id=user_id, role="user", email="")
    return user_has_org_permission(
        user=user,  # type: ignore[arg-type]
        org_id=oid,
        permission="org:project:write",
        member_role=role,
    )


def _require_org_project_write(*, user_id: str, org_id: str) -> None:
    from types import SimpleNamespace

    from app.api.deps import user_has_org_permission
    from app.services.auth.orgs import get_org_member_role

    oid = (org_id or "").strip()
    if not oid:
        raise ProjectForbiddenError("", code="org_id_required")
    role = get_org_member_role(org_id=oid, user_id=user_id)
    user = SimpleNamespace(id=user_id, role="user", email="")
    if not user_has_org_permission(
        user=user,  # type: ignore[arg-type]
        org_id=oid,
        permission="org:project:write",
        member_role=role,
    ):
        raise ProjectForbiddenError("", code="org_permission_denied")


def _project_out_meta(
    row: Any,
    *,
    thumb_key: str | None,
    thumb_custom: bool,
    org_name: str | None = None,
) -> dict[str, Any]:
    oid = getattr(row, "org_id", None)
    return {
        "id": row.id,
        "name": row.name,
        "orgId": str(oid) if oid else None,
        "orgName": org_name,
        "thumbnailUrl": _thumbnail_urls_out(thumb_key),
        "thumbnailCustom": bool(thumb_custom),
        "revision": int(row.revision or 1),
        "updatedAt": int(float(row.updated_at) * 1000),
        "createdAt": int(float(row.created_at) * 1000),
    }


def _org_names_by_id(session: Any, org_ids: list[str]) -> dict[str, str]:
    ids = [str(x).strip() for x in org_ids if str(x or "").strip()]
    if not ids:
        return {}
    from sqlmodel import select

    from app.models import Org

    rows = session.exec(select(Org).where(Org.id.in_(ids))).all()
    return {str(r.id): str(r.name or "") for r in rows if r}


def _decode_document_row(row: Any) -> dict[str, Any] | None:
    doc_json = _row_field(row, "document_json")
    doc_key = _row_field(row, "document_key")
    if doc_json:
        try:
            doc = json.loads(doc_json)
            return doc if isinstance(doc, dict) else None
        except json.JSONDecodeError:
            return None
    if doc_key:
        raw = get_bytes(doc_key)
        if raw:
            try:
                doc = json.loads(raw.decode("utf-8"))
                return doc if isinstance(doc, dict) else None
            except (json.JSONDecodeError, UnicodeDecodeError):
                return None
    return None


def _row_field(row: Any, key: str, default: Any = None) -> Any:
    if isinstance(row, dict):
        return row.get(key, default)
    return getattr(row, key, default)


def _encode_document(
    user_id: str, project_id: str, document: dict[str, Any]
) -> tuple[str | None, str | None]:
    """Return (document_json, document_key) — one of them set."""
    storage = get_storage()
    raw = json.dumps(document, ensure_ascii=False, separators=(",", ":"))
    encoded = raw.encode("utf-8")
    if storage.enabled_remote() and len(encoded) > _MAX_INLINE_BYTES:
        doc_key = f"projects/{user_id}/{project_id}/document.json"
        put_bytes(doc_key, encoded, content_type="application/json")
        return None, doc_key
    return raw, None


def _next_thumbnail(
    user_id: str,
    project_id: str,
    existing_key: str | None,
    *,
    existing_custom: bool,
    mark_custom: bool | None,
    thumbnail_urls: list[str] | None = None,
    document: dict[str, Any] | None = None,
) -> tuple[str | None, bool]:
    """Resolve next thumbnail_key (+ JSON array) and custom flag."""
    if mark_custom is True:
        hosted = _normalize_incoming_urls(thumbnail_urls)
        if hosted:
            _delete_thumb_entries(existing_key)
            return _encode_thumb_entries(hosted), True

    if existing_custom and mark_custom is not False:
        return existing_key, True

    if document is not None and mark_custom is not True:
        auto = _build_auto_cover_key(user_id, project_id, document, existing_key)
        if auto:
            return auto, False
        _delete_thumb_entries(existing_key)
        print(
            f"[projects.thumb] cleared project={project_id} (no cover tiles)",
            flush=True,
        )
        return None, False

    hosted = _normalize_incoming_urls(thumbnail_urls)
    if hosted and mark_custom is not True:
        _delete_thumb_entries(existing_key)
        encoded = _encode_thumb_entries(hosted)
        print(
            f"[projects.thumb] urls ok project={project_id} n={len(hosted)} custom=False",
            flush=True,
        )
        return encoded, False

    if mark_custom is False:
        return existing_key, False
    return existing_key, bool(existing_custom)


def _row_thumb_custom(row: Any) -> bool:
    try:
        return bool(int(_row_field(row, "thumbnail_custom") or 0))
    except (TypeError, ValueError):
        return False


def _parse_thumb_entries(raw: str | None) -> list[str]:
    """Decode thumbnail_key JSON array."""
    text = (raw or "").strip()
    if not text:
        return []
    if text.startswith("["):
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, list):
            out: list[str] = []
            for item in parsed:
                s = str(item or "").strip()
                if s and s not in out:
                    out.append(s)
                if len(out) >= 4:
                    break
            return out
    return []


def _encode_thumb_entries(entries: list[str] | None) -> str | None:
    cleaned: list[str] = []
    for item in entries or []:
        s = str(item or "").strip()
        if s and s not in cleaned:
            cleaned.append(s)
        if len(cleaned) >= 4:
            break
    if not cleaned:
        return None
    encoded = json.dumps(cleaned, ensure_ascii=False)
    # Legacy MySQL VARCHAR(512) — prefer a shorter collage over failing PUT /projects.
    if len(encoded) <= 500:
        return encoded
    for n in range(len(cleaned) - 1, 0, -1):
        trimmed = cleaned[:n]
        if len(trimmed) == 1:
            return trimmed[0]
        again = json.dumps(trimmed, ensure_ascii=False)
        if len(again) <= 500:
            return again
    return cleaned[0][:500] if cleaned else None


def _is_project_owned_thumb_key(entry: str) -> bool:
    text = (entry or "").strip()
    if not text or text.startswith("http://") or text.startswith("https://"):
        return False
    return text.startswith("projects/") and "/thumb" in text


def _delete_thumb_entries(raw: str | None) -> None:
    for entry in _parse_thumb_entries(raw):
        if _is_project_owned_thumb_key(entry):
            try:
                delete_object(entry)
            except Exception:
                pass


def _prune_thumb_entries(raw: str | None, keep: list[str]) -> None:
    """Drop owned thumb objects that are no longer referenced."""
    keep_set = {str(k).strip() for k in keep if str(k or "").strip()}
    for entry in _parse_thumb_entries(raw):
        if entry in keep_set:
            continue
        if _is_project_owned_thumb_key(entry):
            try:
                delete_object(entry)
            except Exception:
                pass


def _thumbnail_urls_out(raw: str | None) -> list[str]:
    """Public list of cover URLs (always an array for C-end collage)."""
    out: list[str] = []
    for entry in _parse_thumb_entries(raw):
        url = _url(entry)
        if url:
            out.append(url)
    return out


def _reconcile_stale_auto_covers(
    session: Any,
    user_id: str,
    row: Any,
) -> tuple[str | None, bool]:
    """If auto covers exist but the document has no cover tiles, clear them.

    Fixes rows written before PATCH rebuilt covers from the live document.
    Never raise — list/get must not 500 because one row's cover reconcile failed.
    """
    thumb_key = getattr(row, "thumbnail_key", None)
    custom = _row_thumb_custom(row)
    try:
        if custom or not (thumb_key or "").strip():
            return thumb_key, custom
        doc = _decode_document_row(row)
        if not isinstance(doc, dict):
            return thumb_key, custom
        if _cov_pick_nodes(doc):
            return thumb_key, custom
        _delete_thumb_entries(thumb_key)
        now = time.time()
        from app import crud

        crud.update_project_covers(
            session=session,
            user_id=user_id,
            project_id=str(row.id),
            thumbnail_key=None,
            thumbnail_custom=False,
            updated_at=now,
        )
        print(
            f"[projects.thumb] reconcile cleared project={row.id} (doc has no cover tiles)",
            flush=True,
        )
        return None, False
    except Exception as exc:
        print(
            f"[projects.thumb] reconcile skip project={getattr(row, 'id', '?')} err={exc!r}",
            flush=True,
        )
        return thumb_key, custom


def _normalize_incoming_urls(urls: list[str] | None) -> list[str]:
    out: list[str] = []
    for item in urls or []:
        s = str(item or "").strip()
        if not s or s.startswith("data:"):
            continue
        if s not in out:
            out.append(s)
        if len(out) >= 4:
            break
    return out


_MAX_COVER_TILES = 4
_COVER_EDGE = 360
_MIN_COVER_EDGE = 40


def _cov_json_list(raw: Any) -> list[Any]:
    if isinstance(raw, list):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return []
        return parsed if isinstance(parsed, list) else []
    return []


def _cov_plain_text(attrs: dict[str, Any]) -> str:
    origin_lines: list[str] = []
    for block in _cov_json_list(attrs.get("ORIGIN_DATA")):
        if not isinstance(block, dict):
            continue
        children = block.get("children")
        if not isinstance(children, list):
            continue
        origin_lines.append(
            "".join(str(c.get("text") or "") for c in children if isinstance(c, dict))
        )
    origin = "\n".join(part for part in origin_lines if part)
    if origin:
        return origin
    data_lines: list[str] = []
    for run in _cov_json_list(attrs.get("DATA")):
        if not isinstance(run, dict):
            continue
        chars = run.get("chars")
        if not isinstance(chars, list):
            continue
        data_lines.append(
            "".join(str(item.get("char") or "") for item in chars if isinstance(item, dict))
        )
    data = "\n".join(data_lines)
    if data:
        return data
    md = attrs.get("markdown")
    if isinstance(md, str) and md.strip():
        return md.strip()
    return ""


def _cov_num(value: Any, fallback: float = 0.0) -> float:
    try:
        n = float(value)
        return n if n == n and abs(n) != float("inf") else fallback
    except (TypeError, ValueError):
        return fallback


def _cov_parse_rgba(raw: Any) -> tuple[int, int, int, int] | None:
    """Parse #RGB / #RRGGBB / #RRGGBBAA / rgba() → RGBA 0–255. Skip transparent/none."""
    text = str(raw or "").strip()
    if not text or text.lower() in ("none", "transparent"):
        return None
    if text.startswith("#"):
        h = text[1:]
        if len(h) == 3 and all(c in "0123456789abcdefABCDEF" for c in h):
            r, g, b = (int(c * 2, 16) for c in h)
            return r, g, b, 255
        if len(h) == 6 and all(c in "0123456789abcdefABCDEF" for c in h):
            return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 255
        if len(h) == 8 and all(c in "0123456789abcdefABCDEF" for c in h):
            return (
                int(h[0:2], 16),
                int(h[2:4], 16),
                int(h[4:6], 16),
                int(h[6:8], 16),
            )
        return None
    lower = text.lower()
    if lower.startswith("rgba(") or lower.startswith("rgb("):
        inner = text[text.find("(") + 1 : text.rfind(")")]
        parts = [p.strip() for p in inner.split(",")]
        if len(parts) < 3:
            return None
        try:
            r = int(float(parts[0]))
            g = int(float(parts[1]))
            b = int(float(parts[2]))
            a = 255
            if len(parts) >= 4:
                af = float(parts[3])
                a = int(round(af * 255)) if af <= 1.0 else int(round(af))
            return max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b)), max(
                0, min(255, a)
            )
        except (TypeError, ValueError):
            return None
    return None


def _cov_attr_flag(attrs: dict[str, Any], key: str) -> bool:
    v = attrs.get(key)
    if v is True or v == 1:
        return True
    if isinstance(v, str) and v.strip().lower() in ("1", "true", "yes"):
        return True
    return False


def _cov_has_visual(node: dict[str, Any]) -> bool:
    if not isinstance(node, dict):
        return False
    attrs = node.get("attrs") if isinstance(node.get("attrs"), dict) else {}
    if _cov_attr_flag(attrs, "hidden"):
        return False
    if str(attrs.get("processStatus") or "") == "running":
        return False
    key = str(node.get("key") or "")
    if key == "image" and _cov_attr_flag(attrs, "imageGenerator"):
        return False
    if key == "video" and _cov_attr_flag(attrs, "videoGenerator"):
        return False
    if key == "lottie" and _cov_attr_flag(attrs, "lottieGenerator"):
        return False
    if key == "audio" and _cov_attr_flag(attrs, "audioGenerator"):
        return False
    if key in ("image", "video", "lottie"):
        src = str(attrs.get("src") or "").strip()
        poster = str(attrs.get("poster") or "").strip()
        return bool(src or poster)
    if key == "audio":
        return bool(str(attrs.get("src") or "").strip())
    if key in ("shape", "rect", "text", "svg", "path"):
        return True
    return False


def _cov_type_rank(key: str) -> int:
    if key in ("image", "video"):
        return 0
    if key in ("lottie", "audio"):
        return 1
    if key in ("shape", "rect", "svg", "path"):
        return 2
    if key == "text":
        return 3
    return 4


def _cov_pick_nodes(document: dict[str, Any]) -> list[dict[str, Any]]:
    """Up to 4 latest visual elements — image-first, then area, then z (children order)."""
    delta = document.get("deltaSetLike")
    if not isinstance(delta, dict):
        return []
    start_ids = _cov_page_child_ids(document, delta)
    ranked: list[tuple[int, float, int, dict[str, Any]]] = []
    _cov_collect_visual_nodes(delta, start_ids, ranked, z_offset=0)
    ranked.sort(key=lambda t: (t[0], -t[1], -t[2]))
    return [t[3] for t in ranked[:_MAX_COVER_TILES]]


def _cov_page_child_ids(document: dict[str, Any], delta: dict[str, Any]) -> list[str]:
    pages = document.get("pages")
    if isinstance(pages, list) and pages:
        page0 = pages[0]
        if isinstance(page0, dict) and isinstance(page0.get("children"), list):
            kids = [str(c).strip() for c in page0["children"] if str(c or "").strip()]
            if kids:
                return kids
    raw = document.get("pageChildren")
    if isinstance(raw, list) and raw:
        return [str(c).strip() for c in raw if str(c or "").strip()]
    root = delta.get("ROOT")
    children = root.get("children") if isinstance(root, dict) else None
    if isinstance(children, list):
        return [str(c).strip() for c in children if str(c or "").strip()]
    return []


def _cov_collect_visual_nodes(
    delta: dict[str, Any],
    node_ids: list[str],
    ranked: list[tuple[int, float, int, dict[str, Any]]],
    *,
    z_offset: int,
) -> None:
    for z, nid in enumerate(node_ids):
        node = delta.get(str(nid))
        if not isinstance(node, dict):
            continue
        key = str(node.get("key") or "")
        if key == "frame":
            kids = node.get("children")
            if isinstance(kids, list) and kids:
                child_ids = [str(c).strip() for c in kids if str(c or "").strip()]
                _cov_collect_visual_nodes(
                    delta, child_ids, ranked, z_offset=z_offset + z + 1
                )
            continue
        if not _cov_has_visual(node):
            continue
        w = max(1.0, _cov_num(node.get("width"), 1))
        h = max(1.0, _cov_num(node.get("height"), 1))
        if min(w, h) < _MIN_COVER_EDGE and w * h < _MIN_COVER_EDGE * _MIN_COVER_EDGE:
            continue
        ranked.append((_cov_type_rank(key), w * h, z_offset + z, {**node, "id": str(nid)}))


def _cov_media_src(node: dict[str, Any]) -> str | None:
    attrs = node.get("attrs") if isinstance(node.get("attrs"), dict) else {}
    for key in ("src", "poster"):
        s = str(attrs.get(key) or "").strip()
        if s and not s.startswith("data:"):
            return s
    return None


def _cov_fetch_media_bytes(src: str) -> bytes | None:
    from app.services.assets import _fetch_bytes

    try:
        data, _ctype = _fetch_bytes(src)
        return data if data and len(data) >= 8 else None
    except Exception:
        return None


def _cov_raster_image(node: dict[str, Any]) -> bytes | None:
    """Host image tiles on storage — avoids CORS/auth issues with raw src URLs."""
    src = _cov_media_src(node)
    if not src:
        return None
    raw = _cov_fetch_media_bytes(src)
    if not raw:
        return None
    try:
        from io import BytesIO

        from PIL import Image
    except Exception:
        return None
    attrs = node.get("attrs") if isinstance(node.get("attrs"), dict) else {}
    try:
        with Image.open(BytesIO(raw)) as im:
            im = im.convert("RGBA")
            crop_x = _cov_num(attrs.get("cropX"), -1)
            crop_y = _cov_num(attrs.get("cropY"), -1)
            crop_w = _cov_num(attrs.get("cropW"), -1)
            crop_h = _cov_num(attrs.get("cropH"), -1)
            if crop_w > 0 and crop_h > 0:
                iw, ih = im.size
                left = max(0, min(iw - 1, int(round(crop_x * iw))))
                top = max(0, min(ih - 1, int(round(crop_y * ih))))
                right = max(left + 1, min(iw, int(round((crop_x + crop_w) * iw))))
                bottom = max(top + 1, min(ih, int(round((crop_y + crop_h) * ih))))
                im = im.crop((left, top, right, bottom))
            w, h = im.size
            if w < 1 or h < 1:
                return None
            scale = min(1.0, float(_COVER_EDGE) / max(w, h))
            out_w = max(32, int(round(w * scale)))
            out_h = max(32, int(round(h * scale)))
            if scale < 1.0:
                im = im.resize((out_w, out_h), Image.Resampling.LANCZOS)
            rgb = Image.new("RGB", im.size, (255, 255, 255))
            rgb.paste(im, mask=im.split()[3] if im.mode == "RGBA" else None)
            buf = BytesIO()
            rgb.save(buf, format="WEBP", quality=82, method=4)
            return buf.getvalue()
    except Exception:
        return None


def _cov_put_tile_bytes(
    user_id: str,
    project_id: str,
    blob: bytes | None,
    *,
    index: int,
    ext: str = "webp",
    digest: str | None = None,
) -> str | None:
    if not blob:
        return None
    suffix = f"-{index}" if index else ""
    key_part = (digest or "").strip() or str(int(time.time() * 1000))
    content_type = "image/webp" if ext == "webp" else f"image/{ext}"
    thumb_key = f"projects/{user_id}/{project_id}/thumb-{key_part}{suffix}.{ext}"
    try:
        put_bytes(
            thumb_key,
            blob,
            content_type=content_type,
            cache_control="no-cache, max-age=0, must-revalidate",
        )
        return thumb_key
    except Exception:
        return None


def _cov_node_cover_digest(node: dict[str, Any], blob: bytes | None) -> str:
    """Stable id for raster tiles — same pixels → same storage key."""
    parts = [
        str(node.get("id") or ""),
        str(node.get("key") or ""),
        str(_cov_num(node.get("width"), 0)),
        str(_cov_num(node.get("height"), 0)),
    ]
    attrs = node.get("attrs") if isinstance(node.get("attrs"), dict) else {}
    for key in ("fill-color", "fill", "shapeType", "border-color", "border-width"):
        if key in attrs:
            parts.append(f"{key}={attrs[key]}")
    for key in ("src", "uploadKey", "cropX", "cropY", "cropW", "cropH", "opacity"):
        if key in attrs:
            parts.append(f"{key}={attrs[key]}")
    if node.get("fill"):
        parts.append(f"fill={node.get('fill')}")
    if blob:
        parts.append(hashlib.sha256(blob).hexdigest()[:16])
    return hashlib.sha256("|".join(parts).encode()).hexdigest()[:16]


def _cov_raster_shape(node: dict[str, Any]) -> bytes | None:
    """Pillow tile for shape/rect — edge-to-edge fill/stroke (no letterbox margin)."""
    try:
        from io import BytesIO

        from PIL import Image, ImageDraw
    except Exception:
        return None

    attrs = node.get("attrs") if isinstance(node.get("attrs"), dict) else {}
    w = max(1.0, _cov_num(node.get("width"), 1))
    h = max(1.0, _cov_num(node.get("height"), 1))
    scale = min(1.0, float(_COVER_EDGE) / max(w, h))
    out_w = max(32, int(round(w * scale)))
    out_h = max(32, int(round(h * scale)))

    fill = _cov_parse_rgba(
        attrs.get("fill-color") or attrs.get("fill") or node.get("fill")
    )
    stroke = _cov_parse_rgba(attrs.get("border-color") or node.get("stroke"))
    sw_raw = attrs.get("border-width")
    stroke_w = max(0.0, _cov_num(sw_raw, 0)) * scale
    if stroke is None and stroke_w <= 0:
        stroke = (51, 51, 51, 255)
        stroke_w = max(1.5, 2.0 * scale)

    key = str(node.get("key") or "")
    shape_type = str(attrs.get("shapeType") or "").lower()
    if not shape_type and key == "rect":
        shape_type = "rect"
    if not shape_type:
        shape_type = "rect"

    # Edge-to-edge tile — list cards use object-cover; no white letterbox margin.
    img = Image.new("RGBA", (out_w, out_h), (255, 255, 255, 255))
    draw = ImageDraw.Draw(img)
    x0, y0 = 0.0, 0.0
    x1, y1 = float(out_w - 1), float(out_h - 1)
    fill_c = fill  # may be None → outline only
    stroke_c = stroke if stroke_w > 0 else None
    outline_w = max(1, int(round(stroke_w))) if stroke_c else 0

    is_ellipse = shape_type in ("circle", "ellipse", "oval")
    if is_ellipse:
        if fill_c:
            draw.ellipse([x0, y0, x1, y1], fill=fill_c)
        if stroke_c and outline_w:
            draw.ellipse([x0, y0, x1, y1], outline=stroke_c, width=outline_w)
        if not fill_c and not stroke_c:
            draw.ellipse([x0, y0, x1, y1], outline=(51, 51, 51, 255), width=2)
    else:
        # rect / polygon / triangle / star → bounding rect (best-effort)
        if fill_c:
            draw.rectangle([x0, y0, x1, y1], fill=fill_c)
        if stroke_c and outline_w:
            draw.rectangle([x0, y0, x1, y1], outline=stroke_c, width=outline_w)
        if not fill_c and not stroke_c:
            draw.rectangle([x0, y0, x1, y1], outline=(51, 51, 51, 255), width=2)

    buf = BytesIO()
    img.convert("RGB").save(buf, format="WEBP", quality=82, method=4)
    return buf.getvalue()


def _cov_raster_text(node: dict[str, Any]) -> bytes | None:
    try:
        from io import BytesIO

        from PIL import Image, ImageDraw, ImageFont
    except Exception:
        return None
    attrs = node.get("attrs") if isinstance(node.get("attrs"), dict) else {}
    text = _cov_plain_text(attrs).strip()
    if not text:
        return None
    w = max(64.0, _cov_num(node.get("width"), 160))
    h = max(40.0, _cov_num(node.get("height"), 48))
    scale = min(1.0, float(_COVER_EDGE) / max(w, h))
    out_w = max(48, int(round(w * scale)))
    out_h = max(32, int(round(h * scale)))
    fill = _cov_parse_rgba(attrs.get("fill-color")) or (30, 30, 30, 255)
    img = Image.new("RGB", (out_w, out_h), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.load_default()
    except Exception:
        font = None
    draw.text((8, 8), text[:80], fill=fill[:3], font=font)
    buf = BytesIO()
    img.save(buf, format="WEBP", quality=82, method=4)
    return buf.getvalue()


def _cov_tile_for_node(
    user_id: str,
    project_id: str,
    node: dict[str, Any],
    *,
    index: int,
    existing_entries: list[str] | None = None,
) -> str | None:
    """Return hosted URL or uploaded thumb key for one element tile."""
    existing = existing_entries or []
    suffix = f"-{index}" if index else ""
    key = str(node.get("key") or "")
    if key == "image":
        blob = _cov_raster_image(node)
        if blob:
            digest = _cov_node_cover_digest(node, blob)
            thumb_key = f"projects/{user_id}/{project_id}/thumb-{digest}{suffix}.webp"
            if thumb_key in existing:
                return thumb_key
            return _cov_put_tile_bytes(
                user_id, project_id, blob, index=index, digest=digest
            )
        return None
    if key in ("video", "lottie", "audio"):
        src = _cov_media_src(node)
        return src
    blob: bytes | None = None
    if key in ("shape", "rect", "path"):
        blob = _cov_raster_shape(node)
    elif key == "text":
        blob = _cov_raster_text(node)
    elif key == "svg":
        blob = _cov_raster_shape(
            {
                **node,
                "attrs": {
                    **(node.get("attrs") if isinstance(node.get("attrs"), dict) else {}),
                    "shapeType": "rect",
                    "fill": "#E8E8E8",
                },
            }
        )
    if not blob:
        return None
    digest = _cov_node_cover_digest(node, blob)
    thumb_key = f"projects/{user_id}/{project_id}/thumb-{digest}{suffix}.webp"
    if thumb_key in existing:
        return thumb_key
    return _cov_put_tile_bytes(
        user_id, project_id, blob, index=index, digest=digest
    )


def _build_auto_cover_key(
    user_id: str,
    project_id: str,
    document: dict[str, Any] | None,
    existing_key: str | None,
) -> str | None:
    """Build ≤4 cover tiles from the latest visual elements in ``document``."""
    if not isinstance(document, dict):
        return None
    nodes = _cov_pick_nodes(document)
    if not nodes:
        return None
    existing_entries = _parse_thumb_entries(existing_key)
    entries: list[str] = []
    for i, node in enumerate(nodes):
        entry = _cov_tile_for_node(
            user_id, project_id, node, index=i, existing_entries=existing_entries
        )
        if entry and entry not in entries:
            entries.append(entry)
        if len(entries) >= _MAX_COVER_TILES:
            break
    if not entries:
        return None
    encoded = _encode_thumb_entries(entries)
    prev = (existing_key or "").strip()
    if encoded and encoded == prev:
        return existing_key
    _prune_thumb_entries(existing_key, entries)
    print(
        f"[projects.thumb] auto ok project={project_id} n={len(entries)}",
        flush=True,
    )
    return encoded


def _ensure_delta_root(doc: dict[str, Any]) -> dict[str, Any]:
    delta = doc.get("deltaSetLike")
    if not isinstance(delta, dict):
        delta = {}
        doc["deltaSetLike"] = delta
    if "ROOT" not in delta or not isinstance(delta.get("ROOT"), dict):
        delta["ROOT"] = {"id": "ROOT", "key": "entry", "children": []}
    return delta


def _apply_remove_nodes(delta: dict[str, Any], remove_ids: Any) -> None:
    if not isinstance(remove_ids, list):
        return
    for nid in remove_ids:
        sid = str(nid or "").strip()
        if not sid or sid == "ROOT":
            continue
        delta.pop(sid, None)


def _apply_upsert_nodes(delta: dict[str, Any], upsert: Any) -> None:
    if not isinstance(upsert, dict):
        return
    for nid, node in upsert.items():
        sid = str(nid or "").strip()
        if not sid or sid == "ROOT":
            continue
        if isinstance(node, dict):
            delta[sid] = node


def _normalize_page_children(raw_children: Any, delta: dict[str, Any]) -> list[str]:
    children: list[str] = []
    if not isinstance(raw_children, list):
        return children
    seen: set[str] = set()
    for c in raw_children:
        cid = str(c or "").strip()
        if not cid or cid == "ROOT" or cid in seen or cid not in delta:
            continue
        seen.add(cid)
        children.append(cid)
    return children


def _apply_page_children(doc: dict[str, Any], delta: dict[str, Any], patch: dict[str, Any]) -> None:
    if "pageChildren" not in patch or patch["pageChildren"] is None:
        return
    children = _normalize_page_children(patch["pageChildren"], delta)
    pages = doc.get("pages")
    if not isinstance(pages, list) or not pages:
        pages = [{"id": "page_1", "children": children}]
        doc["pages"] = pages
    else:
        page0 = pages[0] if isinstance(pages[0], dict) else {"id": "page_1"}
        page0 = {**page0, "children": children}
        pages = [page0, *[p for p in pages[1:] if isinstance(p, dict)]]
        doc["pages"] = pages
    doc["activePageId"] = str(pages[0].get("id") or "page_1")
    root = delta.get("ROOT")
    if isinstance(root, dict):
        root["children"] = list(children)
        delta["ROOT"] = root


def _apply_frames_patch(doc: dict[str, Any], patch: dict[str, Any]) -> None:
    if "frames" in patch and patch["frames"] is not None:
        frames = patch["frames"]
        doc["frames"] = frames if isinstance(frames, list) else []
    if "activeFrameId" in patch:
        af = patch["activeFrameId"]
        doc["activeFrameId"] = None if af is None else str(af)


def _apply_canvas_meta(doc: dict[str, Any], patch: dict[str, Any]) -> None:
    canvas = patch.get("canvas")
    if not isinstance(canvas, dict):
        return
    for key in _CANVAS_META_KEYS:
        if key in canvas:
            doc[key] = canvas[key]


def _node_bound_to_frame(delta: dict[str, Any], node_id: str) -> bool:
    node = delta.get(node_id)
    if not isinstance(node, dict):
        return False
    attrs = node.get("attrs")
    if not isinstance(attrs, dict):
        return False
    return bool(str(attrs.get("frameId") or "").strip())


def _reconcile_stack_order(doc: dict[str, Any], delta: dict[str, Any]) -> None:
    """Drop deleted stack keys; append newly upserted nodes/frames."""
    pages = doc.get("pages")
    node_ids: list[str] = []
    if isinstance(pages, list) and pages and isinstance(pages[0], dict):
        kids = pages[0].get("children")
        if isinstance(kids, list):
            node_ids = [str(x) for x in kids if str(x or "").strip()]
    if not node_ids:
        root = delta.get("ROOT")
        if isinstance(root, dict) and isinstance(root.get("children"), list):
            node_ids = [str(x) for x in root["children"] if str(x or "").strip()]
    # Frame-bound nodes render via attrs.frameId; they never get world stack slots.
    node_ids = [nid for nid in node_ids if not _node_bound_to_frame(delta, nid)]
    node_set = set(node_ids)
    frame_ids: list[str] = []
    frames = doc.get("frames")
    if isinstance(frames, list):
        for frame in frames:
            if not isinstance(frame, dict):
                continue
            fid = str(frame.get("id") or "").strip()
            if fid:
                frame_ids.append(fid)
    frame_set = set(frame_ids)
    kept: list[str] = []
    seen: set[str] = set()
    raw = doc.get("stackOrder")
    if isinstance(raw, list):
        for key in raw:
            item = str(key or "")
            if not item or item in seen:
                continue
            if item.startswith("node:") and item[5:] in node_set:
                seen.add(item)
                kept.append(item)
            elif item.startswith("frame:") and item[6:] in frame_set:
                seen.add(item)
                kept.append(item)
    for fid in frame_ids:
        key = f"frame:{fid}"
        if key not in seen:
            kept.append(key)
            seen.add(key)
    for nid in node_ids:
        key = f"node:{nid}"
        if key not in seen:
            kept.append(key)
            seen.add(key)
    doc["stackOrder"] = kept


def apply_document_patch(base: dict[str, Any] | None, patch: dict[str, Any]) -> dict[str, Any]:
    """Merge node-level patch into a document dict (mutates a shallow copy tree)."""
    import copy

    doc: dict[str, Any] = copy.deepcopy(base) if isinstance(base, dict) else {}
    delta = _ensure_delta_root(doc)
    _apply_remove_nodes(delta, patch.get("removeNodeIds") or [])
    _apply_upsert_nodes(delta, patch.get("upsertNodes") or {})
    _apply_page_children(doc, delta, patch)
    _apply_frames_patch(doc, patch)
    _apply_canvas_meta(doc, patch)
    _reconcile_stack_order(doc, delta)
    return doc


def _patch_touches_document(patch: dict[str, Any] | None) -> bool:
    """True when the patch mutates canvas/document (not rename-only)."""
    if not patch:
        return False
    if patch.get("upsertNodes") or patch.get("removeNodeIds"):
        return True
    if patch.get("pageChildren") is not None:
        return True
    if patch.get("frames") is not None:
        return True
    if "activeFrameId" in patch:
        return True
    if patch.get("canvas") is not None:
        return True
    return False


def patch_project(
    user_id: str,
    project_id: str,
    *,
    name: str | None = None,
    patch: dict[str, Any],
    thumbnail_urls: list[str] | None = None,
    thumbnail_custom: bool | None = None,
    base_revision: int | None = None,
) -> dict[str, Any]:
    """Apply incremental document patch under optimistic concurrency."""
    from sqlmodel import Session

    from app import crud
    from app.core.db import engine

    init_schema()
    pid = (project_id or "").strip()
    if not pid:
        raise ProjectNotFoundError("")
    now = time.time()

    with Session(engine) as session:
        existing = crud.get_project_accessible(
            session=session, user_id=user_id, project_id=pid
        )
        if not existing:
            raise ProjectNotFoundError(pid)
        if not _can_write_project(user_id=user_id, row=existing):
            raise ProjectForbiddenError(pid)

        cur_rev = int(existing.revision or 1)
        if base_revision is None or int(base_revision) != cur_rev:
            raise ProjectConflictError(
                project_id=pid,
                revision=cur_rev,
                updated_at_ms=int(float(existing.updated_at) * 1000),
            )

        base_doc = _decode_document_row(existing)
        if base_doc is None and (existing.document_json or existing.document_key):
            raise ProjectConflictError(
                project_id=pid,
                revision=cur_rev,
                updated_at_ms=int(float(existing.updated_at) * 1000),
            )
        merged = apply_document_patch(base_doc, patch or {})
        # Encode under document owner id so COS keys stay stable for org collaborators.
        owner_id = str(existing.user_id or user_id)
        doc_json, doc_key = _encode_document(owner_id, pid, merged)
        next_rev = cur_rev + 1
        name_n = (
            (name or "").strip()[:255]
            if name is not None and str(name).strip()
            else str(existing.name or "Untitled")
        )
        # Rebuild covers only when the patch changes document content.
        touch_doc = _patch_touches_document(patch or {})
        try:
            thumb_key, thumb_custom = _next_thumbnail(
                owner_id,
                pid,
                existing.thumbnail_key,
                existing_custom=_row_thumb_custom(existing),
                mark_custom=thumbnail_custom,
                thumbnail_urls=thumbnail_urls,
                document=merged if touch_doc else None,
            )
        except Exception as exc:
            print(
                f"[projects.thumb] patch keep existing project={pid} err={exc!r}",
                flush=True,
            )
            thumb_key, thumb_custom = existing.thumbnail_key, _row_thumb_custom(
                existing
            )
        old_key = existing.document_key
        created_at = float(existing.created_at)
        org_id_out = getattr(existing, "org_id", None)

        ok = crud.update_project_if_revision_accessible(
            session=session,
            project_id=pid,
            expected_revision=cur_rev,
            values={
                "name": name_n,
                "thumbnail_key": thumb_key,
                "thumbnail_custom": 1 if thumb_custom else 0,
                "document_key": doc_key,
                "document_json": doc_json,
                "revision": next_rev,
                "updated_at": now,
            },
        )
        if not ok:
            latest = crud.get_project_accessible(
                session=session, user_id=user_id, project_id=pid
            )
            raise ProjectConflictError(
                project_id=pid,
                revision=int((latest.revision if latest else cur_rev) or cur_rev),
                updated_at_ms=int(
                    float((latest.updated_at if latest else existing.updated_at)) * 1000
                ),
            )

    if old_key and old_key != doc_key:
        delete_object(old_key)

    # Keep linked share snapshots warm (same as upsert) — PATCH used to skip this.
    try:
        from app.services.shares.store import sync_project_share_documents

        sync_project_share_documents(
            owner_id=owner_id, project_id=pid, document=merged
        )
    except Exception:
        pass

    return {
        "id": pid,
        "name": name_n,
        "orgId": str(org_id_out) if org_id_out else None,
        "thumbnailUrl": _thumbnail_urls_out(thumb_key),
        "thumbnailCustom": bool(thumb_custom),
        "revision": next_rev,
        "updatedAt": int(now * 1000),
        "createdAt": int(created_at * 1000),
    }


def list_projects(
    user_id: str,
    *,
    page: int = 1,
    page_size: int = 24,
    org_id: str | None = None,
) -> dict[str, Any]:
    from sqlmodel import Session

    from app import crud
    from app.core.db import engine

    init_schema()
    page_n = max(1, int(page or 1))
    page_size_n = max(1, min(int(page_size or 24), 100))
    offset = (page_n - 1) * page_size_n
    with Session(engine) as session:
        total = crud.count_projects_accessible(
            session=session, user_id=user_id, org_id=org_id
        )
        rows = crud.list_projects_accessible(
            session=session,
            user_id=user_id,
            offset=offset,
            limit=page_size_n,
            org_id=org_id,
        )
        projects: list[dict[str, Any]] = []
        org_ids = [
            str(r.org_id)
            for r in rows
            if getattr(r, "org_id", None)
        ]
        names = _org_names_by_id(session, org_ids)
        for r in rows:
            thumb_key, thumb_custom = _reconcile_stale_auto_covers(
                session, str(r.user_id or user_id), r
            )
            oid = str(getattr(r, "org_id", None) or "") or None
            item = _project_out_meta(
                r,
                thumb_key=thumb_key,
                thumb_custom=thumb_custom,
                org_name=names.get(oid) if oid else None,
            )
            item["hasDocument"] = bool(r.document_key or r.document_json)
            projects.append(item)
    return {
        "projects": projects,
        "page": page_n,
        "pageSize": page_size_n,
        "total": total,
        "hasMore": offset + len(projects) < total,
    }


def get_project(user_id: str, project_id: str) -> dict[str, Any] | None:
    from sqlmodel import Session

    from app import crud
    from app.core.db import engine

    init_schema()
    with Session(engine) as session:
        row = crud.get_project_accessible(
            session=session, user_id=user_id, project_id=project_id
        )
        if not row:
            return None
        thumb_key, thumb_custom = _reconcile_stale_auto_covers(
            session, str(row.user_id or user_id), row
        )
        document = _decode_document_row(row)
        oid = str(getattr(row, "org_id", None) or "") or None
        names = _org_names_by_id(session, [oid] if oid else [])
        out = _project_out_meta(
            row,
            thumb_key=thumb_key,
            thumb_custom=thumb_custom,
            org_name=names.get(oid) if oid else None,
        )
        out["document"] = document
        return out


def set_project_org(
    user_id: str,
    project_id: str,
    *,
    org_id: str | None,
) -> dict[str, Any]:
    """Attach / detach project to an org (owner or org:project:write). Does not bump revision."""
    from sqlmodel import Session

    from app import crud
    from app.core.db import engine
    from app.models import Project

    init_schema()
    pid = (project_id or "").strip()
    if not pid:
        raise ProjectNotFoundError("")
    want = (org_id or "").strip() or None

    with Session(engine) as session:
        existing = crud.get_project_accessible(
            session=session, user_id=user_id, project_id=pid
        )
        if not existing:
            raise ProjectNotFoundError(pid)
        # Only the personal owner (or org writer already on the project) may move it.
        is_owner = str(existing.user_id or "") == str(user_id or "")
        if not is_owner and not _can_write_project(user_id=user_id, row=existing):
            raise ProjectForbiddenError(pid)
        if want:
            _require_org_project_write(user_id=user_id, org_id=want)
        elif not is_owner:
            # Detach: require owner (org members shouldn't orphan owner's project).
            raise ProjectForbiddenError(pid, code="owner_required_to_detach")

        now = time.time()
        from sqlalchemy import update as sa_update

        session.execute(
            sa_update(Project)
            .where(Project.id == pid)
            .values(org_id=want, updated_at=now)
        )
        session.commit()

        row = session.get(Project, pid)
        if not row:
            raise ProjectNotFoundError(pid)
        names = _org_names_by_id(session, [want] if want else [])
        return _project_out_meta(
            row,
            thumb_key=row.thumbnail_key,
            thumb_custom=_row_thumb_custom(row),
            org_name=names.get(want) if want else None,
        )


def upsert_project(
    user_id: str,
    *,
    project_id: str | None,
    name: str,
    document: dict[str, Any] | None,
    thumbnail_urls: list[str] | None = None,
    thumbnail_custom: bool | None = None,
    base_revision: int | None = None,
    org_id: str | None = None,
) -> dict[str, Any]:
    from sqlmodel import Session

    from app import crud
    from app.core.db import engine
    from app.models import Project

    init_schema()
    pid = (project_id or "").strip() or f"proj_{uuid.uuid4().hex[:16]}"
    name_n = (name or "").strip()[:255] or "Untitled"
    now = time.time()
    want_org = (org_id or "").strip() or None

    doc_json: str | None = None
    doc_key: str | None = None
    if document is not None:
        doc_json, doc_key = _encode_document(user_id, pid, document)

    with Session(engine) as session:
        existing = crud.get_project_accessible(
            session=session, user_id=user_id, project_id=pid
        )
        if existing:
            if not _can_write_project(user_id=user_id, row=existing):
                raise ProjectForbiddenError(pid)
            owner_id = str(existing.user_id or user_id)
            if document is not None:
                doc_json, doc_key = _encode_document(owner_id, pid, document)
            cur_rev = int(existing.revision or 1)
            if base_revision is not None and int(base_revision) != cur_rev:
                raise ProjectConflictError(
                    project_id=pid,
                    revision=cur_rev,
                    updated_at_ms=int(float(existing.updated_at) * 1000),
                )
            next_rev = cur_rev + 1
            next_doc_key = doc_key if document is not None else existing.document_key
            next_doc_json = doc_json if document is not None else existing.document_json
            if document is not None and doc_json is not None:
                next_doc_key = None
            if document is not None and next_doc_key:
                next_doc_json = None
            try:
                next_thumb, next_custom = _next_thumbnail(
                    owner_id,
                    pid,
                    existing.thumbnail_key,
                    existing_custom=_row_thumb_custom(existing),
                    mark_custom=thumbnail_custom,
                    thumbnail_urls=thumbnail_urls,
                    document=document,
                )
            except Exception as exc:
                # Cover rebuild must not block document save (COS / URL collage).
                print(
                    f"[projects.thumb] upsert keep existing project={pid} err={exc!r}",
                    flush=True,
                )
                next_thumb, next_custom = existing.thumbnail_key, _row_thumb_custom(
                    existing
                )
            old_doc_key = existing.document_key
            ok = crud.update_project_if_revision_accessible(
                session=session,
                project_id=pid,
                expected_revision=cur_rev,
                values={
                    "name": name_n,
                    "thumbnail_key": next_thumb,
                    "thumbnail_custom": 1 if next_custom else 0,
                    "document_key": next_doc_key,
                    "document_json": next_doc_json,
                    "revision": next_rev,
                    "updated_at": now,
                },
            )
            if not ok:
                latest = crud.get_project_accessible(
                    session=session, user_id=user_id, project_id=pid
                )
                raise ProjectConflictError(
                    project_id=pid,
                    revision=int((latest.revision if latest else cur_rev) or cur_rev),
                    updated_at_ms=int(
                        float((latest.updated_at if latest else existing.updated_at))
                        * 1000
                    ),
                )
            if (
                document is not None
                and old_doc_key
                and old_doc_key != next_doc_key
            ):
                delete_object(old_doc_key)
            created = float(existing.created_at)
            revision = next_rev
            thumb_key = next_thumb
            thumb_custom = next_custom
            org_id_out = getattr(existing, "org_id", None)
        else:
            # Creating a new id — deny if another user's project already occupies it.
            occupied = session.get(Project, pid)
            if occupied:
                raise ProjectForbiddenError(pid)
            if want_org:
                _require_org_project_write(user_id=user_id, org_id=want_org)
            try:
                thumb_key, thumb_custom = _next_thumbnail(
                    user_id,
                    pid,
                    None,
                    existing_custom=False,
                    mark_custom=thumbnail_custom,
                    thumbnail_urls=thumbnail_urls,
                    document=document,
                )
            except Exception as exc:
                print(
                    f"[projects.thumb] create skip cover project={pid} err={exc!r}",
                    flush=True,
                )
                thumb_key, thumb_custom = None, False
            crud.create_project(
                session=session,
                project=Project(
                    id=pid,
                    user_id=user_id,
                    org_id=want_org,
                    name=name_n,
                    thumbnail_key=thumb_key,
                    thumbnail_custom=1 if thumb_custom else 0,
                    document_key=doc_key,
                    document_json=doc_json,
                    revision=1,
                    updated_at=now,
                    created_at=now,
                ),
            )
            created = now
            revision = 1
            org_id_out = want_org
            owner_id = user_id

    if document is not None:
        try:
            from app.services.shares.store import sync_project_share_documents

            sync_project_share_documents(
                owner_id=owner_id, project_id=pid, document=document
            )
        except Exception:
            # Share snapshot sync must not fail the project save.
            pass

    return {
        "id": pid,
        "name": name_n,
        "orgId": str(org_id_out) if org_id_out else None,
        "thumbnailUrl": _thumbnail_urls_out(thumb_key),
        "thumbnailCustom": bool(thumb_custom),
        "revision": revision,
        "updatedAt": int(now * 1000),
        "createdAt": int(created * 1000),
    }


def delete_project(user_id: str, project_id: str) -> bool:
    return delete_projects(user_id, [project_id]) > 0


def delete_projects(user_id: str, project_ids: list[str]) -> int:
    """Delete many projects owned by user. Returns number deleted."""
    from sqlmodel import Session

    from app import crud
    from app.core.db import engine

    init_schema()
    ids = [str(x).strip() for x in (project_ids or []) if str(x).strip()]
    seen: set[str] = set()
    uniq: list[str] = []
    for pid in ids:
        if pid in seen:
            continue
        seen.add(pid)
        uniq.append(pid)
    if not uniq:
        return 0

    deleted = 0
    with Session(engine) as session:
        for pid in uniq:
            row = crud.delete_project_for_user(
                session=session, user_id=user_id, project_id=pid
            )
            if not row:
                continue
            deleted += 1
            if row.get("document_key"):
                delete_object(row["document_key"])
            _delete_thumb_entries(row.get("thumbnail_key"))
    return deleted


def _url(key: str | None) -> str | None:
    if not key:
        return None
    text = str(key).strip()
    if not text:
        return None
    # Absolute http(s) — image-node collage tiles / CDN.
    if text.startswith("http://") or text.startswith("https://"):
        try:
            from urllib.parse import unquote, urlparse

            path = unquote(urlparse(text).path or "").lstrip("/")
            if path.startswith("projects/") and "/thumb" in path:
                return f"/api/v1/uploads/files/{path}"
        except Exception:
            pass
        return text
    # JSON array stored by mistake in a single-key call site.
    if text.startswith("["):
        urls = _thumbnail_urls_out(text)
        return urls[0] if urls else None
    # Legacy rows sometimes stored the download path; peel to object key.
    api_prefix = "/api/v1/uploads/files/"
    if text.startswith(api_prefix):
        text = text[len(api_prefix) :].lstrip("/")
    elif text.startswith("/"):
        return text
    if not text:
        return None
    # Prefer same-origin public cover for project thumbs.
    if text.startswith("projects/") and "/thumb" in text:
        return f"/api/v1/uploads/files/{text}"
    storage = get_storage()
    if not storage.enabled_remote():
        return f"/api/v1/uploads/files/{text}"
    return storage.url_for(text)
