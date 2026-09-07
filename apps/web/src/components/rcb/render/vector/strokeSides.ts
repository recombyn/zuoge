/**
 * Per-side stroke visibility for rect-like shapes (attrs T/R/B/L).
 * Matches SVG `createRectLike` behavior.
 */
import { boolEffectAttr } from '@/components/rcb/scene/document/sceneEffects';
import type { Vec2 } from '@/components/rcb/render/vector/contour';

export type StrokeSideFlags = { T: boolean; R: boolean; B: boolean; L: boolean };

export function resolveStrokeSideFlags(
  attrs: Record<string, unknown> | null | undefined
): StrokeSideFlags {
  return {
    T: boolEffectAttr(attrs?.T, true),
    R: boolEffectAttr(attrs?.R, true),
    B: boolEffectAttr(attrs?.B, true),
    L: boolEffectAttr(attrs?.L, true),
  };
}

export function isRectLikeStrokeSidesShape(shapeType: string, nodeKey?: string): boolean {
  const t = String(shapeType || '').toLowerCase();
  const key = String(nodeKey || '').toLowerCase();
  if (t === 'rect' || t === 'roundrect') return true;
  if (!t && (key === 'shape' || key === 'rect')) return true;
  return false;
}

export type CornerRadiiLike = { tl: number; tr: number; br: number; bl: number };

function clampRadii(w: number, h: number, r: CornerRadiiLike): CornerRadiiLike {
  const maxR = Math.min(w, h) / 2;
  return {
    tl: Math.min(Math.max(0, r.tl), maxR),
    tr: Math.min(Math.max(0, r.tr), maxR),
    br: Math.min(Math.max(0, r.br), maxR),
    bl: Math.min(Math.max(0, r.bl), maxR),
  };
}

function nearlySame(a: Vec2, b: Vec2): boolean {
  return Math.abs(a.x - b.x) < 1e-4 && Math.abs(a.y - b.y) < 1e-4;
}

function pushPoint(poly: Vec2[], p: Vec2): void {
  const last = poly[poly.length - 1];
  if (last && nearlySame(last, p)) return;
  poly.push({ x: p.x, y: p.y });
}

/** Densify a circular arc (inclusive of end; start may duplicate previous point). */
function appendArc(
  poly: Vec2[],
  cx: number,
  cy: number,
  radius: number,
  a0: number,
  a1: number
): void {
  if (!(radius > 0.5)) return;
  const sweep = a1 - a0;
  const steps = Math.max(2, Math.ceil((Math.abs(sweep) / (Math.PI / 2)) * 8));
  for (let i = 0; i <= steps; i += 1) {
    const t = a0 + (sweep * i) / steps;
    pushPoint(poly, { x: cx + radius * Math.cos(t), y: cy + radius * Math.sin(t) });
  }
}

/**
 * Open edge polylines for partial rect strokes (local space).
 * Contiguous sides (CW: T→R→B→L, including wrap) merge into one polyline so
 * linejoin applies at shared corners. Isolated sides stay separate open segments.
 * Corner radii inset edge endpoints and include shared corner arcs when both
 * adjacent sides are enabled (so partial sides work on rounded rects).
 * - `null` → keep closed outline stroke (all sides)
 * - `[]` → no stroke (all sides off)
 * - otherwise → stroke only these open polylines (align forced to center, like SVG)
 */
export function rectStrokeSideRuns(
  width: number,
  height: number,
  attrs: Record<string, unknown> | null | undefined,
  radii?: CornerRadiiLike | null
): Vec2[][] | null {
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const sides = resolveStrokeSideFlags(attrs);
  const all = sides.T && sides.R && sides.B && sides.L;
  const none = !sides.T && !sides.R && !sides.B && !sides.L;
  if (all) return null;
  if (none) return [];

  const r = clampRadii(w, h, radii || { tl: 0, tr: 0, br: 0, bl: 0 });
  const enabled = [sides.T, sides.R, sides.B, sides.L];

  // Edge endpoints inset by corner radii (CW from top).
  const edgeEnds: Array<[Vec2, Vec2]> = [
    [
      { x: r.tl, y: 0 },
      { x: w - r.tr, y: 0 },
    ],
    [
      { x: w, y: r.tr },
      { x: w, y: h - r.br },
    ],
    [
      { x: w - r.br, y: h },
      { x: r.bl, y: h },
    ],
    [
      { x: 0, y: h - r.bl },
      { x: 0, y: r.tl },
    ],
  ];

  // Corner arc after side i (between side i and side i+1), CW.
  const cornerAfter = (i: number, poly: Vec2[]) => {
    if (i === 0 && r.tr > 0.5) {
      appendArc(poly, w - r.tr, r.tr, r.tr, -Math.PI / 2, 0);
    } else if (i === 1 && r.br > 0.5) {
      appendArc(poly, w - r.br, h - r.br, r.br, 0, Math.PI / 2);
    } else if (i === 2 && r.bl > 0.5) {
      appendArc(poly, r.bl, h - r.bl, r.bl, Math.PI / 2, Math.PI);
    } else if (i === 3 && r.tl > 0.5) {
      appendArc(poly, r.tl, r.tl, r.tl, Math.PI, (3 * Math.PI) / 2);
    }
  };

  let start = 0;
  for (let i = 0; i < 4; i += 1) {
    if (enabled[i] && !enabled[(i + 3) % 4]) {
      start = i;
      break;
    }
  }

  const runs: Vec2[][] = [];
  let i = start;
  let visited = 0;
  while (visited < 4) {
    if (!enabled[i]) {
      i = (i + 1) % 4;
      visited += 1;
      continue;
    }
    const poly: Vec2[] = [];
    let j = i;
    let count = 0;
    while (count < 4 && enabled[j]) {
      const [a, b] = edgeEnds[j]!;
      pushPoint(poly, a);
      pushPoint(poly, b);
      const next = (j + 1) % 4;
      if (enabled[next] && count + 1 < 4) {
        // Shared corner between this side and the next enabled side.
        cornerAfter(j, poly);
      }
      j = next;
      count += 1;
      if (j === i) break;
    }
    if (poly.length >= 2) runs.push(poly);
    visited += count;
    i = j;
    if (i === start) break;
  }
  return runs;
}

/** Trace an open polyline into the current Canvas path. */
export function traceStrokeSideRun(
  ctx: { beginPath(): void; moveTo(x: number, y: number): void; lineTo(x: number, y: number): void },
  run: Vec2[]
): void {
  if (run.length < 2) return;
  const a = run[0]!;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  for (let i = 1; i < run.length; i += 1) {
    const p = run[i]!;
    ctx.lineTo(p.x, p.y);
  }
}

/** SVG path `d` for an open side run. */
export function strokeSideRunPathD(run: Vec2[]): string {
  if (run.length < 2) return '';
  const a = run[0]!;
  let d = `M${a.x} ${a.y}`;
  for (let i = 1; i < run.length; i += 1) {
    const p = run[i]!;
    d += `L${p.x} ${p.y}`;
  }
  return d;
}
