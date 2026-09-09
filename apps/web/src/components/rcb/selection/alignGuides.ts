/**
 * Kit InputManager SnapEngine owns node move/resize snap; this module is
 * product chrome + frame-plate helpers + grid size for setGridSnap.
 */
import type { SceneBox } from './resizeGeometry';

export type { SceneBox };

/** Pixel snap step. Override via document.gridSize. */
export const DEFAULT_GRID_SIZE = 1;

/**
 * Screen-px proximity for **自动吸附** + align guides while dragging.
 * Runtime radius is `SMART_SNAP_PX / zoom`.
 */
export const SMART_SNAP_PX = 8;

/** Alignment + spacing guide color. */
export const SMART_GUIDE_COLOR = '#FF6B35';

/** Vertical (`axis: 'x'`) or horizontal (`axis: 'y'`) align guide. */
export type SmartGuideAlign = {
  kind: 'align';
  axis: 'x' | 'y';
  /** Scene x (vertical line) or y (horizontal line). */
  at: number;
  from: number;
  to: number;
  /** Path keypoints on this guide (corners + edge midpoints). */
  marks?: Array<{ x: number; y: number }>;
};

/** Spacing measure between two boxes. */
export type SmartGuideGap = {
  kind: 'gap';
  axis: 'x' | 'y';
  from: number;
  to: number;
  at: number;
  dist: number;
  /** Dashed extension rails (perpendicular to the measure), usually one per box edge. */
  rails?: Array<{ from: number; to: number; at: number }>;
};

export type SmartGuideLine = SmartGuideAlign | SmartGuideGap;

/** Align-guide target. Frames are tagged so callers can distinguish artboards from peers. */
export type SmartGuideTarget = SceneBox & {
  guideKind?: 'frame' | 'peer';
};

/**
 * Guide paint proximity in scene units (`SMART_SNAP_PX / zoom`).
 * Capped so low-zoom drags do not light guides against distant elements.
 */
export const SMART_SNAP_MAX_SCENE = 40;

export function smartSnapThreshold(zoom: number): number {
  const z = Math.max(0.05, Number(zoom) || 1);
  return Math.min(SMART_SNAP_PX / z, SMART_SNAP_MAX_SCENE);
}

/** Pad around the moving box when collecting nearby guide targets. */
export function smartGuideTargetPad(threshold: number): number {
  const t = Math.max(0, Number(threshold) || 0);
  return Math.max(t * 3, 180);
}

type AxisMark = { value: number; role: 'min' | 'mid' | 'max' };

function boxXMarks(box: SceneBox): AxisMark[] {
  return [
    { value: box.left, role: 'min' },
    { value: box.left + box.width / 2, role: 'mid' },
    { value: box.left + box.width, role: 'max' },
  ];
}

function boxYMarks(box: SceneBox): AxisMark[] {
  return [
    { value: box.top, role: 'min' },
    { value: box.top + box.height / 2, role: 'mid' },
    { value: box.top + box.height, role: 'max' },
  ];
}

function mergeGuideExtent(a0: number, a1: number, b0: number, b1: number): { from: number; to: number } {
  return { from: Math.min(a0, a1, b0, b1), to: Math.max(a0, a1, b0, b1) };
}

function mergeMarks(
  prev: Array<{ x: number; y: number }> | undefined,
  next: Array<{ x: number; y: number }>
): Array<{ x: number; y: number }> {
  const out = prev ? [...prev] : [];
  for (const m of next) {
    if (out.some((p) => Math.abs(p.x - m.x) < 0.25 && Math.abs(p.y - m.y) < 0.25)) continue;
    out.push(m);
  }
  return out;
}

/** Path keypoints on an align guide: corners + edge midpoints (上中/下中/左中/右中). */
function pathMarksForAlign(
  box: SceneBox,
  axis: 'x' | 'y',
  at: number,
  eps: number
): Array<{ x: number; y: number }> {
  if (!(box.width > 0) || !(box.height > 0)) return [];
  const midX = box.left + box.width / 2;
  const midY = box.top + box.height / 2;
  const right = box.left + box.width;
  const bottom = box.top + box.height;

  if (axis === 'y') {
    const hit = boxYMarks(box).find((m) => Math.abs(m.value - at) <= eps);
    if (!hit) return [];
    const y = at;
    // Center line: only the box center. Edge line: L / mid / R (上中·下中).
    if (hit.role === 'mid') return [{ x: midX, y }];
    return [
      { x: box.left, y },
      { x: midX, y },
      { x: right, y },
    ];
  }
  const hit = boxXMarks(box).find((m) => Math.abs(m.value - at) <= eps);
  if (!hit) return [];
  const x = at;
  // Center line: only the box center. Edge line: T / mid / B (左中·右中).
  if (hit.role === 'mid') return [{ x, y: midY }];
  return [
    { x, y: box.top },
    { x, y: midY },
    { x, y: bottom },
  ];
}

function marksAlongGuide(
  box: SceneBox,
  targets: SceneBox[],
  axis: 'x' | 'y',
  at: number,
  eps: number
): Array<{ x: number; y: number }> {
  let marks = pathMarksForAlign(box, axis, at, eps);
  for (const t of targets) {
    marks = mergeMarks(marks, pathMarksForAlign(t, axis, at, eps));
  }
  return marks;
}

function rangeOverlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.min(a1, b1) - Math.max(a0, b0);
}

function overlapMid(a0: number, a1: number, b0: number, b1: number): number | null {
  const lo = Math.max(a0, b0);
  const hi = Math.min(a1, b1);
  if (hi - lo <= 0) return null;
  return (lo + hi) / 2;
}

/** Align guides: match edges/centers within `epsilon`.
 * `at` is the **target** edge so proximity lines sit on the sibling (not a
 * near-miss line glued to the mover that looked like a wall).
 * Artboards (`guideKind: 'frame'`): only edge↔edge or center↔center — same rule
 * as {@link snapTranslateToPeers} — so midlines do not light up for a corner/edge.
 */
function collectAlignGuides(box: SceneBox, targets: SceneBox[], epsilon: number): SmartGuideAlign[] {
  const eps = Math.max(0.5, epsilon);
  const byKey = new Map<string, SmartGuideAlign>();

  const pushAxis = (
    axis: 'x' | 'y',
    boxMarks: AxisMark[],
    targetMarks: (t: SceneBox) => AxisMark[],
    extent: (t: SceneBox) => { from: number; to: number }
  ) => {
    for (const t of targets) {
      if (!(t.width > 0) || !(t.height > 0)) continue;
      const guideKind = (t as SmartGuideTarget).guideKind;
      for (const m of boxMarks) {
        for (const tm of targetMarks(t)) {
          if (Math.abs(tm.value - m.value) > eps) continue;
          if (guideKind === 'frame' && (m.role === 'mid') !== (tm.role === 'mid')) {
            continue;
          }
          const ext = extent(t);
          const at = tm.value;
          const marks = mergeMarks(
            pathMarksForAlign(box, axis, at, eps),
            pathMarksForAlign(t, axis, at, eps)
          );
          const key = `${axis}:${at.toFixed(2)}`;
          const prev = byKey.get(key);
          if (prev) {
            byKey.set(key, {
              ...prev,
              from: Math.min(prev.from, ext.from),
              to: Math.max(prev.to, ext.to),
              marks: mergeMarks(prev.marks, marks),
            });
          } else {
            byKey.set(key, {
              kind: 'align',
              axis,
              at,
              from: ext.from,
              to: ext.to,
              marks,
            });
          }
        }
      }
    }
  };

  pushAxis(
    'x',
    boxXMarks(box),
    boxXMarks,
    (t) => mergeGuideExtent(box.top, box.top + box.height, t.top, t.top + t.height)
  );
  pushAxis(
    'y',
    boxYMarks(box),
    boxYMarks,
    (t) => mergeGuideExtent(box.left, box.left + box.width, t.left, t.left + t.width)
  );
  return [...byKey.values()];
}

/**
 * Idle select↔hover spacing — clear gaps, plus edge offsets when neighbors
 * share a cross-axis overlap (top/bottom for side-by-side, L/R when stacked).
 *
 * Measure line sits in the gap between boxes; dashed rails run on both edges
 * being compared out to that measure line (not a short stub on one side only).
 */
export function collectPairSpacingGuides(a: SceneBox, b: SceneBox): SmartGuideLine[] {
  if (!(a.width > 0) || !(a.height > 0) || !(b.width > 0) || !(b.height > 0)) return [];
  const gaps = collectGapGuides(a, [b]);
  const out: SmartGuideLine[] = [...gaps];
  const aR = a.left + a.width;
  const aB = a.top + a.height;
  const bR = b.left + b.width;
  const bB = b.top + b.height;
  const yOv = rangeOverlap(a.top, aB, b.top, bB);
  const xOv = rangeOverlap(a.left, aR, b.left, bR);
  const sideBySide = yOv > 0 && (aR <= b.left + 1e-6 || bR <= a.left + 1e-6);
  const stacked = xOv > 0 && (aB <= b.top + 1e-6 || bB <= a.top + 1e-6);

  const pushOffset = (
    axis: 'x' | 'y',
    edgeA: number,
    edgeB: number,
    at: number,
    rails: Array<{ from: number; to: number; at: number }>
  ) => {
    const dist = Math.abs(edgeB - edgeA);
    if (dist <= 0.5) return;
    out.push({
      kind: 'gap',
      axis,
      from: Math.min(edgeA, edgeB),
      to: Math.max(edgeA, edgeB),
      at,
      dist: Math.round(dist),
      rails: rails.filter((r) => Math.abs(r.to - r.from) > 0.5),
    });
  };

  /** Dashed stub from a box edge to the measure line (skip if measure cuts the box). */
  const railFromBoxToAt = (
    boxMin: number,
    boxMax: number,
    at: number,
    edgeAt: number
  ): { from: number; to: number; at: number } | null => {
    if (at < boxMin - 1e-6) return { from: at, to: boxMin, at: edgeAt };
    if (at > boxMax + 1e-6) return { from: boxMax, to: at, at: edgeAt };
    return null;
  };

  if (sideBySide) {
    // Vertical measure in the horizontal gap; rails on both tops (and bottoms if needed).
    const aFacing = aR <= b.left + 1e-6 ? aR : a.left;
    const bFacing = aR <= b.left + 1e-6 ? b.left : bR;
    const atX = (aFacing + bFacing) / 2;
    const topRails = [
      railFromBoxToAt(a.left, aR, atX, a.top),
      railFromBoxToAt(b.left, bR, atX, b.top),
    ].filter(Boolean) as Array<{ from: number; to: number; at: number }>;
    pushOffset('y', a.top, b.top, atX, topRails);
    // Bottom offset only when tops already match — otherwise top delta is enough
    // and a second rail pair reads as a stray "lower dashed" measure.
    if (Math.abs(a.top - b.top) <= 0.5) {
      const botRails = [
        railFromBoxToAt(a.left, aR, atX, aB),
        railFromBoxToAt(b.left, bR, atX, bB),
      ].filter(Boolean) as Array<{ from: number; to: number; at: number }>;
      pushOffset('y', aB, bB, atX, botRails);
    }
  } else if (stacked) {
    const aFacing = aB <= b.top + 1e-6 ? aB : a.top;
    const bFacing = aB <= b.top + 1e-6 ? b.top : bB;
    const atY = (aFacing + bFacing) / 2;
    const leftRails = [
      railFromBoxToAt(a.top, aB, atY, a.left),
      railFromBoxToAt(b.top, bB, atY, b.left),
    ].filter(Boolean) as Array<{ from: number; to: number; at: number }>;
    pushOffset('x', a.left, b.left, atY, leftRails);
    if (Math.abs(a.left - b.left) <= 0.5) {
      const rightRails = [
        railFromBoxToAt(a.top, aB, atY, aR),
        railFromBoxToAt(b.top, bB, atY, bR),
      ].filter(Boolean) as Array<{ from: number; to: number; at: number }>;
      pushOffset('x', aR, bR, atY, rightRails);
    }
  } else if (!gaps.length) {
    // Diagonal (no x/y overlap): still show both clearances — preview inspect
    // often picks a poster and a rect that sit corner-to-corner.
    const aLeftOfB = aR <= b.left + 1e-6;
    const bLeftOfA = bR <= a.left + 1e-6;
    if (aLeftOfB || bLeftOfA) {
      const leftBox = aLeftOfB ? a : b;
      const rightBox = aLeftOfB ? b : a;
      const from = leftBox.left + leftBox.width;
      const to = rightBox.left;
      const atY = Math.min(leftBox.top + leftBox.height, rightBox.top + rightBox.height);
      const hRails = [
        railFromBoxToAt(leftBox.top, leftBox.top + leftBox.height, atY, from),
        railFromBoxToAt(rightBox.top, rightBox.top + rightBox.height, atY, to),
      ].filter(Boolean) as Array<{ from: number; to: number; at: number }>;
      pushOffset('x', from, to, atY, hRails);
    }
    const aAboveB = aB <= b.top + 1e-6;
    const bAboveA = bB <= a.top + 1e-6;
    if (aAboveB || bAboveA) {
      const topBox = aAboveB ? a : b;
      const botBox = aAboveB ? b : a;
      const from = topBox.top + topBox.height;
      const to = botBox.top;
      const atX = Math.min(topBox.left + topBox.width, botBox.left + botBox.width);
      const vRails = [
        railFromBoxToAt(topBox.left, topBox.left + topBox.width, atX, from),
        railFromBoxToAt(botBox.left, botBox.left + botBox.width, atX, to),
      ].filter(Boolean) as Array<{ from: number; to: number; at: number }>;
      pushOffset('y', from, to, atX, vRails);
    }
  }

  return out;
}

/**
 * Nearest clear gap per cardinal direction when ranges overlap on the cross axis.
 * Does not require edge snap — spacing chrome appears while dragging beside a sibling.
 */
function collectGapGuides(box: SceneBox, targets: SceneBox[]): SmartGuideGap[] {
  const out: SmartGuideGap[] = [];
  type GapCand = { dist: number; from: number; to: number; at: number };
  let left: GapCand | null = null;
  let right: GapCand | null = null;
  let above: GapCand | null = null;
  let below: GapCand | null = null;

  const considerGap = (
    prev: GapCand | null,
    dist: number,
    from: number,
    to: number,
    at: number
  ): GapCand | null => {
    if (!(dist > 0.5)) return prev;
    if (prev && !(dist < prev.dist)) return prev;
    return { dist, from, to, at };
  };

  const bR = box.left + box.width;
  const bB = box.top + box.height;

  for (const t of targets) {
    if (!(t.width > 0) || !(t.height > 0)) continue;
    const tR = t.left + t.width;
    const tB = t.top + t.height;

    // Horizontal gap: need vertical overlap (side-by-side).
    const yOv = rangeOverlap(box.top, bB, t.top, tB);
    if (yOv > 0) {
      const at = overlapMid(box.top, bB, t.top, tB);
      if (at != null) {
        if (tR <= box.left + 1e-6) {
          left = considerGap(left, box.left - tR, tR, box.left, at);
        }
        if (t.left >= bR - 1e-6) {
          right = considerGap(right, t.left - bR, bR, t.left, at);
        }
      }
    }

    // Vertical gap: need horizontal overlap (stacked).
    const xOv = rangeOverlap(box.left, bR, t.left, tR);
    if (xOv > 0) {
      const at = overlapMid(box.left, bR, t.left, tR);
      if (at != null) {
        if (tB <= box.top + 1e-6) {
          above = considerGap(above, box.top - tB, tB, box.top, at);
        }
        if (t.top >= bB - 1e-6) {
          below = considerGap(below, t.top - bB, bB, t.top, at);
        }
      }
    }
  }

  const pushGap = (axis: 'x' | 'y', c: GapCand | null) => {
    if (!c) return;
    out.push({
      kind: 'gap',
      axis,
      from: c.from,
      to: c.to,
      at: c.at,
      dist: Math.round(c.dist),
    });
  };
  pushGap('x', left);
  pushGap('x', right);
  pushGap('y', above);
  pushGap('y', below);
  return out;
}

/** Scene epsilon: path marks must nearly coincide (do not scale with zoom snap threshold). */
export const GUIDE_COINCIDE_EPS = 0.51;

/**
 * Drag indicators: alignment lines plus nearest clear gaps. Gap guides render
 * as arrowed distance measures, so edit-mode movement gets the same feedback
 * as inspect/preview without an additional measurement path.
 * Prefer {@link snapTranslateToPeers} while moving (吸附 + guides together).
 */
export function collectMoveSnapIndicators(
  box: SceneBox,
  targets: SceneBox[],
  eps: number = GUIDE_COINCIDE_EPS
): SmartGuideLine[] {
  const coincide = Math.max(GUIDE_COINCIDE_EPS, Number(eps) || 0);
  const aligns = collectAlignGuides(box, targets, coincide).map((g) => ({
    ...g,
    marks: g.marks?.length
      ? g.marks
      : marksAlongGuide(box, targets, g.axis, g.at, coincide),
  }));
  return [...aligns, ...collectGapGuides(box, targets)];
}

type SnapPoint = {
  x: number;
  y: number;
  roleX: 'min' | 'mid' | 'max';
  roleY: 'min' | 'mid' | 'max';
};

/** Corners + edge mids + center for translate 自动吸附. */
function boxSnapPoints(box: SceneBox): SnapPoint[] {
  const midX = box.left + box.width / 2;
  const midY = box.top + box.height / 2;
  const right = box.left + box.width;
  const bottom = box.top + box.height;
  return [
    { x: box.left, y: box.top, roleX: 'min', roleY: 'min' },
    { x: midX, y: box.top, roleX: 'mid', roleY: 'min' },
    { x: right, y: box.top, roleX: 'max', roleY: 'min' },
    { x: box.left, y: midY, roleX: 'min', roleY: 'mid' },
    { x: midX, y: midY, roleX: 'mid', roleY: 'mid' },
    { x: right, y: midY, roleX: 'max', roleY: 'mid' },
    { x: box.left, y: bottom, roleX: 'min', roleY: 'max' },
    { x: midX, y: bottom, roleX: 'mid', roleY: 'max' },
    { x: right, y: bottom, roleX: 'max', roleY: 'max' },
  ];
}

function roundSnapDist(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

/**
 * **自动吸附**: nearest peer snap-points within `threshold` nudge the box;
 * then paint exact guides.
 *
 * Frames and peer nodes share the same corner, edge, and center candidates.
 * Frame edges prefer their matching edge over an equally-close center point,
 * so content snaps flush to an artboard boundary.
 * Mid↔mid (center) snaps are stickier so boxes prefer aligning through the middle.
 */
export function snapTranslateToPeers(
  box: SceneBox,
  targets: SmartGuideTarget[],
  threshold: number
): { box: SceneBox; nudgeX: number; nudgeY: number; guides: SmartGuideLine[] } {
  const thr = Math.max(0, Number(threshold) || 0);
  if (!(thr > 0) || !targets.length || !(box.width > 0) || !(box.height > 0)) {
    return { box, nudgeX: 0, nudgeY: 0, guides: [] };
  }

  const selectionPts = boxSnapPoints(box);
  type OtherPt = SnapPoint & { guideKind?: 'frame' | 'peer' };
  const otherPts: OtherPt[] = [];
  for (const t of targets) {
    if (!(t.width > 0) || !(t.height > 0)) continue;
    for (const p of boxSnapPoints(t)) {
      otherPts.push({ ...p, guideKind: t.guideKind });
    }
  }
  if (!otherPts.length) {
    return { box, nudgeX: 0, nudgeY: 0, guides: [] };
  }

  // Prefer center-to-center over corner/edge-to-center when both are in range.
  // Artboard midlines use a stronger bias so content centers catch the crosshair.
  const midBias = Math.min(3, thr * 0.45);
  const frameMidBias = Math.min(thr * 0.9, Math.max(midBias, thr - 0.25));

  type AxisBest = { score: number; nudge: number; pref: number };
  let bestX: AxisBest | null = null;
  let bestY: AxisBest | null = null;

  const rolePref = (
    selfRole: SnapPoint['roleX'],
    otherRole: SnapPoint['roleX']
  ): number => {
    if (selfRole === otherRole) return selfRole === 'mid' ? 3 : 2;
    if (selfRole === 'mid' || otherRole === 'mid') return 1;
    return 0;
  };

  const midPairBias = (selfMid: boolean, other: OtherPt) => {
    if (!selfMid) return 0;
    // other mid role checked by caller
    return other.guideKind === 'frame' ? frameMidBias : midBias;
  };

  const considerX = (self: SnapPoint, other: OtherPt) => {
    const offset = Math.abs(self.x - other.x);
    if (offset > thr + 1e-9) return;
    const pref = rolePref(self.roleX, other.roleX);
    const score =
      offset -
      (self.roleX === 'mid' && other.roleX === 'mid'
        ? midPairBias(true, other)
        : 0);
    if (
      !bestX ||
      score < bestX.score - 1e-9 ||
      (Math.abs(score - bestX.score) <= 1e-9 && pref > bestX.pref)
    ) {
      bestX = { score, nudge: other.x - self.x, pref };
    }
  };
  const considerY = (self: SnapPoint, other: OtherPt) => {
    const offset = Math.abs(self.y - other.y);
    if (offset > thr + 1e-9) return;
    const pref = rolePref(self.roleY, other.roleY);
    const score =
      offset -
      (self.roleY === 'mid' && other.roleY === 'mid'
        ? midPairBias(true, other)
        : 0);
    if (
      !bestY ||
      score < bestY.score - 1e-9 ||
      (Math.abs(score - bestY.score) <= 1e-9 && pref > bestY.pref)
    ) {
      bestY = { score, nudge: other.y - self.y, pref };
    }
  };

  for (const self of selectionPts) {
    for (const other of otherPts) {
      if (other.guideKind === 'frame') {
        // Artboard: only edge↔edge or center↔center (no corner-to-midline).
        if ((self.roleX === 'mid') === (other.roleX === 'mid')) {
          considerX(self, other);
        }
        if ((self.roleY === 'mid') === (other.roleY === 'mid')) {
          considerY(self, other);
        }
        continue;
      }
      considerX(self, other);
      considerY(self, other);
    }
  }

  const nudgeX = bestX?.nudge ?? 0;
  const nudgeY = bestY?.nudge ?? 0;

  if (!(Math.abs(nudgeX) > 1e-9) && !(Math.abs(nudgeY) > 1e-9)) {
    return {
      box,
      nudgeX: 0,
      nudgeY: 0,
      guides: collectMoveSnapIndicators(box, targets, Math.max(GUIDE_COINCIDE_EPS, thr)),
    };
  }

  const next = {
    ...box,
    left: box.left + nudgeX,
    top: box.top + nudgeY,
  };
  return {
    box: next,
    nudgeX,
    nudgeY,
    guides: collectMoveSnapIndicators(next, targets, GUIDE_COINCIDE_EPS),
  };
}

export function getDocumentGridSize(doc: unknown): number {
  const n = Number((doc as { gridSize?: unknown } | null)?.gridSize);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_GRID_SIZE;
}

/**
 * Min canvas zoom before the 1px cell grid appears.
 * Below ~800% a 1px lattice is dense, noisy, and costly.
 * Uses camera zoom only (not browser zoom / devicePixelRatio).
 */
export const PIXEL_GRID_MIN_ZOOM = 8;

/** Auto pixel-grid visibility — canvas zoom only, independent of browser zoom. */
export function shouldShowPixelGrid(zoom: number): boolean {
  const z = Math.max(0, Number(zoom) || 0);
  return z >= PIXEL_GRID_MIN_ZOOM - 1e-6;
}

export function snapCoordToGrid(value: number, gridSize: number): number {
  if (!(gridSize > 0) || !Number.isFinite(value)) return value;
  return Math.round(value / gridSize) * gridSize;
}

/**
 * Snap all four edges to the grid (draw / place).
 * Collapsed edges expand by one cell so a soft drag still yields a grid tile.
 */
export function snapBoxEdgesToGrid(box: SceneBox, gridSize: number, minCells = 1): SceneBox {
  if (!(gridSize > 0)) return box;
  let left = snapCoordToGrid(box.left, gridSize);
  let top = snapCoordToGrid(box.top, gridSize);
  let right = snapCoordToGrid(box.left + box.width, gridSize);
  let bottom = snapCoordToGrid(box.top + box.height, gridSize);
  const min = Math.max(1, minCells) * gridSize;
  if (right - left < min) {
    right = left + min;
  }
  if (bottom - top < min) {
    bottom = top + min;
  }
  return { left, top, width: right - left, height: bottom - top };
}

/** Snap box origin to grid; size unchanged (move / translate). */
export function snapBoxToGrid(box: SceneBox, gridSize: number): SceneBox {
  if (!(gridSize > 0)) return box;
  return {
    ...box,
    left: snapCoordToGrid(box.left, gridSize),
    top: snapCoordToGrid(box.top, gridSize),
  };
}
