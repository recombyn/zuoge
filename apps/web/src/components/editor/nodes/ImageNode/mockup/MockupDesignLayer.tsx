import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  memo,
} from 'react';
import { useRcbCamera, rcbCameraCssZoom } from '@/components/rcb';
import type { MockupPlacement } from './mockupPlacement';
import { DEMO_CYLINDER_PRINT } from './mockupPlacement';

type SceneBox = { left: number; top: number; width: number; height: number };

type DragMode = 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se' | 'rotate';

function clampPlacement(p: MockupPlacement, tw: number, th: number): MockupPlacement {
  const width = Math.max(24, Math.min(tw, p.width));
  const height = Math.max(24, Math.min(th, p.height));
  const x = Math.max(0, Math.min(tw - width, p.x));
  const y = Math.max(0, Math.min(th - height, p.y));
  let angle = p.angle % 360;
  if (angle < 0) angle += 360;
  return { ...p, x, y, width, height, angle };
}

function MockupDesignLayer({
  imageBox,
  designSrc,
  placement,
  selected,
  onSelect,
  onPlacementChange,
  templateW = DEMO_CYLINDER_PRINT.templateW,
  templateH = DEMO_CYLINDER_PRINT.templateH,
  ghostHitOnly = false,
  /** When live UV preview is under this layer, hide flat design pixels. */
  hideDesignImage = false,
  onLivePlacementChange,
}: {
  imageBox: SceneBox;
  designSrc: string;
  placement: MockupPlacement;
  selected: boolean;
  onSelect: () => void;
  onPlacementChange: (next: MockupPlacement) => void;
  /** Live updates while dragging (preview only; no document persist). */
  onLivePlacementChange?: (next: MockupPlacement) => void;
  templateW?: number;
  templateH?: number;
  ghostHitOnly?: boolean;
  hideDesignImage?: boolean;
}): ReactNode {
  const camera = useRcbCamera();
  const z = Math.max(0.05, rcbCameraCssZoom(camera));
  const shellRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    mode: DragMode;
    pointerId: number;
    startPlacement: MockupPlacement;
    startLocalX: number;
    startLocalY: number;
    startAngle: number;
  } | null>(null);
  const liveCbRef = useRef(onLivePlacementChange);
  liveCbRef.current = onLivePlacementChange;

  const [livePlacement, setLivePlacement] = useState(placement);
  useEffect(() => {
    if (!dragRef.current) setLivePlacement(placement);
  }, [placement]);

  const stageW = Math.max(1, imageBox.width * z);
  const stageH = Math.max(1, imageBox.height * z);

  const localFromClient = useCallback(
    (clientX: number, clientY: number) => {
      const rect = shellRef.current?.getBoundingClientRect();
      const left = rect?.left ?? 0;
      const top = rect?.top ?? 0;
      const w = rect?.width && rect.width > 0 ? rect.width : stageW;
      const h = rect?.height && rect.height > 0 ? rect.height : stageH;
      const lsx = w / templateW;
      const lsy = h / templateH;
      return {
        x: (clientX - left) / lsx,
        y: (clientY - top) / lsy,
      };
    },
    [stageW, stageH, templateW, templateH]
  );

  const applyDrag = useCallback(
    (mode: DragMode, start: MockupPlacement, dx: number, dy: number, localX: number, localY: number): MockupPlacement => {
      if (mode === 'move') {
        return clampPlacement({ ...start, x: start.x + dx, y: start.y + dy }, templateW, templateH);
      }
      if (mode === 'rotate') {
        const cx = start.x + start.width / 2;
        const cy = start.y + start.height / 2;
        const a0 = Math.atan2(dragRef.current!.startLocalY - cy, dragRef.current!.startLocalX - cx);
        const a1 = Math.atan2(localY - cy, localX - cx);
        const deg = ((a1 - a0) * 180) / Math.PI;
        return clampPlacement({ ...start, angle: start.angle + deg }, templateW, templateH);
      }
      let { x, y, width, height } = start;
      const aspect = start.width / Math.max(1, start.height);
      if (mode === 'se') {
        width = start.width + dx;
        height = start.height + dy;
      } else if (mode === 'sw') {
        x = start.x + dx;
        width = start.width - dx;
        height = start.height + dy;
      } else if (mode === 'ne') {
        y = start.y + dy;
        width = start.width + dx;
        height = start.height - dy;
      } else if (mode === 'nw') {
        x = start.x + dx;
        y = start.y + dy;
        width = start.width - dx;
        height = start.height - dy;
      } else if (mode === 'e') {
        width = start.width + dx;
        height = width / aspect;
        y = start.y + (start.height - height) / 2;
      } else if (mode === 'w') {
        x = start.x + dx;
        width = start.width - dx;
        height = width / aspect;
        y = start.y + (start.height - height) / 2;
      } else if (mode === 's') {
        height = start.height + dy;
        width = height * aspect;
        x = start.x + (start.width - width) / 2;
      } else if (mode === 'n') {
        y = start.y + dy;
        height = start.height - dy;
        width = height * aspect;
        x = start.x + (start.width - width) / 2;
      }
      // Corner resize: lock aspect toward the opposite corner.
      if (mode === 'se' || mode === 'sw' || mode === 'ne' || mode === 'nw') {
        const useW = Math.abs(width - start.width) >= Math.abs(height - start.height);
        if (useW) height = width / aspect;
        else width = height * aspect;
        if (mode === 'nw') {
          x = start.x + start.width - width;
          y = start.y + start.height - height;
        } else if (mode === 'ne') {
          y = start.y + start.height - height;
        } else if (mode === 'sw') {
          x = start.x + start.width - width;
        }
      }
      return clampPlacement({ ...start, x, y, width, height }, templateW, templateH);
    },
    [templateW, templateH]
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      const p = localFromClient(e.clientX, e.clientY);
      const dx = p.x - drag.startLocalX;
      const dy = p.y - drag.startLocalY;
      const next = applyDrag(drag.mode, drag.startPlacement, dx, dy, p.x, p.y);
      setLivePlacement(next);
      liveCbRef.current?.(next);
    };
    const onUp = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      dragRef.current = null;
      setLivePlacement((cur) => {
        onPlacementChange(cur);
        return cur;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [applyDrag, localFromClient, onPlacementChange]);

  const p = livePlacement;
  const sx = stageW / templateW;
  const sy = stageH / templateH;
  const left = p.x * sx;
  const top = p.y * sy;
  const width = Math.max(8, p.width * sx);
  const height = Math.max(8, p.height * sy);

  const shellStyle: CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 0,
    width: '100%',
    height: '100%',
    zIndex: 35,
    touchAction: 'none',
  };

  const startDrag = (e: ReactPointerEvent, mode: DragMode) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect();
    const local = localFromClient(e.clientX, e.clientY);
    dragRef.current = {
      mode,
      pointerId: e.pointerId,
      startPlacement: { ...livePlacement },
      startLocalX: local.x,
      startLocalY: local.y,
      startAngle: livePlacement.angle,
    };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const handleCls =
    'pointer-events-auto absolute z-[2] h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-[2px] border border-white bg-[var(--accent)] shadow';

  const corners = [
    { id: 'nw' as const, x: left, y: top, cursor: 'nwse-resize' },
    { id: 'ne' as const, x: left + width, y: top, cursor: 'nesw-resize' },
    { id: 'sw' as const, x: left, y: top + height, cursor: 'nesw-resize' },
    { id: 'se' as const, x: left + width, y: top + height, cursor: 'nwse-resize' },
  ];
  const edges = [
    { id: 'n' as const, x: left + width / 2, y: top, cursor: 'ns-resize' },
    { id: 's' as const, x: left + width / 2, y: top + height, cursor: 'ns-resize' },
    { id: 'w' as const, x: left, y: top + height / 2, cursor: 'ew-resize' },
    { id: 'e' as const, x: left + width, y: top + height / 2, cursor: 'ew-resize' },
  ];

  return (
    <div
      ref={shellRef}
      data-mockup-design-layer
      className="pointer-events-none absolute"
      style={shellStyle}
    >
      <div
        className="pointer-events-auto absolute overflow-hidden"
        style={{
          left,
          top,
          width,
          height,
          transform: `rotate(${p.angle}deg)`,
          transformOrigin: 'center center',
          outline: ghostHitOnly
            ? 'none'
            : selected
              ? '2px solid var(--accent)'
              : '1px dashed rgba(59,130,246,0.65)',
          boxShadow:
            ghostHitOnly || !selected ? undefined : '0 0 0 1px rgba(255,255,255,0.85)',
          cursor: 'move',
          opacity: ghostHitOnly ? 0 : 1,
        }}
        onPointerDown={(e) => startDrag(e, 'move')}
      >
        {!ghostHitOnly && !hideDesignImage ? (
          <img src={designSrc} alt="" className="h-full w-full object-fill" draggable={false} />
        ) : null}
      </div>
      {selected && !ghostHitOnly ? (
        <>
          {corners.map((c) => (
            <span
              key={c.id}
              className={handleCls}
              style={{ left: c.x, top: c.y, cursor: c.cursor }}
              onPointerDown={(e) => startDrag(e, c.id)}
            />
          ))}
          {edges.map((c) => (
            <span
              key={c.id}
              className={handleCls}
              style={{ left: c.x, top: c.y, cursor: c.cursor }}
              onPointerDown={(e) => startDrag(e, c.id)}
            />
          ))}
          {/* Rotate hotzone — above top edge, selection-chrome-style */}
          <span
            className="pointer-events-auto absolute z-[2] h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-[var(--accent)] shadow"
            style={{ left: left + width / 2, top: top - 18, cursor: 'grab' }}
            onPointerDown={(e) => startDrag(e, 'rotate')}
            title="Rotate"
          />
          <span
            className="pointer-events-none absolute w-px bg-[var(--accent)]"
            style={{ left: left + width / 2, top: top - 18, height: 18 }}
          />
        </>
      ) : null}
    </div>
  );
}

export default memo(MockupDesignLayer);
