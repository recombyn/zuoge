import { useEffect, useMemo, useState, type CSSProperties, type ReactNode, memo } from 'react';
import { useSelector } from '@/store';
import { useSelectedNodeIds } from '@/store/editorSelectors';
import { useTranslation } from 'react-i18next';
import {
  closeShapeStylePanel,
  patchDocumentNode,
} from '@/store/modules/editor';
import { pushParametricOutlineToKit } from '@/components/rcb/canvas/kitBridge';
import { useKitSelectionDockAabb } from '@/components/rcb/selection/useKitSelectionDockAabb';
import { nodeLeftTop } from '@/components/rcb/scene/layout/nodeLayout';
import {
  RcbOverlayPortal,
  useRcbCamera,
  rcbSceneToScreen,
} from '@/components/rcb';
import { FillPanel, type FillPanelValue } from '@/components/editor/panels/FillPanel';
import {
  StrokePanel,
  type StrokePanelValue,
  type StrokeSides,
} from '@/components/editor/nodes/ShapeNode/StrokePanel';
import {
  CornerRadiusPanel,
  type CornerRadiiValue,
} from '@/components/editor/nodes/ShapeNode/CornerRadiusPanel';
import GradientHandlesOverlay from '@/components/editor/nodes/ShapeNode/GradientHandlesOverlay';
import MeshHandlesOverlay from '@/components/editor/nodes/ShapeNode/MeshHandlesOverlay';
import FillImageHandlesOverlay from '@/components/editor/nodes/ShapeNode/FillImageHandlesOverlay';
import { parseStrokeStyle } from '@/components/rcb/scene/document/sceneStrokeStyle';
import {
  supportsSideStroke
} from '@/components/rcb/scene/document/nodeCapabilities';
import {
  fillImageFieldsFromAttrs,
  parseFillGradient,
  parseFillType,
  serializeFillGradient,
  serializeShapeFillAttrs,
  type FillGradient,
} from '@/components/rcb/scene/document/sceneFill';
import {
  resolveStrokeAlign,
  resolveStrokeLinecap,
  resolveStrokeLinejoin,
  boolEffectAttr,
  inflateBoxByVisualOutset,
  inflateBoxByTextSelectionPad,
  geometryPatchForStrokeVisibilityToggle,
  geometryPatchForStrokeOutsetChange,
  type StrokeLinecap,
  type StrokeLinejoin,
} from '@/components/rcb/scene/document/sceneEffects';
import {
  supportsFill,
  supportsCornerRadius
} from '@/components/rcb/scene/document/nodeCapabilities';
import {
  cornerVertexCount,
  isRadiusLinked,
  parseClosedPathRings,
  radiiFromAttrs,
  serializeRadiusVertices,
  vertexRadiiFromAttrs,
} from '@/components/rcb/scene/document/sceneRadii';
import type { SceneDocument, SceneNode, SceneNodeInput } from '@/components/rcb/sceneNode';

type SceneBox = { left: number; top: number; width: number; height: number };

function parseClosedFlag(closedAttr: unknown): boolean | null {
  if (closedAttr === true || closedAttr === 'true') return true;
  if (closedAttr === false || closedAttr === 'false') return false;
  return null;
}

function resolvePanelGradient(
  fillGradient: unknown,
  fillType: 'linear' | 'radial' | 'angular' | 'diffuse',
  fillColor: unknown
): FillGradient {
  const g = parseFillGradient(fillGradient, fillType, String(fillColor ?? ''));
  g.type = fillType;
  return g;
}

/** Panel docked to the top-right of the selection (same pattern as eraser). */
function panelStyleTopRight(
  camera: { x: number; y: number; zoom: number },
  box: SceneBox
): CSSProperties {
  const gap = 16 / Math.max(0.05, camera.zoom);
  const { x, y } = rcbSceneToScreen(camera, box.left + box.width + gap, box.top);
  return {
    position: 'absolute',
    left: x,
    top: y,
    zIndex: 40,
  };
}

function unionBoxes(boxes: SceneBox[]): SceneBox | null {
  if (!boxes.length) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const b of boxes) {
    left = Math.min(left, b.left);
    top = Math.min(top, b.top);
    right = Math.max(right, b.left + b.width);
    bottom = Math.max(bottom, b.top + b.height);
  }
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

/** Geometry AABB (fill / path) — gradient & mesh handles stay on this. */
function nodeGeomBox(document: SceneDocument, node: SceneNodeInput): SceneBox | null {
  if (!node) return null;
  const { left, top } = nodeLeftTop(document, node);
  return {
    left,
    top,
    width: Math.max(1, Number(node.width) || 1),
    height: Math.max(1, Number(node.height) || 1),
  };
}

/** Painted footprint including stroke outset — dock panels outside this. */
function nodeVisualBox(document: SceneDocument, node: SceneNodeInput): SceneBox | null {
  const geom = nodeGeomBox(document, node);
  if (!geom) return null;
  return inflateBoxByVisualOutset(inflateBoxByTextSelectionPad(geom, node), node);
}

function fillAttrsFromValue(
  next: FillPanelValue,
  shapeType?: unknown,
  opts?: { visible?: boolean }
) {
  return serializeShapeFillAttrs(next, { shapeType, visible: opts?.visible });
}

function strokeAttrsFromValue(
  next: StrokePanelValue,
  opts?: { writeSides?: boolean; visible?: boolean }
) {
  const linecap = next.linecap ?? 'butt';
  const linejoin = next.linejoin ?? 'miter';
  const visible = opts?.visible !== false;
  const attrs: Record<string, unknown> = {
    'border-color': next.color,
    'stroke-opacity': Math.max(0, Math.min(100, Math.round(next.opacity))),
    'border-width': Math.max(0, Math.round(next.width) || 0),
    strokeStyle: next.style,
    strokeAlign: next.align ?? 'center',
    strokeLinecap: linecap,
    strokeLinejoin: linejoin,
    'stroke-enabled': visible ? 'true' : 'false',
    'stroke-visible': visible ? 'true' : 'false',
  };
  if (opts?.writeSides && next.sides) {
    attrs.T = next.sides.T ? 'true' : 'false';
    attrs.R = next.sides.R ? 'true' : 'false';
    attrs.B = next.sides.B ? 'true' : 'false';
    attrs.L = next.sides.L ? 'true' : 'false';
  }
  return attrs;
}

function readFillValue(attrs: Record<string, unknown> | undefined): FillPanelValue {
  const a = attrs || {};
  return {
    fillType: parseFillType(a['fill-type']),
    fillColor: String(a['fill-color'] || '#FFFFFF'),
    fillOpacity: Number(a['fill-opacity'] ?? 100),
    fillGradient: a['fill-gradient'] != null ? String(a['fill-gradient']) : undefined,
    ...fillImageFieldsFromAttrs(a),
  };
}

function readStrokeSides(attrs: Record<string, unknown> | undefined): StrokeSides {
  const a = attrs || {};
  return {
    T: boolEffectAttr(a.T, true),
    R: boolEffectAttr(a.R, true),
    B: boolEffectAttr(a.B, true),
    L: boolEffectAttr(a.L, true),
  };
}

function readStrokeCorners(
  attrs: Record<string, unknown> | undefined,
  vertexCount = 4
): CornerRadiiValue {
  const r = radiiFromAttrs(attrs);
  const n = Math.max(3, Math.round(vertexCount) || 4);
  const vertices = vertexRadiiFromAttrs(attrs, n);
  // Rect: default linked. Multi-corner path/polygon: default unlocked so each
  // vertex is editable (explicit radiusLinked=true still locks them together).
  const linked =
    n === 4
      ? isRadiusLinked(attrs)
      : attrs?.radiusLinked === true || attrs?.radiusLinked === 'true';
  return {
    tl: r.tl,
    tr: r.tr,
    br: r.br,
    bl: r.bl,
    linked: Boolean(linked),
    vertices,
  };
}

function readStrokeValue(attrs: Record<string, unknown> | undefined): StrokePanelValue {
  const a = attrs || {};
  const style = parseStrokeStyle(a.strokeStyle);
  const widthNum = Number(a['border-width'] ?? 1);
  const shapeType = String(a.shapeType || '');
  // Pencil default round; pen + line + arrow default butt (stroke panel).
  const roundCaps = shapeType === 'pencil';
  const hasCapAttr = a.strokeLinecap != null;
  const hasJoinAttr = a.strokeLinejoin != null;
  let linecap: StrokeLinecap = roundCaps ? 'round' : 'butt';
  if (hasCapAttr) linecap = resolveStrokeLinecap(a);
  let linejoin: StrokeLinejoin = roundCaps ? 'round' : 'miter';
  if (hasJoinAttr) linejoin = resolveStrokeLinejoin(a);
  return {
    color: String(a['border-color'] || '#333333'),
    opacity: Math.max(0, Math.min(100, Number(a['stroke-opacity'] ?? 100))),
    width: Number.isFinite(widthNum) ? widthNum : 1,
    style,
    align: resolveStrokeAlign(a),
    linecap,
    linejoin,
    sides: readStrokeSides(a),
  };
}

/**
 * Fill / stroke editor docked to the right of the selection.
 * Top selection toolbar is suppressed while this is open (see SvgCanvas suppressChrome).
 */
function ShapeStylePanelHost({
  document,
  hidden = false,
}: {
  document: SceneDocument;
  /** Hide docked side panel while selection is transforming (drag/resize). */
  hidden?: boolean;
}): ReactNode {
  const { t } = useTranslation();
  const camera = useRcbCamera();
  const panel = useSelector(
    (s: any) =>
      s.editor.shapeStylePanel as null | {
        kind: 'fill' | 'stroke' | 'radius';
        nodeIds: string[];
      }
  );
  const selectedNodeIds = useSelectedNodeIds();
  const kitDockAabb = useKitSelectionDockAabb(selectedNodeIds);
  const [meshSelectedIndex, setMeshSelectedIndex] = useState(0);
  const [meshShowGuides, setMeshShowGuides] = useState(true);
  const [gradientStopIndex, setGradientStopIndex] = useState(0);

  const panelFillType = useMemo(() => {
    if (!panel || panel.kind !== 'fill') return null;
    const attrs = document?.deltaSetLike?.[panel.nodeIds[0]]?.attrs as
      | Record<string, unknown>
      | undefined;
    return parseFillType(String(attrs?.['fill-type'] || 'solid'));
  }, [panel, document]);

  useEffect(() => {
    setMeshSelectedIndex(0);
    setGradientStopIndex(0);
  }, [panel?.nodeIds?.join(','), panel?.kind, panelFillType]);

  useEffect(() => {
    if (!panel) return;
    const same =
      panel.nodeIds.length === selectedNodeIds.length &&
      panel.nodeIds.every((id) => selectedNodeIds.includes(id));
    if (!same) closeShapeStylePanel();
  }, [panel, selectedNodeIds]);

  useEffect(() => {
    if (!panel || panel.kind !== 'fill') return;
    const anyFill = panel.nodeIds.some((id) => supportsFill(document?.deltaSetLike?.[id]));
    if (!anyFill) closeShapeStylePanel();
  }, [panel, document]);

  useEffect(() => {
    if (!panel || panel.kind !== 'radius') return;
    const anyRadius = panel.nodeIds.some((id) =>
      supportsCornerRadius(document?.deltaSetLike?.[id])
    );
    if (!anyRadius) closeShapeStylePanel();
  }, [panel, document]);

  useEffect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeShapeStylePanel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel]);

  const docBox = useMemo(() => {
    if (!panel) return null;
    const boxes = panel.nodeIds
      .map((id) => nodeVisualBox(document, document?.deltaSetLike?.[id]))
      .filter(Boolean) as SceneBox[];
    return unionBoxes(boxes);
  }, [document, panel]);
  // Same SoT as selection toolbar — Kit control-box AABB (recomputed every frame).
  const box = kitDockAabb ?? docBox;

  if (!panel || !box) return null;

  const firstId = panel.nodeIds[0];
  const firstNode = document?.deltaSetLike?.[firstId];
  const firstAttrs = firstNode?.attrs as Record<string, unknown> | undefined;
  const close = () => closeShapeStylePanel();
  const fillValue = readFillValue(firstAttrs);
  const fillType = parseFillType(fillValue.fillType);
  const showGradientHandles =
    panel.kind === 'fill' &&
    (fillType === 'linear' || fillType === 'radial' || fillType === 'angular');
  const showMeshHandles = panel.kind === 'fill' && fillType === 'diffuse';
  const showImageFillHandles =
    panel.kind === 'fill' &&
    fillType === 'image' &&
    Boolean(String(fillValue.fillImageSrc || '').trim());
  const handleBox = nodeGeomBox(document, firstNode) || box;
  const nodeAngle = Number(firstAttrs?.angle);
  const gradient: FillGradient | null = showGradientHandles
    ? resolvePanelGradient(
        fillValue.fillGradient,
        fillType as 'linear' | 'radial' | 'angular',
        fillValue.fillColor
      )
    : null;
  const meshGradient: FillGradient | null = showMeshHandles
    ? resolvePanelGradient(fillValue.fillGradient, 'diffuse', fillValue.fillColor)
    : null;

  const fillLayerVisible =
    boolEffectAttr(firstAttrs?.['fill-enabled'], true) &&
    boolEffectAttr(firstAttrs?.['fill-visible'], true);
  const strokeLayerVisible =
    boolEffectAttr(firstAttrs?.['stroke-enabled'], true) &&
    boolEffectAttr(firstAttrs?.['stroke-visible'], true);

  const applyFill = (next: FillPanelValue) => {
    for (const id of panel.nodeIds) {
      const node = document?.deltaSetLike?.[id];
      if (!supportsFill(node)) continue;
      const shapeType = node?.attrs?.shapeType;
      const a = node?.attrs || {};
      const hasFill =
        parseFillType(next.fillType) !== 'solid' ||
        (String(next.fillColor || '').trim() !== '' && next.fillColor !== 'transparent');
      const wasVisible =
        boolEffectAttr(a['fill-enabled'], true) && boolEffectAttr(a['fill-visible'], true);
      const visible = hasFill ? true : wasVisible;
      patchDocumentNode({
          nodeId: id,
          patch: { attrs: fillAttrsFromValue(next, shapeType, { visible }) },
        });
    }
  };

  const applyGradient = (next: FillGradient) => {
    applyFill({
      ...fillValue,
      fillType: next.type,
      fillGradient: serializeFillGradient(next),
    });
  };

  const applyStroke = (next: StrokePanelValue) => {
    for (const id of panel.nodeIds) {
      const node = document?.deltaSetLike?.[id];
      if (!node) continue;
      const a = node?.attrs || {};
      const visible =
        boolEffectAttr(a['stroke-enabled'], true) && boolEffectAttr(a['stroke-visible'], true);
      const t = String(a.shapeType || node.key || '');
      const closedAttr = a.closed;
      const closedExplicit = parseClosedFlag(closedAttr);
      const closed =
        closedExplicit ??
        (typeof a.path === 'string' && /z\s*$/i.test(String(a.path).trim()));
      const openStroke =
        t === 'line' ||
        t === 'arrow' ||
        t === 'pencil' ||
        ((t === 'pen' || t === 'path' || node.key === 'path') && !closed);
      const attrs = strokeAttrsFromValue(next, {
        writeSides: !openStroke,
        visible,
      });
      // Keep outer ink on the same grid when width/align change (path insets).
      const geom = geometryPatchForStrokeOutsetChange(node, attrs);
      patchDocumentNode({
          nodeId: id,
          patch: {
            ...(geom || {}),
            attrs,
          },
        });
    }
  };

  const setFillLayerVisible = (visible: boolean) => {
    for (const id of panel.nodeIds) {
      const node = document?.deltaSetLike?.[id];
      if (!supportsFill(node)) continue;
      const shapeType = node?.attrs?.shapeType;
      patchDocumentNode({
          nodeId: id,
          patch: {
            attrs: {
              ...(shapeType != null ? { shapeType } : {}),
              'fill-enabled': visible ? 'true' : 'false',
              'fill-visible': visible ? 'true' : 'false',
            },
          },
        });
    }
  };

  const setStrokeLayerVisible = (visible: boolean) => {
    for (const id of panel.nodeIds) {
      const node = document?.deltaSetLike?.[id];
      if (!node) continue;
      const shapeType = node?.attrs?.shapeType;
      const geom = geometryPatchForStrokeVisibilityToggle(node, visible);
      patchDocumentNode({
          nodeId: id,
          patch: {
            ...(geom || {}),
            attrs: {
              ...(shapeType != null ? { shapeType } : {}),
              'stroke-enabled': visible ? 'true' : 'false',
              'stroke-visible': visible ? 'true' : 'false',
            },
          },
        });
    }
  };

  const applyRadius = (next: CornerRadiiValue) => {
    for (const id of panel.nodeIds) {
      const node = document?.deltaSetLike?.[id];
      if (!node || !supportsCornerRadius(node)) continue;
      const count = cornerVertexCount(node);
      const vertices =
        next.vertices && next.vertices.length
          ? Array.from({ length: count }, (_, i) =>
              Math.max(
                0,
                Math.round(
                  next.vertices![i] ??
                    next.vertices![next.vertices!.length - 1] ??
                    next.tl ??
                    0
                )
              )
            )
          : vertexRadiiFromAttrs(
              {
                radiusTL: next.tl,
                radiusTR: next.tr,
                radiusBR: next.br,
                radiusBL: next.bl,
                radiusLinked: next.linked ? 'true' : 'false',
              },
              count
            );
      // Honor explicit link toggle — do not re-link just because corners match.
      patchDocumentNode({
          nodeId: id,
          patch: {
            attrs: {
              radiusTL: Math.max(0, Math.round(next.tl) || 0),
              radiusTR: Math.max(0, Math.round(next.tr) || 0),
              radiusBR: Math.max(0, Math.round(next.br) || 0),
              radiusBL: Math.max(0, Math.round(next.bl) || 0),
              radiusLinked: next.linked ? 'true' : 'false',
              radiusVertices: serializeRadiusVertices(vertices),
              // Keep radius aliases in sync for inventory / import paths.
              radius: Math.max(
                0,
                Math.round(Math.max(next.tl, next.tr, next.br, next.bl) || 0)
              ),
              cornerRadius: Math.max(
                0,
                Math.round(Math.max(next.tl, next.tr, next.br, next.bl) || 0)
              ),
            },
          },
        });
      // Polygon / star corner radii rebuild Kit path (same bridge as sides / IR).
      pushParametricOutlineToKit(id);
    }
  };

  const shapeType = String(firstAttrs?.shapeType || firstNode?.key || 'rect');
  const closedAttr = firstAttrs?.closed;
  const pathClosedExplicit = parseClosedFlag(closedAttr);
  const pathClosed =
    pathClosedExplicit ??
    (typeof firstAttrs?.path === 'string' && /z\s*$/i.test(String(firstAttrs.path).trim()));
  /**
   * Open strokes (line / arrow / open pen / pencil): show linecap (—).
   * Side toggles (All / T / L / B / R) only for rect-like nodes — never for pen/path.
   */
  const isOpenStroke =
    shapeType === 'line' ||
    shapeType === 'arrow' ||
    shapeType === 'pencil' ||
    ((shapeType === 'pen' || shapeType === 'path' || firstNode?.key === 'path') && !pathClosed);
  const showLinecap = isOpenStroke;
  const showAlign = !isOpenStroke;
  const showSides = supportsSideStroke(firstNode);
  const cornerMax = Math.max(
    8,
    ...panel.nodeIds.map((id) => {
      const n = document?.deltaSetLike?.[id];
      if (!n) return 0;
      const boxCap = Math.floor(Math.min(Number(n.width) || 0, Number(n.height) || 0) / 2);
      const d = String(n.attrs?.path || '');
      const shapeType = String(n.attrs?.shapeType || n.key || '');
      if (d && (shapeType === 'pen' || shapeType === 'path' || n.key === 'path')) {
        const rings = parseClosedPathRings(d);
        let shortest = Infinity;
        for (const ring of rings) {
          for (let i = 0; i < ring.length; i += 1) {
            const a = ring[i];
            const b = ring[(i + 1) % ring.length];
            shortest = Math.min(shortest, Math.hypot(b[0] - a[0], b[1] - a[1]));
          }
        }
        if (Number.isFinite(shortest) && shortest < Infinity) {
          return Math.min(boxCap || shortest / 2, Math.max(8, Math.floor(shortest / 2)));
        }
      }
      return boxCap;
    })
  );

  return (
    <>
      {showGradientHandles && gradient ? (
        <GradientHandlesOverlay
          box={handleBox}
          angle={Number.isFinite(nodeAngle) ? nodeAngle : 0}
          gradient={gradient}
          onChange={applyGradient}
          onActiveStopChange={setGradientStopIndex}
        />
      ) : null}
      {showMeshHandles && meshGradient ? (
        <MeshHandlesOverlay
          box={handleBox}
          angle={Number.isFinite(nodeAngle) ? nodeAngle : 0}
          gradient={meshGradient}
          selectedIndex={meshSelectedIndex}
          showGuides={meshShowGuides}
          onChange={applyGradient}
          onActivePointChange={setMeshSelectedIndex}
        />
      ) : null}
      {showImageFillHandles ? (
        <FillImageHandlesOverlay
          box={handleBox}
          angle={Number.isFinite(nodeAngle) ? nodeAngle : 0}
          value={fillValue}
          onChange={applyFill}
        />
      ) : null}
      <RcbOverlayPortal>
        <div
          className="pointer-events-auto"
          style={{
            ...panelStyleTopRight(camera, box),
            ...(hidden
              ? { visibility: 'hidden' as const, pointerEvents: 'none' as const }
              : null),
          }}
          aria-hidden={hidden}
          data-shape-style-panel
          onPointerDown={(e) => e.stopPropagation()}
        >
          {panel.kind === 'fill' ? (
            <FillPanel
              value={fillValue}
              onChange={applyFill}
              title={t('editor.selectionToolbar.color')}
              onClose={close}
              meshSelectedIndex={meshSelectedIndex}
              onMeshSelectedIndexChange={setMeshSelectedIndex}
              meshShowGuides={meshShowGuides}
              onMeshShowGuidesChange={setMeshShowGuides}
              activeStopIndex={gradientStopIndex}
              onActiveStopIndexChange={setGradientStopIndex}
              layerVisible={fillLayerVisible}
              onLayerVisibleChange={setFillLayerVisible}
            />
          ) : panel.kind === 'radius' ? (
            <CornerRadiusPanel
              value={readStrokeCorners(
                firstAttrs,
                firstNode ? cornerVertexCount(firstNode) : 4
              )}
              onChange={applyRadius}
              title={t('editor.selectionToolbar.cornerRadius')}
              onClose={close}
              max={cornerMax}
              vertexCount={firstNode ? cornerVertexCount(firstNode) : 4}
            />
          ) : (
            <StrokePanel
              value={readStrokeValue(firstAttrs)}
              onChange={applyStroke}
              title={t('editor.selectionToolbar.stroke')}
              onClose={close}
              showLinecap={showLinecap}
              showAlign={showAlign}
              showSides={showSides}
              layerVisible={strokeLayerVisible}
              onLayerVisibleChange={setStrokeLayerVisible}
            />
          )}
        </div>
      </RcbOverlayPortal>
    </>
  );
}

export default memo(ShapeStylePanelHost);
