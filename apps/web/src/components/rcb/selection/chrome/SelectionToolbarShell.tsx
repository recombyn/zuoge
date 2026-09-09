import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  memo,
} from 'react';
import {
  RcbOverlayPortal,
  useRcbCamera,
  useRcbDevicePixelRatio,
} from '../../camera/context';
import { rcbCameraCssZoom, rcbSceneToScreen } from '../../core/math';
import { FloatingToolbar } from '@/components/editor/chrome/FloatingToolbar';
import { cn } from '@/utils/classnames';

/** Interactive controls inside canvas overlays (toolbars / generators / menus). */
const CHROME_ACTION_SEL =
  'button:not([disabled]), [role="button"]:not([aria-disabled="true"]), [role="menuitem"]:not([aria-disabled="true"])';

function chromeActionFromEvent(
  target: EventTarget | null,
  root: EventTarget & HTMLElement
): HTMLElement | null {
  const el = (target as HTMLElement | null)?.closest?.(CHROME_ACTION_SEL) as HTMLElement | null;
  if (!el || !root.contains(el)) return null;
  return el;
}

/**
 * Activate chrome buttons on pointer down/up (same path as node hits).
 * Suppresses the following real click after a synthetic `.click()`.
 */
export function useChromePointerActivate() {
  const armedRef = useRef<HTMLElement | null>(null);
  const suppressBrowserClickRef = useRef(false);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation?.();
    suppressBrowserClickRef.current = false;
    if (e.button !== 0) {
      armedRef.current = null;
      return;
    }
    armedRef.current = chromeActionFromEvent(e.target, e.currentTarget);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const armed = armedRef.current;
    armedRef.current = null;
    if (!armed || e.button !== 0) return;
    if (chromeActionFromEvent(e.target, e.currentTarget) !== armed) return;
    e.preventDefault();
    e.stopPropagation();
    suppressBrowserClickRef.current = true;
    armed.click();
  };

  const onPointerCancel = () => {
    armedRef.current = null;
    suppressBrowserClickRef.current = false;
  };

  const onClickCapture = (e: ReactMouseEvent<HTMLElement>) => {
    if (!suppressBrowserClickRef.current) return;
    // Programmatic `.click()` is detail 0 — let it reach the button onClick.
    if (e.detail === 0) return;
    suppressBrowserClickRef.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  return { onPointerDown, onPointerUp, onPointerCancel, onClickCapture };
}

/**
 * Title row gaps above the frame (screen px → scene via /zoom).
 */
export const NODE_TITLE_LABEL_GAP_PX = 10;
export const NODE_TITLE_LABEL_LINE_PX = 16;
/** Left inset before icon + name (0 = flush with plate left, matching size on the right). */
export const NODE_TITLE_LABEL_INSET_PX = 0;

/** Gap between title top and toolbar bottom (above dock, titled). */
export const SELECTION_TOOLBAR_ABOVE_LABEL_GAP_PX = 8;

/** Gap between box edge and toolbar when there is no title. */
export const SELECTION_TOOLBAR_ABOVE_BOX_GAP_PX = 20;

/** Gap between box bottom and toolbar top (below dock). */
export const SELECTION_TOOLBAR_BELOW_BOX_GAP_PX = 20;

/** Half knob + air outside the chrome edge (must clear 10px resize hit). */
export const SELECTION_HANDLE_CLEARANCE_PX = 14;

/**
 * Scene distance from the **control-box** edge outward for chrome UI
 * (title / toolbar / generator composers).
 *
 * `gapPx` (+ optional extra) are **screen pixels**, converted with `/zoom`.
 * Do not pass scene stroke widths here — `strokeScene * zoom` as a screen
 * offset makes titles/toolbars fly away while zooming (looks like drift).
 * Clear thick stroke by parking knobs, not by shoving the whole chrome UI.
 */
export function chromeUiOutsideScene(
  zoom: number,
  gapPx: number,
  extraScreenPx = 0
): number {
  const z = Math.max(0.05, Number(zoom) || 1);
  return chromeUiOutsideScreenPx(z, gapPx, extraScreenPx) / z;
}

/** Screen-px outside the control box (counter-scaled HTML titles / math). */
export function chromeUiOutsideScreenPx(
  _zoom: number,
  gapPx: number,
  extraScreenPx = 0
): number {
  return (
    Math.max(0, gapPx) +
    SELECTION_HANDLE_CLEARANCE_PX +
    Math.max(0, extraScreenPx)
  );
}

export type SelectionToolbarBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/** Screen px from selection top → toolbar bottom (above dock). */
export function toolbarAboveClearancePx(hasTitleLabel: boolean) {
  if (!hasTitleLabel) return SELECTION_TOOLBAR_ABOVE_BOX_GAP_PX;
  return (
    NODE_TITLE_LABEL_GAP_PX +
    NODE_TITLE_LABEL_LINE_PX +
    SELECTION_TOOLBAR_ABOVE_LABEL_GAP_PX
  );
}

/** Scene Y of the toolbar bottom edge when docking above `boxTop`. */
export function selectionToolbarAboveAnchorScene(
  boxTop: number,
  zoom: number,
  hasTitleLabel: boolean,
  extraScreenPx = 0
): number {
  const z = Math.max(0.05, Number(zoom) || 1);
  const gapPx = toolbarAboveClearancePx(hasTitleLabel);
  // Titled: stack already sits above knobs (title = 10px). Untitled: clear handles.
  const screen = hasTitleLabel
    ? gapPx + Math.max(0, extraScreenPx)
    : chromeUiOutsideScreenPx(z, gapPx, extraScreenPx);
  return boxTop - screen / z;
}

/**
 * Stage layout px from plate top → toolbar bottom (above dock).
 * Pass `viewportScale` when an ancestor CSS-scales the stage.
 */
export function toolbarAboveScreenGapPx(
  boxTop: number,
  zoom: number,
  hasTitleLabel: boolean,
  extraScreenPx = 0,
  viewportScale = 1
): number {
  const z = Math.max(0.05, zoom || 1);
  const sx = viewportScale > 0 ? viewportScale : 1;
  const anchor = selectionToolbarAboveAnchorScene(
    boxTop,
    z,
    hasTitleLabel,
    extraScreenPx
  );
  return (boxTop - anchor) * z * sx;
}

/**
 * Screen-space HTML chrome on `[data-rcb-overlay]` (no camera / no `scale(1/zoom)`).
 *
 * Callers pass **scene** `left` / `top` / `railWidth`; this converts via
 * `rcbSceneToScreen` so the pill stays screen-sized while tracking the box.
 *
 * - **Rail** (`railWidth` > 0): `left` = selection left; pill flex-aligns in
 *   that width (selection toolbars + generator composers).
 * - **Point** (`railWidth` = 0): `left` = mid-x (or right edge); width-0 flex
 *   centers / end-aligns on that point.
 *
 * `edgeGapPx` is screen-constant air between the selection edge and the pill.
 * Outer stays height-0 / pe:none so the layout box cannot cover resize knobs.
 *
 * Uses `position: fixed` (no viewport-edge clamp) so chrome follows the
 * selection even past the stage overflow — can sit over editor HUD / off-canvas.
 */
export function WorldScreenChromeRoot({
  left,
  top,
  anchor = 'bottom',
  hAlign = 'center',
  edgeGapPx = 0,
  railWidth = 0,
  /** Stretch pill to the full rail (node titles: name left / size right). */
  fillRail = false,
  className,
  style,
  children,
  ...rest
}: {
  left: number;
  top: number;
  anchor?: 'bottom' | 'top';
  /** Horizontal dock: center (default) or top-right of the selection. */
  hAlign?: 'center' | 'right';
  /** Screen px between selection edge and toolbar (zoom-stable). */
  edgeGapPx?: number;
  /**
   * Scene width of the selection. When > 0, `left` is the left edge and the
   * pill is flex-aligned inside this rail (selection toolbars).
   */
  railWidth?: number;
  fillRail?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, 'style' | 'children'>) {
  const camera = useRcbCamera();
  const dpr = useRcbDevicePixelRatio();
  const zoom = rcbCameraCssZoom(camera);
  const gap = Math.max(0, Number(edgeGapPx) || 0);
  // Above: pill bottom at -gap. Below: pill top at +gap.
  const contentTop = anchor === 'bottom' ? -gap : gap;
  const rail = Math.max(0, Number(railWidth) || 0);
  const alignEnd = hAlign === 'right';
  const { x: screenLeft, y: screenTop } = rcbSceneToScreen(camera, left, top, dpr);
  const railScreen = rail * zoom;
  const hostRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  /** Hide until first non-zero layout — avoids spawn flash at 0×0. */
  const [placed, setPlaced] = useState(false);
  const [fixedOrigin, setFixedOrigin] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    const host = hostRef.current;
    const pill = pillRef.current;
    const overlay = host?.closest('[data-rcb-overlay="1"]') as HTMLElement | null;
    if (!host || !pill || !overlay) {
      setPlaced(false);
      return;
    }
    const sync = () => {
      const o = overlay.getBoundingClientRect();
      const next = { left: o.left + screenLeft, top: o.top + screenTop };
      setFixedOrigin((prev) =>
        Math.abs(prev.left - next.left) < 0.5 && Math.abs(prev.top - next.top) < 0.5
          ? prev
          : next
      );
      const r = pill.getBoundingClientRect();
      if (r.width >= 1 && r.height >= 1) setPlaced(true);
    };
    sync();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    ro?.observe(pill);
    ro?.observe(overlay);
    window.addEventListener('resize', sync);
    window.addEventListener('scroll', sync, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', sync);
      window.removeEventListener('scroll', sync, true);
    };
  }, [screenLeft, screenTop, railScreen, contentTop, anchor, zoom, camera.x, camera.y, fillRail]);

  return (
    <RcbOverlayPortal>
      <div
        ref={hostRef}
        className={cn('pointer-events-none overflow-visible', className)}
        style={{
          position: 'fixed',
          left: fixedOrigin.left,
          top: fixedOrigin.top,
          width: railScreen,
          height: 0,
          display: 'flex',
          // height:0 + default stretch collapses the marker/host to 0×N — Playwright
          // (and hit tests that use host GBR) then treat the chrome as hidden.
          alignItems: 'flex-start',
          justifyContent: alignEnd ? 'flex-end' : fillRail ? 'stretch' : 'center',
          pointerEvents: 'none',
          zIndex: 40,
          ...style,
          opacity: placed ? (style?.opacity as number | undefined) ?? 1 : 0,
        }}
      >
        <div
          ref={pillRef}
          className="pointer-events-auto"
          style={{
            marginTop: contentTop,
            width: fillRail ? '100%' : 'max-content',
            minWidth: fillRail ? 0 : undefined,
            transform: anchor === 'bottom' ? 'translateY(-100%)' : undefined,
          }}
          {...rest}
        >
          {children}
        </div>
      </div>
    </RcbOverlayPortal>
  );
}

/** Scene axis-aligned bounds of a rotated control box (toolbar stays screen-upright). */
export function orientedBoxAabb(
  box: SelectionToolbarBox,
  angleDeg: number
): SelectionToolbarBox {
  const angle = Number(angleDeg) || 0;
  if (Math.abs(angle) < 0.001) {
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  }
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  const hw = box.width / 2;
  const hh = box.height / 2;
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corners = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [dx, dy] of corners) {
    const x = cx + dx * cos - dy * sin;
    const y = cy + dx * sin + dy * cos;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return {
    left: minX,
    top: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

/** Scene Y extents of a rotated control box (for above/below dock choice). */
export function orientedBoxVerticalExtents(
  box: SelectionToolbarBox,
  angleDeg: number
): { top: number; bottom: number } {
  const aabb = orientedBoxAabb(box, angleDeg);
  return { top: aabb.top, bottom: aabb.top + aabb.height };
}

/**
 * Scene-edge placement for selection / frame floating toolbars.
 * `top` is the selection edge; {@link WorldScreenChromeRoot} applies `edgeGapPx`
 * in screen space so high zoom cannot eat the air gap.
 * Horizontally: rail = selection AABB (`left` + `railWidth`) so the pill
 * flex-centers on the control box.
 */
export function useSelectionToolbarPlacement(opts: {
  box: SelectionToolbarBox | null | undefined;
  hasTitleLabel?: boolean;
  /** Extra **screen** px beyond the usual gap (not scene stroke). */
  edgePadScene?: number;
  /** Control-box rotation (degrees) — dock to visual AABB, toolbar stays upright. */
  angle?: number;
  /** `auto` picks above/below; composers always use `below`. */
  dock?: 'auto' | 'below' | 'above';
}): {
  preferAbove: boolean;
  left: number;
  railWidth: number;
  top: number;
  anchor: 'bottom' | 'top';
  edgeGapPx: number;
} {
  const camera = useRcbCamera();
  const zoom = rcbCameraCssZoom(camera);
  const extraPx = Math.max(0, Number(opts.edgePadScene) || 0);
  const angle = Number(opts.angle) || 0;
  const dock = opts.dock || 'auto';
  const aboveScreen = opts.hasTitleLabel
    ? toolbarAboveClearancePx(true) + extraPx
    : chromeUiOutsideScreenPx(zoom, toolbarAboveClearancePx(false), extraPx);
  const belowScreen = chromeUiOutsideScreenPx(
    zoom,
    SELECTION_TOOLBAR_BELOW_BOX_GAP_PX,
    extraPx
  );
  const dockBox = opts.box ? orientedBoxAabb(opts.box, angle) : null;
  if (!dockBox) {
    return {
      preferAbove: false,
      left: 0,
      railWidth: 0,
      top: 0,
      anchor: 'top',
      edgeGapPx: belowScreen,
    };
  }

  if (dock === 'below') {
    return {
      preferAbove: false,
      left: dockBox.left,
      railWidth: Math.max(0, dockBox.width),
      top: dockBox.top + dockBox.height,
      anchor: 'top',
      edgeGapPx: belowScreen,
    };
  }
  if (dock === 'above') {
    return {
      preferAbove: true,
      left: dockBox.left,
      railWidth: Math.max(0, dockBox.width),
      top: dockBox.top,
      anchor: 'bottom',
      edgeGapPx: aboveScreen,
    };
  }

  const aboveGapScene = aboveScreen / Math.max(0.05, zoom);
  const preferAbove = dockBox.top >= aboveGapScene;
  return {
    preferAbove,
    left: dockBox.left,
    railWidth: Math.max(0, dockBox.width),
    top: preferAbove ? dockBox.top : dockBox.top + dockBox.height,
    anchor: preferAbove ? 'bottom' : 'top',
    edgeGapPx: preferAbove ? aboveScreen : belowScreen,
  };
}

type ShellProps = {
  box: SelectionToolbarBox | null | undefined;
  hasTitleLabel?: boolean;
  /** Scene pad beyond chrome for outer stroke ink. */
  edgePadScene?: number;
  /** Control-box rotation — dock to visual AABB; toolbar stays screen-upright. */
  angle?: number;
  /** `auto` picks above/below from AABB; shape chrome prefers below like Kit. */
  dock?: 'auto' | 'below' | 'above';
  children: ReactNode;
  className?: string;
  isFrameToolbar?: boolean;
  bare?: boolean;
  zIndexClassName?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, 'style' | 'children' | 'className'>;

/** Overlay selection toolbars + on-canvas composers (one placement shell). */
function SelectionToolbarShell({
  box,
  hasTitleLabel = false,
  edgePadScene = 0,
  angle = 0,
  dock = 'auto',
  children,
  className,
  isFrameToolbar = false,
  bare = false,
  zIndexClassName = 'z-30',
  ...rest
}: ShellProps) {
  const { left, railWidth, top, anchor, edgeGapPx } = useSelectionToolbarPlacement({
    box,
    hasTitleLabel,
    edgePadScene,
    angle,
    dock,
  });
  const chromePointer = useChromePointerActivate();
  if (!box) return null;

  return (
    <WorldScreenChromeRoot
      left={left}
      railWidth={railWidth}
      top={top}
      anchor={anchor}
      edgeGapPx={edgeGapPx}
      hAlign="center"
      data-sel-toolbar
      {...(isFrameToolbar ? { 'data-frame-toolbar': true } : {})}
      className={zIndexClassName}
      {...chromePointer}
      {...rest}
    >
      {bare ? (
        <div className={cn('pointer-events-auto', className)}>{children}</div>
      ) : (
        <FloatingToolbar bare={bare} className={className}>
          {children}
        </FloatingToolbar>
      )}
    </WorldScreenChromeRoot>
  );
}

const MemoizedSelectionToolbarShell = memo(SelectionToolbarShell);
export { MemoizedSelectionToolbarShell as SelectionToolbarShell };
