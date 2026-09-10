import { useMemo, useRef, useState, useSyncExternalStore, memo } from 'react';

import { useTranslation } from 'react-i18next';
import {
  fillPanelPreview,
  type FillPanelValue,
} from '@/components/editor/panels/FillPanel';
import { ExportSelectionPopover } from '@/components/editor/panels/ExportSelectionPanel';
import {
  fillImageFieldsFromAttrs,
  parseFillType,
} from '@/components/rcb/scene/document/sceneFill';
import { boolEffectAttr } from '@/components/rcb/scene/document/sceneEffects';
import { openShapeStylePanel, patchDocumentNode } from '@/store/modules/editor';
import ToolbarValueSlider, {
  SEL_ICON_BTN,
  SEL_SIZE_INPUT,
  SEL_TOOL_BTN,
} from '@/components/rcb/selection/chrome/ToolbarValueSlider';
import {
  FillColorSwatch,
  IconCornerRadius,
  StrokeColorSwatch,
} from '@/components/rcb/selection/chrome/StyleToolbarIcons';
import StrokeStylePicker from '@/components/editor/nodes/ShapeNode/StrokeStylePicker';
import { parseStrokeStyle } from '@/components/rcb/scene/document/sceneStrokeStyle';
import AspectRatioPresetMenu, {
  ELEMENT_ASPECT_PRESETS,
} from '@/components/rcb/selection/chrome/AspectRatioPresetMenu';
import {
  matchAspectPresetKey,
  sizeFromAspectPreset,
} from '@/components/rcb/selection/resizeGeometry';
import Tooltip from '@/components/base/tooltip';
import { Icon } from '@/components/base/icon';
import { cn } from '@/utils/classnames';
import {
  supportsAspectPresets,
  supportsCornerRadius,
  supportsFill,
  supportsShapeSides,
  supportsStroke
} from '@/components/rcb/scene/document/nodeCapabilities';
import {
  cornerRadiusToolbarDisplay,
  getLiveCornerRadiusPreview,
  subscribeLiveCornerRadiusPreview,
} from '@/components/rcb/scene/document/sceneRadii';
import {
  clampStarInnerRatio,
  clampShapeSides,
  clampEllipseInnerRatio,
  clampEllipseArcPercent,
  DEFAULT_SHAPE_SIDES,
  MAX_SHAPE_SIDES,
  MIN_SHAPE_SIDES,
  sidesFromAttrs,
  starInnerRatioFromAttrs,
  ellipseInnerRatioFromAttrs,
  ellipseArcPercentFromAttrs,
  getLiveShapeParamsPreview,
  subscribeLiveShapeParamsPreview,
  strokeEndpointsFromBox,
  strokeNodeFromEndpoints,
} from '@/components/rcb/scene/document/sceneShapes';
import { getShapeBaselineD } from '@/components/rcb/core/geometry';
import { pushParametricOutlineToKit } from '@/components/rcb/canvas/kitBridge';
import { nodeLeftTop } from '@/components/rcb/scene/layout/nodeLayout';
import { clearNodeTransformPreviews } from '@/components/rcb/core/transformPreview';
import { sceneToDocumentCoords } from '@/components/rcb/scene/layout/coords';
import type { SceneDocument, SceneNode, SceneNodeInput } from '@/components/rcb/sceneNode';

function readAspectLocked(attrs: Record<string, unknown> | undefined): boolean {
  const raw = attrs?.lockAspect;
  if (raw === true || raw === 'true' || raw === 1 || raw === '1') return true;
  if (raw === false || raw === 'false' || raw === 0 || raw === '0') return false;
  return false;
}

/** Compact toolbar R: linked — any corner; unlinked — max so mixed corners stay visible. */
function toolbarCornerRadius(attrs: Record<string, unknown> | undefined): number {
  return cornerRadiusToolbarDisplay(attrs);
}

type SceneBox = { left: number; top: number; width: number; height: number };

/** Stored before first ratio preset so 「自由—can restore. */
const ASPECT_ORIG_W = 'aspect-original-width';
const ASPECT_ORIG_H = 'aspect-original-height';
type StrokeLengthAnchor = { x: number; y: number; angle: number };
// Selection chrome may remount while an extreme-length stroke leaves the viewport.
// Keep the active W-edit anchor outside that transient React subtree.
const strokeLengthAnchors = new Map<string, StrokeLengthAnchor>();
type BoxSizeAnchor = { x: number; y: number; angle: number };
const boxSizeAnchors = new Map<string, BoxSizeAnchor>();

/** Actual scene position of a box's local top-left under rotate-about-center. */
function rotatedTopLeft(
  left: number,
  top: number,
  width: number,
  height: number,
  angleDeg: number
) {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: left + w / 2 - (w / 2) * cos + (h / 2) * sin,
    y: top + h / 2 - (w / 2) * sin - (h / 2) * cos,
  };
}

/** Solve the unrotated box origin while keeping its local top-left in place. */
function originFromRotatedTopLeft(
  anchor: { x: number; y: number },
  width: number,
  height: number,
  angleDeg: number
) {
  const offset = rotatedTopLeft(0, 0, width, height, angleDeg);
  return { left: anchor.x - offset.x, top: anchor.y - offset.y };
}

/** Single-shape floating bar: fill / stroke · corner radius · W·H · ratio · download. */
function ShapeSelectionToolbar({
  nodeId,
  node,
  box,
  valueBox,
  document,
  hideExport = false,
}: {
  nodeId: string;
  node: SceneNodeInput;
  box: SceneBox;
  valueBox?: SceneBox;
  document: SceneDocument;
  /** When true, parent renders Export after blend (unified toolbar order). */
  hideExport?: boolean;
}) {
  const { t } = useTranslation();
  const [ratioOpen, setRatioOpen] = useState(false);
  // W is applied on every keystroke. Keep the original shaft start for the
  // entire edit session so intermediate values cannot move the fixed endpoint.
  const strokeLengthAnchorRef = useRef<StrokeLengthAnchor | null>(null);
  const boxSizeAnchorRef = useRef<BoxSizeAnchor | null>(null);
  const cornerRadius = supportsCornerRadius(node);
  const canFill = supportsFill(node);
  const canStroke = supportsStroke(node);
  const showAspectPresets = supportsAspectPresets(node);
  const showSides = supportsShapeSides(node);
  const shapeType = String(node?.attrs?.shapeType || '');
  const sidesLabel =
    shapeType === 'star'
      ? t('editor.selectionToolbar.pointCount')
      : t('editor.selectionToolbar.sideCount');
  const sidesPrefix =
    shapeType === 'star'
      ? t('editor.selectionToolbar.pointPrefix')
      : t('editor.selectionToolbar.sidePrefix');
  const liveShapeParams = useSyncExternalStore(
    subscribeLiveShapeParamsPreview,
    () => getLiveShapeParamsPreview(nodeId),
    () => null
  );
  const sides = liveShapeParams?.sides ?? sidesFromAttrs(node?.attrs);
  const showStarInnerRadius = shapeType === 'star';
  const starInnerRadiusPct = Math.round(
    (liveShapeParams?.starInnerRatio ?? starInnerRatioFromAttrs(node?.attrs)) * 100
  );
  const showEllipseControls =
    shapeType === 'circle' || shapeType === 'ellipse' || node.key === 'ellipse';
  const ellipseInnerRadiusPct = Math.round(
    (liveShapeParams?.ellipseInnerRatio ?? ellipseInnerRatioFromAttrs(node?.attrs)) * 100
  );
  const ellipseArcPercent =
    liveShapeParams?.ellipseArcPercent ?? ellipseArcPercentFromAttrs(node?.attrs);
  const aspectLocked = readAspectLocked(node?.attrs);
  const isOpenStroke = shapeType === 'line' || shapeType === 'arrow';
  const isFreehandStroke = shapeType === 'pen' || shapeType === 'pencil';
  const showSizeControls = !isFreehandStroke;
  const sizeBox = valueBox || box;
  const strokeWidth = Math.max(
    1,
    Math.round(Number(node?.attrs?.['border-width'] ?? 2) || 2)
  );

  const activeRatioId = useMemo(
    () => matchAspectPresetKey(sizeBox.width, sizeBox.height, ELEMENT_ASPECT_PRESETS),
    [sizeBox.width, sizeBox.height]
  );

  const fillValue: FillPanelValue = {
    fillType: parseFillType(node?.attrs?.['fill-type']),
    fillColor: String(node?.attrs?.['fill-color'] || '#FFFFFF'),
    fillOpacity: Number(node?.attrs?.['fill-opacity'] ?? 100),
    fillGradient:
      node?.attrs?.['fill-gradient'] != null ? String(node.attrs['fill-gradient']) : undefined,
    ...fillImageFieldsFromAttrs(node?.attrs),
  };
  const fillVisible =
    boolEffectAttr(node?.attrs?.['fill-enabled'], true) &&
    boolEffectAttr(node?.attrs?.['fill-visible'], true);
  const fillPreview = fillVisible ? fillPanelPreview(fillValue) : 'transparent';
  const strokeVisible =
    boolEffectAttr(node?.attrs?.['stroke-enabled'], true) &&
    boolEffectAttr(node?.attrs?.['stroke-visible'], true);
  const strokeColor = String(node?.attrs?.['border-color'] || '#333333');
  const strokeStyle = parseStrokeStyle(node?.attrs?.strokeStyle);
  const liveCornerRadius = useSyncExternalStore(
    subscribeLiveCornerRadiusPreview,
    () => getLiveCornerRadiusPreview(nodeId),
    () => null
  );
  const radius = liveCornerRadius ?? toolbarCornerRadius(node?.attrs);

  const patchAttrs = (attrs: Record<string, unknown>) => {
    const shapeType = node?.attrs?.shapeType;
    patchDocumentNode({
        nodeId,
        patch: {
          attrs: {
            ...(shapeType != null ? { shapeType } : {}),
            ...attrs,
          },
        },
      });
  };

  /** Sides / IR / Ar — persist attrs + rebuild Kit path (reconcile may skip on Kit flush race). */
  const patchParametricAttrs = (attrs: Record<string, unknown>) => {
    const shapeType = node?.attrs?.shapeType;
    const merged = {
      ...(node?.attrs || {}),
      ...(shapeType != null ? { shapeType } : {}),
      ...attrs,
    };
    const previewNode = { ...node, attrs: merged } as SceneNodeInput;
    const d = getShapeBaselineD(previewNode);
    const nextAttrs = {
      ...(shapeType != null ? { shapeType } : {}),
      ...attrs,
      ...(d ? { path: d } : {}),
    };
    patchDocumentNode({
      nodeId,
      patch: { attrs: nextAttrs },
    });
    pushParametricOutlineToKit(nodeId, {
      ...node,
      attrs: { ...(node?.attrs || {}), ...nextAttrs },
    } as SceneNodeInput);
  };

  const captureStrokeLengthAnchor = () => {
    if (!isOpenStroke) return;
    const { left, top } = nodeLeftTop(document, node);
    const angle = Number(node.attrs?.angle) || 0;
    const endpoints = strokeEndpointsFromBox(
      {
        left,
        top,
        width: Math.max(1, Number(node.width) || 1),
        height: Math.max(1, Number(node.height) || 1),
      },
      angle
    );
    const anchor = { x: endpoints.x0, y: endpoints.y0, angle };
    strokeLengthAnchorRef.current = anchor;
    strokeLengthAnchors.set(nodeId, anchor);
  };

  const clearStrokeLengthAnchor = () => {
    strokeLengthAnchorRef.current = null;
    strokeLengthAnchors.delete(nodeId);
  };

  const captureBoxSizeAnchor = () => {
    if (isOpenStroke) return;
    const angle = Number(node.attrs?.angle) || 0;
    const { left, top } = nodeLeftTop(document, node);
    const anchor = rotatedTopLeft(
      left,
      top,
      Math.max(1, Number(node.width) || 1),
      Math.max(1, Number(node.height) || 1),
      angle
    );
    const value = { ...anchor, angle };
    boxSizeAnchorRef.current = value;
    boxSizeAnchors.set(nodeId, value);
  };

  const clearBoxSizeAnchor = () => {
    boxSizeAnchorRef.current = null;
    boxSizeAnchors.delete(nodeId);
  };

  /**
   * Size fields are a direct geometry edit, not a resize gesture. Apply the exact
   * same scene box to the mounted SVG before the editor store publishes the document box.
   * This keeps the visual top-left and persisted top-left identical.
   */
  const commitBoxGeometry = (
    _nextBox: SceneBox,
    patch: Record<string, unknown>
  ) => {
    patchDocumentNode({
        nodeId,
        patch,
        // Noop preview always returned false — remount host from document.
        skipHostReload: false,
      });
    // Document is the commit fact — drop gesture overlay so Kit bake can resume.
    clearNodeTransformPreviews([nodeId]);
  };

  const patchSize = (
    width: number,
    height: number,
    extraPatch: Record<string, unknown> = {}
  ) => {
    if (isOpenStroke) {
      const currentWidth = Math.max(1, Number(node.width) || 1);
      const currentHeight = Math.max(1, Number(node.height) || 1);
      const angle = Number(node.attrs?.angle) || 0;
      const { left, top } = nodeLeftTop(document, node);
      const endpoints = strokeEndpointsFromBox(
        {
          left,
          top,
          width: currentWidth,
          height: currentHeight,
        },
        angle
      );
      const anchor = strokeLengthAnchorRef.current || strokeLengthAnchors.get(nodeId);
      const fixedStart = anchor && anchor.angle === angle
        ? anchor
        : { x: endpoints.x0, y: endpoints.y0, angle };
      const rad = (fixedStart.angle * Math.PI) / 180;
      const nextLength = Math.max(1, Math.round(width));
      const lengthChanged = nextLength !== currentWidth;
      // Preserve the local start endpoint while the segment's center moves with its length.
      const next = strokeNodeFromEndpoints({
        x0: fixedStart.x,
        y0: fixedStart.y,
        x1: fixedStart.x + Math.cos(rad) * nextLength,
        y1: fixedStart.y + Math.sin(rad) * nextLength,
      });
      const nextOrigin = sceneToDocumentCoords(document, next.x, next.y);
      commitBoxGeometry(
        { left: next.x, top: next.y, width: next.width, height: next.height },
      {
          ...extraPatch,
          ...(lengthChanged ? { x: nextOrigin.x, y: nextOrigin.y, width: next.width } : {}),
          // Lines are defined by length + rotation. Their visual thickness is stroke width.
          height: next.height,
          attrs: {
            ...(lengthChanged ? { angle } : {}),
            'border-width': Math.max(1, Math.round(height)),
            ...(shapeType === 'arrow'
              ? { 'arrow-head-size': Math.max(14, Math.round(height * 1.25)) }
              : {}),
          },
        }
      );
      return;
    }
    const nextWidth = Math.max(1, Math.round(width));
    const nextHeight = Math.max(1, Math.round(height));
    const angle = Number(node.attrs?.angle) || 0;
    const { left, top } = nodeLeftTop(document, node);
    const oldWidth = Math.max(1, Number(node.width) || 1);
    const oldHeight = Math.max(1, Number(node.height) || 1);
    const anchor = boxSizeAnchorRef.current || boxSizeAnchors.get(nodeId) ||
      rotatedTopLeft(left, top, oldWidth, oldHeight, angle);
    const nextOrigin = originFromRotatedTopLeft(anchor, nextWidth, nextHeight, angle);
    const documentOrigin = sceneToDocumentCoords(document, nextOrigin.left, nextOrigin.top);
    commitBoxGeometry(
      { left: nextOrigin.left, top: nextOrigin.top, width: nextWidth, height: nextHeight },
      {
        ...extraPatch,
        x: documentOrigin.x,
        y: documentOrigin.y,
        width: nextWidth,
        height: nextHeight,
      }
    );
  };

  const setSize = (axis: 'w' | 'h', raw: string) => {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return;
    const n = Math.round(Number(trimmed));
    if (!Number.isFinite(n) || n < 1) return;
    if (isOpenStroke) {
      if (axis === 'w') {
        if (n !== Math.round(sizeBox.width)) patchSize(n, strokeWidth);
      } else if (n !== strokeWidth) {
        patchSize(Math.round(sizeBox.width), n);
      }
      return;
    }
    if (axis === 'w' && n === Math.round(sizeBox.width)) return;
    if (axis === 'h' && n === Math.round(sizeBox.height)) return;
    if (aspectLocked) {
      const ratio = sizeBox.width / Math.max(1, sizeBox.height);
      if (axis === 'w') patchSize(n, Math.max(1, Math.round(n / ratio)));
      else patchSize(Math.max(1, Math.round(n * ratio)), n);
      return;
    }
    if (axis === 'w') patchSize(n, Math.round(sizeBox.height));
    else patchSize(Math.round(sizeBox.width), n);
  };

  const applySides = (n: number) => {
    patchParametricAttrs({ sides: clampShapeSides(n, DEFAULT_SHAPE_SIDES) });
  };

  const applyStarInnerRadius = (pct: number) => {
    patchParametricAttrs({ starInnerRatio: clampStarInnerRatio(pct / 100) });
  };

  const applyEllipseInnerRadius = (pct: number) => {
    patchParametricAttrs({ ellipseInnerRatio: clampEllipseInnerRatio(pct / 100) });
  };

  const applyEllipseArc = (pct: number) => {
    // Always clockwise from the right — never reopen counter-clockwise / from the left.
    patchParametricAttrs({
      ellipseArcPercent: clampEllipseArcPercent(Math.abs(pct)),
      ellipseStartDeg: 0,
    });
  };

  const applyAspectPreset = (preset: (typeof ELEMENT_ASPECT_PRESETS)[number]) => {
    if (preset.id === 'original') {
      // 「自由」：保持当前尺寸，取消比例锁—
      patchAttrs({ lockAspect: 'false' });
      return;
    }
    const shapeType = node?.attrs?.shapeType;
    const hasOrig =
      Number(node?.attrs?.[ASPECT_ORIG_W]) > 0 && Number(node?.attrs?.[ASPECT_ORIG_H]) > 0;
    const next = sizeFromAspectPreset(box, preset.w, preset.h);
    patchSize(
      Math.max(1, Math.round(next.width)),
      Math.max(1, Math.round(next.height)),
      {
        attrs: {
          ...(shapeType != null ? { shapeType } : {}),
          lockAspect: 'true',
          ...(!hasOrig
            ? {
                [ASPECT_ORIG_W]: Math.round(sizeBox.width),
                [ASPECT_ORIG_H]: Math.round(sizeBox.height),
              }
            : {}),
        },
      }
    );
  };

  const openStyle = (kind: 'fill' | 'stroke' | 'radius') => {
    openShapeStylePanel({ kind, nodeIds: [nodeId] });
  };

  return (
    <>
      {canFill ? (
        <Tooltip tip={t('editor.selectionToolbar.color')} placement="top">
          <button
            type="button"
            aria-label={t('editor.selectionToolbar.color')}
            className={cn(SEL_ICON_BTN, !fillVisible && 'opacity-55')}
            onClick={() => openStyle('fill')}
          >
            <FillColorSwatch color={fillPreview} />
          </button>
        </Tooltip>
      ) : null}

      {canStroke ? (
        <Tooltip tip={t('editor.selectionToolbar.stroke')} placement="top">
          <button
            type="button"
            aria-label={t('editor.selectionToolbar.stroke')}
            className={cn(SEL_ICON_BTN, !strokeVisible && 'opacity-55')}
            onClick={() => openStyle('stroke')}
          >
            <StrokeColorSwatch color={strokeVisible ? strokeColor : 'var(--line)'} />
          </button>
        </Tooltip>
      ) : null}
      {isOpenStroke ? (
        <StrokeStylePicker
          value={strokeStyle}
          onChange={(next) => patchAttrs({ strokeStyle: next })}
        />
      ) : null}
      {cornerRadius ? (
        <Tooltip tip={t('editor.selectionToolbar.cornerRadius')} placement="top">
          <button
            type="button"
            aria-label={t('editor.selectionToolbar.cornerRadius')}
            className={SEL_TOOL_BTN}
            onClick={() => openStyle('radius')}
          >
            <IconCornerRadius className="h-4 w-4 text-[var(--muted)]" />
            <span className="tabular-nums">{radius}</span>
          </button>
        </Tooltip>
      ) : null}

      {showSides ? (
        <ToolbarValueSlider
          prefix={sidesPrefix}
          value={sides}
          min={MIN_SHAPE_SIDES}
          max={MAX_SHAPE_SIDES}
          onChange={applySides}
          title={sidesLabel}
          panelLabel={sidesLabel}
        />
      ) : null}

      {showStarInnerRadius ? (
        <ToolbarValueSlider
          prefix="IR"
          value={starInnerRadiusPct}
          min={8}
          max={92}
          onChange={applyStarInnerRadius}
          title="Inner radius"
          panelLabel="Inner radius"
        />
      ) : null}

      {showEllipseControls ? (
        <>
          <ToolbarValueSlider
            prefix="IR"
            value={ellipseInnerRadiusPct}
            min={0}
            max={92}
            onChange={applyEllipseInnerRadius}
            title={t('editor.imageToolbar.ellipseInnerRadius', { defaultValue: 'Inner radius' })}
            panelLabel={t('editor.imageToolbar.ellipseInnerRadius', { defaultValue: 'Inner radius' })}
          />
          <ToolbarValueSlider
            prefix="Ar"
            value={Math.abs(ellipseArcPercent)}
            min={0.5}
            max={100}
            step={0.1}
            precision={1}
            onChange={applyEllipseArc}
            title={t('editor.imageToolbar.arcPercent', { defaultValue: 'Arc' })}
            panelLabel={t('editor.imageToolbar.arcPercent', { defaultValue: 'Arc' })}
          />
        </>
      ) : null}

      {showAspectPresets && showSizeControls && !isOpenStroke ? (
        <AspectRatioPresetMenu
          open={ratioOpen}
          onOpenChange={setRatioOpen}
          activeId={activeRatioId}
          onPick={applyAspectPreset}
        />
      ) : null}

      {showSizeControls ? (
        <label className="inline-flex h-8 items-center gap-1 rounded-lg px-1.5 text-[12px] text-[var(--ink)]">
          <span className="text-[var(--muted)]">W</span>
          <input
            className={SEL_SIZE_INPUT}
            defaultValue={Math.round(sizeBox.width)}
            key={`w-${nodeId}`}
            onPointerDown={(e) => e.stopPropagation()}
            onFocus={() => {
              captureStrokeLengthAnchor();
              captureBoxSizeAnchor();
            }}
            onChange={(e) => setSize('w', e.target.value)}
            onBlur={(e) => {
              setSize('w', e.target.value);
              clearStrokeLengthAnchor();
              clearBoxSizeAnchor();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setSize('w', (e.target as HTMLInputElement).value);
                clearStrokeLengthAnchor();
                clearBoxSizeAnchor();
              }
            }}
          />
        </label>
      ) : null}
      {showSizeControls && !isOpenStroke ? (
        <Tooltip
          tip={
            aspectLocked
              ? t('editor.imageToolbar.unlockAspect')
              : t('editor.imageToolbar.lockAspect')
          }
          placement="top"
        >
          <button
            type="button"
            aria-label={
              aspectLocked
                ? t('editor.imageToolbar.unlockAspect')
                : t('editor.imageToolbar.lockAspect')
            }
            aria-pressed={aspectLocked}
            className={cn(
              'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--ink)]',
              aspectLocked && 'bg-[var(--accent-soft)] text-[var(--ink)]'
            )}
            onClick={() =>
              patchAttrs({ lockAspect: aspectLocked ? 'false' : 'true' })
            }
          >
            {aspectLocked ? (
              <Icon name="editor-link" width={14} height={14} />
            ) : (
              <Icon name="editor-unlink" width={14} height={14} />
            )}
          </button>
        </Tooltip>
      ) : null}
      {showSizeControls ? (
        <Tooltip
          tip={
            isOpenStroke
              ? t('editor.selectionToolbar.strokeWidth')
              : t('editor.selectionToolbar.height')
          }
          placement="top"
        >
          <label className="inline-flex h-8 items-center gap-1 rounded-lg px-1.5 text-[12px] text-[var(--ink)]">
            <span className="text-[var(--muted)]">H</span>
            <input
              className={SEL_SIZE_INPUT}
              defaultValue={isOpenStroke ? strokeWidth : Math.round(sizeBox.height)}
              key={`h-${nodeId}`}
              onPointerDown={(e) => e.stopPropagation()}
              onFocus={captureBoxSizeAnchor}
              onChange={(e) => setSize('h', e.target.value)}
              onBlur={(e) => {
                setSize('h', e.target.value);
                clearBoxSizeAnchor();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setSize('h', (e.target as HTMLInputElement).value);
                  clearBoxSizeAnchor();
                }
              }}
            />
          </label>
        </Tooltip>
      ) : null}

      {hideExport ? null : <ExportSelectionPopover nodeIds={[nodeId]} />}
    </>
  );
}

export default memo(ShapeSelectionToolbar);
