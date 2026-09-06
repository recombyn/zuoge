import {
  buildTextAttrsPreservingMarkdown,
  measurePlainTextSize,
  measureWrappedTextSize,
  parseNodeText,
  parseNodeTextStyle,
} from '../document/sceneText';
import {
  normalizeDocument,
} from '../document/sceneDocument';
import { isCustomPathShape, scalePathData } from '../document/pathScale';
import type { SceneDocument } from '@/components/rcb/sceneNode';
import {
  documentPointToNodeLocal,
  isFrameLocalCoordSpace,
} from '@/components/rcb/scene/paint/sceneToSvg';

function num(v: unknown, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Scene left/top → document node x/y (adds page origin). */
export function sceneToDocumentCoords(document: SceneDocument, left: number, top: number) {
  return {
    x: num(left, 0) + num(document?.x, 0),
    y: num(top, 0) + num(document?.y, 0),
  };
}

/**
 * Where to store a boolean (or similar) result's top-left.
 * Scene-absolute geometry in → node x/y out (plate-local when frameLocal + frameId).
 */
export function storedOriginForSceneResult(
  document: SceneDocument,
  sceneLeft: number,
  sceneTop: number,
  frameId?: string | null
): { x: number; y: number } {
  const abs = sceneToDocumentCoords(document, sceneLeft, sceneTop);
  const fid = String(frameId || '').trim();
  if (!fid || !isFrameLocalCoordSpace(document)) return abs;
  return documentPointToNodeLocal(document, { attrs: { frameId: fid } } as never, abs.x, abs.y);
}

export type TextResizeMode = 'scale' | 'wrap' | 'frame';

export type PatchGeometryOptions = {
  /** Remasure text height so chrome hugs ink (keep wrap width). */
  fitTextBox?: boolean;
  /**
   * text resize:
   * - `scale`: corner handles — scale font with box
   * - `wrap`: left/right edges — change width only, remasure height (no font scale)
   * - `frame`: fixed text plate — resize box only, font unchanged
   */
  textResizeMode?: TextResizeMode;
};

/** Infer text resize mode when callers omit it (width-only → wrap). */
function inferTextResizeMode(
  oldW: number,
  oldH: number,
  newW: number,
  newH: number,
  explicit?: TextResizeMode
): TextResizeMode {
  if (explicit) return explicit;
  const dw = Math.abs(newW - oldW);
  const dh = Math.abs(newH - oldH);
  if (dw > 0.5 && dh <= 0.5) return 'wrap';
  return 'scale';
}

/** Patch a single node's geometry from selection chrome — document. */
export function patchNodeGeometry(
  document: SceneDocument,
  nodeId: string,
  geometry: { left: number; top: number; width: number; height: number },
  options?: PatchGeometryOptions
) {
  const next = normalizeDocument(document);
  const node = next.deltaSetLike?.[nodeId];
  if (!node) return next;
  const abs = sceneToDocumentCoords(next, geometry.left, geometry.top);
  const local = documentPointToNodeLocal(next, node, abs.x, abs.y);
  const oldW = Math.max(1, Number(node.width) || 1);
  const oldH = Math.max(1, Number(node.height) || 1);
  // Keep subpixel geometry. Integer rounding breaks flush visual snaps when stroke
  // outset is *.5 (odd border-width) — invisible at 100%, obvious at 300–800%.
  const quantize = (n: number) => Math.round(n * 1000) / 1000;
  let newW = Math.max(1, quantize(geometry.width));
  let newH = Math.max(1, quantize(geometry.height));
  const ix = quantize(local.x);
  const iy = quantize(local.y);

  let attrs = node.attrs;
  const shapeType = String(node.attrs?.shapeType || '');
  const pathD = node.attrs?.path != null ? String(node.attrs.path) : '';
  if (
    isCustomPathShape(shapeType) &&
    pathD &&
    (Math.abs(newW - oldW) > 0.5 || Math.abs(newH - oldH) > 0.5)
  ) {
    attrs = {
      ...node.attrs,
      path: scalePathData(pathD, newW / oldW, newH / oldH),
    };
  }

  // Text: corners scale type; L/R edges set wrap width only; frames resize box only.
  if (
    node.key === 'text' &&
    (Math.abs(newW - oldW) > 0.5 || Math.abs(newH - oldH) > 0.5)
  ) {
    let style = parseNodeTextStyle(attrs || node.attrs || {});
    const mode = inferTextResizeMode(oldW, oldH, newW, newH, options?.textResizeMode);

    if (mode === 'frame') {
      // Fixed plate: geometry only — content scrolls inside at constant font size.
    } else if (mode === 'scale') {
      const sx = newW / oldW;
      const sy = newH / oldH;
      // Prefer uniform scale when aspect-locked (sx ≈ sy); else follow height.
      const s = Math.abs(sx - sy) < 0.02 ? sx : sy;
      if (Math.abs(s - 1) > 1e-4) {
        const nextSize = Math.max(1, Math.round(style.fontSize * s));
        const nextSpacing = Math.round(style.letterSpacing * s * 1000) / 1000;
        style = { ...style, fontSize: nextSize, letterSpacing: nextSpacing };
        attrs = {
          ...(attrs || node.attrs),
          ...buildTextAttrsPreservingMarkdown(node.attrs || {}, {
            fontSize: nextSize,
            letterSpacing: nextSpacing,
          }),
        };
      }
    }

    // Hug ink height; never shrink wrap width back to content (that broke edge resize).
    // Geometry resizing owns the requested box. Re-measuring in scale mode
    // changes the box again after the drag and makes the control frame diverge
    // from the text. Wrapping is the only mode that should recompute height.
    if (mode === 'wrap') {
      const plain = parseNodeText(attrs || node.attrs || {}) || ' ';
      const prevAuto =
        String((attrs || node.attrs || {}).autoSize ?? 'true') !== 'false';
      // only L/R wrap resize turns off autoSize — not corner scale / fit.
      if (mode === 'wrap') {
        const measured = measureWrappedTextSize(plain, style, Math.max(24, newW));
        newW = Math.max(1, Math.round(measured.width));
        newH = Math.max(1, Math.round(measured.height));
        attrs = {
          ...(attrs || node.attrs),
          autoSize: 'false',
        };
      } else if (prevAuto) {
        const measured = measurePlainTextSize(plain, style);
        newW = Math.max(1, Math.round(measured.width));
        newH = Math.max(1, Math.round(measured.height));
      } else {
        const measured = measureWrappedTextSize(plain, style, Math.max(24, newW));
        newW = Math.max(1, Math.round(measured.width));
        newH = Math.max(1, Math.round(measured.height));
      }
    }
  }

  next.deltaSetLike[nodeId] = {
    ...node,
    attrs,
    x: ix,
    y: iy,
    width: newW,
    height: newH,
  };
  return next;
}

/** Move/resize multiple nodes. Each entry is scene-local left/top/size. */
export function patchNodesGeometry(
  document: SceneDocument,
  patches: Array<{ nodeId: string; left: number; top: number; width: number; height: number }>,
  options?: PatchGeometryOptions
) {
  let next = normalizeDocument(document);
  patches.forEach((p) => {
    next = patchNodeGeometry(next, p.nodeId, p, options);
  });
  return next;
}
