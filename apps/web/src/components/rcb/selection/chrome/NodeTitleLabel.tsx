/**
 * Frame / image / video title row above the control box.
 * Same dock as selection toolbars: {@link WorldScreenChromeRoot}
 * (`rcbSceneToScreen` + screen-constant `edgeGapPx`), so zoom cannot eat the gap.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  type SVGProps,
  memo,
} from 'react';
import { LuAudioLines, LuImagePlus, LuType } from 'react-icons/lu';
import { RiVideoAiLine } from 'react-icons/ri';
import { HiOutlineVideoCamera } from 'react-icons/hi2';
import { AnimationOutlineIcon } from '@/components/editor/nodes/AnimationNode/AnimationOutlineIcon';
import {
  useRcbCamera,
  rcbCameraCssZoom,
} from '@/components/rcb';
import {
  NODE_TITLE_LABEL_GAP_PX,
  NODE_TITLE_LABEL_INSET_PX,
  NODE_TITLE_LABEL_LINE_PX,
  WorldScreenChromeRoot,
  orientedBoxAabb,
} from './SelectionToolbarShell';
import { liveShapeGeomBox } from '../hostGeom';
import { shiftConstrainedMoveDelta } from '../selectionLogic';
import { cn } from '@/utils/classnames';

type NodeTitleLabelBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type NodeTitleIcon =
  | 'frame'
  | 'image'
  | 'image-generator'
  | 'video'
  | 'video-generator'
  | 'lottie'
  | 'lottie-generator'
  | 'audio'
  | 'text';

type Props = {
  /** Scene-space AABB of the node / frame. */
  box: NodeTitleLabelBox;
  name: string;
  sizeWidth: number;
  sizeHeight: number;
  /** Hit-test marker: `data-frame-label` | `data-image-label`. */
  dataAttr: 'frame-label' | 'image-label';
  icon?: NodeTitleIcon;
  dataProps?: Record<string, string>;
  /** Degrees; dock uses oriented AABB (title stays screen-upright). */
  angle?: number;
  hidden?: boolean;
  onSelect?: () => void;
  onRename?: (name: string, options?: { skipHistory?: boolean }) => void;
  onMove?: (
    x: number,
    y: number,
    opts?: { skipGrid?: boolean; axisLock?: 'h' | 'v' }
  ) => void;
  onMoveStart?: () => void;
  onMoveEnd?: () => void;
  originX?: number;
  originY?: number;
  renameAriaLabel?: string;
  /** Short badge after the name (e.g. mockup mode indicator). */
  titleSuffix?: string;
  /**
   * Prefer live host lattice (same as blue control box). When set, overrides
   * `box` left/top/size from the editor store so the title does not drift after sticky snap.
   */
  nodeId?: string;
  /** Kept for call-site compat; overlay chrome uses fixed stacking like toolbars. */
  zIndex?: number;
};

const MUTED = 'var(--muted)';
/** Idle + edit font (screen px). */
const TITLE_FONT_PX = 11;
const TITLE_ICON_PX = 12;

const STROKE_ICON = {
  fill: 'none' as const,
  stroke: MUTED,
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

/**
 * Scene-space title layout contract (toolbar clearance / tests).
 * Paint uses {@link WorldScreenChromeRoot}; these numbers stay `screenPx / zoom`.
 */
export function nodeTitleLabelWorldPlacement(
  box: NodeTitleLabelBox,
  zoom: number,
  opts?: { sizeText?: string }
) {
  const z = Math.max(0.05, zoom || 1);
  const inv = 1 / z;
  const gapScene = NODE_TITLE_LABEL_GAP_PX * inv;
  const lineScene = NODE_TITLE_LABEL_LINE_PX * inv;
  const fontSize = TITLE_FONT_PX * inv;
  const iconSize = TITLE_ICON_PX * inv;
  const insetScene = NODE_TITLE_LABEL_INSET_PX * inv;
  const labelBottomScene = box.top - gapScene;
  const labelTopScene = labelBottomScene - lineScene;
  const textY = labelTopScene + lineScene * 0.5;
  const sizeText = opts?.sizeText ?? '000 × 000';
  const sizeReserve = Math.max(fontSize * 3, sizeText.length * fontSize * 0.62);
  const iconX = box.left + insetScene;
  const nameX = iconX + iconSize + 4 * inv;
  const sizeX = box.left + Math.max(1, box.width);
  return {
    inv,
    gapScene,
    lineScene,
    fontSize,
    iconSize,
    labelBottomScene,
    labelTopScene,
    textY,
    iconX,
    iconY: textY - iconSize * 0.5,
    nameX,
    sizeX,
    nameMaxWidth: Math.max(0, sizeX - 8 * inv - sizeReserve - nameX),
    sizeReserve,
    hitLeft: iconX,
    hitTop: labelTopScene,
    hitWidth: Math.max(1, box.width - insetScene),
    hitHeight: lineScene,
  };
}

/** Stage layout px from plate top → title bottom. */
export function nodeTitleScreenGapPx(
  place: { labelBottomScene: number },
  boxTop: number,
  cameraZoom: number,
  viewportScale = 1
): number {
  const z = Math.max(0.05, cameraZoom || 1);
  const sx = viewportScale > 0 ? viewportScale : 1;
  return (boxTop - place.labelBottomScene) * z * sx;
}

function LucideTitleIcon({
  Icon,
  opacity,
  size = TITLE_ICON_PX,
}: {
  Icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number }>;
  opacity?: number;
  size?: number;
}): ReactNode {
  return (
    <Icon
      size={size}
      strokeWidth={2}
      className="shrink-0"
      style={{ color: MUTED, opacity }}
      aria-hidden
    />
  );
}

function SvgTitleIcon({
  children,
  size = TITLE_ICON_PX,
}: {
  children: ReactNode;
  size?: number;
}): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className="shrink-0"
      aria-hidden
    >
      {children}
    </svg>
  );
}

/** Same glyphs as context-menu Generators. */
function TitleIcon({ kind, size = TITLE_ICON_PX }: { kind: NodeTitleIcon; size?: number }): ReactNode {
  switch (kind) {
    case 'audio':
      return <LucideTitleIcon Icon={LuAudioLines} size={size} />;
    case 'text':
      return <LucideTitleIcon Icon={LuType} size={size} />;
    case 'image-generator':
      return <LucideTitleIcon Icon={LuImagePlus} size={size} />;
    case 'video-generator':
      return <LucideTitleIcon Icon={RiVideoAiLine} opacity={0.72} size={size} />;
    case 'lottie':
    case 'lottie-generator':
      return (
        <AnimationOutlineIcon
          size={size}
          strokeWidth={1.75}
          className="shrink-0"
          style={{ color: MUTED }}
        />
      );
    case 'frame':
      return (
        <SvgTitleIcon size={size}>
          <rect x={1.5} y={1.5} width={21} height={21} rx={2} {...STROKE_ICON} />
          <path d="M1.5 8h21" {...STROKE_ICON} />
          <path d="M8 22.5V8" {...STROKE_ICON} />
        </SvgTitleIcon>
      );
    case 'video':
      return <LucideTitleIcon Icon={HiOutlineVideoCamera} size={size} />;
    default:
      return (
        <SvgTitleIcon size={size}>
          <rect x={1.5} y={1.5} width={21} height={21} rx={2} {...STROKE_ICON} />
          <circle cx={9} cy={9} r={2} {...STROKE_ICON} />
          <path d="M21 15l-5-5L5 21" {...STROKE_ICON} />
        </SvgTitleIcon>
      );
  }
}

function TitleNameField({
  editing,
  name,
  titleSuffix,
  renameAriaLabel,
  inputRef,
  onRenameLive,
  onCommit,
  onCancel,
}: {
  editing: boolean;
  name: string;
  titleSuffix?: string;
  renameAriaLabel?: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onRenameLive: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}): ReactNode {
  if (!editing) {
    return (
      <span className="min-w-0 flex-1 truncate leading-none">
        {name}
        {titleSuffix ? (
          <span className="ml-1 opacity-70">{titleSuffix}</span>
        ) : null}
      </span>
    );
  }
  return (
    <input
      ref={inputRef}
      data-rcb-title-edit="1"
      className="min-w-0 flex-1 bg-transparent outline-none leading-none"
      style={{ color: MUTED, fontSize: TITLE_FONT_PX }}
      defaultValue={name}
      aria-label={renameAriaLabel || name}
      onChange={(e) => onRenameLive(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
        e.stopPropagation();
      }}
    />
  );
}

/**
 * Title row above frames / images / generators — overlay chrome like toolbars.
 */
function NodeTitleLabel({
  box,
  name,
  sizeWidth,
  sizeHeight,
  dataAttr,
  icon,
  dataProps,
  angle = 0,
  hidden = false,
  onSelect,
  onRename,
  onMove,
  onMoveStart,
  onMoveEnd,
  originX = 0,
  originY = 0,
  renameAriaLabel,
  titleSuffix,
  nodeId,
}: Props): ReactNode {
  const [editing, setEditing] = useState(false);
  const [labelDragging, setLabelDragging] = useState(false);
  const lastRenamedRef = useRef(name);
  const renameStartRef = useRef(name);
  const wroteDuringEditRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const wasEditingRef = useRef(false);
  const labelDragRef = useRef<{
    originX: number;
    originY: number;
    clientX0: number;
    clientY0: number;
    started: boolean;
    moveAxisLock?: 'h' | 'v';
  } | null>(null);

  const camera = useRcbCamera();
  const z = Math.max(0.05, rcbCameraCssZoom(camera));
  const sizeText = `${Math.round(sizeWidth)} × ${Math.round(sizeHeight)}`;
  const plate = (nodeId && liveShapeGeomBox(nodeId)) || box;
  const dock = orientedBoxAabb(plate, angle);

  useEffect(() => {
    if (!editing) lastRenamedRef.current = name;
  }, [name, editing]);

  const rename = (value: string, options?: { skipHistory?: boolean }) => {
    if (value === lastRenamedRef.current) return;
    lastRenamedRef.current = value;
    const skipHistory = Boolean(options?.skipHistory && wroteDuringEditRef.current);
    onRename?.(value, { skipHistory });
    if (options?.skipHistory) wroteDuringEditRef.current = true;
  };

  const beginRename = () => {
    if (!onRename) return;
    renameStartRef.current = name;
    wroteDuringEditRef.current = false;
    setEditing(true);
  };

  const commit = () => {
    const next = (inputRef.current?.value ?? '').trim() || name;
    setEditing(false);
    rename(next);
  };

  const cancelRename = () => {
    rename(renameStartRef.current, { skipHistory: true });
    setEditing(false);
  };

  useLayoutEffect(() => {
    const wasEditing = wasEditingRef.current;
    wasEditingRef.current = editing;
    if (!editing) return;
    const el = inputRef.current;
    if (!el) return;
    if (window.document.activeElement !== el) el.focus({ preventScroll: true });
    if (!wasEditing) el.select();
  }, [editing]);

  useEffect(() => {
    if (!editing) return undefined;
    const onPointerDown = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest?.('[data-rcb-title-edit="1"]')) return;
      window.requestAnimationFrame(() => {
        const value = (inputRef.current?.value ?? '').trim() || name;
        setEditing(false);
        rename(value);
      });
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [editing, name, onRename]);

  if (hidden || labelDragging) return null;

  const iconKind = icon ?? (dataAttr === 'frame-label' ? 'frame' : 'image');
  const hitAttr =
    dataAttr === 'frame-label'
      ? ({ 'data-frame-label': true } as const)
      : ({ 'data-image-label': true } as const);

  const onLabelPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button === 2) return;
    e.stopPropagation();
    if (editing) return;
    onSelect?.();
    if (e.detail === 2) {
      e.preventDefault();
      beginRename();
      return;
    }
    if (!onMove || e.button !== 0) return;

    labelDragRef.current = {
      originX,
      originY,
      clientX0: e.clientX,
      clientY0: e.clientY,
      started: false,
    };

    const onMoveWin = (ev: PointerEvent) => {
      const drag = labelDragRef.current;
      if (!drag) return;
      const dx = (ev.clientX - drag.clientX0) / z;
      const dy = (ev.clientY - drag.clientY0) / z;
      if (!drag.started) {
        if (Math.hypot(dx, dy) < 3) return;
        drag.started = true;
        setLabelDragging(true);
        onMoveStart?.();
      }
      const { dx: cdx, dy: cdy } = shiftConstrainedMoveDelta(drag, dx, dy, ev.shiftKey);
      onMove(Math.round(drag.originX + cdx), Math.round(drag.originY + cdy), {
        skipGrid: ev.ctrlKey || ev.metaKey,
        axisLock: drag.moveAxisLock,
      });
    };

    const onUpWin = () => {
      const wasDragging = labelDragRef.current?.started;
      labelDragRef.current = null;
      setLabelDragging(false);
      window.removeEventListener('pointermove', onMoveWin);
      window.removeEventListener('pointerup', onUpWin);
      if (wasDragging) onMoveEnd?.();
    };

    window.addEventListener('pointermove', onMoveWin);
    window.addEventListener('pointerup', onUpWin);
  };

  return (
    <WorldScreenChromeRoot
      left={dock.left}
      top={dock.top}
      railWidth={Math.max(0, dock.width)}
      anchor="bottom"
      edgeGapPx={NODE_TITLE_LABEL_GAP_PX}
      fillRail
      data-rcb-node-title="1"
    >
      <div
        {...hitAttr}
        {...dataProps}
        role="button"
        tabIndex={0}
        aria-label={renameAriaLabel || name}
        className={cn(
          'pointer-events-auto flex min-w-0 items-center justify-between overflow-hidden font-medium select-none',
          onMove ? 'cursor-grab' : 'cursor-default'
        )}
        style={{
          width: '100%',
          height: NODE_TITLE_LABEL_LINE_PX,
          margin: 0,
          padding: 0,
          boxSizing: 'border-box',
          gap: 4,
          paddingLeft: NODE_TITLE_LABEL_INSET_PX,
          paddingRight: NODE_TITLE_LABEL_INSET_PX,
          color: MUTED,
          fontSize: TITLE_FONT_PX,
          lineHeight: `${NODE_TITLE_LABEL_LINE_PX}px`,
        }}
        onPointerDown={onLabelPointerDown}
        onKeyDown={(e) => {
          if (editing || (e.key !== 'Enter' && e.key !== ' ')) return;
          e.preventDefault();
          e.stopPropagation();
          onSelect?.();
          if (e.key === 'Enter') beginRename();
        }}
        onDoubleClick={(e) => {
          if (!onRename) return;
          e.preventDefault();
          e.stopPropagation();
          onSelect?.();
          beginRename();
        }}
      >
        <TitleIcon kind={iconKind} />
        <TitleNameField
          editing={editing && Boolean(onRename)}
          name={name}
          titleSuffix={titleSuffix}
          renameAriaLabel={renameAriaLabel}
          inputRef={inputRef}
          onRenameLive={(value) => rename(value, { skipHistory: true })}
          onCommit={commit}
          onCancel={cancelRename}
        />
        <span className="shrink-0 opacity-80 tabular-nums leading-none">{sizeText}</span>
      </div>
    </WorldScreenChromeRoot>
  );
}

export default memo(NodeTitleLabel);
