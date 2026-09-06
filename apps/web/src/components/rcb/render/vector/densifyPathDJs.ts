/**
 * JS densify of SVG path `d` → polyline (baselines / vector contour).
 * Cubic/quad/arc steps scale with length ÷ flatness so circles stay smooth.
 */
export type DensifyVec2 = { x: number; y: number };

/** Default chord budget in scene units (~circle peri / 0.4 → dense ring). */
export const DENSIFY_DEFAULT_FLATNESS = 0.4;

/**
 * Scene-space flatness for current display scale.
 * Higher zoom×dpr → smaller flatness → denser chords (no soft mush on curves).
 */
export function sceneFlatness(zoom = 1, dpr = 1): number {
  const s = Math.max(0.05, Number(zoom) || 1) * Math.max(1, Number(dpr) || 1);
  return Math.max(0.05, Math.min(DENSIFY_DEFAULT_FLATNESS, DENSIFY_DEFAULT_FLATNESS / s));
}

/** LOD bucket for mesh fingerprints (bucket change → rebuild). */
export function densifyLodBucket(zoom = 1, dpr = 1): number {
  const s = Math.max(0.05, Number(zoom) || 1) * Math.max(1, Number(dpr) || 1);
  return Math.round(Math.log2(s) * 16);
}

function curveSteps(approxLen: number, flatness: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.ceil(approxLen / Math.max(0.25, flatness))));
}

/** SVG elliptical arc → sampled polyline (endpoint→center). */
function densifyEllipticalArc(
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  phiDeg: number,
  largeArc: number,
  sweep: number,
  x2: number,
  y2: number,
  flatness: number,
  push: (x: number, y: number) => void
): void {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx < 1e-6 || ry < 1e-6) {
    push(x2, y2);
    return;
  }
  if (Math.abs(x1 - x2) < 1e-9 && Math.abs(y1 - y2) < 1e-9) return;

  const phi = (phiDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;

  let rx2 = rx * rx;
  let ry2 = ry * ry;
  const x1p2 = x1p * x1p;
  const y1p2 = y1p * y1p;
  const lam = x1p2 / rx2 + y1p2 / ry2;
  if (lam > 1) {
    const s = Math.sqrt(lam);
    rx *= s;
    ry *= s;
    rx2 = rx * rx;
    ry2 = ry * ry;
  }

  const denom = rx2 * y1p2 + ry2 * x1p2;
  let sq = denom > 1e-12 ? (rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2) / denom : 0;
  if (sq < 0) sq = 0;
  const coef = (largeArc === sweep ? -1 : 1) * Math.sqrt(sq);
  const cxp = (coef * (rx * y1p)) / ry;
  const cyp = (coef * -(ry * x1p)) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  const angleBetween = (ux: number, uy: number, vx: number, vy: number) => {
    const n = Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1;
    let c = (ux * vx + uy * vy) / n;
    c = Math.max(-1, Math.min(1, c));
    let a = Math.acos(c);
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };

  const theta1 = angleBetween(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dtheta = angleBetween(
    (x1p - cxp) / rx,
    (y1p - cyp) / ry,
    (-x1p - cxp) / rx,
    (-y1p - cyp) / ry
  );
  if (!sweep && dtheta > 0) dtheta -= Math.PI * 2;
  if (sweep && dtheta < 0) dtheta += Math.PI * 2;

  const rMax = Math.max(rx, ry);
  const steps = curveSteps(Math.abs(dtheta) * rMax, flatness, 8, 128);
  for (let s = 1; s <= steps; s += 1) {
    const t = theta1 + (dtheta * s) / steps;
    const cosT = Math.cos(t);
    const sinT = Math.sin(t);
    push(
      cosPhi * rx * cosT - sinPhi * ry * sinT + cx,
      sinPhi * rx * cosT + cosPhi * ry * sinT + cy
    );
  }
}

export function densifyPathDJs(d: string, flatness = DENSIFY_DEFAULT_FLATNESS): DensifyVec2[] {
  const src = String(d || '').trim();
  if (!src) return [];
  const flat = Math.max(0.15, Number(flatness) || DENSIFY_DEFAULT_FLATNESS);
  const pts: DensifyVec2[] = [];
  const re = /([MLHVCSQTAZmlhvcsqtaz])([^MLHVCSQTAZmlhvcsqtaz]*)/g;
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  let m: RegExpExecArray | null;
  const push = (x: number, y: number) => {
    const n = pts.length;
    if (n > 0) {
      const p = pts[n - 1]!;
      if (Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6) return;
    }
    pts.push({ x, y });
  };
  const nums = (s: string) =>
    (s.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []).map(Number).filter((n) => Number.isFinite(n));

  while ((m = re.exec(src))) {
    const cmd = m[1]!;
    const args = nums(m[2] || '');
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    let i = 0;
    if (C === 'M') {
      let subpathStart = true;
      while (i + 1 < args.length) {
        let x = args[i++]!;
        let y = args[i++]!;
        if (rel) {
          x += cx;
          y += cy;
        }
        cx = x;
        cy = y;
        startX = x;
        startY = y;
        // New subpath — keep a NaN break so stroke mesh does not bridge shaft→V (arrows).
        if (subpathStart && pts.length > 0) {
          pts.push({ x: Number.NaN, y: Number.NaN });
        }
        subpathStart = false;
        push(x, y);
        while (i + 1 < args.length) {
          let x2 = args[i++]!;
          let y2 = args[i++]!;
          if (rel) {
            x2 += cx;
            y2 += cy;
          }
          cx = x2;
          cy = y2;
          push(x2, y2);
        }
      }
    } else if (C === 'L') {
      while (i + 1 < args.length) {
        let x = args[i++]!;
        let y = args[i++]!;
        if (rel) {
          x += cx;
          y += cy;
        }
        cx = x;
        cy = y;
        push(x, y);
      }
    } else if (C === 'H') {
      while (i < args.length) {
        let x = args[i++]!;
        if (rel) x += cx;
        cx = x;
        push(cx, cy);
      }
    } else if (C === 'V') {
      while (i < args.length) {
        let y = args[i++]!;
        if (rel) y += cy;
        cy = y;
        push(cx, cy);
      }
    } else if (C === 'C') {
      while (i + 5 < args.length) {
        let x1 = args[i++]!;
        let y1 = args[i++]!;
        let x2 = args[i++]!;
        let y2 = args[i++]!;
        let x = args[i++]!;
        let y = args[i++]!;
        if (rel) {
          x1 += cx;
          y1 += cy;
          x2 += cx;
          y2 += cy;
          x += cx;
          y += cy;
        }
        const x0 = cx;
        const y0 = cy;
        const len =
          Math.hypot(x1 - x0, y1 - y0) +
          Math.hypot(x2 - x1, y2 - y1) +
          Math.hypot(x - x2, y - y2);
        const steps = curveSteps(len, flat, 8, 96);
        for (let s = 1; s <= steps; s += 1) {
          const t = s / steps;
          const u = 1 - t;
          const bx =
            u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x;
          const by =
            u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y;
          push(bx, by);
        }
        cx = x;
        cy = y;
      }
    } else if (C === 'Q') {
      while (i + 3 < args.length) {
        let x1 = args[i++]!;
        let y1 = args[i++]!;
        let x = args[i++]!;
        let y = args[i++]!;
        if (rel) {
          x1 += cx;
          y1 += cy;
          x += cx;
          y += cy;
        }
        const x0 = cx;
        const y0 = cy;
        const len = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x - x1, y - y1);
        const steps = curveSteps(len, flat, 6, 64);
        for (let s = 1; s <= steps; s += 1) {
          const t = s / steps;
          const u = 1 - t;
          push(u * u * x0 + 2 * u * t * x1 + t * t * x, u * u * y0 + 2 * u * t * y1 + t * t * y);
        }
        cx = x;
        cy = y;
      }
    } else if (C === 'A') {
      while (i + 6 < args.length) {
        const rx = args[i++]!;
        const ry = args[i++]!;
        const phi = args[i++]!;
        const large = args[i++]! ? 1 : 0;
        const sweep = args[i++]! ? 1 : 0;
        let x = args[i++]!;
        let y = args[i++]!;
        if (rel) {
          x += cx;
          y += cy;
        }
        densifyEllipticalArc(cx, cy, rx, ry, phi, large, sweep, x, y, flat, push);
        cx = x;
        cy = y;
      }
    } else if (C === 'Z') {
      push(startX, startY);
      cx = startX;
      cy = startY;
    }
  }
  return pts;
}

/** Split densified polylines on NaN,NaN subpath breaks (multi-M paths / arrows). */
export function splitPolylineContours(points: DensifyVec2[]): DensifyVec2[][] {
  const runs: DensifyVec2[][] = [];
  let cur: DensifyVec2[] = [];
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      if (cur.length >= 2) runs.push(cur);
      cur = [];
      continue;
    }
    cur.push(p);
  }
  if (cur.length >= 2) runs.push(cur);
  return runs;
}
