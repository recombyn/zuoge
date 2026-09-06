/**
 * Horizontal align strip + property inspector for Animation workbench children.
 * 「关键帧—opens the vertical inspector panel and hides this strip.
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useSelector } from '@/store';
import { useTranslation } from 'react-i18next';
import { BiExit } from 'react-icons/bi';
import {
  HiOutlineEye,
  HiOutlineEyeSlash,
  HiOutlineChevronDown,
  HiOutlineLink,
  HiOutlineLinkSlash,
  HiOutlineMinus,
  HiOutlinePhoto,
  HiOutlinePlus,
} from 'react-icons/hi2';
import { MdOutlineOpacity } from 'react-icons/md';
import { Dropdown, Icon, message } from '@/components/base';
import type { MenuItemType } from '@/components/base/dropdown';
import { normalizeHex } from '@/components/base/colorPanel';
import Tooltip from '@/components/base/tooltip';
import {
  findFrameAnimationMediaId,
  resolveAnimationFrameId,
} from '@/components/editor/nodes/AnimationNode/resolveAnimationFrameId';
import { nodeIdsBoundToFrames } from '@/components/rcb/scene/document/sceneClipboard';
import AnimationAnchorMarker from '@/components/editor/nodes/AnimationNode/AnimationAnchorMarker';
import { IconCornerRadius } from '@/components/rcb/selection/chrome/StyleToolbarIcons';
import { ImageToolSep, imageToolBtn } from '@/components/editor/nodes/ImageNode/imageToolbarShared';
import ImageToolbarMoreDownload, {
  type ImageMoreAction,
} from '@/components/editor/nodes/ImageNode/ImageToolbarMoreDownload';
import { GiPuppet } from 'react-icons/gi';
import { expandPuppetTimelineLayer } from '@/components/editor/nodes/ImageNode/puppet/puppetTimeline';
import { SelectionToolbarShell } from '@/components/rcb/selection/chrome/SelectionToolbarShell';
import {
  parseAnchorPreset,
  type LottieAnchorPreset,
  anchorPresetToFrac,
} from '@/components/editor/nodes/AnimationNode/animationFrameSync';
import { sceneBoxToLottieLocal } from '@/components/editor/nodes/AnimationNode/animationComposeLayers';
import { secToFrame } from '@/components/editor/nodes/AnimationNode/animationTimelineModel';
import {
  removeTransformKeyframe,
  upsertTransformKeyframe,
  liveSceneValueForTransformProp,
} from '@/components/editor/nodes/AnimationNode/animationTimelineMutate';
import {
  autoKeyAnimatedProp,
  liveValueContextFromLink,
  resolveAnimationLayerLink,
} from '@/components/editor/nodes/AnimationNode/animationAutoKey';
import {
  ensureAnimationFrameMedia,
  openImageToolPanel,
  closeImageToolPanel,
  openShapeStylePanel,
  patchDocumentNode,
  patchDocumentNodes,
  startImageProcess,
} from '@/store/modules/editor';
import type { ImageToolPanelState } from '@/store/modules/editor';
import { AI_IMAGE_PROCESS_KINDS } from '@/service/imageTools';
import {
  parseLottieAnimationData,
  serializeLottieAnimationData,
} from '@/components/rcb/scene/document/nodeFactories';
import {
  supportsCornerRadius,
} from '@/components/rcb/scene/document/nodeCapabilities';
import { cornerRadiusToolbarDisplay } from '@/components/rcb/scene/document/sceneRadii';
import {
  RcbOverlayPortal,
  rcbSceneToScreen,
  useRcbCamera,
  useRcbDevicePixelRatio,
} from '@/components/rcb';
import {
  BLEND_MODE_OPTIONS,
  parseBlendMode,
} from '@/components/rcb/selection/chrome/BlendModeControl';
import {
  documentPointToNodeLocal,
  isFrameLocalCoordSpace,
} from '@/components/rcb/scene/paint/sceneToSvg';
import store from '@/store';
import { cn } from '@/utils/classnames';
import type { SceneDocument, SceneNode } from '@/components/rcb/sceneNode';

/**
 * Inspector X/Y are plate-local (0 = frame TL). Node storage under frameLocal
 * is also plate-local — never write world abs (that double-adds frame origin).
 */
export function inspectorLocalToStoredXY(
  document: SceneDocument | null | undefined,
  frameId: string | null | undefined,
  frameX: number,
  frameY: number,
  localX: number,
  localY: number
): { x: number; y: number } {
  if (isFrameLocalCoordSpace(document) && String(frameId || '').trim()) {
    return { x: localX, y: localY };
  }
  return { x: frameX + localX, y: frameY + localY };
}

/** Timeline dock listens — expand the layer so new keyframes are visible. */
export const LOTTIE_EXPAND_LAYER_EVENT = 'lottie-timeline-expand-layer';

type SceneBox = { left: number; top: number; width: number; height: number };

type Props = {
  document: SceneDocument;
  nodeId: string;
  box: SceneBox;
  valueBox?: SceneBox;
  edgePadScene?: number;
  angle?: number;
};

const ANCHOR_CELLS: LottieAnchorPreset[] = [
  'tl',
  'tm',
  'tr',
  'ml',
  'mm',
  'mr',
  'bl',
  'bm',
  'br',
];

const ALIGN_ITEMS = [
  { mode: 'left' as const, tipKey: 'editor.selectionToolbar.alignLeft', icon: 'editor-align-left' },
  {
    mode: 'centerX' as const,
    tipKey: 'editor.selectionToolbar.alignCenterX',
    icon: 'editor-align-center-x',
  },
  { mode: 'right' as const, tipKey: 'editor.selectionToolbar.alignRight', icon: 'editor-align-right' },
  { mode: 'top' as const, tipKey: 'editor.selectionToolbar.alignTop', icon: 'editor-align-top' },
  {
    mode: 'middle' as const,
    tipKey: 'editor.selectionToolbar.alignMiddle',
    icon: 'editor-align-middle',
  },
  {
    mode: 'bottom' as const,
    tipKey: 'editor.selectionToolbar.alignBottom',
    icon: 'editor-align-bottom',
  },
];

type SiblingBox = {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
};

/** Pin first/last to frame ends; even gaps for middles. Sole child stretches to fill. */
function justifyInFramePatches(
  boxes: SiblingBox[],
  axis: 'h' | 'v',
  frame: { x: number; y: number; w: number; h: number }
): Array<{ nodeId: string; patch: { x?: number; y?: number; width?: number; height?: number } }> {
  if (!boxes.length) return [];
  const horizontal = axis === 'h';
  const start = horizontal ? frame.x : frame.y;
  const size = horizontal ? frame.w : frame.h;

  if (boxes.length === 1) {
    const b = boxes[0];
    return [
      {
        nodeId: b.id,
        patch: horizontal
          ? { x: Math.round(start), width: Math.max(1, Math.round(size)) }
          : { y: Math.round(start), height: Math.max(1, Math.round(size)) },
      },
    ];
  }

  const sorted = [...boxes].sort((a, b) =>
    horizontal ? a.left - b.left : a.top - b.top
  );
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const firstSize = horizontal ? first.width : first.height;
  const lastSize = horizontal ? last.width : last.height;
  const end = start + size;

  if (boxes.length === 2) {
    return [
      {
        nodeId: first.id,
        patch: horizontal ? { x: Math.round(start) } : { y: Math.round(start) },
      },
      {
        nodeId: last.id,
        patch: horizontal
          ? { x: Math.round(end - lastSize) }
          : { y: Math.round(end - lastSize) },
      },
    ];
  }

  const middle = sorted.slice(1, -1);
  const middleSize = middle.reduce(
    (s, b) => s + (horizontal ? b.width : b.height),
    0
  );
  const free = size - firstSize - lastSize - middleSize;
  const gap = free / (sorted.length - 1);
  let cursor = start + firstSize + gap;
  const out: Array<{
    nodeId: string;
    patch: { x?: number; y?: number; width?: number; height?: number };
  }> = [
    {
      nodeId: first.id,
      patch: horizontal ? { x: Math.round(start) } : { y: Math.round(start) },
    },
  ];
  for (const b of middle) {
    out.push({
      nodeId: b.id,
      patch: horizontal ? { x: Math.round(cursor) } : { y: Math.round(cursor) },
    });
    cursor += (horizontal ? b.width : b.height) + gap;
  }
  out.push({
    nodeId: last.id,
    patch: horizontal
      ? { x: Math.round(end - lastSize) }
      : { y: Math.round(end - lastSize) },
  });
  return out;
}

const PANEL_W = 260;

/** Custom dropdown — native <select> popup colors differ from the closed field. */
function InspectorSelect({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: {
  value: string;
  options: Array<{ key: string; label: string }>;
  onChange: (key: string) => void;
  ariaLabel?: string;
  className?: string;
}) {
  const selected = options.find((o) => o.key === value) || options[0];
  const items: MenuItemType[] = options.map((o) => ({
    key: o.key || '__none',
    label: o.label,
  }));
  return (
    <Dropdown
      trigger="click"
      placement="bottom-start"
      strategy="fixed"
      offset={4}
      items={items}
      selectedKeys={[value || '__none']}
      onClick={(key) => onChange(key === '__none' ? '' : String(key))}
      popupClassName="max-h-[min(50vh,16rem)] min-w-[10rem] overflow-y-auto"
      floatingClassName="z-[520]"
      referenceClassName="block min-w-0 w-full"
    >
      <button
        type="button"
        aria-label={ariaLabel}
        className={cn(
          'flex h-8 w-full min-w-0 items-center justify-between gap-1 rounded-sm bg-[var(--accent-soft)] px-2.5 text-left text-[12px] text-[var(--ink)] outline-none',
          className
        )}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <span className="min-w-0 truncate">{selected?.label ?? ''}</span>
        <HiOutlineChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--muted)]" />
      </button>
    </Dropdown>
  );
}

function TrimStartIcon() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0 text-[var(--muted)]" aria-hidden>
      <path
        d="M3 2v8M3 6h6M7 3.5L9.5 6 7 8.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="square"
      />
    </svg>
  );
}

function TrimEndIcon() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0 text-[var(--muted)]" aria-hidden>
      <path
        d="M9 2v8M3 6h6M5 3.5L2.5 6 5 8.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="square"
      />
    </svg>
  );
}

function TrimOffsetIcon() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0 text-[var(--muted)]" aria-hidden>
      <path
        d="M6 2.5a3.5 3.5 0 1 1-2.4 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
      <path d="M3 6.5h2.2V8.7" fill="none" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  );
}

/** Labeled field: caption above, icon + value + optional kf (Rive trim/roundness). */
function LabeledValueField({
  caption,
  icon,
  value,
  suffix,
  onCommit,
  kf,
  className,
}: {
  caption: string;
  icon?: ReactNode;
  value: number;
  suffix?: string;
  onCommit: (n: number) => void;
  kf?: ReactNode;
  className?: string;
}) {
  const scrub = useLabelScrub(onCommit, value);
  return (
    <div className={cn('min-w-0', className)}>
      <div className="mb-1 text-[10px] font-medium text-[var(--muted)]">{caption}</div>
      <div className="flex h-8 w-full min-w-0 items-center gap-0.5 rounded-sm bg-[var(--accent-soft)] px-1.5 text-[11px] text-[var(--ink)]">
        {icon ? (
          <span className="inline-flex shrink-0 cursor-ew-resize select-none touch-none items-center justify-center text-[var(--muted)]" title="Drag to adjust" {...scrub}>
            {icon}
          </span>
        ) : null}
        <input
          type="number"
          className="w-0 min-w-0 flex-1 border-0 bg-transparent text-[11px] tabular-nums text-[var(--ink)] outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          value={Number.isFinite(value) ? Math.round(value * 100) / 100 : 0}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (!Number.isFinite(n)) return;
            onCommit(n);
          }}
        />
        {suffix ? (
          <span className="w-2.5 shrink-0 text-[10px] text-[var(--muted)]">{suffix}</span>
        ) : null}
        {kf ? (
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center">{kf}</span>
        ) : null}
      </div>
    </div>
  );
}

/** Collapsed section row with + / ? like Rive inspector. */
function SectionHeader({
  title,
  open,
  onToggle,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex h-8 items-center justify-between px-3 text-[12px] font-medium text-[var(--ink)]">
      <span>{title}</span>
      <button
        type="button"
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-[var(--muted)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--ink)] disabled:opacity-35"
        aria-label={open ? 'Collapse' : 'Expand'}
        aria-expanded={open}
        onClick={onToggle}
      >
        {open ? (
          <HiOutlineMinus className="h-3.5 w-3.5" />
        ) : (
          <HiOutlinePlus className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}

function panelStyleRight(
  camera: { x: number; y: number; zoom: number },
  box: SceneBox,
  dpr?: number
): CSSProperties {
  const gap = 12 / Math.max(0.05, camera.zoom);
  const { x, y } = rcbSceneToScreen(camera, box.left + box.width + gap, box.top, dpr);
  return {
    position: 'absolute',
    left: x,
    top: y,
    zIndex: 45,
    width: PANEL_W,
  };
}

function KfDiamond({
  active,
  tip,
  onClick,
}: {
  active: boolean;
  tip: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={tip}
      aria-label={tip}
      aria-pressed={active}
      className={cn(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm',
        active ? 'text-[var(--ink)]' : 'text-[var(--muted)] hover:bg-[var(--accent-soft)] hover:text-[var(--ink)]'
      )}
      onPointerDown={(e) => {
        // Prefer pointerdown so Tooltip wrappers / scrub capture cannot swallow click.
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
    >
      <span
        className={cn(
          'block h-3 w-3 rotate-45 border-[1.5px]',
          active
            ? 'border-[var(--ink)] bg-[var(--ink)]'
            : 'border-current bg-transparent'
        )}
      />
    </button>
  );
}

function useLabelScrub(onCommit: (n: number) => void, value: number, step = 1) {
  const valueRef = useRef(value);
  valueRef.current = value;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const stepRef = useRef(step);
  stepRef.current = step;
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startValue: number;
    moved: boolean;
    target: HTMLElement | null;
  } | null>(null);

  const endScrub = useCallback((pointerId?: number) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (pointerId != null && drag.pointerId !== pointerId) return;
    const el = drag.target;
    dragRef.current = null;
    if (el) {
      try {
        el.releasePointerCapture(drag.pointerId);
      } catch {
        /* ignore */
      }
    }
    const root = window.document.documentElement;
    if (root.hasAttribute('data-lottie-scrubbing')) {
      root.removeAttribute('data-lottie-scrubbing');
      window.dispatchEvent(new CustomEvent('lottie-inspector-scrub-end'));
    }
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      e.preventDefault();
      e.stopPropagation();
      const dx = e.clientX - drag.startX;
      if (!drag.moved && Math.abs(dx) < 2) return;
      drag.moved = true;
      const fine = e.shiftKey ? 0.1 : 1;
      const next =
        drag.startValue + Math.round((dx / 2) * fine) * stepRef.current;
      onCommitRef.current(next);
    };
    const onUp = (e: PointerEvent) => endScrub(e.pointerId);
    // Safety: never leave the global scrub flag stuck (blocks canvas select).
    const onLost = () => endScrub();
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    window.addEventListener('blur', onLost);
    window.document.addEventListener('visibilitychange', onLost);
    return () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      window.removeEventListener('blur', onLost);
      window.document.removeEventListener('visibilitychange', onLost);
      endScrub();
    };
  }, [endScrub]);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    window.document.documentElement.setAttribute('data-lottie-scrubbing', '1');
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startValue: valueRef.current,
      moved: false,
      target: el,
    };
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }, []);

  return { onPointerDown };
}

function ScrubIcon({
  value,
  onCommit,
  step = 1,
  children,
}: {
  value: number;
  onCommit: (n: number) => void;
  step?: number;
  children: ReactNode;
}) {
  const scrub = useLabelScrub(onCommit, value, step);
  return (
    <span className="inline-flex shrink-0 cursor-ew-resize select-none touch-none items-center justify-center text-[var(--muted)]" title="Drag to adjust" {...scrub}>
      {children}
    </span>
  );
}

function InspectorField({
  label,
  value,
  onCommit,
  suffix,
  kf,
  step = 1,
}: {
  label: string;
  value: number;
  onCommit: (n: number) => void;
  suffix?: string;
  kf?: ReactNode;
  step?: number;
}) {
  const scrub = useLabelScrub(onCommit, value, step);
  return (
    <div className="flex h-7 w-full min-w-0 items-center gap-0.5 rounded-sm bg-[var(--accent-soft)] px-1.5 text-[11px] text-[var(--ink)]">
      <span className="inline-flex w-5 shrink-0 cursor-ew-resize select-none touch-none items-center justify-center truncate text-center text-[10px] uppercase tracking-wide text-[var(--muted)]" title="Drag to adjust" {...scrub}>
        {label}
      </span>
      <input
        type="number"
        className="w-0 min-w-0 flex-1 border-0 bg-transparent text-[11px] tabular-nums text-[var(--ink)] outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        value={Number.isFinite(value) ? Math.round(value * 100) / 100 : 0}
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isFinite(n)) return;
          onCommit(n);
        }}
      />
      {suffix ? <span className="w-2.5 shrink-0 text-[10px] text-[var(--muted)]">{suffix}</span> : null}
      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center">{kf ?? null}</span>
    </div>
  );
}

function PairHalf({
  label,
  value,
  onCommit,
  suffix,
  step = 1,
}: {
  label: string;
  value: number;
  onCommit: (n: number) => void;
  suffix?: string;
  step?: number;
}) {
  const scrub = useLabelScrub(onCommit, value, step);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-0.5 px-1.5">
      <span className="inline-flex w-5 shrink-0 cursor-ew-resize select-none touch-none items-center justify-center truncate text-center text-[10px] uppercase tracking-wide text-[var(--muted)]" title="Drag to adjust" {...scrub}>
        {label}
      </span>
      <input
        type="number"
        className="w-0 min-w-0 flex-1 border-0 bg-transparent text-[11px] tabular-nums text-[var(--ink)] outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        value={Number.isFinite(value) ? Math.round(value * 100) / 100 : 0}
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isFinite(n)) return;
          onCommit(n);
        }}
      />
      {suffix ? <span className="w-2.5 shrink-0 text-[10px] text-[var(--muted)]">{suffix}</span> : null}
    </div>
  );
}

/** Rive-style joined dual field: left | mid | right + one shared keyframe. */
function PairedInspectorField({
  left,
  right,
  mid,
  kf,
}: {
  left: { label: string; value: number; onCommit: (n: number) => void; suffix?: string };
  right: { label: string; value: number; onCommit: (n: number) => void; suffix?: string };
  mid?: ReactNode;
  kf?: ReactNode;
}) {
  return (
    <div className="flex h-7 w-full min-w-0 items-center rounded-sm bg-[var(--accent-soft)] text-[11px] text-[var(--ink)]">
      <PairHalf {...left} />
      {mid ? (
        <span className="inline-flex h-7 w-6 shrink-0 items-center justify-center">{mid}</span>
      ) : (
        <div className="h-4 w-px shrink-0 self-center bg-[var(--line)]" aria-hidden />
      )}
      <PairHalf {...right} />
      <span className={cn('inline-flex h-8 w-8 shrink-0 items-center justify-center', 'pr-1')}>{kf ?? null}</span>
    </div>
  );
}

/** Rive-style anchor glyph: corners = L, edges = T, center = +. */
function AnchorGlyph({ id, active }: { id: LottieAnchorPreset; active: boolean }) {
  const stroke = active ? 'var(--surface)' : 'currentColor';
  const common = {
    fill: 'none' as const,
    stroke,
    strokeWidth: 1.35,
    strokeLinecap: 'square' as const,
    strokeLinejoin: 'miter' as const,
  };
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden>
      {id === 'tl' ? <path d="M3 9V3h6" {...common} /> : null}
      {id === 'tr' ? <path d="M3 3h6v6" {...common} /> : null}
      {id === 'bl' ? <path d="M3 3v6h6" {...common} /> : null}
      {id === 'br' ? <path d="M9 3v6H3" {...common} /> : null}
      {id === 'tm' ? <path d="M2 3h8M6 3v6" {...common} /> : null}
      {id === 'bm' ? <path d="M2 9h8M6 9V3" {...common} /> : null}
      {id === 'ml' ? <path d="M3 2v8M3 6h6" {...common} /> : null}
      {id === 'mr' ? <path d="M9 2v8M9 6H3" {...common} /> : null}
      {id === 'mm' ? (
        <>
          <path d="M2 6h8" {...common} />
          <path d="M6 2v8" {...common} />
        </>
      ) : null}
    </svg>
  );
}

function AnchorPointGrid({
  value,
  onChange,
}: {
  value: LottieAnchorPreset;
  onChange: (next: LottieAnchorPreset) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="grid h-14 w-14 shrink-0 grid-cols-3 grid-rows-3 gap-0.5 rounded-md border border-[var(--line)] bg-[var(--accent-soft)] p-1"
      role="group"
      aria-label={t('editor.lottieToolbar.anchorPoint')}
    >
      {ANCHOR_CELLS.map((id) => {
        const on = value === id;
        return (
          <button
            key={id}
            type="button"
            aria-label={id}
            aria-pressed={on}
            className={cn(
              'flex h-full w-full items-center justify-center rounded-[2px] text-[var(--muted)]',
              on
                ? 'bg-[var(--ink)] text-[var(--surface)]'
                : 'bg-transparent hover:bg-[var(--surface)] hover:text-[var(--ink)]'
            )}
            onClick={() => onChange(id)}
          >
            <AnchorGlyph id={id} active={on} />
          </button>
        );
      })}
    </div>
  );
}

function propHasKfAt(
  anim: Record<string, unknown> | null,
  layerInd: number,
  propKey: string,
  timeSec: number,
  fps: number
): boolean {
  if (!anim) return false;
  const layers = Array.isArray(anim.layers) ? (anim.layers as any[]) : [];
  const layer = layers.find((l) => Number(l?.ind) === layerInd);
  const prop = layer?.ks?.[propKey];
  if (!prop || Number(prop.a) !== 1 || !Array.isArray(prop.k)) return false;
  const frame = secToFrame(timeSec, fps);
  return prop.k.some((row: any) => Math.abs(Number(row?.t) - frame) <= 0.51);
}

function isAspectLocked(attrs: Record<string, unknown> | null | undefined): boolean {
  const raw = attrs?.lockAspect;
  return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

function isNodeHidden(attrs: Record<string, unknown> | null | undefined): boolean {
  const raw = attrs?.hidden;
  return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

function AnimationFrameChildToolbar({
  document,
  nodeId,
  box,
  valueBox,
  edgePadScene,
  angle,
}: Props) {
  const { t } = useTranslation();
  const camera = useRcbCamera();
  const dpr = useRcbDevicePixelRatio();
  const playhead = useSelector((s: any) => Number(s.editor.lottiePlayheadSec) || 0);
  const timelinePanelNodeId = useSelector(
    (s: any) => String(s.editor.lottieTimelinePanel?.nodeId || '').trim()
  );
  const imageToolPanel = useSelector(
    (s: any) => s.editor.imageToolPanel as ImageToolPanelState | null
  );
  const puppetActive =
    imageToolPanel?.kind === 'puppet' && imageToolPanel?.nodeId === nodeId;
  const node = document?.deltaSetLike?.[nodeId] as SceneNode | undefined;
  const frameId = resolveAnimationFrameId(document, node);
  const frame = useMemo(() => {
    if (!frameId || !document) return null;
    const frames = Array.isArray(document.frames) ? document.frames : [];
    return frames.find((f: any) => String(f?.id) === frameId) || null;
  }, [document, frameId]);
  const hostId = frameId ? findFrameAnimationMediaId(document, frameId) : null;
  /** Timeline dock open — hide diamond 「关键帧—(dock owns keyframes). */
  const editModeOpen = Boolean(timelinePanelNodeId);
  const host = hostId ? document?.deltaSetLike?.[hostId] : null;
  const anim = useMemo(
    () => parseLottieAnimationData(host?.attrs?.animationData),
    [host?.attrs?.animationData]
  );
  const fps = Math.max(1, Number(anim?.fr) || 30);
  const layerInd = Math.max(1, Number(node?.attrs?.lottieLayerInd) || 0);
  const geom = valueBox || box;
  const frameX = Number(frame?.x) || 0;
  const frameY = Number(frame?.y) || 0;
  const frameW = Math.max(1, Number(frame?.width) || 1);
  const frameH = Math.max(1, Number(frame?.height) || 1);
  const frameLocal = isFrameLocalCoordSpace(document);
  // Selection chrome is world; inspector fields are plate-local.
  const localX = geom.left - frameX;
  const localY = geom.top - frameY;
  const w = Math.max(1, geom.width);
  const h = Math.max(1, geom.height);
  const rot = angle ?? (Number(node?.attrs?.angle) || 0);
  const skew = Number(node?.attrs?.skewX ?? node?.attrs?.skew) || 0;
  const skewAxis = Number(node?.attrs?.skewAxis ?? node?.attrs?.skewY) || 0;
  const opacityRaw = Number(node?.attrs?.opacity);
  const opacity = Number.isFinite(opacityRaw)
    ? opacityRaw <= 1
      ? Math.round(opacityRaw * 100)
      : Math.round(opacityRaw)
    : 100;
  const fillOpacityRaw = Number(node?.attrs?.fillOpacity ?? node?.attrs?.['fill-opacity']);
  const fillOpacity = Number.isFinite(fillOpacityRaw)
    ? fillOpacityRaw <= 1
      ? Math.round(fillOpacityRaw * 100)
      : Math.round(fillOpacityRaw)
    : 100;
  const trimStart = Number(node?.attrs?.lottieTrimStart) || 0;
  const trimEnd = Number.isFinite(Number(node?.attrs?.lottieTrimEnd))
    ? Number(node?.attrs?.lottieTrimEnd)
    : 100;
  const trimOffset = Number(node?.attrs?.lottieTrimOffset) || 0;
  const aspectLocked = isAspectLocked(node?.attrs);
  const hidden = isNodeHidden(node?.attrs);
  const anchorHiddenRaw = node?.attrs?.anchorHidden;
  const anchorVisible = !(
    anchorHiddenRaw === true ||
    anchorHiddenRaw === 'true' ||
    anchorHiddenRaw === 1 ||
    anchorHiddenRaw === '1'
  );
  const anchor = parseAnchorPreset(node?.attrs?.anchorPreset);
  const canRadius = Boolean(node && supportsCornerRadius(node));
  const radius = cornerRadiusToolbarDisplay(node?.attrs);
  const isShape =
    node?.key === 'shape' ||
    node?.key === 'rect' ||
    node?.key === 'ellipse' ||
    node?.key === 'path';
  const isImage = node?.key === 'image';
  const isVector = isShape; // Appearance / Trim / Roundness ? not for raster images
  const fill = String(node?.attrs?.['fill-color'] || '#3B82F6');
  const fillHex = fill.startsWith('#') ? fill.replace('#', '').toUpperCase() : fill;
  const blendMode = parseBlendMode(node?.attrs?.blendMode);
  const matteLayer = String(node?.attrs?.lottieMatteLayer || '');
  const matteType = String(node?.attrs?.lottieMatteType || 'none');
  const hasMatte = Boolean(matteLayer) || (matteType !== 'none' && matteType !== '');
  const hasTrim =
    trimStart !== 0 || trimEnd !== 100 || trimOffset !== 0;
  const hasRoundness = canRadius && radius > 0;
  const [matteExpanded, setMatteExpanded] = useState(hasMatte);
  const [trimExpanded, setTrimExpanded] = useState(hasTrim);
  const [roundExpanded, setRoundExpanded] = useState(hasRoundness);
  const [appearExpanded, setAppearExpanded] = useState(isVector);
  const [imageOptsExpanded, setImageOptsExpanded] = useState(true);
  /** Property inspector — opened from 「关键帧— hides the align toolbar while open. */
  const [kfPanelOpen, setKfPanelOpen] = useState(false);
  /** Local hex draft while typing; null = show attrs. */
  const [fillHexDraft, setFillHexDraft] = useState<string | null>(null);

  useEffect(() => {
    setKfPanelOpen(false);
  }, [nodeId]);
  const fillHexShown = fillHexDraft ?? (fill === 'transparent' ? '' : fillHex);
  const commitFillHex = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      patchAttrs({ 'fill-color': 'transparent' });
      setFillHexDraft(null);
      return;
    }
    const next = normalizeHex(trimmed.startsWith('#') ? trimmed : `#${trimmed}`, fill);
    if (next === 'transparent' || next === fill) {
      setFillHexDraft(null);
      if (next !== fill) patchAttrs({ 'fill-color': next });
      return;
    }
    patchAttrs({ 'fill-color': next });
    setFillHexDraft(null);
  };
  const layerName =
    String(node?.attrs?.name || node?.attrs?.label || node?.key || 'Layer').trim() || 'Layer';
  const imageFileLabel = useMemo(() => {
    if (!isImage) return layerName;
    const named = String(node?.attrs?.name || '').trim();
    if (named) return named;
    const src = String(node?.attrs?.src || '');
    try {
      const path = src.split('?')[0];
      const base = path.split('/').pop() || path;
      return decodeURIComponent(base) || layerName;
    } catch {
      return layerName;
    }
  }, [isImage, layerName, node?.attrs?.name, node?.attrs?.src]);
  const style = panelStyleRight(camera, box, dpr);
  const panelRef = useRef<HTMLDivElement>(null);

  const ensureLinked = () => {
    if (!frameId) return null;
    ensureAnimationFrameMedia({ frameId });
    const doc = store.getState()?.editor?.document;
    const hid = findFrameAnimationMediaId(doc, frameId);
    const child = doc?.deltaSetLike?.[nodeId];
    const ind = Number(child?.attrs?.lottieLayerInd);
    const animationData = parseLottieAnimationData(
      doc?.deltaSetLike?.[hid || '']?.attrs?.animationData
    );
    if (!hid || !animationData || !Number.isFinite(ind) || ind <= 0) return null;
    return { hostId: hid, animationData, layerInd: ind };
  };

  const patchAttrs = (attrs: Record<string, unknown>, geomPatch?: Partial<SceneNode>) => {
    patchDocumentNode({
        nodeId,
        patch: {
          ...(geomPatch || {}),
          attrs,
        },
      });
    const docNow = store.getState()?.editor?.document || document;
    const mergedNode = {
      ...(docNow?.deltaSetLike?.[nodeId] || node || {}),
      ...(geomPatch || {}),
      attrs: {
        ...((docNow?.deltaSetLike?.[nodeId] || node)?.attrs || {}),
        ...attrs,
      },
    };
    const propKeys: string[] = [];
    if ('angle' in attrs) propKeys.push('r');
    if ('opacity' in attrs || 'fill-opacity' in attrs) propKeys.push('o');
    if ('skewX' in attrs || 'skew' in attrs) propKeys.push('sk');
    if ('skewAxis' in attrs) propKeys.push('sa');
    if ('lottieTrimStart' in attrs) propKeys.push('ts');
    if ('lottieTrimEnd' in attrs) propKeys.push('te');
    if ('lottieTrimOffset' in attrs) propKeys.push('to');
    if (
      'rx' in attrs ||
      'ry' in attrs ||
      'cornerRadius' in attrs ||
      'radius' in attrs ||
      'radiusTl' in attrs
    ) {
      propKeys.push('rd');
    }
    if ('anchorPreset' in attrs || 'anchorX' in attrs || 'anchorY' in attrs) {
      propKeys.push('a');
    }
    if (geomPatch && ('x' in geomPatch || 'y' in geomPatch)) propKeys.push('p');
    if (geomPatch && ('width' in geomPatch || 'height' in geomPatch)) propKeys.push('s');

    for (const propKey of [...new Set(propKeys)]) {
      const keyed = autoKeyAnimatedProp({
        document: {
          ...docNow,
          deltaSetLike: {
            ...(docNow?.deltaSetLike || {}),
            [nodeId]: mergedNode,
          },
        },
        nodeId,
        propKey,
        playheadSec: playhead,
      });
      if (keyed) {
        patchDocumentNode({
            nodeId: keyed.hostId,
            patch: { attrs: { animationData: keyed.animationJson } },
          });
      }
    }
    // Defer frame sync while label-scrubbing — sync each move was rewriting
    // chrome and felt like the selection width was changing under the pointer.
    // Use window.document: `document` in this component is the scene model.
    if (
      frameId &&
      !window.document.documentElement.hasAttribute('data-lottie-scrubbing')
    ) {
      ensureAnimationFrameMedia({ frameId });
    }
  };

  useEffect(() => {
    const onScrubEnd = () => {
      if (frameId) ensureAnimationFrameMedia({ frameId });
    };
    window.addEventListener('lottie-inspector-scrub-end', onScrubEnd);
    return () => window.removeEventListener('lottie-inspector-scrub-end', onScrubEnd);
  }, [frameId]);

  const commitWorldXY = (nextLocalX: number, nextLocalY: number) => {
    const stored = inspectorLocalToStoredXY(
      document,
      frameId,
      frameX,
      frameY,
      nextLocalX,
      nextLocalY
    );
    patchAttrs({}, { x: stored.x, y: stored.y });
  };

  /** World chrome origin → node storage x/y (frameLocal-aware). */
  const commitWorldOrigin = (worldLeft: number, worldTop: number) => {
    const stored = documentPointToNodeLocal(document, node, worldLeft, worldTop);
    patchAttrs({}, { x: Math.round(stored.x), y: Math.round(stored.y) });
  };

  /** Keep visual pose when changing Anchor; write anchorX/Y so canvas R/Sk/Sa pivot. */
  const commitAnchorPreset = (next: LottieAnchorPreset) => {
    const prev = anchor;
    const { fx: ofx, fy: ofy } = anchorPresetToFrac(prev);
    const { fx, fy } = anchorPresetToFrac(next);
    const angleDeg = rot;
    let nextWorldX = geom.left;
    let nextWorldY = geom.top;
    if (Math.abs(angleDeg) > 1e-6 && (ofx !== fx || ofy !== fy)) {
      const p0x = w * ofx;
      const p0y = h * ofy;
      const p1x = w * fx;
      const p1y = h * fy;
      const dx = p0x - p1x;
      const dy = p0y - p1y;
      const rad = (angleDeg * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const rx = cos * dx - sin * dy;
      const ry = sin * dx + cos * dy;
      nextWorldX = geom.left + (dx - rx);
      nextWorldY = geom.top + (dy - ry);
    }
    const stored = documentPointToNodeLocal(document, node, nextWorldX, nextWorldY);
    patchAttrs(
      {
        anchorPreset: next,
        anchorX: Math.round(fx * 100),
        anchorY: Math.round(fy * 100),
      },
      { x: Math.round(stored.x), y: Math.round(stored.y) }
    );
  };

  const toggleKf = (propKey: string) => {
    const linked = ensureLinked();
    if (!linked) {
      message.warning(
        t('editor.lottieTimeline.kfSyncFailed')
      );
      return;
    }
    const frameN = secToFrame(playhead, fps);
    const has = propHasKfAt(linked.animationData, linked.layerInd, propKey, playhead, fps);

    const plate = {
      left: frameX,
      top: frameY,
      width: frameW,
      height: frameH,
    };
    const local = sceneBoxToLottieLocal(
      { x: geom.left, y: geom.top, w, h },
      plate,
      frameW,
      frameH
    );
    const link = resolveAnimationLayerLink(
      store.getState()?.editor?.document || document,
      nodeId
    );
    const liveCtx = link
      ? liveValueContextFromLink(link)
      : {
          plate,
          animW: frameW,
          animH: frameH,
          layerBaseW: local.w,
          layerBaseH: local.h,
        };
    const { fx, fy } = anchorPresetToFrac(anchor);
    const explicitValue = ((): number | number[] | undefined => {
      if (propKey === 'p') {
        if (isImage) {
          const ax = local.w * fx;
          const ay = local.h * fy;
          return [local.x + ax, local.y + ay, 0];
        }
        return [local.x + local.w / 2, local.y + local.h / 2, 0];
      }
      if (propKey === 's') {
        return liveSceneValueForTransformProp(
          { key: isImage ? 'image' : node?.key, x: geom.left, y: geom.top, width: w, height: h, attrs: node?.attrs },
          's',
          liveCtx
        );
      }
      if (propKey === 'a') {
        if (isImage) return [local.w * fx, local.h * fy, 0];
        return [(fx - 0.5) * local.w, (fy - 0.5) * local.h, 0];
      }
      if (propKey === 'r') return rot;
      if (propKey === 'o') return opacity;
      if (propKey === 'sk') return skew;
      if (propKey === 'sa') return skewAxis;
      if (propKey === 'ts') return trimStart;
      if (propKey === 'te') return trimEnd;
      if (propKey === 'to') return trimOffset;
      if (propKey === 'rd') return radius;
      return undefined;
    })();

    const next = has
      ? removeTransformKeyframe({
          animationData: linked.animationData,
          sceneKind: 'main',
          layerInd: linked.layerInd,
          propKey,
          frame: frameN,
        })
      : upsertTransformKeyframe({
          animationData: linked.animationData,
          sceneKind: 'main',
          layerInd: linked.layerInd,
          propKey,
          frame: frameN,
          value: explicitValue,
        });
    if (!next) {
      message.warning(
        t('editor.lottieTimeline.kfWriteFailed')
      );
      return;
    }
    const json = serializeLottieAnimationData(next);
    if (!json) return;
    patchDocumentNode({ nodeId: linked.hostId, patch: { attrs: { animationData: json } } });
    window.dispatchEvent(
      new CustomEvent(LOTTIE_EXPAND_LAYER_EVENT, {
        detail: { layerInd: linked.layerInd, propKey },
      })
    );
  };

  const commitSize = (nextW: number, nextH: number) => {
    let width = Math.max(1, nextW);
    let height = Math.max(1, nextH);
    if (aspectLocked && w > 0 && h > 0) {
      if (Math.abs(width - w) >= Math.abs(height - h)) {
        height = Math.max(1, Math.round((width * h) / w));
      } else {
        width = Math.max(1, Math.round((height * w) / h));
      }
    }
    patchAttrs({}, { width, height });
  };

  const alignToFrame = (mode: (typeof ALIGN_ITEMS)[number]['mode']) => {
    let nextWorldX = geom.left;
    let nextWorldY = geom.top;
    if (mode === 'left') nextWorldX = frameX;
    if (mode === 'centerX') nextWorldX = frameX + (frameW - w) / 2;
    if (mode === 'right') nextWorldX = frameX + frameW - w;
    if (mode === 'top') nextWorldY = frameY;
    if (mode === 'middle') nextWorldY = frameY + (frameH - h) / 2;
    if (mode === 'bottom') nextWorldY = frameY + frameH - h;
    commitWorldOrigin(nextWorldX, nextWorldY);
  };

  const siblingBoxes = useMemo((): SiblingBox[] => {
    if (!frameId || !document) return [];
    const ids = nodeIdsBoundToFrames(document, [frameId]);
    const out: SiblingBox[] = [];
    for (const id of ids) {
      const n = document.deltaSetLike?.[id] as SceneNode | undefined;
      if (!n) continue;
      out.push({
        id,
        left: Number(n.x) || 0,
        top: Number(n.y) || 0,
        width: Math.max(1, Number(n.width) || 1),
        height: Math.max(1, Number(n.height) || 1),
      });
    }
    return out;
  }, [document, frameId]);

  const canJustify = siblingBoxes.length >= 1;

  const justifyInFrame = (axis: 'h' | 'v') => {
    if (!canJustify || !frame) return;
    // Sibling boxes use stored node.x/y — under frameLocal that is plate-local.
    const patches = justifyInFramePatches(siblingBoxes, axis, {
      x: frameLocal ? 0 : frameX,
      y: frameLocal ? 0 : frameY,
      w: frameW,
      h: frameH,
    });
    if (!patches.length) return;
    patchDocumentNodes({ patches });
    if (frameId) ensureAnimationFrameMedia({ frameId });
  };

  const kfTip = (on: boolean) =>
    on
      ? t('editor.lottieTimeline.removeKf')
      : t('editor.lottieTimeline.addKf');

  const blendOptions = useMemo(
    () => BLEND_MODE_OPTIONS.filter((o) => o.id !== 'pass-through'),
    []
  );

  const matteLayerOptions = useMemo(() => {
    const none = {
      key: '',
      label: t('editor.lottieToolbar.noMatte'),
    };
    if (!frameId || !document) return [none];
    const ids = nodeIdsBoundToFrames(document, [frameId]);
    const layers: Array<{ key: string; label: string }> = [];
    for (const id of ids) {
      if (id === nodeId) continue;
      const n = document.deltaSetLike?.[id] as SceneNode | undefined;
      if (!n) continue;
      const nm =
        String(n.attrs?.name || n.attrs?.label || n.key || id).trim() || id;
      layers.push({ key: id, label: nm });
    }
    return [none, ...layers];
  }, [document, frameId, nodeId, t]);

  if (!node || !frameId) return null;

  const hasP = propHasKfAt(anim, layerInd, 'p', playhead, fps);
  const hasS = propHasKfAt(anim, layerInd, 's', playhead, fps);
  const hasR = propHasKfAt(anim, layerInd, 'r', playhead, fps);
  const hasSk = propHasKfAt(anim, layerInd, 'sk', playhead, fps);
  const hasSa = propHasKfAt(anim, layerInd, 'sa', playhead, fps);
  const hasO = propHasKfAt(anim, layerInd, 'o', playhead, fps);
  const hasTs = propHasKfAt(anim, layerInd, 'ts', playhead, fps);
  const hasTe = propHasKfAt(anim, layerInd, 'te', playhead, fps);
  const hasTo = propHasKfAt(anim, layerInd, 'to', playhead, fps);
  const hasRd = propHasKfAt(anim, layerInd, 'rd', playhead, fps);

  const onOpenKeyframes = () => {
    // Sync host + layer inds so diamond toggles can write; panel is the UI for 关键帧.
    if (frameId) ensureAnimationFrameMedia({ frameId });
    setKfPanelOpen(true);
  };

  const alignBtnClass =
    'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--muted)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--ink)] disabled:opacity-35';

  return (
    <>
      <AnimationAnchorMarker
        box={geom}
        preset={anchor}
        hidden={!anchorVisible}
      />
      {!kfPanelOpen ? (
      <SelectionToolbarShell box={geom} angle={rot} edgePadScene={edgePadScene}>
        <div
          className="flex flex-nowrap items-center gap-0.5"
          role="group"
          aria-label={t('editor.selectionToolbar.align')}
        >
          {ALIGN_ITEMS.map((item) => (
            <Tooltip key={item.mode} tip={t(item.tipKey)} placement="top">
              <button
                type="button"
                aria-label={t(item.tipKey)}
                className={alignBtnClass}
                onClick={() => alignToFrame(item.mode)}
              >
                <Icon name={item.icon} width={14} height={14} />
              </button>
            </Tooltip>
          ))}
          <span className="mx-0.5 h-4 w-px shrink-0 bg-[var(--line)]" aria-hidden />
          <Tooltip
            tip={t('editor.selectionToolbar.distributeH')}
            placement="top"
          >
            <button
              type="button"
              aria-label={t('editor.selectionToolbar.distributeH')}
              className={cn(alignBtnClass, !canJustify && 'opacity-40')}
              disabled={!canJustify}
              onClick={() => justifyInFrame('h')}
            >
              <Icon name="editor-distribute" width={14} height={14} />
            </button>
          </Tooltip>
          <Tooltip
            tip={t('editor.selectionToolbar.distributeV')}
            placement="top"
          >
            <button
              type="button"
              aria-label={t('editor.selectionToolbar.distributeV')}
              className={cn(alignBtnClass, !canJustify && 'opacity-40')}
              disabled={!canJustify}
              onClick={() => justifyInFrame('v')}
            >
              <span className="inline-flex rotate-90">
                <Icon name="editor-distribute" width={14} height={14} />
              </span>
            </button>
          </Tooltip>
        </div>
        <ImageToolSep />
        <Tooltip
          tip={
            isImage
              ? t('editor.imageToolbar.puppet', { defaultValue: '人偶' })
              : t('editor.imageToolbar.puppetDisabled', {
                  defaultValue: '仅位图可使用人偶钉',
                })
          }
          placement="top"
        >
          <button
            type="button"
            className={cn(
              imageToolBtn,
              !isImage && 'opacity-40',
              puppetActive && 'bg-[var(--accent-soft)]'
            )}
            disabled={!isImage}
            aria-label={t('editor.imageToolbar.puppet', { defaultValue: '人偶' })}
            aria-pressed={puppetActive}
            onClick={(e) => {
              e.stopPropagation();
              if (!isImage) return;
              if (puppetActive) {
                closeImageToolPanel();
                return;
              }
              // Open panel first so chrome stays in puppet mode even if attrs patch re-renders.
              openImageToolPanel({ nodeId, kind: 'puppet' });
              patchDocumentNode({
                  nodeId,
                  patch: { attrs: { puppetEnabled: true } },
                });
              expandPuppetTimelineLayer(node);
            }}
          >
            <GiPuppet className="h-3 w-3" />
            <span>{t('editor.imageToolbar.puppet', { defaultValue: '人偶' })}</span>
          </button>
        </Tooltip>
        {!editModeOpen ? (
        <Tooltip
          tip={t('editor.lottieToolbar.propertiesTip')}
          placement="top"
        >
          <button
            type="button"
            className={imageToolBtn}
            onClick={onOpenKeyframes}
          >
            <span
              aria-hidden
              className="block h-2.5 w-2.5 shrink-0 rotate-45 border-[1.5px] border-current bg-transparent"
            />
            <span>{t('editor.lottieToolbar.timeline')}</span>
          </button>
        </Tooltip>
        ) : (
        <Tooltip
          tip={t('editor.lottieToolbar.propertiesTip')}
          placement="top"
        >
          <button
            type="button"
            className={imageToolBtn}
            onClick={onOpenKeyframes}
          >
            <span>{t('editor.lottieToolbar.properties')}</span>
          </button>
        </Tooltip>
        )}
        {isImage ? (
          <ImageToolbarMoreDownload
            showCornerRadius={supportsCornerRadius(node)}
            vectorizeEnabled={AI_IMAGE_PROCESS_KINDS.has('vector')}
            onAction={(key: ImageMoreAction) => {
              if (key === 'vectorize') {
                if (!AI_IMAGE_PROCESS_KINDS.has('vector')) {
                  message.warning(t('editor.lottieToolbar.vectorizeUnavailable'));
                  return;
                }
                startImageProcess({
                    sourceId: nodeId,
                    kind: 'vector',
                    label: t('editor.imageToolbar.vectorize', {
                      defaultValue: '矢量化',
                    }),
                  });
                return;
              }
              if (key === 'cornerRadius') {
                openShapeStylePanel({ kind: 'radius', nodeIds: [nodeId] });
                return;
              }
              if (
                key === 'expand' ||
                key === 'crop' ||
                key === 'adjust' ||
                key === 'blendMode' ||
                key === 'effects' ||
                key === 'flipRotate' ||
                key === 'opacity'
              ) {
                openImageToolPanel({ nodeId, kind: key });
              }
            }}
          />
        ) : null}
      </SelectionToolbarShell>
      ) : null}

      {kfPanelOpen ? (
      <RcbOverlayPortal>
        <div
          ref={panelRef}
          className="pointer-events-auto flex flex-col overflow-hidden rounded-xl bg-[var(--surface)] text-[var(--ink)] shadow-lg ring-1 ring-[var(--line)]"
          style={style}
          data-lottie-inspector
          onPointerDown={(e) => {
            // Same as ImageToolPanelHost ? keep selection; do not use capture.
            e.stopPropagation();
          }}
          onWheel={(e) => e.stopPropagation()}
        >
        <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[var(--line)] px-2">
          <div className="min-w-0 flex-1 truncate px-1 text-[12px] font-medium text-[var(--ink)]">
            {t('editor.lottieToolbar.properties')}
          </div>
          <Tooltip
            tip={t('editor.imageToolbar.panelExit')}
            placement="bottom"
          >
            <button
              type="button"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-[var(--muted)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--ink)]"
              aria-label={t('editor.imageToolbar.panelExit')}
              onClick={() => setKfPanelOpen(false)}
            >
              <BiExit className="h-[18px] w-[18px]" />
            </button>
          </Tooltip>
        </div>
        <div className="max-h-[min(70vh,500px)] min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain">
        {/* Name + transform */}
        <div className="space-y-1.5 px-3 py-2.5">
          <div className="flex h-8 items-center gap-1.5">
            {isImage ? (
              <HiOutlinePhoto className="h-3.5 w-3.5 shrink-0 text-[var(--muted)]" />
            ) : null}
            <div className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--ink)]">
              {isImage ? imageFileLabel : layerName}
            </div>
          </div>

          <div className="w-full min-w-0">
            <PairedInspectorField
              left={{
                label: 'X',
                value: localX,
                onCommit: (n) => commitWorldXY(n, localY),
              }}
              right={{
                label: 'Y',
                value: localY,
                onCommit: (n) => commitWorldXY(localX, n),
              }}
              kf={<KfDiamond active={hasP} tip={kfTip(hasP)} onClick={() => toggleKf('p')} />}
            />
          </div>

          <div className="w-full min-w-0">
            <PairedInspectorField
              left={{ label: 'W', value: w, onCommit: (n) => commitSize(n, h) }}
              mid={
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
                    aria-pressed={aspectLocked}
                    className={cn(
                      'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-[var(--muted)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--ink)]',
                      aspectLocked && 'text-[var(--ink)]'
                    )}
                    onClick={() => patchAttrs({ lockAspect: aspectLocked ? 'false' : 'true' })}
                  >
                    {aspectLocked ? (
                      <HiOutlineLink className="h-3.5 w-3.5" strokeWidth={1.75} />
                    ) : (
                      <HiOutlineLinkSlash className="h-3.5 w-3.5" strokeWidth={1.75} />
                    )}
                  </button>
                </Tooltip>
              }
              right={{ label: 'H', value: h, onCommit: (n) => commitSize(w, n) }}
              kf={<KfDiamond active={hasS} tip={kfTip(hasS)} onClick={() => toggleKf('s')} />}
            />
          </div>

          <div className="grid w-full grid-cols-2 items-center gap-1.5 [&>*]:min-w-0">
            <InspectorField
              label="R"
              value={rot}
              suffix={'\u00B0'}
              onCommit={(n) => patchAttrs({ angle: n })}
              kf={<KfDiamond active={hasR} tip={kfTip(hasR)} onClick={() => toggleKf('r')} />}
            />
            <InspectorField
              label="Sk"
              value={skew}
              suffix={'\u00B0'}
              onCommit={(n) => patchAttrs({ skewX: n, skewY: '' })}
              kf={<KfDiamond active={hasSk} tip={kfTip(hasSk)} onClick={() => toggleKf('sk')} />}
            />
          </div>

          <div className="w-full min-w-0">
            <InspectorField
              label="Sa"
              value={skewAxis}
              suffix={'\u00B0'}
              onCommit={(n) => patchAttrs({ skewAxis: n, skewY: '' })}
              kf={<KfDiamond active={hasSa} tip={kfTip(hasSa)} onClick={() => toggleKf('sa')} />}
            />
          </div>
        </div>

        {/* Anchor — header like Layer; no keyframe diamond (Rive) */}
        <div className="border-t border-[var(--line)]">
          <div className="flex h-8 items-center gap-1.5 px-3 text-[12px] font-medium text-[var(--ink)]">
            <span className="min-w-0 flex-1 truncate">
              {t('editor.lottieToolbar.anchorPoint')}
            </span>
            <button
              type="button"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-[var(--muted)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--ink)] disabled:opacity-35"
              aria-label={t('editor.lottieToolbar.toggleAnchor')}
              aria-pressed={anchorVisible}
              onClick={() => patchAttrs({ anchorHidden: anchorVisible ? 'true' : 'false' })}
            >
              {anchorVisible ? (
                <HiOutlineEye className="h-4 w-4" />
              ) : (
                <HiOutlineEyeSlash className="h-4 w-4" />
              )}
            </button>
          </div>
          <div className="flex justify-end px-3 pb-3">
            <AnchorPointGrid value={anchor} onChange={commitAnchorPreset} />
          </div>
        </div>

        {/* Layer */}
        <div className="border-t border-[var(--line)]">
          <div className="flex h-8 items-center gap-1.5 px-3 text-[12px] font-medium text-[var(--ink)]">
            <span className="min-w-0 flex-1 truncate">
            {t('editor.lottieToolbar.layerSection')}
            </span>
            <button
              type="button"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-[var(--muted)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--ink)] disabled:opacity-35"
              aria-pressed={!hidden}
              aria-label={t('editor.lottieToolbar.toggleVisibility')}
              onClick={() => patchAttrs({ hidden: hidden ? 'false' : 'true' })}
            >
              {hidden ? (
                <HiOutlineEyeSlash className="h-4 w-4" />
              ) : (
                <HiOutlineEye className="h-4 w-4" />
              )}
            </button>
          </div>
          <div className="flex w-full items-center gap-1.5 px-3 pb-3">
            <div className={cn('flex h-8 w-full min-w-0 items-center gap-1 rounded-sm bg-[var(--accent-soft)] px-2 text-[12px] text-[var(--ink)]', 'w-[6.5rem] shrink-0 flex-none')}>
              <ScrubIcon
                value={opacity}
                onCommit={(n) =>
                  patchAttrs({ opacity: Math.max(0, Math.min(100, Math.round(n))) })
                }
              >
                <MdOutlineOpacity className="h-4 w-4 shrink-0" />
              </ScrubIcon>
              <input
                type="number"
                className="w-0 min-w-0 flex-1 border-0 bg-transparent text-[12px] tabular-nums text-[var(--ink)] outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                value={opacity}
                onPointerDown={(e) => e.stopPropagation()}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (!Number.isFinite(n)) return;
                  patchAttrs({ opacity: Math.max(0, Math.min(100, Math.round(n))) });
                }}
              />
              <span className="w-3 shrink-0 text-[11px] text-[var(--muted)]">%</span>
              <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center">
                <KfDiamond active={hasO} tip={kfTip(hasO)} onClick={() => toggleKf('o')} />
              </span>
            </div>
            <InspectorSelect
              className="min-w-0 flex-1"
              value={blendMode}
              ariaLabel={t('editor.imageToolbar.blendMode')}
              options={blendOptions.map((o) => ({
                key: o.id,
                label: t(`editor.blendMode.${o.id}`),
              }))}
              onChange={(key) => patchAttrs({ blendMode: key })}
            />
          </div>
        </div>

        {/* Appearance ? vectors only */}
        {isVector ? (
          <div className="border-t border-[var(--line)]">
            <SectionHeader
              title={t('editor.lottieToolbar.appearance')}
              open={appearExpanded}
              onToggle={() => setAppearExpanded((v) => !v)}
            />
            {appearExpanded ? (
              <div className="grid grid-cols-[minmax(0,1fr)_1.5rem] items-center gap-1.5 px-3 pb-2.5">
                <div className="flex h-7 w-full min-w-0 items-center gap-0.5 rounded-sm bg-[var(--accent-soft)] px-1.5 text-[11px] text-[var(--ink)]">
                  <button
                    type="button"
                    className="h-3.5 w-3.5 shrink-0 rounded-full ring-1 ring-[var(--line)]"
                    style={{ background: fill === 'transparent' ? 'transparent' : fill }}
                    aria-label={t('editor.selectionToolbar.color')}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() =>
                      openShapeStylePanel({ kind: 'fill', nodeIds: [nodeId] })
                    }
                  />
                  <input
                    type="text"
                    spellCheck={false}
                    className={cn('w-0 min-w-0 flex-1 border-0 bg-transparent text-[11px] tabular-nums text-[var(--ink)] outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none', 'font-mono tracking-wide uppercase')}
                    value={fillHexShown}
                    placeholder="HEX"
                    aria-label={t('editor.selectionToolbar.color')}
                    onPointerDown={(e) => e.stopPropagation()}
                    onFocus={() => setFillHexDraft(fill === 'transparent' ? '' : fillHex)}
                    onChange={(e) => {
                      const v = e.target.value.replace(/[^0-9a-fA-F#]/g, '').slice(0, 7);
                      setFillHexDraft(v.replace(/^#/, ''));
                    }}
                    onBlur={() => commitFillHex(fillHexDraft ?? fillHexShown)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        (e.target as HTMLInputElement).blur();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setFillHexDraft(null);
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                  />
                </div>
                <button
                  type="button"
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-[var(--muted)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--ink)] disabled:opacity-35"
                  aria-label={t('editor.selectionToolbar.clearFill')}
                  onClick={() => {
                    setFillHexDraft(null);
                    patchAttrs({ 'fill-color': 'transparent' });
                  }}
                >
                  <HiOutlineMinus className="h-3.5 w-3.5" />
                </button>
                <div className="flex h-7 w-full min-w-0 items-center gap-0.5 rounded-sm bg-[var(--accent-soft)] px-1.5 text-[11px] text-[var(--ink)]">
                  <MdOutlineOpacity className="h-3.5 w-3.5 shrink-0 text-[var(--muted)]" />
                  <input
                    type="number"
                    className="w-0 min-w-0 flex-1 border-0 bg-transparent text-[11px] tabular-nums text-[var(--ink)] outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    value={fillOpacity}
                    onPointerDown={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (!Number.isFinite(n)) return;
                      patchAttrs({ fillOpacity: Math.max(0, Math.min(100, Math.round(n))) });
                    }}
                  />
                  <span className="w-2.5 shrink-0 text-[10px] text-[var(--muted)]">%</span>
                </div>
                <span aria-hidden />
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Matte ? Rive: Matte Layer dropdown only */}
        <div className="border-t border-[var(--line)]">
          <SectionHeader
            title={t('editor.lottieToolbar.matte')}
            open={matteExpanded}
            onToggle={() => {
              if (matteExpanded) {
                patchAttrs({ lottieMatteLayer: '', lottieMatteType: 'none' });
                setMatteExpanded(false);
              } else {
                setMatteExpanded(true);
              }
            }}
          />
          {matteExpanded ? (
            <div className="px-3 pb-3">
              <div className="mb-1 text-[10px] font-medium text-[var(--muted)]">
                {t('editor.lottieToolbar.matteLayer')}
              </div>
              <InspectorSelect
                className="h-7 text-[11px]"
                value={matteLayer}
                ariaLabel={t('editor.lottieToolbar.matteLayer')}
                options={matteLayerOptions.map((o) => ({
                  key: o.key,
                  label: o.label,
                }))}
                onChange={(key) => {
                  patchAttrs({
                    lottieMatteLayer: key,
                    lottieMatteType: key
                      ? matteType === 'none'
                        ? 'alpha'
                        : matteType
                      : 'none',
                  });
                }}
              />
            </div>
          ) : null}
        </div>

        {/* Trim path / Roundness ? vectors only */}
        {isVector ? (
          <>
            <div className="border-t border-[var(--line)]">
              <SectionHeader
                title={t('editor.lottieToolbar.trimPath')}
                open={trimExpanded}
                onToggle={() => {
                  if (trimExpanded) {
                    patchAttrs({ lottieTrimStart: 0, lottieTrimEnd: 100, lottieTrimOffset: 0 });
                    setTrimExpanded(false);
                  } else {
                    setTrimExpanded(true);
                  }
                }}
              />
              {trimExpanded ? (
                <div className="space-y-2 px-3 pb-3">
                  <div className="grid w-full grid-cols-2 gap-1.5 [&>*]:min-w-0">
                    <LabeledValueField
                      caption={t('editor.lottieToolbar.trimStart')}
                      icon={<TrimStartIcon />}
                      value={trimStart}
                      suffix="%"
                      onCommit={(n) =>
                        patchAttrs({ lottieTrimStart: Math.max(0, Math.min(100, n)) })
                      }
                      kf={
                        <KfDiamond
                          active={hasTs}
                          tip={kfTip(hasTs)}
                          onClick={() => toggleKf('ts')}
                        />
                      }
                    />
                    <LabeledValueField
                      caption={t('editor.lottieToolbar.trimEnd')}
                      icon={<TrimEndIcon />}
                      value={trimEnd}
                      suffix="%"
                      onCommit={(n) =>
                        patchAttrs({ lottieTrimEnd: Math.max(0, Math.min(100, n)) })
                      }
                      kf={
                        <KfDiamond
                          active={hasTe}
                          tip={kfTip(hasTe)}
                          onClick={() => toggleKf('te')}
                        />
                      }
                    />
                  </div>
                  <div className="w-1/2 min-w-0">
                    <LabeledValueField
                      caption={t('editor.lottieToolbar.trimOffset')}
                      icon={<TrimOffsetIcon />}
                      value={trimOffset}
                      suffix={'\u00B0'}
                      onCommit={(n) => patchAttrs({ lottieTrimOffset: n })}
                      kf={
                        <KfDiamond
                          active={hasTo}
                          tip={kfTip(hasTo)}
                          onClick={() => toggleKf('to')}
                        />
                      }
                    />
                  </div>
                </div>
              ) : null}
            </div>

            {canRadius ? (
              <div className="border-t border-[var(--line)]">
                <SectionHeader
                  title={t('editor.lottieToolbar.roundness')}
                  open={roundExpanded}
                  onToggle={() => {
                    if (roundExpanded) {
                      patchAttrs({
                        cornerRadius: 0,
                        cornerRadiusTL: 0,
                        cornerRadiusTR: 0,
                        cornerRadiusBR: 0,
                        cornerRadiusBL: 0,
                      });
                      setRoundExpanded(false);
                    } else {
                      setRoundExpanded(true);
                    }
                  }}
                />
                {roundExpanded ? (
                  <div className="w-1/2 min-w-0 px-3 pb-3">
                    <LabeledValueField
                      caption={t('editor.lottieToolbar.roundness')}
                      icon={<IconCornerRadius className="h-3.5 w-3.5 shrink-0" />}
                      value={radius}
                      onCommit={(n) => {
                        const v = Math.max(0, Math.round(n));
                        patchAttrs({
                          cornerRadius: v,
                          cornerRadiusTL: v,
                          cornerRadiusTR: v,
                          cornerRadiusBR: v,
                          cornerRadiusBL: v,
                        });
                      }}
                      kf={
                        <KfDiamond
                          active={hasRd}
                          tip={kfTip(hasRd)}
                          onClick={() => toggleKf('rd')}
                        />
                      }
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}

        {/* Image Options — name only; 矢量—lives on the image toolbar More menu. */}
        {isImage ? (
          <div className="border-t border-[var(--line)]">
            <SectionHeader
              title={t('editor.lottieToolbar.imageOptions')}
              open={imageOptsExpanded}
              onToggle={() => setImageOptsExpanded((v) => !v)}
            />
            {imageOptsExpanded ? (
              <div className="space-y-2 px-3 pb-3">
                <input
                  type="text"
                  className="h-7 w-full rounded-sm border-0 bg-[var(--accent-soft)] px-2 text-[11px] text-[var(--ink)] outline-none"
                  value={String(node?.attrs?.name || imageFileLabel)}
                  onChange={(e) => patchAttrs({ name: e.target.value })}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        </div>
      </div>
    </RcbOverlayPortal>
      ) : null}
    </>
  );
}

export default memo(AnimationFrameChildToolbar);
