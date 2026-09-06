import { useEffect, useMemo, useState, type ReactNode, memo } from 'react';

import { useTranslation } from 'react-i18next';
import { HiOutlineLink, HiOutlineLinkSlash } from 'react-icons/hi2';
import { Icon, message, DropdownPanel, DropdownPanelItem } from '@/components/base';
import Tooltip from '@/components/base/tooltip';
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
import {
  nodeLeftTop,
} from '@/components/rcb/scene/paint/sceneToSvg';
import {
  sceneToDocumentCoords,
  storedOriginForSceneResult,
} from '@/components/rcb/scene/paint/svgToScene';
import {
  addNodeToDocument,
  removeNodesFromDocument
} from '@/components/rcb/scene/document/sceneDocument';
import {
  createShapeNode
} from '@/components/rcb/scene/document/nodeFactories';
import {
  groupNodesInDocument,
  selectionSharedGroupId,
  ungroupNodesInDocument,
  unlockedGroupableIds,
} from '@/components/rcb/scene/document/sceneGroups';
import {
  resolveSelectionNodeIds
} from '@/components/rcb/scene/document/sceneClipboard';
import {
  supportsAspectPresets,
  supportsCornerRadius,
  supportsFill,
  supportsStroke,
  supportsBooleanOp,
  isOutlinedPath,
  isGeneratorNode,
} from '@/components/rcb/scene/document/nodeCapabilities';
import {
  ensureAnimationFrameMedia,
  openShapeStylePanel,
  patchDocumentNodes,
  setDocument,
  setMixedSelection,
  setSelectedNodeId,
  setSelectedNodeIds,
} from '@/store/modules/editor';
import { resolveBooleanResultFrameId } from '@/components/editor/nodes/AnimationNode/resolveAnimationFrameId';
import {
  tagCreatedNodeForWorkbenchSurround,
  WORKBENCH_SURROUND_ATTR,
} from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import { isAnimationArtboardKind } from '@/components/rcb/frames/types';
import { cn } from '@/utils/classnames';
import {
  SEL_ICON_BTN,
  SEL_ICON_BTN_ACTIVE,
  SEL_SIZE_INPUT,
  SEL_TOOL_BTN,
} from './ToolbarValueSlider';
import { FillColorSwatch, StrokeColorSwatch } from './StyleToolbarIcons';
import BlendModeControl from './BlendModeControl';
import { SelectionToolbarShell } from './SelectionToolbarShell';
import AspectRatioPresetMenu, {
  ELEMENT_ASPECT_PRESETS,
} from './AspectRatioPresetMenu';
import {
  matchAspectPresetKey,
  sizeFromAspectPreset,
} from '../resizeGeometry';
import { radiiFromAttrs } from '@/components/rcb/scene/document/sceneRadii';
import {
  computeShapeBoolean,
  applyBooleanResultPaint,
  type BoolMode,
} from '../shapeBoolean';
import { tidyLayoutPatches } from '../tidyLayout';
import type { SceneDocument, SceneNode, SceneNodeInput } from '@/components/rcb/sceneNode';

const ASPECT_ORIG_W = 'aspect-original-width';
const ASPECT_ORIG_H = 'aspect-original-height';

/** Match SelectionFeature: images default locked; others free unless attrs say so. */
function readNodeAspectLocked(node: SceneNodeInput): boolean {
  const raw = node?.attrs?.lockAspect;
  if (raw === true || raw === 'true' || raw === 1 || raw === '1') return true;
  if (raw === false || raw === 'false' || raw === 0 || raw === '0') return false;
  return node?.key === 'image';
}

/** Multi-select lock: on when selection includes images (unless any unlocked). */
function readMultiAspectLocked(document: SceneDocument, nodeIds: string[]): boolean {
  const nodes = nodeIds.map((id) => document?.deltaSetLike?.[id]).filter(Boolean);
  if (!nodes.length) return false;
  const hasExplicitUnlock = nodes.some((n) => {
    const raw = n?.attrs?.lockAspect;
    return raw === false || raw === 'false' || raw === 0 || raw === '0';
  });
  if (!hasExplicitUnlock && nodes.some((n) => n.key === 'image')) return true;
  return nodes.every((n) => readNodeAspectLocked(n));
}

type SceneBox = { left: number; top: number; width: number; height: number };

type Props = {
  document: SceneDocument;
  nodeIds: string[];
  /** Co-selected artboards — group/ungroup expand to content inside them. */
  frameIds?: string[];
  box: SceneBox;
  /** Control-box rotation — dock to visual AABB; toolbar stays upright. */
  angle?: number;
  /** Extra screen px beyond chrome for outer stroke ink. */
  edgePadScene?: number;
};

const btn = SEL_TOOL_BTN;
const iconBtn = SEL_ICON_BTN;

function Sep() {
  return <div className="mx-0.5 h-4 w-px shrink-0 bg-[var(--line)]" aria-hidden />;
}

type AlignMode = 'left' | 'centerX' | 'right' | 'top' | 'middle' | 'bottom';

type GeomPatch = {
  nodeId: string;
  patch: { x?: number; y?: number; width?: number; height?: number; attrs?: Record<string, unknown> };
};

type NodeBox = {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
  shapeType: string;
  fill: string;
  stroke: string;
  borderWidth: number;
  path?: string;
  angle?: number;
  sides?: number;
  attrs?: Record<string, unknown>;
};

/** Axis-aligned overlap (strict) — boolean ops need shared area to be meaningful. */
function sceneBoxesOverlap(a: SceneBox, b: SceneBox): boolean {
  return (
    a.left < b.left + b.width &&
    a.left + a.width > b.left &&
    a.top < b.top + b.height &&
    a.top + a.height > b.top
  );
}

/** True when at least one pair of shape AABBs overlaps. */
function selectionHasShapeOverlap(boxes: SceneBox[]): boolean {
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      if (sceneBoxesOverlap(boxes[i], boxes[j])) return true;
    }
  }
  return false;
}

function readBoxes(document: SceneDocument, nodeIds: string[]): NodeBox[] {
  return nodeIds
    .map((id) => {
      const node = document?.deltaSetLike?.[id];
      if (!node) return null;
      const { left, top } = nodeLeftTop(document, node);
      const pathRaw = node.attrs?.path != null ? String(node.attrs.path) : '';
      const angle = Number(node.attrs?.angle ?? 0) || 0;
      const sidesRaw = Number(node.attrs?.sides);
      return {
        id,
        left,
        top,
        width: Math.max(1, Number(node.width) || 1),
        height: Math.max(1, Number(node.height) || 1),
        shapeType: String(node.attrs?.shapeType || (node.key === 'shape' ? 'rect' : node.key || '')),
        fill: String(node.attrs?.['fill-color'] || '#FFFFFF'),
        stroke: String(node.attrs?.['border-color'] || '#333333'),
        borderWidth: Number(node.attrs?.['border-width'] ?? 1) || 1,
        path: pathRaw || undefined,
        angle,
        sides: Number.isFinite(sidesRaw) ? sidesRaw : undefined,
        // Keep radii / star / ellipse params so boolean samples the painted silhouette.
        attrs: node.attrs && typeof node.attrs === 'object' ? { ...node.attrs } : undefined,
      };
    })
    .filter(Boolean) as NodeBox[];
}

/** `assets/svg/editor/*.svg` — `<Icon name="editor-— />` */
const ALIGN_ITEMS: Array<{ mode: AlignMode; tipKey: string; icon: string }> = [
  { mode: 'left', tipKey: 'editor.selectionToolbar.alignLeft', icon: 'editor-align-left' },
  { mode: 'centerX', tipKey: 'editor.selectionToolbar.alignCenterX', icon: 'editor-align-center-x' },
  { mode: 'right', tipKey: 'editor.selectionToolbar.alignRight', icon: 'editor-align-right' },
  { mode: 'top', tipKey: 'editor.selectionToolbar.alignTop', icon: 'editor-align-top' },
  { mode: 'middle', tipKey: 'editor.selectionToolbar.alignMiddle', icon: 'editor-align-middle' },
  { mode: 'bottom', tipKey: 'editor.selectionToolbar.alignBottom', icon: 'editor-align-bottom' },
];

const BOOL_ITEMS: Array<{ mode: BoolMode; tipKey: string; labelKey: string; icon: string }> = [
  {
    mode: 'union',
    tipKey: 'editor.selectionToolbar.boolUnionShortcut',
    labelKey: 'editor.selectionToolbar.boolUnion',
    icon: 'editor-bool-union',
  },
  {
    mode: 'subtract',
    tipKey: 'editor.selectionToolbar.boolSubtract',
    labelKey: 'editor.selectionToolbar.boolSubtract',
    icon: 'editor-bool-subtract',
  },
  {
    mode: 'intersect',
    tipKey: 'editor.selectionToolbar.boolIntersect',
    labelKey: 'editor.selectionToolbar.boolIntersect',
    icon: 'editor-bool-intersect',
  },
  {
    mode: 'exclude',
    tipKey: 'editor.selectionToolbar.boolExclude',
    labelKey: 'editor.selectionToolbar.boolExclude',
    icon: 'editor-bool-exclude',
  },
];

const STYLE_SUPPORT = {
  fill: supportsFill,
  stroke: supportsStroke,
  radius: supportsCornerRadius,
} as const;

function toolbarIconBtn(
  tip: string,
  opts: {
    key?: string;
    onClick: () => void;
    active?: boolean;
    children: ReactNode;
    className?: string;
    expanded?: boolean;
  }
) {
  return (
    <Tooltip key={opts.key} tip={tip} placement="top">
      <button
        type="button"
        aria-label={tip}
        aria-expanded={opts.expanded}
        className={cn(iconBtn, opts.active && SEL_ICON_BTN_ACTIVE, opts.className)}
        onClick={opts.onClick}
      >
        {opts.children}
      </button>
    </Tooltip>
  );
}

function joinToolbarSections(parts: ReactNode[]) {
  const shown = parts.filter(Boolean);
  return shown.map((section, i) => (
    <div key={i} className="contents">
      {i > 0 ? <Sep /> : null}
      {section}
    </div>
  ));
}

function alignPatches(boxes: NodeBox[], mode: AlignMode): GeomPatch[] {
  if (boxes.length < 2) return [];
  const minL = Math.min(...boxes.map((b) => b.left));
  const maxR = Math.max(...boxes.map((b) => b.left + b.width));
  const minT = Math.min(...boxes.map((b) => b.top));
  const maxB = Math.max(...boxes.map((b) => b.top + b.height));
  const midX = (minL + maxR) / 2;
  const midY = (minT + maxB) / 2;
  return boxes.map((b) => {
    switch (mode) {
      case 'left':
        return { nodeId: b.id, patch: { x: minL } };
      case 'centerX':
        return { nodeId: b.id, patch: { x: midX - b.width / 2 } };
      case 'right':
        return { nodeId: b.id, patch: { x: maxR - b.width } };
      case 'top':
        return { nodeId: b.id, patch: { y: minT } };
      case 'middle':
        return { nodeId: b.id, patch: { y: midY - b.height / 2 } };
      case 'bottom':
        return { nodeId: b.id, patch: { y: maxB - b.height } };
      default:
        return { nodeId: b.id, patch: {} };
    }
  });
}

/** Even gaps along one axis; first/last stay put. */
function distributePatches(boxes: NodeBox[], axis: 'h' | 'v'): GeomPatch[] {
  if (boxes.length < 3) return [];
  const horizontal = axis === 'h';
  const sorted = [...boxes].sort((a, b) =>
    horizontal ? a.left - b.left : a.top - b.top
  );
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const totalSize = sorted.reduce((s, b) => s + (horizontal ? b.width : b.height), 0);
  const span = horizontal
    ? last.left + last.width - first.left - totalSize
    : last.top + last.height - first.top - totalSize;
  const gap = span / (sorted.length - 1);
  let cursor = horizontal ? first.left : first.top;
  const out: GeomPatch[] = [];
  sorted.forEach((b, i) => {
    if (i === 0) {
      cursor = (horizontal ? b.left + b.width : b.top + b.height) + gap;
      return;
    }
    if (i === sorted.length - 1) return;
    out.push({
      nodeId: b.id,
      patch: horizontal ? { x: cursor } : { y: cursor },
    });
    cursor += (horizontal ? b.width : b.height) + gap;
  });
  return out;
}

function scaleBoxesAroundCenter(
  boxes: NodeBox[],
  union: SceneBox,
  sx: number,
  sy: number
): GeomPatch[] {
  const cx = union.left + union.width / 2;
  const cy = union.top + union.height / 2;
  return boxes.map((b) => {
    const ncx = b.left + b.width / 2;
    const ncy = b.top + b.height / 2;
    const nw = Math.max(1, Math.round(b.width * sx));
    const nh = Math.max(1, Math.round(b.height * sy));
    return {
      nodeId: b.id,
      patch: {
        x: Math.round(cx + (ncx - cx) * sx - nw / 2),
        y: Math.round(cy + (ncy - cy) * sy - nh / 2),
        width: nw,
        height: nh,
      },
    };
  });
}

/** Multi-select floating bar: align inline; distribute / boolean in menus. */
function MultiSelectionToolbar({
  document,
  nodeIds,
  frameIds = [],
  box,
  angle = 0,
  edgePadScene = 0,
}: Props): ReactNode {
  const { t } = useTranslation();
  const [distributeOpen, setDistributeOpen] = useState(false);
  const [booleanOpen, setBooleanOpen] = useState(false);
  const [ratioOpen, setRatioOpen] = useState(false);

  /** Artboards co-selected: do not expand plate children into style ops. */
  const selectionHasFrames = (frameIds?.length ?? 0) > 0;
  const opNodeIds = useMemo(
    () =>
      selectionHasFrames
        ? (nodeIds || []).filter(Boolean)
        : resolveSelectionNodeIds(document, nodeIds, frameIds),
    [document, nodeIds, frameIds, selectionHasFrames]
  );

  const boxes = useMemo(() => readBoxes(document, opNodeIds), [document, opNodeIds]);
  const aspectLocked = useMemo(
    () => readMultiAspectLocked(document, opNodeIds),
    [document, opNodeIds]
  );

  const shapeBoxes = useMemo(
    () =>
      boxes.filter((b) => {
        const node = document?.deltaSetLike?.[b.id];
        return supportsBooleanOp(node);
      }),
    [boxes, document]
  );

  const allSupport = (pred: (node: SceneNodeInput) => boolean) =>
    opNodeIds.length > 0 &&
    opNodeIds.every((id) => pred(document?.deltaSetLike?.[id]));

  const showBoolean =
    shapeBoxes.length >= 2 &&
    allSupport(supportsBooleanOp) &&
    selectionHasShapeOverlap(shapeBoxes);
  const showStroke = allSupport(supportsStroke);
  const showFill = allSupport(supportsFill);
  const showCornerRadius =
    allSupport(supportsCornerRadius) &&
    opNodeIds.every((id) => !isOutlinedPath(document?.deltaSetLike?.[id]));
  const showAspectPresets = allSupport(supportsAspectPresets);
  const canAlign = boxes.length >= 2;
  const canTidy = boxes.length >= 2;
  const canDistribute = boxes.length >= 3;
  /** Generator plates: align/tidy only — no style / size / blend / group / export. */
  const allGenerators =
    opNodeIds.length > 0 &&
    opNodeIds.every((id) => isGeneratorNode(document?.deltaSetLike?.[id]));
  // Mixed with artboards / 动画: keep align only — opacity / blend / group are
  // node-style chrome and do not apply to plates (FrameMultiSelectionToolbar).
  const showStyleChrome =
    !selectionHasFrames && !allGenerators && (showFill || showStroke || showCornerRadius);
  const showGeometryChrome = !selectionHasFrames && !allGenerators;
  const showActionChrome = !selectionHasFrames && !allGenerators;

  const activeRatioId = useMemo(
    () => matchAspectPresetKey(box.width, box.height, ELEMENT_ASPECT_PRESETS),
    [box.width, box.height]
  );

  const applyPatches = (patches: GeomPatch[]) => {
    if (!patches.length) return;
    patchDocumentNodes({ patches });
  };

  const align = (mode: AlignMode) => {
    applyPatches(alignPatches(boxes, mode));
  };

  const distribute = (axis: 'h' | 'v') => {
    if (boxes.length < 3) {
      message.warning(t('editor.selectionToolbar.distributeNeed3'));
      return;
    }
    applyPatches(distributePatches(boxes, axis));
    setDistributeOpen(false);
  };

  const tidy = () => {
    if (boxes.length < 2) {
      message.warning(t('editor.selectionToolbar.tidyNeed2'));
      return;
    }
    applyPatches(tidyLayoutPatches(boxes));
    setDistributeOpen(false);
  };

  const runBoolean = (mode: BoolMode) => {
    if (shapeBoxes.length < 2) {
      message.warning(t('editor.selectionToolbar.boolNeed2'));
      return;
    }
    if (!selectionHasShapeOverlap(shapeBoxes)) {
      message.warning(t('editor.selectionToolbar.boolNoOverlap'));
      return;
    }

    const ids = shapeBoxes.map((b) => b.id);
    const { result, usedFallback, hasNonRect } = computeShapeBoolean(shapeBoxes, mode);

    if (!result) {
      if (mode === 'intersect') {
        message.warning(t('editor.selectionToolbar.boolNoOverlap'));
      } else if (mode === 'subtract') {
        message.warning(t('editor.selectionToolbar.boolSubtractEmpty'));
      } else {
        message.warning(t('editor.selectionToolbar.boolFailed'));
      }
      return;
    }

    if (usedFallback && hasNonRect) {
      message.warning(t('editor.selectionToolbar.boolApprox'));
    }

    const sample =
      shapeBoxes.find((b) => {
        const a = b.attrs || {};
        const fill = String(a['fill-color'] || b.fill || '');
        return (
          fill &&
          fill !== 'transparent' &&
          fill !== 'none' &&
          a['fill-enabled'] !== false &&
          a['fill-enabled'] !== 'false'
        );
      }) ||
      shapeBoxes.find((b) => {
        const a = b.attrs || {};
        return (
          a['stroke-enabled'] !== false &&
          a['stroke-enabled'] !== 'false' &&
          Number(a['border-width'] ?? b.borderWidth) > 0
        );
      }) ||
      shapeBoxes[0];
    const sampleNode = document?.deltaSetLike?.[sample.id];
    // Prefer a shared frameId from operands (paint sample may lack it).
    const operandFrameIds = shapeBoxes
      .map((b) => String(document?.deltaSetLike?.[b.id]?.attrs?.frameId || '').trim())
      .filter(Boolean);
    const abs = sceneToDocumentCoords(document, result.x, result.y);
    const frameId = resolveBooleanResultFrameId(
      document,
      operandFrameIds,
      abs.x + result.width / 2,
      abs.y + result.height / 2
    );
    // frameLocal: plate-relative x/y (not world abs — that shifts by artboard origin).
    const origin = storedOriginForSceneResult(document, result.x, result.y, frameId);
    const { id, node } = createShapeNode({
      x: origin.x,
      y: origin.y,
      width: result.width,
      height: result.height,
      shapeType: 'path',
      fill: sample.fill,
      stroke: sample.stroke,
      borderWidth: sample.borderWidth,
      path: result.path,
      closed: true,
    });
    const attrs = node.attrs as Record<string, unknown>;
    attrs['fill-rule'] = result.fillRule;
    attrs.closed = 'true';
    // Same as 轮廓——densified boolean path: no corner-radius chrome.
    attrs.outlined = 'true';
    // Bind only when the result sits inside the plate — never force timeline focus.
    if (frameId) {
      attrs.frameId = frameId;
      const orders = shapeBoxes
        .map((b) => Number(document?.deltaSetLike?.[b.id]?.attrs?.frameOrder))
        .filter(Number.isFinite);
      if (orders.length) attrs.frameOrder = Math.max(...orders) + 1;
      // Result is inside the plate — never mark as workbench surround pasteboard.
      delete attrs[WORKBENCH_SURROUND_ATTR];
    }
    applyBooleanResultPaint(
      attrs,
      sampleNode?.attrs as Record<string, unknown> | undefined,
      { stroke: sample.stroke, borderWidth: sample.borderWidth, fill: sample.fill }
    );

    let next = addNodeToDocument(document, id, node);
    next = removeNodesFromDocument(next, ids);
    // Outside the plate while timeline is open — pasteboard surround, not a track layer.
    if (!frameId) {
      next = tagCreatedNodeForWorkbenchSurround(next, id);
    }
    setDocument(next);
    if (frameId) {
      const frame = (next.frames || []).find((f) => String(f?.id) === frameId);
      if (frame && isAnimationArtboardKind(frame.kind)) {
        ensureAnimationFrameMedia({ frameId });
      }
    }
    setSelectedNodeIds([id]);
    setSelectedNodeId(id);
    setDistributeOpen(false);
    setBooleanOpen(false);
  };

  useEffect(() => {
    if (!showBoolean) setBooleanOpen(false);
  }, [showBoolean]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.altKey) return;
      if (e.key.toLowerCase() !== 'u') return;
      if (!showBoolean) return;
      e.preventDefault();
      runBoolean('union');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document, shapeBoxes, showBoolean]);

  useEffect(() => {
    if (!distributeOpen && !booleanOpen) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('[data-multi-toolbar-menu]')) return;
      setDistributeOpen(false);
      setBooleanOpen(false);
    };
    window.addEventListener('pointerdown', onPointer, true);
    return () => window.removeEventListener('pointerdown', onPointer, true);
  }, [distributeOpen, booleanOpen]);

  const openStyle = (kind: keyof typeof STYLE_SUPPORT) => {
    const ids = opNodeIds.filter((id) => STYLE_SUPPORT[kind](document?.deltaSetLike?.[id]));
    if (!ids.length) return;
    openShapeStylePanel({ kind, nodeIds: ids });
  };

  const toggleAspectLock = () => {
    const next = aspectLocked ? 'false' : 'true';
    applyPatches(
      opNodeIds.map((id) => {
        const shapeType = document?.deltaSetLike?.[id]?.attrs?.shapeType;
        return {
          nodeId: id,
          patch: {
            attrs: {
              ...(shapeType != null ? { shapeType } : {}),
              lockAspect: next,
            },
          },
        };
      })
    );
  };

  const setSize = (axis: 'w' | 'h', raw: string) => {
    if (!box) return;
    const trimmed = String(raw || '').trim();
    if (!trimmed) return;
    const n = Math.round(Number(trimmed));
    if (!Number.isFinite(n) || n < 1) return;
    // Toolbar shows Math.round(chrome); blur with the same digits must be a no-op
    // (otherwise sx = round(w)/w quietly shrinks/grows the path).
    if (axis === 'w' && n === Math.round(box.width)) return;
    if (axis === 'h' && n === Math.round(box.height)) return;
    const oldW = Math.max(1, box.width);
    const oldH = Math.max(1, box.height);
    let newW = oldW;
    let newH = oldH;
    if (aspectLocked) {
      const ratio = oldW / oldH;
      if (axis === 'w') {
        newW = n;
        newH = Math.max(1, Math.round(n / ratio));
      } else {
        newH = n;
        newW = Math.max(1, Math.round(n * ratio));
      }
    } else if (axis === 'w') {
      newW = n;
    } else {
      newH = n;
    }
    applyPatches(scaleBoxesAroundCenter(boxes, box, newW / oldW, newH / oldH));
  };

  if (!boxes.length || !box) return null;

  const fillSourceId =
    opNodeIds.find((id) => supportsFill(document?.deltaSetLike?.[id])) || opNodeIds[0];
  const firstAttrs = document?.deltaSetLike?.[fillSourceId]?.attrs || {};
  const fillSample: FillPanelValue = {
    fillType: parseFillType(firstAttrs['fill-type']),
    fillColor: String(firstAttrs['fill-color'] || '#FFFFFF'),
    fillOpacity: Number(firstAttrs['fill-opacity'] ?? 100),
    fillGradient:
      firstAttrs['fill-gradient'] != null ? String(firstAttrs['fill-gradient']) : undefined,
    ...fillImageFieldsFromAttrs(firstAttrs),
  };
  const fillVisible = opNodeIds
    .filter((id) => supportsFill(document?.deltaSetLike?.[id]))
    .every((id) => {
      const a = document?.deltaSetLike?.[id]?.attrs || {};
      return boolEffectAttr(a['fill-enabled'], true) && boolEffectAttr(a['fill-visible'], true);
    });
  const fillPreview = fillVisible ? fillPanelPreview(fillSample) : 'transparent';
  const strokeVisible = opNodeIds.every((id) => {
    const a = document?.deltaSetLike?.[id]?.attrs || {};
    return (
      boolEffectAttr(a['stroke-enabled'], true) && boolEffectAttr(a['stroke-visible'], true)
    );
  });
  const strokeColor = String(firstAttrs['border-color'] || '#333333');
  const radiusSample = radiiFromAttrs(firstAttrs).tl;

  const groupId = selectionSharedGroupId(document, opNodeIds);

  const createGroup = () => {
    const ids = unlockedGroupableIds(document, opNodeIds);
    if (ids.length < 2) return;
    const next = groupNodesInDocument(document, ids);
    setDocument(next);
    setMixedSelection({ nodeIds: ids, frameIds });
  };

  const ungroup = () => {
    const ids = unlockedGroupableIds(document, opNodeIds);
    if (!ids.length) return;
    const next = ungroupNodesInDocument(document, ids);
    setDocument(next);
    setMixedSelection({ nodeIds: ids, frameIds });
  };

  const applyAspectPreset = (preset: (typeof ELEMENT_ASPECT_PRESETS)[number]) => {
    if (preset.id === 'original') {
      applyPatches(
        boxes.map((b) => {
          const shapeType = document?.deltaSetLike?.[b.id]?.attrs?.shapeType;
          return {
            nodeId: b.id,
            patch: {
              attrs: {
                ...(shapeType != null ? { shapeType } : {}),
                lockAspect: 'false',
              },
            },
          };
        })
      );
      return;
    }
    const unionNext = sizeFromAspectPreset(box, preset.w, preset.h);
    const geom = scaleBoxesAroundCenter(
      boxes,
      box,
      unionNext.width / Math.max(1, box.width),
      unionNext.height / Math.max(1, box.height)
    );
    applyPatches(
      geom.map((p, i) => {
        const b = boxes[i];
        const node = document?.deltaSetLike?.[b.id];
        const hasOrig =
          Number(node?.attrs?.[ASPECT_ORIG_W]) > 0 &&
          Number(node?.attrs?.[ASPECT_ORIG_H]) > 0;
        const shapeType = node?.attrs?.shapeType;
        return {
          nodeId: p.nodeId,
          patch: {
            ...p.patch,
            attrs: {
              ...(shapeType != null ? { shapeType } : {}),
              lockAspect: 'true',
              ...(!hasOrig
                ? {
                    [ASPECT_ORIG_W]: Math.round(b.width),
                    [ASPECT_ORIG_H]: Math.round(b.height),
                  }
                : {}),
            },
          },
        };
      })
    );
  };

  // Selected group: ungroup | export
  if (groupId) {
    return (
      <SelectionToolbarShell box={box} angle={angle} edgePadScene={edgePadScene}>
        <Tooltip tip={t('editor.selectionToolbar.ungroup')} placement="top">
          <button
            type="button"
            className={btn}
            aria-label={t('editor.selectionToolbar.ungroup')}
            onClick={ungroup}
          >
            <Icon name="editor-ungroup" width={14} height={14} />
            <span>{t('editor.selectionToolbar.ungroup')}</span>
          </button>
        </Tooltip>
        <Sep />
        <ExportSelectionPopover nodeIds={opNodeIds} />
      </SelectionToolbarShell>
    );
  }

  const styleItems = [
    showStyleChrome &&
      showFill &&
      toolbarIconBtn(t('editor.selectionToolbar.fill'), {
        key: 'fill',
        onClick: () => openStyle('fill'),
        className: !fillVisible ? 'opacity-55' : undefined,
        children: <FillColorSwatch color={fillPreview} />,
      }),
    showStyleChrome &&
      showStroke &&
      toolbarIconBtn(t('editor.selectionToolbar.stroke'), {
        key: 'stroke',
        onClick: () => openStyle('stroke'),
        className: !strokeVisible ? 'opacity-55' : undefined,
        children: (
          <StrokeColorSwatch color={strokeVisible ? strokeColor : 'var(--line)'} />
        ),
      }),
    showStyleChrome &&
      showCornerRadius && (
      <Tooltip key="radius" tip={t('editor.selectionToolbar.cornerRadius')} placement="top">
        <button
          type="button"
          aria-label={t('editor.selectionToolbar.cornerRadius')}
          className={SEL_TOOL_BTN}
          onClick={() => openStyle('radius')}
        >
          <Icon name="editor-corner-radius" width={16} height={16} />
          <span className="tabular-nums">{radiusSample}</span>
        </button>
      </Tooltip>
    ),
  ].filter(Boolean);

  const layoutItems = [
    (canTidy || canAlign) && (
      <div
        key="align"
        className="flex flex-nowrap items-center gap-0.5"
        role="group"
        aria-label={t('editor.selectionToolbar.align')}
      >
        {canTidy
          ? toolbarIconBtn(t('editor.selectionToolbar.tidy'), {
              key: 'tidy',
              onClick: tidy,
              children: <Icon name="editor-tidy-up" width={16} height={16} />,
            })
          : null}
        {canAlign
          ? ALIGN_ITEMS.map(({ mode, tipKey, icon }) =>
              toolbarIconBtn(t(tipKey), {
                key: mode,
                onClick: () => align(mode),
                children: <Icon name={icon} width={16} height={16} />,
              })
            )
          : null}
      </div>
    ),
    canDistribute && (
      <div key="distribute" className="relative" data-multi-toolbar-menu>
        {toolbarIconBtn(t('editor.selectionToolbar.distribute'), {
          key: 'distribute-btn',
          active: distributeOpen,
          onClick: () => {
            setBooleanOpen(false);
            setDistributeOpen((v) => !v);
          },
          children: <Icon name="editor-distribute" width={16} height={16} />,
        })}
        {distributeOpen && (
          <DropdownPanel className="absolute left-0 top-[calc(100%+6px)] z-40 min-w-[9rem]">
            <DropdownPanelItem onClick={() => distribute('h')}>
              {t('editor.selectionToolbar.distributeH')}
            </DropdownPanelItem>
            <DropdownPanelItem onClick={() => distribute('v')}>
              {t('editor.selectionToolbar.distributeV')}
            </DropdownPanelItem>
          </DropdownPanel>
        )}
      </div>
    ),
  ].filter(Boolean);

  const booleanMenu = showBoolean && (
    <div className="relative" data-multi-toolbar-menu>
      {toolbarIconBtn(t('editor.selectionToolbar.boolean'), {
        active: booleanOpen,
        expanded: booleanOpen,
        onClick: () => {
          setDistributeOpen(false);
          setBooleanOpen((v) => !v);
        },
        children: <Icon name="editor-bool-union" width={16} height={16} />,
      })}
      {booleanOpen && (
        <DropdownPanel className="absolute left-0 top-[calc(100%+6px)] z-40 min-w-[10.5rem]">
          {BOOL_ITEMS.map(({ mode, tipKey, labelKey, icon }) => (
            <DropdownPanelItem
              key={mode}
              onClick={() => runBoolean(mode)}
              className="gap-2"
              title={t(tipKey)}
            >
              <Icon name={icon} width={16} height={16} className="text-[var(--ink)]" />
              <span>{t(labelKey)}</span>
            </DropdownPanelItem>
          ))}
        </DropdownPanel>
      )}
    </div>
  );

  const sizeField = (axis: 'w' | 'h', value: number) => (
    <label className="inline-flex h-8 items-center gap-1 rounded-lg px-1.5 text-[12px] text-[var(--ink)]">
      <span className="text-[var(--muted)]">{axis.toUpperCase()}</span>
      <input
        className={SEL_SIZE_INPUT}
        defaultValue={Math.round(value)}
        key={`${axis}-${Math.round(value)}`}
        onPointerDown={(e) => e.stopPropagation()}
        onBlur={(e) => setSize(axis, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') setSize(axis, (e.target as HTMLInputElement).value);
        }}
      />
    </label>
  );

  const geometryCluster = showGeometryChrome ? (
    <>
      {showAspectPresets && (
        <AspectRatioPresetMenu
          open={ratioOpen}
          onOpenChange={setRatioOpen}
          activeId={activeRatioId}
          onPick={applyAspectPreset}
        />
      )}
      {sizeField('w', box.width)}
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
          onClick={toggleAspectLock}
        >
          {aspectLocked ? (
            <HiOutlineLink className="h-3.5 w-3.5" strokeWidth={1.75} />
          ) : (
            <HiOutlineLinkSlash className="h-3.5 w-3.5" strokeWidth={1.75} />
          )}
        </button>
      </Tooltip>
      {sizeField('h', box.height)}
      <BlendModeControl
        blendMode={firstAttrs.blendMode}
        opacity={firstAttrs.opacity}
        allowPassThrough={opNodeIds.every(
          (id) => document?.deltaSetLike?.[id]?.key === 'frame'
        )}
        onBlendModeChange={(mode) => {
          applyPatches(
            opNodeIds.map((id) => ({ nodeId: id, patch: { attrs: { blendMode: mode } } }))
          );
        }}
        onOpacityChange={(opacity) => {
          applyPatches(
            opNodeIds.map((id) => ({ nodeId: id, patch: { attrs: { opacity } } }))
          );
        }}
      />
    </>
  ) : null;

  const actionCluster = showActionChrome ? (
    <>
      {opNodeIds.length >= 2 && (
        <Tooltip tip={t('editor.selectionToolbar.createGroup')} placement="top">
          <button
            type="button"
            className={btn}
            aria-label={t('editor.selectionToolbar.createGroup')}
            onClick={createGroup}
          >
            <Icon name="editor-group" width={14} height={14} />
            <span>{t('editor.selectionToolbar.createGroup')}</span>
          </button>
        </Tooltip>
      )}
      <ExportSelectionPopover nodeIds={opNodeIds} />
    </>
  ) : null;

  const sections = joinToolbarSections([
    styleItems.length ? <>{styleItems}</> : null,
    layoutItems.length ? (
      <div className="flex flex-nowrap items-center gap-0.5">{layoutItems}</div>
    ) : null,
    booleanMenu,
    geometryCluster,
    actionCluster,
  ]);
  // Mixed artboards strip node chrome — do not leave an empty FloatingToolbar pill.
  if (!sections.length) return null;

  return (
    <SelectionToolbarShell box={box} angle={angle} edgePadScene={edgePadScene}>
      {sections}
    </SelectionToolbarShell>
  );
}

export default memo(MultiSelectionToolbar);
