/**
 * Idle smart guides as scene-space HTML under the HTML camera mount.
 * Kit paints live snap guides on the canvas; this layer only paints idle /
 * inspect badges + align/gap chrome when product asks. No stage-wide SVG.
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useRcbCamera } from '@/components/rcb/camera/context';
import { CHROME_STROKE_PX } from '../chromeMetrics';
import {
  SMART_GUIDE_COLOR,
  type SceneBox,
  type SmartGuideGap,
  type SmartGuideLine,
} from '../alignGuides';
import {
  getSceneSmartGuidesMount,
  getSceneWorldEpoch,
  subscribeShapeHosts,
} from '../../shapes/shapeHostRegistry';

const GUIDE_STROKE = SMART_GUIDE_COLOR;
const SIZE_BADGE_FILL = '#3388ff';

function isGapGuide(g: SmartGuideLine): g is SmartGuideGap {
  return g.kind === 'gap';
}

function GuideLine({
  x1,
  y1,
  x2,
  y2,
  strokeWidth,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  strokeWidth: number;
}) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const style: CSSProperties = {
    position: 'absolute',
    left: x1,
    top: y1 - strokeWidth / 2,
    width: len,
    height: strokeWidth,
    background: GUIDE_STROKE,
    transformOrigin: '0 50%',
    transform: `rotate(${angle}deg)`,
    pointerEvents: 'none',
  };
  return <div data-rcb-guide-line="1" style={style} />;
}

function GuideBadge({
  text,
  x,
  y,
  inv,
  anchor,
  fill = GUIDE_STROKE,
}: {
  text: string;
  x: number;
  y: number;
  inv: number;
  /** `center` — pill sits on the measure line (reference spacing chrome). */
  anchor: 'below' | 'right' | 'center';
  fill?: string;
}) {
  const fontSize = 11 * inv;
  const padX = 5.5 * inv;
  const padY = 2.25 * inv;
  const radius = 4 * inv;
  const gap = 6 * inv;
  const tw = Math.max(14 * inv, String(text).length * fontSize * 0.62);
  const th = fontSize * 1.2;
  const w = tw + padX * 2;
  const h = th + padY * 2;
  const cx = anchor === 'right' ? x + gap + w / 2 : x;
  const cy = anchor === 'below' ? y + gap + h / 2 : y;
  return (
    <div
      style={{
        position: 'absolute',
        left: cx - w / 2,
        top: cy - h / 2,
        width: w,
        height: h,
        borderRadius: radius,
        background: fill,
        color: '#fff',
        fontSize,
        fontWeight: 600,
        fontFamily: 'system-ui, sans-serif',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </div>
  );
}

/** × snap mark — short diagonals so the guide stroke still reads continuous. */
export function GuideMarkX({
  x,
  y,
  r,
  strokeWidth,
}: {
  x: number;
  y: number;
  r: number;
  strokeWidth: number;
}) {
  const arm = Math.max(r * 0.85, strokeWidth * 1.4);
  const sw = Math.max(strokeWidth, r * 0.35);
  return (
    <div data-rcb-guide-mark="x" style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}>
      <GuideLine x1={x - arm} y1={y - arm} x2={x + arm} y2={y + arm} strokeWidth={sw} />
      <GuideLine x1={x - arm} y1={y + arm} x2={x + arm} y2={y - arm} strokeWidth={sw} />
    </div>
  );
}

function formatSizeBadge(box: SceneBox): string {
  const w = Math.max(0, Math.round(box.width));
  const h = Math.max(0, Math.round(box.height));
  return `${w} × ${h}`;
}

function ArrowTips({
  axis,
  at,
  from,
  to,
  tip,
  strokeWidth,
}: {
  axis: 'x' | 'y';
  at: number;
  from: number;
  to: number;
  tip: number;
  strokeWidth: number;
}) {
  if (axis === 'x') {
    return (
      <>
        <GuideLine x1={from + tip} y1={at - tip} x2={from} y2={at} strokeWidth={strokeWidth} />
        <GuideLine x1={from + tip} y1={at + tip} x2={from} y2={at} strokeWidth={strokeWidth} />
        <GuideLine x1={to - tip} y1={at - tip} x2={to} y2={at} strokeWidth={strokeWidth} />
        <GuideLine x1={to - tip} y1={at + tip} x2={to} y2={at} strokeWidth={strokeWidth} />
      </>
    );
  }
  return (
    <>
      <GuideLine x1={at - tip} y1={from + tip} x2={at} y2={from} strokeWidth={strokeWidth} />
      <GuideLine x1={at + tip} y1={from + tip} x2={at} y2={from} strokeWidth={strokeWidth} />
      <GuideLine x1={at - tip} y1={to - tip} x2={at} y2={to} strokeWidth={strokeWidth} />
      <GuideLine x1={at + tip} y1={to - tip} x2={at} y2={to} strokeWidth={strokeWidth} />
    </>
  );
}

export default function SmartGuidesOverlay({
  guides,
  sizeBox = null,
}: {
  guides: SmartGuideLine[];
  /** Idle or inspect: blue WxH badge under the selected box. */
  sizeBox?: SceneBox | null;
}) {
  const camera = useRcbCamera();
  const z = Math.max(0.05, camera.zoom || 1);
  const inv = 1 / z;
  const stroke = Math.max(1 / z, CHROME_STROKE_PX / z);
  const tip = 5 * inv;
  const markR = Math.max(stroke * 1.25, 4 * inv);

  const [, setWorldEpoch] = useState(() => getSceneWorldEpoch());
  useEffect(
    () =>
      subscribeShapeHosts(() => {
        setWorldEpoch((prev) => {
          const next = getSceneWorldEpoch();
          return prev === next ? prev : next;
        });
      }),
    []
  );
  const guidesMount = getSceneSmartGuidesMount();

  const nodes = useMemo(() => {
    if (!guides.length && !sizeBox) return null;
    const out: ReactNode[] = [];
    guides.forEach((g, i) => {
      if (isGapGuide(g)) {
        const x0 = g.axis === 'x' ? Math.min(g.from, g.to) : g.at;
        const x1 = g.axis === 'x' ? Math.max(g.from, g.to) : g.at;
        const y0 = g.axis === 'y' ? Math.min(g.from, g.to) : g.at;
        const y1 = g.axis === 'y' ? Math.max(g.from, g.to) : g.at;
        const midX = g.axis === 'x' ? (g.from + g.to) / 2 : g.at;
        const midY = g.axis === 'y' ? (g.from + g.to) / 2 : g.at;
        out.push(
          <div key={`gap-${i}`} style={{ position: 'absolute', left: 0, top: 0 }}>
            {g.rails?.map((rail, ri) => (
              <GuideLine
                key={`rail-${ri}`}
                x1={g.axis === 'y' ? Math.min(rail.from, rail.to) : rail.at}
                y1={g.axis === 'y' ? rail.at : Math.min(rail.from, rail.to)}
                x2={g.axis === 'y' ? Math.max(rail.from, rail.to) : rail.at}
                y2={g.axis === 'y' ? rail.at : Math.max(rail.from, rail.to)}
                strokeWidth={stroke}
              />
            ))}
            <GuideLine
              x1={g.axis === 'x' ? x0 : g.at}
              y1={g.axis === 'x' ? g.at : y0}
              x2={g.axis === 'x' ? x1 : g.at}
              y2={g.axis === 'x' ? g.at : y1}
              strokeWidth={stroke}
            />
            <ArrowTips
              axis={g.axis}
              at={g.at}
              from={g.axis === 'x' ? x0 : y0}
              to={g.axis === 'x' ? x1 : y1}
              tip={tip}
              strokeWidth={stroke}
            />
            <GuideBadge text={String(g.dist)} x={midX} y={midY} inv={inv} anchor="center" />
          </div>
        );
        return;
      }
      out.push(
        <div key={`align-${i}`} style={{ position: 'absolute', left: 0, top: 0 }}>
          <GuideLine
            x1={g.axis === 'x' ? g.at : g.from}
            y1={g.axis === 'x' ? g.from : g.at}
            x2={g.axis === 'x' ? g.at : g.to}
            y2={g.axis === 'x' ? g.to : g.at}
            strokeWidth={stroke}
          />
          {(g.marks || []).map((m, mi) => (
            <GuideMarkX key={mi} x={m.x} y={m.y} r={markR} strokeWidth={stroke} />
          ))}
        </div>
      );
    });
    if (sizeBox && sizeBox.width > 0 && sizeBox.height > 0) {
      out.push(
        <GuideBadge
          key="size-badge"
          text={formatSizeBadge(sizeBox)}
          x={sizeBox.left + sizeBox.width / 2}
          y={sizeBox.top + sizeBox.height}
          inv={inv}
          anchor="below"
          fill={SIZE_BADGE_FILL}
        />
      );
    }
    return out;
  }, [guides, sizeBox, inv, stroke, tip, markR]);

  if (!nodes || !guidesMount) return null;

  return createPortal(
    <div data-rcb-smart-guides="1" aria-hidden style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}>
      {nodes}
    </div>,
    guidesMount
  );
}
