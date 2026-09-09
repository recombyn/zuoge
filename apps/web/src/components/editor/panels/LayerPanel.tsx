import { useEffect, useMemo, useRef, useState, useDeferredValue, type ComponentType, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, memo } from 'react';
import { useSelector } from '@/store';
import {
  useActiveFrameId,
  useEditorDocumentOnCommit,
  useSelectedFrameIds,
  useSelectedNodeId,
  useSelectedNodeIds,
} from '@/store/editorSelectors';
import { useTranslation } from 'react-i18next';
import { FiPenTool } from 'react-icons/fi';
import {
  LuAudioLines,
  LuFrame,
  LuPanelLeft,
  LuPencil,
  LuHexagon,
  LuImagePlus,
  LuLayoutGrid,
} from 'react-icons/lu';
import { RiVideoAiLine } from 'react-icons/ri';
import { RxText } from 'react-icons/rx';
import { AnimationOutlineIcon } from '@/components/editor/nodes/AnimationNode/AnimationOutlineIcon';
import {
  HiOutlineChevronDown,
  HiOutlineChevronLeft,
  HiOutlineChevronUp,
  HiOutlineEye,
  HiOutlineEyeSlash,
  HiOutlineLockClosed,
  HiOutlineLockOpen,
  HiOutlineMinus,
  HiOutlinePhoto,
  HiOutlineStop,
  HiOutlineVideoCamera,
} from 'react-icons/hi2';
import { TbArrowUpRight, TbCircle, TbStar, TbTriangle } from 'react-icons/tb';
import Tooltip from '@/components/base/tooltip';
import { VirtualList, type VirtualListHandle } from '@/components/base/VirtualList';
import {
  isGeneratorNode,
  isImageGeneratorNode,
  isAudioGeneratorNode,
  isAnimationFrameHostNode,
  isLottieGeneratorNode,
  isVideoGeneratorNode,
  isNodeHidden,
  isNodeLocked
} from '@/components/rcb/scene/document/nodeCapabilities';
import { isAnimationArtboardKind } from '@/components/rcb/frames/types';
import {
  getAnimationWorkbenchTimelineFocus,
  isArtboardVisibleInDocument,
  isHiddenByAnimationWorkbenchFocus,
} from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import {
  listSceneNodes,
  parseStackKey,
  stackNodeKey,
} from '@/components/rcb/scene/document/sceneDocument';
import { nodeIdsBoundToFrames } from '@/components/rcb/scene/document/sceneClipboard';
import { cn } from '@/utils/classnames';
import {
  patchDocumentNode,
  setActiveFrameId,
  setFrameChromeMode,
  setSelectedNodeId,
  updateArtboardFrame,
} from '@/store/modules/editor';

type LayerStackRow =
  | { kind: 'frame' | 'node'; id: string }
  | { kind: 'pasteboard' };

function getStackOrder(document: any): string[] {
  return Array.isArray(document?.stackOrder) ? document.stackOrder.map(String) : [];
}

/** Match canvas structural hide for layer chrome (edit-mode focus + hosts). */
function isLayerRowNodeVisible(document: any, node: any): boolean {
  if (!node) return false;
  if (isAnimationFrameHostNode(node, document)) return false;
  if (isHiddenByAnimationWorkbenchFocus(node)) return false;
  return true;
}

function listRootLayerRows(opts: {
  document: any;
  frameById: Map<string, any>;
  frames: any[];
  nodeById: Map<string, any>;
  nodes: Array<{ id: string; node: any }>;
}): LayerStackRow[] {
  const { document, frameById, frames, nodeById, nodes } = opts;
  const order = getStackOrder(document);
  const rows: LayerStackRow[] = [];
  if (order.length) {
    for (const key of [...order].reverse()) {
      const parsed = parseStackKey(key);
      if (parsed?.kind === 'frame' && frameById.has(parsed.id)) {
        const frame = frameById.get(parsed.id);
        if (!isArtboardVisibleInDocument(frame)) continue;
        rows.push(parsed);
      }
    }
  } else {
    for (const f of [...frames].reverse()) {
      if (!f?.id) continue;
      if (!isArtboardVisibleInDocument(f)) continue;
      rows.push({ kind: 'frame', id: String(f.id) });
    }
  }
  const pasteboardRows = listPasteboardLayerRows({ document, nodeById, nodes });
  // Edit mode: omit empty pasteboard row (other plates already filtered above).
  if (pasteboardRows.length || !getAnimationWorkbenchTimelineFocus()) {
    rows.push({ kind: 'pasteboard' });
  }
  return rows;
}

function listPasteboardLayerRows(opts: {
  document: any;
  nodeById: Map<string, any>;
  nodes: Array<{ id: string; node: any }>;
}): LayerStackRow[] {
  const { document, nodeById, nodes } = opts;
  const order = getStackOrder(document);
  const rows: LayerStackRow[] = [];
  if (order.length) {
    for (const key of [...order].reverse()) {
      const parsed = parseStackKey(key);
      if (parsed?.kind !== 'node' || !nodeById.has(parsed.id)) continue;
      const node = nodeById.get(parsed.id);
      if (String(node?.attrs?.frameId || '').trim()) continue;
      if (!isLayerRowNodeVisible(document, node)) continue;
      rows.push(parsed);
    }
    return rows;
  }
  for (const { id, node } of [...nodes].reverse()) {
    if (String(node?.attrs?.frameId || '').trim()) continue;
    if (!isLayerRowNodeVisible(document, node)) continue;
    rows.push({ kind: 'node', id });
  }
  return rows;
}

function listFrameChildLayerRows(
  document: any,
  frameId: string,
  nodeById: Map<string, any>
): LayerStackRow[] {
  if (!document || !frameId) return [];
  const ids = nodeIdsBoundToFrames(document, [frameId]).filter((id) =>
    isLayerRowNodeVisible(document, nodeById.get(id))
  );
  const sorted = [...ids].sort((a, b) => {
    const ao = Number(nodeById.get(a)?.attrs?.frameOrder);
    const bo = Number(nodeById.get(b)?.attrs?.frameOrder);
    const aOrder = Number.isFinite(ao) ? ao : 0;
    const bOrder = Number.isFinite(bo) ? bo : 0;
    if (aOrder !== bOrder) return bOrder - aOrder;
    const order = getStackOrder(document);
    return order.indexOf(stackNodeKey(b)) - order.indexOf(stackNodeKey(a));
  });
  return sorted.map((id) => ({ kind: 'node' as const, id }));
}

type LayerScope = 'root' | 'frame' | 'pasteboard';

type LayerNav =
  | { scope: 'root'; pinned?: boolean }
  | { scope: 'frame'; frameId: string }
  | { scope: 'pasteboard' };

function resolveLayerView(
  nav: LayerNav,
  selectedNodeFrameId: string | null,
  selectedNodeIsPasteboard: boolean
): { scope: LayerScope; frameId: string | null } {
  if (nav.scope === 'root' && nav.pinned) {
    return { scope: 'root', frameId: null };
  }
  if (nav.scope === 'frame') {
    return { scope: 'frame', frameId: nav.frameId };
  }
  if (nav.scope === 'pasteboard') {
    return { scope: 'pasteboard', frameId: null };
  }
  if (selectedNodeFrameId) {
    return { scope: 'frame', frameId: selectedNodeFrameId };
  }
  if (selectedNodeIsPasteboard) {
    return { scope: 'pasteboard', frameId: null };
  }
  return { scope: 'root', frameId: null };
}

function syncLayerNavFromSelection(
  setLayerNav: (value: LayerNav | ((prev: LayerNav) => LayerNav)) => void,
  setEditingFrameId: (value: string | null) => void,
  opts: {
    selectedNodeFrameId: string | null;
    selectedNodeIsPasteboard: boolean;
    selectedNodeId: string | null;
    selectedFrameIds: string[];
    activeFrameId: string | null | undefined;
  }
) {
  if (opts.selectedNodeFrameId) {
    setLayerNav({ scope: 'frame', frameId: opts.selectedNodeFrameId });
    return;
  }
  if (opts.selectedNodeIsPasteboard) {
    setLayerNav({ scope: 'pasteboard' });
    return;
  }
  if (
    isCanvasDeselected(opts.selectedNodeId, opts.selectedFrameIds, opts.activeFrameId)
  ) {
    setEditingFrameId(null);
    setLayerNav((prev) => (prev.scope === 'root' ? prev : { scope: 'root', pinned: true }));
  }
}

function listRowsForScope(
  scope: LayerScope,
  frameId: string | null,
  opts: {
    document: any;
    frameById: Map<string, any>;
    frames: any[];
    nodeById: Map<string, any>;
    nodes: Array<{ id: string; node: any }>;
  }
): LayerStackRow[] {
  if (scope === 'frame' && frameId) {
    return listFrameChildLayerRows(opts.document, frameId, opts.nodeById);
  }
  if (scope === 'pasteboard') {
    return listPasteboardLayerRows({
      document: opts.document,
      nodeById: opts.nodeById,
      nodes: opts.nodes,
    });
  }
  return listRootLayerRows({
    document: opts.document,
    frameById: opts.frameById,
    frames: opts.frames,
    nodeById: opts.nodeById,
    nodes: opts.nodes,
  });
}

function isNestedLayerScope(scope: LayerScope): boolean {
  return scope === 'frame' || scope === 'pasteboard';
}

function layerScopeTitle(
  scope: LayerScope,
  scopedFrame: { name?: string } | undefined,
  t: (key: string, opts?: { defaultValue?: string }) => string
): string {
  if (scope === 'pasteboard') return t('editor.pasteboard');
  return String(scopedFrame?.name || t('editor.tools.frame') || 'Frame');
}

function isCanvasDeselected(
  selectedNodeId: string | null,
  selectedFrameIds: string[],
  activeFrameId: string | null | undefined
): boolean {
  return !selectedNodeId && selectedFrameIds.length === 0 && !activeFrameId;
}

function isLayerRowSelected(
  row: LayerStackRow,
  selectedNodeId: string | null,
  selectedFrameIds: string[],
  activeFrameId: string | null | undefined
): boolean {
  if (row.kind === 'frame') {
    return (
      selectedFrameIds.includes(row.id) ||
      (!selectedFrameIds.length && activeFrameId === row.id)
    );
  }
  if (row.kind === 'node') return selectedNodeId === row.id;
  return false;
}

function findLayerScrollIndex(
  layerRows: LayerStackRow[],
  layerScope: LayerScope,
  selectedNodeId: string | null,
  selectedFrameIds: string[],
  activeFrameId: string | null | undefined
): number {
  if (selectedNodeId) {
    return layerRows.findIndex((r) => r.kind === 'node' && r.id === selectedNodeId);
  }
  if (layerScope !== 'root') return -1;
  const frameId = selectedFrameIds[0] || activeFrameId;
  if (!frameId) return -1;
  return layerRows.findIndex((r) => r.kind === 'frame' && r.id === frameId);
}

function layerRowKey(row: LayerStackRow): string {
  return row.kind === 'pasteboard' ? 'pasteboard' : `${row.kind}-${row.id}`;
}

const LAYER_ROW_SURFACE =
  'group flex min-h-[36px] w-full items-center gap-1 px-2 py-0.5 text-[13px] transition-colors';

function layerRowSurfaceClass(selected: boolean): string {
  return cn(
    LAYER_ROW_SURFACE,
    selected
      ? 'bg-[var(--accent-soft)] text-[var(--ink)]'
      : 'text-[var(--muted)] hover:bg-[var(--accent-soft)] hover:text-[var(--ink)]'
  );
}

const LAYER_ROW_ACTION =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-[var(--muted)] transition hover:bg-[var(--surface)] hover:text-[var(--ink)]';

function layerRowActionClass(active: boolean, selected: boolean, disabled = false): string {
  return cn(
    LAYER_ROW_ACTION,
    disabled &&
      'disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[var(--muted)]',
    !disabled && !active && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
    !disabled && selected && !active && 'opacity-100'
  );
}

function stopDblClick(e: ReactMouseEvent, fn: () => void) {
  e.preventDefault();
  e.stopPropagation();
  fn();
}

function selectContentEditable(el: HTMLElement) {
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

const LAYER_ROW_ESTIMATE_PX = 36;

const LAYER_DOCK_WIDTH_KEY = 'layer-dock-width';
const LAYER_DOCK_MIN_W = 180;
const LAYER_DOCK_MAX_W = 420;
const LAYER_DOCK_DEFAULT_W = 220;

function clampLayerDockWidth(width: number): number {
  const viewportCap =
    typeof window !== 'undefined'
      ? Math.max(LAYER_DOCK_MIN_W, window.innerWidth - 360)
      : LAYER_DOCK_MAX_W;
  return Math.min(
    LAYER_DOCK_MAX_W,
    viewportCap,
    Math.max(LAYER_DOCK_MIN_W, Math.round(width))
  );
}

function writeLayerDockWidth(width: number) {
  try {
    localStorage.setItem(LAYER_DOCK_WIDTH_KEY, String(width));
  } catch {
    /* ignore */
  }
}

/** Current layer dock width (for offsetting overlapping chrome). */
export function getLayerDockWidth(): number {
  try {
    const raw = localStorage.getItem(LAYER_DOCK_WIDTH_KEY);
    if (!raw) return LAYER_DOCK_DEFAULT_W;
    const n = Number(raw);
    if (!Number.isFinite(n)) return LAYER_DOCK_DEFAULT_W;
    return clampLayerDockWidth(n);
  } catch {
    return LAYER_DOCK_DEFAULT_W;
  }
}

type LayerIconComponent = ComponentType<{ className?: string }>;

const LAYER_ICON_SLOT =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded text-[var(--muted)]';

const layerIconByKind: Record<string, LayerIconComponent> = {
  text: RxText,
  image: HiOutlinePhoto,
  rect: HiOutlineStop,
  line: HiOutlineMinus,
  arrow: TbArrowUpRight,
  circle: TbCircle,
  triangle: TbTriangle,
  star: TbStar,
  polygon: LuHexagon,
  pen: FiPenTool,
  pencil: LuPencil,
  path: FiPenTool,
};

const layerIconSizeByKind: Record<string, string> = {
  text: 'h-[14px] w-[14px]',
  image: 'h-[12px] w-[12px]',
  rect: 'h-[12px] w-[12px]',
  line: 'h-[11px] w-[16px]',
  arrow: 'h-[13px] w-[13px]',
  circle: 'h-[16px] w-[16px]',
  triangle: 'h-[14px] w-[14px]',
  star: 'h-[14px] w-[14px]',
  polygon: 'h-[13px] w-[13px]',
  pen: 'h-[14px] w-[14px]',
  pencil: 'h-[14px] w-[14px]',
  path: 'h-[14px] w-[14px]',
};

function resolveLayerIconKind(node: { key: string; attrs?: { shapeType?: string } }) {
  const shapeType = String(node.attrs?.shapeType || '').trim().toLowerCase();
  if (shapeType) return shapeType;
  if (node.key === 'shape') return 'rect';
  return String(node.key || 'rect').trim().toLowerCase() || 'rect';
}

function readLayerMediaSrc(attrs: Record<string, unknown> | undefined) {
  return String(attrs?.src || '').trim();
}

function readLayerPoster(attrs: Record<string, unknown> | undefined) {
  return String(attrs?.poster || '').trim();
}

function LayerMediaThumb({
  src,
  poster,
  kind,
}: {
  src?: string;
  poster?: string;
  kind: 'image' | 'video';
}) {
  const imageSrc = kind === 'video' ? poster || '' : src || '';
  if (imageSrc) {
    return (
      <span className={LAYER_ICON_SLOT}>
        <img src={imageSrc} alt="" className="h-full w-full object-cover" draggable={false} />
      </span>
    );
  }
  if (kind === 'video' && src) {
    return (
      <span className={LAYER_ICON_SLOT}>
        <video
          src={src}
          muted
          playsInline
          preload="metadata"
          className="h-full w-full object-cover"
        />
      </span>
    );
  }
  return null;
}

function LayerGlyphFallback({ children }: { children: ReactNode }) {
  return <span className={LAYER_ICON_SLOT}>{children}</span>;
}

function renderVideoLayerThumb(src: string, poster: string) {
  if (!poster && !src) return null;
  return <LayerMediaThumb kind="video" src={src} poster={poster} />;
}

function LayerIcon({
  node,
  filled,
}: {
  node: {
    key: string;
    attrs?: {
      shapeType?: string;
      ['fill-color']?: string;
      imageGenerator?: unknown;
      videoGenerator?: unknown;
      src?: unknown;
      poster?: unknown;
      name?: unknown;
    };
  };
  filled?: boolean;
}) {
  const src = readLayerMediaSrc(node.attrs as Record<string, unknown> | undefined);
  const poster = readLayerPoster(node.attrs as Record<string, unknown> | undefined);

  if (isImageGeneratorNode(node)) {
    const thumb = src ? <LayerMediaThumb kind="image" src={src} /> : null;
    if (thumb) return thumb;
    return (
      <LayerGlyphFallback>
        <LuImagePlus className="block h-[13px] w-[13px] shrink-0" strokeWidth={1.75} />
      </LayerGlyphFallback>
    );
  }

  if (isVideoGeneratorNode(node)) {
    const thumb = renderVideoLayerThumb(src, poster);
    if (thumb) return thumb;
    return (
      <LayerGlyphFallback>
        <RiVideoAiLine className="block h-[13px] w-[13px] shrink-0" />
      </LayerGlyphFallback>
    );
  }

  if (isLottieGeneratorNode(node)) {
    return (
      <LayerGlyphFallback>
        <AnimationOutlineIcon className="block h-[13px] w-[13px] shrink-0" strokeWidth={1.75} />
      </LayerGlyphFallback>
    );
  }

  if (node.key === 'lottie') {
    return (
      <LayerGlyphFallback>
        <AnimationOutlineIcon className="block h-[13px] w-[13px] shrink-0" strokeWidth={1.75} />
      </LayerGlyphFallback>
    );
  }

  if (isAudioGeneratorNode(node) || node.key === 'audio') {
    return (
      <LayerGlyphFallback>
        <LuAudioLines className="block h-[13px] w-[13px] shrink-0" strokeWidth={1.75} />
      </LayerGlyphFallback>
    );
  }

  if (node.key === 'video') {
    const thumb = renderVideoLayerThumb(src, poster);
    if (thumb) return thumb;
    return (
      <LayerGlyphFallback>
        <HiOutlineVideoCamera className="block h-[13px] w-[13px] shrink-0" strokeWidth={1.75} />
      </LayerGlyphFallback>
    );
  }

  if (node.key === 'image' && src) {
    return <LayerMediaThumb kind="image" src={src} />;
  }

  const kind = resolveLayerIconKind(node);
  const Icon = layerIconByKind[kind] || HiOutlineStop;
  const sizeClass = layerIconSizeByKind[kind] || layerIconSizeByKind.rect;
  const fill = String(node.attrs?.['fill-color'] || '');
  const isSolidRect =
    filled ||
    (kind === 'rect' && fill && fill !== 'transparent' && !/^rgba?\([^)]*,\s*0\)/.test(fill));

  return (
    <span
      className={cn(
        LAYER_ICON_SLOT,
        isSolidRect && 'bg-[var(--accent-soft)]'
      )}
    >
      {isSolidRect && kind === 'rect' ? (
        <span
          className="block h-3 w-3 rounded-[2px]"
          style={{ background: fill || 'var(--muted)' }}
        />
      ) : (
        <Icon className={cn(sizeClass, 'block shrink-0')} />
      )}
    </span>
  );
}

function layerLabel(
  node: {
    key: string;
    attrs?: {
      shapeType?: string;
      imageGenerator?: unknown;
      videoGenerator?: unknown;
      lottieGenerator?: unknown;
      audioGenerator?: unknown;
      name?: unknown;
    };
  },
  imageGeneratorLabel: string,
  videoGeneratorLabel: string | undefined,
  lottieGeneratorLabel: string | undefined,
  audioGeneratorLabel: string | undefined,
  t: (key: string, opts?: { defaultValue?: string }) => string
) {
  if (isImageGeneratorNode(node)) return imageGeneratorLabel;
  if (isVideoGeneratorNode(node)) return videoGeneratorLabel || 'Video Generator';
  if (isLottieGeneratorNode(node)) return lottieGeneratorLabel || 'Lottie Generator';
  if (isAudioGeneratorNode(node)) return audioGeneratorLabel || 'Audio Generator';

  // Prefer upload / rename title (same field as canvas NodeTitleLabel).
  const named = String(node.attrs?.name || '').trim();
  if (named) return named;

  if (node.key === 'video') return 'Video';
  if (node.key === 'lottie') return 'Lottie';
  if (node.key === 'audio') return 'Audio';

  const kind = resolveLayerIconKind(node);
  if (kind === 'triangle') return t('editor.tools.polygon');
  if (kind === 'image') {
    return t('editor.tools.uploadImage', { defaultValue: 'Image' });
  }
  const toolLabel = t(`editor.tools.${kind}`, { defaultValue: '' });
  if (toolLabel) return toolLabel;
  // Fallbacks when i18n key is missing (do not use literal "??" — encoding rot).
  const map: Record<string, string> = {
    text: t('editor.tools.text', { defaultValue: 'Text' }),
    pen: t('editor.tools.pen', { defaultValue: 'Pen' }),
    pencil: t('editor.tools.pencil', { defaultValue: 'Pencil' }),
    path: t('editor.tools.path', { defaultValue: 'Path' }),
    svg: 'SVG',
  };
  return map[kind] || kind;
}

function VisibilityIcon({ hidden }: { hidden: boolean }) {
  const props = { className: 'h-3.5 w-3.5', strokeWidth: 1.75 as const };
  return hidden ? <HiOutlineEyeSlash {...props} /> : <HiOutlineEye {...props} />;
}

function LockIcon({ locked }: { locked: boolean }) {
  const props = { className: 'h-3.5 w-3.5', strokeWidth: 1.75 as const };
  return locked ? <HiOutlineLockClosed {...props} /> : <HiOutlineLockOpen {...props} />;
}

function LayerRowVisibilityButton({
  hidden,
  selected,
  disabled,
  showLabel,
  hideLabel,
  onToggle,
}: {
  hidden: boolean;
  selected: boolean;
  disabled?: boolean;
  showLabel: string;
  hideLabel: string;
  onToggle: () => void;
}) {
  const label = hidden ? showLabel : hideLabel;
  return (
    <Tooltip tip={label} placement="top">
      <button
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-pressed={hidden}
        onClick={(e) => {
          e.stopPropagation();
          if (disabled) return;
          onToggle();
        }}
        className={layerRowActionClass(hidden, selected, disabled)}
      >
        <VisibilityIcon hidden={hidden} />
      </button>
    </Tooltip>
  );
}

function LayerRowLockButton({
  locked,
  selected,
  disabled,
  lockLabel,
  unlockLabel,
  onToggle,
}: {
  locked: boolean;
  selected: boolean;
  disabled?: boolean;
  lockLabel: string;
  unlockLabel: string;
  onToggle: () => void;
}) {
  const label = locked ? unlockLabel : lockLabel;
  return (
    <Tooltip tip={label} placement="top">
      <button
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-pressed={locked}
        onClick={(e) => {
          e.stopPropagation();
          if (disabled) return;
          onToggle();
        }}
        className={layerRowActionClass(locked, selected, disabled)}
      >
        <LockIcon locked={locked} />
      </button>
    </Tooltip>
  );
}

function hiddenAttrPatch(nextHidden: boolean) {
  return { attrs: { hidden: nextHidden ? 'true' : 'false' } };
}

function lockedAttrPatch(nextLocked: boolean) {
  return { attrs: { locked: nextLocked ? 'true' : 'false' } };
}

function PasteboardRootRow({ onEnter }: { onEnter: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onDoubleClick={(e) => stopDblClick(e, onEnter)}
      className="group flex min-h-[36px] w-full items-center gap-2.5 px-2 py-0.5 text-left text-[13px] text-[var(--muted)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--ink)]"
    >
      <span className={LAYER_ICON_SLOT}>
        <LuLayoutGrid className="h-[13px] w-[13px] block shrink-0" strokeWidth={1.75} />
      </span>
      <span className="min-w-0 flex-1 truncate">{t('editor.pasteboard')}</span>
    </button>
  );
}

function FrameLayerRow({
  frameId,
  frame,
  selected,
  editingFrameId,
  onSelectFrame,
  onEnterFrame,
  onStartFrameRename,
  onCommitFrameRename,
}: {
  frameId: string;
  frame: any;
  selected: boolean;
  editingFrameId?: string | null;
  onSelectFrame?: (frameId: string) => void;
  onEnterFrame?: (frameId: string) => void;
  onStartFrameRename?: (frameId: string) => void;
  onCommitFrameRename?: (frameId: string, name: string | null) => void;
}) {
  const { t } = useTranslation();
  const titleEditRef = useRef<HTMLDivElement | null>(null);
  const editingTitleRef = useRef(false);
  const locked = Boolean(frame.locked);
  const hidden = Boolean(frame.hidden);
  const isEditing = editingFrameId === frameId;
  const frameName = String(frame.name || t('editor.tools.frame') || 'Frame');

  const selectFrame = () => {
    if (onSelectFrame) onSelectFrame(frameId);
    else {
      setActiveFrameId(frameId);
      setFrameChromeMode('full');
    }
  };

  useEffect(() => {
    if (!isEditing) return;
    editingTitleRef.current = true;
    const el = titleEditRef.current;
    if (!el) return;
    el.textContent = frameName;
    selectContentEditable(el);
  }, [isEditing, frameName]);

  const finishTitleEdit = (commit: boolean) => {
    if (!editingTitleRef.current) return;
    editingTitleRef.current = false;
    if (!commit) {
      onCommitFrameRename?.(frameId, null);
      return;
    }
    const raw = titleEditRef.current?.textContent ?? '';
    const next = raw.replace(/\s+/g, ' ').trim() || frameName;
    onCommitFrameRename?.(frameId, next === frameName ? null : next);
  };

  return (
    <div className={layerRowSurfaceClass(selected)}>
      <button
        type="button"
        onClick={selectFrame}
        onDoubleClick={(e) => stopDblClick(e, () => onEnterFrame?.(frameId))}
        className={cn(LAYER_ICON_SLOT, hidden && 'opacity-50')}
        aria-label={frameName}
      >
        {isAnimationArtboardKind(frame?.kind) ? (
          <AnimationOutlineIcon className="h-[13px] w-[13px] block shrink-0" strokeWidth={1.75} />
        ) : (
          <LuFrame className="h-[13px] w-[13px] block shrink-0" strokeWidth={1.75} />
        )}
      </button>
      {isEditing ? (
        <div
          ref={titleEditRef}
          role="textbox"
          aria-label={t('home.rename', { defaultValue: 'Rename' })}
          contentEditable
          suppressContentEditableWarning
          className={cn(
            'min-w-0 flex-1 truncate rounded-sm px-1 py-1 text-left text-[13px] text-[var(--ink)] outline-none',
            'overflow-hidden text-ellipsis whitespace-nowrap ring-1 ring-[var(--line)]',
            hidden && 'opacity-50'
          )}
          onClick={(e) => e.stopPropagation()}
          onBlur={() => finishTitleEdit(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              finishTitleEdit(true);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              finishTitleEdit(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          onClick={selectFrame}
          onDoubleClick={(e) => stopDblClick(e, () => onStartFrameRename?.(frameId))}
          className={cn(
            'min-w-0 flex-1 truncate rounded-md px-1 py-1 text-left',
            hidden && 'opacity-50'
          )}
        >
          {frameName}
        </button>
      )}
      <LayerRowVisibilityButton
        hidden={hidden}
        selected={selected}
        showLabel={t('editor.contextMenu.show')}
        hideLabel={t('editor.contextMenu.hide')}
        onToggle={() => {
          const nextHidden = !hidden;
          updateArtboardFrame({ id: frameId, patch: { hidden: nextHidden } });
          if (nextHidden && selected) setActiveFrameId(null);
        }}
      />
      <LayerRowLockButton
        locked={locked}
        selected={selected}
        lockLabel={t('editor.contextMenu.lock')}
        unlockLabel={t('editor.contextMenu.unlock')}
        onToggle={() => {
          updateArtboardFrame({ id: frameId, patch: { locked: !locked } });
        }}
      />
    </div>
  );
}

function NodeLayerRow({
  nodeId,
  node,
  selected,
  onSelectNode,
}: {
  nodeId: string;
  node: any;
  selected: boolean;
  onSelectNode?: (nodeId: string) => void;
}) {
  const { t } = useTranslation();
  const hidden = isNodeHidden(node);
  const locked = isNodeLocked(node);
  const generator = isGeneratorNode(node);

  const selectNode = () => {
    if (onSelectNode) onSelectNode(nodeId);
    else setSelectedNodeId(nodeId);
  };

  return (
    <div className={layerRowSurfaceClass(selected)}>
      <button
        type="button"
        onClick={selectNode}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 py-1 text-left',
          hidden && 'opacity-50'
        )}
      >
        <LayerIcon node={node} />
        <span className="min-w-0 flex-1 truncate">
          {layerLabel(
            node,
            t('editor.tools.imageGenerator'),
            t('editor.tools.videoGenerator'),
            t('editor.tools.lottieGenerator'),
            t('editor.tools.audioGenerator'),
            t
          )}
        </span>
      </button>
      <LayerRowVisibilityButton
        hidden={hidden}
        selected={selected}
        disabled={generator}
        showLabel={t('editor.contextMenu.show')}
        hideLabel={t('editor.contextMenu.hide')}
        onToggle={() => {
          const nextHidden = !hidden;
          patchDocumentNode({
              nodeId,
              patch: hiddenAttrPatch(nextHidden),
            });
          if (nextHidden && selected) setSelectedNodeId(null);
        }}
      />
      <LayerRowLockButton
        locked={locked}
        selected={selected}
        disabled={generator}
        lockLabel={t('editor.contextMenu.lock')}
        unlockLabel={t('editor.contextMenu.unlock')}
        onToggle={() => {
          patchDocumentNode({
              nodeId,
              patch: lockedAttrPatch(!locked),
            });
        }}
      />
    </div>
  );
}

function LayerStackRowView({
  row,
  frame,
  node,
  selected,
  editingFrameId,
  onSelectFrame,
  onSelectNode,
  onEnterFrame,
  onEnterPasteboard,
  onStartFrameRename,
  onCommitFrameRename,
}: {
  row: LayerStackRow;
  frame?: any;
  node?: any;
  selected: boolean;
  editingFrameId?: string | null;
  onSelectFrame?: (frameId: string) => void;
  onSelectNode?: (nodeId: string) => void;
  onEnterFrame?: (frameId: string) => void;
  onEnterPasteboard?: () => void;
  onStartFrameRename?: (frameId: string) => void;
  onCommitFrameRename?: (frameId: string, name: string | null) => void;
}) {
  if (row.kind === 'pasteboard') {
    return <PasteboardRootRow onEnter={() => onEnterPasteboard?.()} />;
  }

  if (row.kind === 'frame') {
    if (!frame) return null;
    return (
      <FrameLayerRow
        frameId={row.id}
        frame={frame}
        selected={selected}
        editingFrameId={editingFrameId}
        onSelectFrame={onSelectFrame}
        onEnterFrame={onEnterFrame}
        onStartFrameRename={onStartFrameRename}
        onCommitFrameRename={onCommitFrameRename}
      />
    );
  }

  if (!node) return null;
  return (
    <NodeLayerRow
      nodeId={row.id}
      node={node}
      selected={selected}
      onSelectNode={onSelectNode}
    />
  );
}

/** Left layers dock  - history + frames/nodes from unified stackOrder. */
function LayerPanel({
  onClose,
  onSelectNode,
  onSelectFrame,
  mobile = false,
}: {
  onClose?: () => void;
  /** Optional override when selecting from the layer list (default: store select only). */
  onSelectNode?: (nodeId: string) => void;
  /** Optional override when selecting a frame row (default: store select only). */
  onSelectFrame?: (frameId: string) => void;
  mobile?: boolean;
} = {}) {
  const { t } = useTranslation();
  const documentCommitted = useEditorDocumentOnCommit();
  // Paste bumps documentRevision / sceneRevision  - defer layer-list rebuild so the
  // Kit paint stays ahead of the dock at 2k - 0k nodes.
  // canvas commit is not blocked by dock work while history snaps accumulate.
  const document = useDeferredValue(documentCommitted);
  const selectedNodeId = useSelectedNodeId();
  const selectedNodeIds = useSelectedNodeIds();
  const activeFrameId = useActiveFrameId();
  const selectedFrameIds = useSelectedFrameIds();
  const historyPastLen = useSelector(
    (state: any) => (state.editor.historyPast as any[])?.length || 0
  );
  /** Recompute layer rows when timeline edit focus toggles (module flag + store). */
  const workbenchEditOpen = useSelector((state: any) =>
    Boolean(state.editor.lottieTimelinePanel?.nodeId)
  );
  const nodes = listSceneNodes(document);
  const frames = Array.isArray(document?.frames) ? document.frames : [];
  const frameById = useMemo(() => {
    const map = new Map<string, any>();
    for (const f of frames) {
      if (f?.id) map.set(String(f.id), f);
    }
    return map;
  }, [frames]);
  const nodeById = useMemo(() => {
    const map = new Map<string, any>();
    for (const { id, node } of nodes) map.set(id, node);
    return map;
  }, [nodes]);
  const selectedNodeFrameId = useMemo(() => {
    if (!selectedNodeId) return null;
    const node = nodeById.get(selectedNodeId);
    const frameId = String(node?.attrs?.frameId || '').trim();
    return frameId && frameById.has(frameId) ? frameId : null;
  }, [selectedNodeId, nodeById, frameById]);
  const selectedNodeIsPasteboard = useMemo(() => {
    if (!selectedNodeId || selectedNodeFrameId) return false;
    return nodeById.has(selectedNodeId);
  }, [selectedNodeId, selectedNodeFrameId, nodeById]);
  const [layerNav, setLayerNav] = useState<LayerNav>({ scope: 'root' });
  const [editingFrameId, setEditingFrameId] = useState<string | null>(null);
  const { scope: layerScope, frameId: scopedFrameId } = useMemo(
    () => resolveLayerView(layerNav, selectedNodeFrameId, selectedNodeIsPasteboard),
    [layerNav, selectedNodeFrameId, selectedNodeIsPasteboard]
  );
  const layerRows = useMemo(
    () =>
      listRowsForScope(layerScope, scopedFrameId, {
        document,
        frameById,
        frames,
        nodeById,
        nodes,
      }),
    [document, layerScope, scopedFrameId, frameById, nodeById, frames, nodes, workbenchEditOpen]
  );
  const scopedFrame = scopedFrameId ? frameById.get(scopedFrameId) : undefined;
  const scopeTitle = isNestedLayerScope(layerScope)
    ? layerScopeTitle(layerScope, scopedFrame, t)
    : null;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dockWidth, setDockWidth] = useState(LAYER_DOCK_DEFAULT_W);
  const resizeDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const layerListRef = useRef<VirtualListHandle | null>(null);

  useEffect(() => {
    setDockWidth(getLayerDockWidth());
  }, []);

  useEffect(() => {
    const onWinResize = () => setDockWidth((w) => clampLayerDockWidth(w));
    window.addEventListener('resize', onWinResize);
    return () => window.removeEventListener('resize', onWinResize);
  }, []);

  useEffect(
    () => () => {
      window.document.body.style.cursor = '';
      window.document.body.style.userSelect = '';
    },
    []
  );

  useEffect(() => {
    syncLayerNavFromSelection(setLayerNav, setEditingFrameId, {
      selectedNodeFrameId,
      selectedNodeIsPasteboard,
      selectedNodeId,
      selectedFrameIds,
      activeFrameId,
    });
  }, [
    selectedNodeFrameId,
    selectedNodeIsPasteboard,
    selectedNodeId,
    selectedNodeIds,
    selectedFrameIds,
    activeFrameId,
  ]);

  const enterFrame = (frameId: string) => {
    setEditingFrameId(null);
    setLayerNav({ scope: 'frame', frameId });
    if (onSelectFrame) onSelectFrame(frameId);
    else {
      setActiveFrameId(frameId);
      setFrameChromeMode('full');
    }
  };

  const enterPasteboard = () => {
    setEditingFrameId(null);
    setLayerNav({ scope: 'pasteboard' });
  };

  const goRoot = () => {
    setEditingFrameId(null);
    setLayerNav({ scope: 'root', pinned: true });
  };

  const commitFrameRename = (frameId: string, name: string | null) => {
    setEditingFrameId(null);
    if (name === null) return;
    const trimmed = String(name || '').trim();
    if (!trimmed) return;
    updateArtboardFrame({ id: frameId, patch: { name: trimmed } });
  };

  useEffect(() => {
    const index = findLayerScrollIndex(
      layerRows,
      layerScope,
      selectedNodeId,
      selectedFrameIds,
      activeFrameId
    );
    if (index >= 0) layerListRef.current?.scrollToIndex(index, { align: 'auto' });
  }, [selectedNodeId, selectedFrameIds, activeFrameId, layerRows, layerScope]);

  const persistDockWidth = (width: number) => {
    const next = clampLayerDockWidth(width);
    setDockWidth(next);
    writeLayerDockWidth(next);
  };

  const onDockResizePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeDragRef.current = { startX: e.clientX, startW: dockWidth };
    window.document.body.style.cursor = 'col-resize';
    window.document.body.style.userSelect = 'none';
  };

  const onDockResizePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeDragRef.current;
    if (!drag) return;
    // Right edge: drag right  - wider
    setDockWidth(clampLayerDockWidth(drag.startW + (e.clientX - drag.startX)));
  };

  const endDockResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizeDragRef.current) return;
    resizeDragRef.current = null;
    window.document.body.style.cursor = '';
    window.document.body.style.userSelect = '';
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    setDockWidth((w) => {
      writeLayerDockWidth(w);
      return w;
    });
  };

  const historyItems = useMemo(() => {
    // Newest first  - length only (never subscribe to full snap docs).
    if (!historyPastLen) return [];
    return Array.from({ length: historyPastLen }, (_, i) => ({
      id: `h-${historyPastLen - i}`,
      label: t('editor.historyStep', { n: historyPastLen - i }),
    }));
  }, [historyPastLen, t]);

  return (
    <aside
      data-editor-left-dock={mobile ? undefined : ''}
      style={mobile ? { width: 'min(20rem, 82vw)' } : { width: dockWidth }}
      className={cn(
        'relative flex h-full shrink-0 flex-col overflow-hidden border-r border-[var(--line)] bg-[var(--surface)]',
        mobile && 'shadow-[0_18px_48px_rgba(12,12,13,0.24)]'
      )}
    >
      {!mobile ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('editor.resizeLayersDock')}
          aria-valuemin={LAYER_DOCK_MIN_W}
          aria-valuemax={LAYER_DOCK_MAX_W}
          aria-valuenow={dockWidth}
          className="absolute inset-y-0 right-0 z-20 w-1.5 cursor-col-resize touch-none hover:bg-[var(--accent)]/25 active:bg-[var(--accent)]/40"
          onPointerDown={onDockResizePointerDown}
          onPointerMove={onDockResizePointerMove}
          onPointerUp={endDockResize}
          onPointerCancel={endDockResize}
          onDoubleClick={() => persistDockWidth(LAYER_DOCK_DEFAULT_W)}
        />
      ) : null}
      <div className="flex h-11 shrink-0 items-center justify-between px-3">
        <span className="text-[14px] font-semibold text-[var(--ink)]">{t('editor.layers')}</span>
        {onClose ? (
          <Tooltip tip={t('editor.closePanel')} placement="bottom">
            <button
              type="button"
              aria-label={t('editor.closePanel')}
              onClick={onClose}
              className="inline-flex h-7 w-7 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--accent-soft)] hover:text-[var(--ink)]"
            >
              <LuPanelLeft className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </Tooltip>
        ) : null}
      </div>

      {/* History */}
      <div className="shrink-0 border-b border-[var(--line)] px-2 pb-2">
        <button
          type="button"
          onClick={() => setHistoryOpen((v) => !v)}
          className="flex w-full items-center justify-between rounded-md px-1 py-1.5 text-left text-[12px] font-medium text-[var(--ink)] hover:bg-[var(--accent-soft)]"
        >
          <span>{t('editor.history')}</span>
          {historyOpen ? (
            <HiOutlineChevronUp className="h-3.5 w-3.5 text-[var(--muted)]" />
          ) : (
            <HiOutlineChevronDown className="h-3.5 w-3.5 text-[var(--muted)]" />
          )}
        </button>
        {historyOpen ? (
          <div className="mt-1 h-[120px] overflow-y-auto">
            {historyItems.length ? (
              <ul className="space-y-0.5">
                {historyItems.map((item) => (
                  <li
                    key={item.id}
                    className="truncate rounded-md px-2 py-1.5 text-[12px] text-[var(--muted)]"
                  >
                    {item.label}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-2 py-2 text-left text-[12px] text-[var(--muted)]">
                {t('editor.noHistory')}
              </p>
            )}
          </div>
        ) : null}
      </div>

      {scopeTitle ? (
        <div className="flex shrink-0 items-center gap-0.5 px-3 py-[3px]">
          <Tooltip tip={t('common.back')} placement="bottom">
            <button
              type="button"
              aria-label={t('common.back')}
              onClick={goRoot}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--muted)] transition hover:bg-[var(--accent-soft)] hover:text-[var(--ink)]"
            >
              <HiOutlineChevronLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
          </Tooltip>
          <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--muted)]">
            {scopeTitle}
          </span>
        </div>
      ) : null}

      {/* Layer rows  - top of list = front of stack (virtualized) */}
      <VirtualList
        ref={layerListRef}
        items={layerRows}
        estimateSize={LAYER_ROW_ESTIMATE_PX}
        overscan={10}
        getItemKey={layerRowKey}
        className="py-1"
        empty={
          <p className="px-3 py-2 text-left text-[12px] text-[var(--muted)]">
            {t('editor.noLayers')}
          </p>
        }
      >
        {(row) => (
          <LayerStackRowView
            row={row}
            frame={row.kind === 'frame' ? frameById.get(row.id) : undefined}
            node={row.kind === 'node' ? nodeById.get(row.id) : undefined}
            selected={isLayerRowSelected(row, selectedNodeId, selectedFrameIds, activeFrameId)}
            editingFrameId={editingFrameId}
            onSelectFrame={onSelectFrame}
            onSelectNode={onSelectNode}
            onEnterFrame={enterFrame}
            onEnterPasteboard={enterPasteboard}
            onStartFrameRename={setEditingFrameId}
            onCommitFrameRename={commitFrameRename}
          />
        )}
      </VirtualList>
    </aside>
  );
}

export default memo(LayerPanel);
