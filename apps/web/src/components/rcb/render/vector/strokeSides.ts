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

/**
 * Open edge polylines for partial rect strokes (local space).
 * Contiguous sides (CW: T→R→B→L, including wrap) merge into one polyline so
 * linejoin applies at shared corners. Isolated sides stay separate open segments.
 * - `null` → keep closed outline stroke (all sides, or has corner radius)
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
  const r = radii || { tl: 0, tr: 0, br: 0, bl: 0 };
  const hasRadius = Math.max(r.tl, r.tr, r.br, r.bl) > 0.5;
  if (all || hasRadius) return null;
  if (none) return [];

  // Clockwise edge segments from each corner.
  const enabled = [sides.T, sides.R, sides.B, sides.L];
  const segs: Array<[Vec2, Vec2]> = [
    [
      { x: 0, y: 0 },
      { x: w, y: 0 },
    ],
    [
      { x: w, y: 0 },
      { x: w, y: h },
    ],
    [
      { x: w, y: h },
      { x: 0, y: h },
    ],
    [
      { x: 0, y: h },
      { x: 0, y: 0 },
    ],
  ];

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
    const poly: Vec2[] = [
      { ...segs[i]![0] },
      { ...segs[i]![1] },
    ];
    let j = (i + 1) % 4;
    let count = 1;
    while (count < 4 && enabled[j]) {
      poly.push({ ...segs[j]![1] });
      j = (j + 1) % 4;
      count += 1;
    }
    runs.push(poly);
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
