/**
 * Pure utility functions for SVG parsing and color conversion.
 * Extracted from UIEngine for testability and reuse.
 */
import type { Color } from './types';

/**
 * Convert a hex color string to an RGBA color object (0-1 range).
 *
 * Accepts the shorthand forms as well as the long ones (#rgb, #rgba, #rrggbb,
 * #rrggbbaa). Fixed 6-digit slicing used to yield NaN for green and blue on a
 * 3-digit value like `#333`, and a NaN channel doesn't survive the trip into
 * the engine — the whole style it belonged to was silently dropped.
 */
export function hexToRgb(hex: string): Color {
    const h = hex.trim().replace(/^#/, '');
    const short = h.length === 3 || h.length === 4;
    const chan = (i: number): number => {
        const s = short ? h[i].repeat(2) : h.slice(i * 2, i * 2 + 2);
        const v = parseInt(s, 16);
        return Number.isNaN(v) ? 0 : v / 255;
    };
    const hasAlpha = h.length === 4 || h.length === 8;
    return { r: chan(0), g: chan(1), b: chan(2), a: hasAlpha ? chan(3) : 1.0 };
}

/** Convert an RGB color object (0-1 range) to hex string. */
export function rgbToHex(color: { r: number; g: number; b: number }): string {
    const r = Math.round((color.r || 0) * 255)
        .toString(16)
        .padStart(2, '0');
    const g = Math.round((color.g || 0) * 255)
        .toString(16)
        .padStart(2, '0');
    const b = Math.round((color.b || 0) * 255)
        .toString(16)
        .padStart(2, '0');
    return `#${r}${g}${b}`;
}

/** Tokenize an SVG number string, handling negatives, decimals, and scientific notation. */
export function tokenizeSVGNumbers(numStr: string): number[] {
    const results: number[] = [];
    const regex = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;
    for (const m of numStr.matchAll(regex)) {
        const n = parseFloat(m[0]);
        if (!Number.isNaN(n)) results.push(n);
    }
    return results;
}

/** An arc-to-cubic-bezier segment. */
export interface ArcSegment {
    c1x: number;
    c1y: number;
    c2x: number;
    c2y: number;
    ex: number;
    ey: number;
}

/**
 * Convert an SVG arc to a series of cubic Bézier curves.
 * Based on the W3C algorithm for endpoint-to-center arc conversion.
 */
export function arcToCubicBeziers(
    x1: number,
    y1: number,
    rx: number,
    ry: number,
    phi: number,
    largeArc: boolean,
    sweep: boolean,
    x2: number,
    y2: number,
): ArcSegment[] {
    const result: ArcSegment[] = [];

    if (rx === 0 || ry === 0) {
        return [{ c1x: x1, c1y: y1, c2x: x2, c2y: y2, ex: x2, ey: y2 }];
    }

    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);

    const dx = (x1 - x2) / 2;
    const dy = (y1 - y2) / 2;
    const x1p = cosPhi * dx + sinPhi * dy;
    const y1p = -sinPhi * dx + cosPhi * dy;

    let rxSq = rx * rx,
        rySq = ry * ry;
    const x1pSq = x1p * x1p,
        y1pSq = y1p * y1p;
    const lambda = x1pSq / rxSq + y1pSq / rySq;
    if (lambda > 1) {
        const sqrtLambda = Math.sqrt(lambda);
        rx *= sqrtLambda;
        ry *= sqrtLambda;
        rxSq = rx * rx;
        rySq = ry * ry;
    }

    let sq = Math.max(
        0,
        (rxSq * rySq - rxSq * y1pSq - rySq * x1pSq) / (rxSq * y1pSq + rySq * x1pSq),
    );
    sq = Math.sqrt(sq);
    if (largeArc === sweep) sq = -sq;

    const cxp = (sq * rx * y1p) / ry;
    const cyp = (-sq * ry * x1p) / rx;

    const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
    const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

    const angle = (ux: number, uy: number, vx: number, vy: number) => {
        const dot = ux * vx + uy * vy;
        const len = Math.sqrt(ux * ux + uy * uy) * Math.sqrt(vx * vx + vy * vy);
        let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
        if (ux * vy - uy * vx < 0) a = -a;
        return a;
    };

    const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);

    if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
    if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

    const numSegs = Math.ceil(Math.abs(dTheta) / (Math.PI / 2));
    const segAngle = dTheta / numSegs;

    for (let i = 0; i < numSegs; i++) {
        const t1 = theta1 + i * segAngle;
        const t2 = theta1 + (i + 1) * segAngle;
        const alpha = (4 / 3) * Math.tan(segAngle / 4);

        const cos1 = Math.cos(t1),
            sin1 = Math.sin(t1);
        const cos2 = Math.cos(t2),
            sin2 = Math.sin(t2);

        const p1x = rx * cos1,
            p1y = ry * sin1;
        const p2x = rx * cos2,
            p2y = ry * sin2;

        const cp1x = p1x - alpha * rx * sin1;
        const cp1y = p1y + alpha * ry * cos1;
        const cp2x = p2x + alpha * rx * sin2;
        const cp2y = p2y - alpha * ry * cos2;

        result.push({
            c1x: cosPhi * cp1x - sinPhi * cp1y + cx,
            c1y: sinPhi * cp1x + cosPhi * cp1y + cy,
            c2x: cosPhi * cp2x - sinPhi * cp2y + cx,
            c2y: sinPhi * cp2x + cosPhi * cp2y + cy,
            ex: cosPhi * p2x - sinPhi * p2y + cx,
            ey: sinPhi * p2x + cosPhi * p2y + cy,
        });
    }

    return result;
}

/** A single point in a parsed SVG path. */
export interface SVGPathPoint {
    x: number;
    y: number;
    cp1: number[];
    cp2: number[];
}

/** A subpath: an array of points plus whether it was closed with Z. */
export interface SVGSubpath {
    points: SVGPathPoint[];
    closed: boolean;
}

/** Parse an SVG path `d` attribute into subpath arrays. */
export function parseSVGPathD(d: string, tx: number, ty: number): SVGSubpath[] {
    const result: SVGSubpath[] = [];
    let currentSubpathPts: SVGPathPoint[] = [];
    let currentClosed = false;

    const segments = d.match(/[MmLlCcSsQqTtHhVvAaZz][^MmLlCcSsQqTtHhVvAaZz]*/g) || [];
    let cx = 0,
        cy = 0;
    let startX = 0,
        startY = 0;
    let lastCmd = '';
    let lastCp2x = 0,
        lastCp2y = 0;
    let lastQx = 0,
        lastQy = 0;

    for (const seg of segments) {
        const cmd = seg[0];
        const nums = tokenizeSVGNumbers(seg.slice(1));

        switch (cmd) {
            case 'M': {
                if (currentSubpathPts.length > 0) {
                    result.push({ points: currentSubpathPts, closed: currentClosed });
                    currentSubpathPts = [];
                    currentClosed = false;
                }
                for (let i = 0; i < nums.length - 1; i += 2) {
                    cx = nums[i] + tx;
                    cy = nums[i + 1] + ty;
                    if (i === 0) {
                        startX = cx;
                        startY = cy;
                    }
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [cx, cy], cp2: [cx, cy] });
                }
                break;
            }
            case 'm': {
                if (currentSubpathPts.length > 0) {
                    result.push({ points: currentSubpathPts, closed: currentClosed });
                    currentSubpathPts = [];
                    currentClosed = false;
                }
                for (let i = 0; i < nums.length - 1; i += 2) {
                    cx += nums[i];
                    cy += nums[i + 1];
                    if (i === 0) {
                        startX = cx;
                        startY = cy;
                    }
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [cx, cy], cp2: [cx, cy] });
                }
                break;
            }
            case 'L': {
                for (let i = 0; i < nums.length - 1; i += 2) {
                    cx = nums[i] + tx;
                    cy = nums[i + 1] + ty;
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [cx, cy], cp2: [cx, cy] });
                }
                break;
            }
            case 'l': {
                for (let i = 0; i < nums.length - 1; i += 2) {
                    cx += nums[i];
                    cy += nums[i + 1];
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [cx, cy], cp2: [cx, cy] });
                }
                break;
            }
            case 'H': {
                for (let i = 0; i < nums.length; i++) {
                    cx = nums[i] + tx;
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [cx, cy], cp2: [cx, cy] });
                }
                break;
            }
            case 'h': {
                for (let i = 0; i < nums.length; i++) {
                    cx += nums[i];
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [cx, cy], cp2: [cx, cy] });
                }
                break;
            }
            case 'V': {
                for (let i = 0; i < nums.length; i++) {
                    cy = nums[i] + ty;
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [cx, cy], cp2: [cx, cy] });
                }
                break;
            }
            case 'v': {
                for (let i = 0; i < nums.length; i++) {
                    cy += nums[i];
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [cx, cy], cp2: [cx, cy] });
                }
                break;
            }
            case 'C': {
                for (let i = 0; i < nums.length - 5; i += 6) {
                    const c1x = nums[i] + tx,
                        c1y = nums[i + 1] + ty;
                    const c2x = nums[i + 2] + tx,
                        c2y = nums[i + 3] + ty;
                    cx = nums[i + 4] + tx;
                    cy = nums[i + 5] + ty;
                    if (currentSubpathPts.length > 0)
                        currentSubpathPts[currentSubpathPts.length - 1].cp2 = [c1x, c1y];
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [c2x, c2y], cp2: [cx, cy] });
                    lastCp2x = c2x;
                    lastCp2y = c2y;
                }
                break;
            }
            case 'c': {
                for (let i = 0; i < nums.length - 5; i += 6) {
                    const c1x = cx + nums[i],
                        c1y = cy + nums[i + 1];
                    const c2x = cx + nums[i + 2],
                        c2y = cy + nums[i + 3];
                    cx += nums[i + 4];
                    cy += nums[i + 5];
                    if (currentSubpathPts.length > 0)
                        currentSubpathPts[currentSubpathPts.length - 1].cp2 = [c1x, c1y];
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [c2x, c2y], cp2: [cx, cy] });
                    lastCp2x = c2x;
                    lastCp2y = c2y;
                }
                break;
            }
            case 'S': {
                for (let i = 0; i < nums.length - 3; i += 4) {
                    let c1x: number, c1y: number;
                    if ('CcSs'.includes(lastCmd)) {
                        c1x = 2 * cx - lastCp2x;
                        c1y = 2 * cy - lastCp2y;
                    } else {
                        c1x = cx;
                        c1y = cy;
                    }
                    const c2x = nums[i] + tx,
                        c2y = nums[i + 1] + ty;
                    cx = nums[i + 2] + tx;
                    cy = nums[i + 3] + ty;
                    if (currentSubpathPts.length > 0)
                        currentSubpathPts[currentSubpathPts.length - 1].cp2 = [c1x, c1y];
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [c2x, c2y], cp2: [cx, cy] });
                    lastCp2x = c2x;
                    lastCp2y = c2y;
                }
                break;
            }
            case 's': {
                for (let i = 0; i < nums.length - 3; i += 4) {
                    let c1x: number, c1y: number;
                    if ('CcSs'.includes(lastCmd)) {
                        c1x = 2 * cx - lastCp2x;
                        c1y = 2 * cy - lastCp2y;
                    } else {
                        c1x = cx;
                        c1y = cy;
                    }
                    const c2x = cx + nums[i],
                        c2y = cy + nums[i + 1];
                    cx += nums[i + 2];
                    cy += nums[i + 3];
                    if (currentSubpathPts.length > 0)
                        currentSubpathPts[currentSubpathPts.length - 1].cp2 = [c1x, c1y];
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [c2x, c2y], cp2: [cx, cy] });
                    lastCp2x = c2x;
                    lastCp2y = c2y;
                }
                break;
            }
            case 'Q': {
                for (let i = 0; i < nums.length - 3; i += 4) {
                    const qx = nums[i] + tx,
                        qy = nums[i + 1] + ty;
                    const ex = nums[i + 2] + tx,
                        ey = nums[i + 3] + ty;
                    const c1x = cx + (2 / 3) * (qx - cx);
                    const c1y = cy + (2 / 3) * (qy - cy);
                    const c2x = ex + (2 / 3) * (qx - ex);
                    const c2y = ey + (2 / 3) * (qy - ey);
                    cx = ex;
                    cy = ey;
                    if (currentSubpathPts.length > 0)
                        currentSubpathPts[currentSubpathPts.length - 1].cp2 = [c1x, c1y];
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [c2x, c2y], cp2: [cx, cy] });
                    lastQx = qx;
                    lastQy = qy;
                }
                break;
            }
            case 'q': {
                for (let i = 0; i < nums.length - 3; i += 4) {
                    const qx = cx + nums[i],
                        qy = cy + nums[i + 1];
                    const ex = cx + nums[i + 2],
                        ey = cy + nums[i + 3];
                    const c1x = cx + (2 / 3) * (qx - cx);
                    const c1y = cy + (2 / 3) * (qy - cy);
                    const c2x = ex + (2 / 3) * (qx - ex);
                    const c2y = ey + (2 / 3) * (qy - ey);
                    cx = ex;
                    cy = ey;
                    if (currentSubpathPts.length > 0)
                        currentSubpathPts[currentSubpathPts.length - 1].cp2 = [c1x, c1y];
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [c2x, c2y], cp2: [cx, cy] });
                    lastQx = qx;
                    lastQy = qy;
                }
                break;
            }
            case 'T': {
                for (let i = 0; i < nums.length - 1; i += 2) {
                    let qx: number, qy: number;
                    if ('QqTt'.includes(lastCmd)) {
                        qx = 2 * cx - lastQx;
                        qy = 2 * cy - lastQy;
                    } else {
                        qx = cx;
                        qy = cy;
                    }
                    const ex = nums[i] + tx,
                        ey = nums[i + 1] + ty;
                    const c1x = cx + (2 / 3) * (qx - cx);
                    const c1y = cy + (2 / 3) * (qy - cy);
                    const c2x = ex + (2 / 3) * (qx - ex);
                    const c2y = ey + (2 / 3) * (qy - ey);
                    cx = ex;
                    cy = ey;
                    if (currentSubpathPts.length > 0)
                        currentSubpathPts[currentSubpathPts.length - 1].cp2 = [c1x, c1y];
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [c2x, c2y], cp2: [cx, cy] });
                    lastQx = qx;
                    lastQy = qy;
                }
                break;
            }
            case 't': {
                for (let i = 0; i < nums.length - 1; i += 2) {
                    let qx: number, qy: number;
                    if ('QqTt'.includes(lastCmd)) {
                        qx = 2 * cx - lastQx;
                        qy = 2 * cy - lastQy;
                    } else {
                        qx = cx;
                        qy = cy;
                    }
                    const ex = cx + nums[i],
                        ey = cy + nums[i + 1];
                    const c1x = cx + (2 / 3) * (qx - cx);
                    const c1y = cy + (2 / 3) * (qy - cy);
                    const c2x = ex + (2 / 3) * (qx - ex);
                    const c2y = ey + (2 / 3) * (qy - ey);
                    cx = ex;
                    cy = ey;
                    if (currentSubpathPts.length > 0)
                        currentSubpathPts[currentSubpathPts.length - 1].cp2 = [c1x, c1y];
                    currentSubpathPts.push({ x: cx, y: cy, cp1: [c2x, c2y], cp2: [cx, cy] });
                    lastQx = qx;
                    lastQy = qy;
                }
                break;
            }
            case 'A':
            case 'a': {
                const isRelative = cmd === 'a';
                for (let i = 0; i < nums.length - 6; i += 7) {
                    const arcRx = Math.abs(nums[i]);
                    const arcRy = Math.abs(nums[i + 1]);
                    const xAxisRotation = (nums[i + 2] * Math.PI) / 180;
                    const largeArcFlag = nums[i + 3] !== 0;
                    const sweepFlag = nums[i + 4] !== 0;
                    let ex = nums[i + 5],
                        ey = nums[i + 6];
                    if (!isRelative) {
                        ex += tx;
                        ey += ty;
                    } else {
                        ex += cx;
                        ey += cy;
                    }

                    const arcPts = arcToCubicBeziers(
                        cx,
                        cy,
                        arcRx,
                        arcRy,
                        xAxisRotation,
                        largeArcFlag,
                        sweepFlag,
                        ex,
                        ey,
                    );
                    for (const arcSeg of arcPts) {
                        if (currentSubpathPts.length > 0)
                            currentSubpathPts[currentSubpathPts.length - 1].cp2 = [
                                arcSeg.c1x,
                                arcSeg.c1y,
                            ];
                        currentSubpathPts.push({
                            x: arcSeg.ex,
                            y: arcSeg.ey,
                            cp1: [arcSeg.c2x, arcSeg.c2y],
                            cp2: [arcSeg.ex, arcSeg.ey],
                        });
                    }
                    cx = ex;
                    cy = ey;
                }
                break;
            }
            case 'Z':
            case 'z': {
                currentClosed = true;
                cx = startX;
                cy = startY;
                if (currentSubpathPts.length > 0) {
                    result.push({ points: currentSubpathPts, closed: true });
                }
                currentSubpathPts = [];
                currentClosed = false;
                break;
            }
        }
        lastCmd = cmd;
    }
    if (currentSubpathPts.length > 0) {
        result.push({ points: currentSubpathPts, closed: currentClosed });
    }
    return result;
}

// ─── Matrix & Transform Utilities ──────────────────────────────────────────

/** Identity matrix as column-major [f32; 9]. */
export function identityMatrix(): number[] {
    return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

/**
 * Multiply two 3×3 matrices (column-major storage).
 * Column-major: index = col * 3 + row.
 * Result = A * B.
 */
export function composeMatrices(a: number[], b: number[]): number[] {
    // a[col*3+row], b[col*3+row]
    return [
        a[0] * b[0] + a[3] * b[1] + a[6] * b[2],
        a[1] * b[0] + a[4] * b[1] + a[7] * b[2],
        a[2] * b[0] + a[5] * b[1] + a[8] * b[2],

        a[0] * b[3] + a[3] * b[4] + a[6] * b[5],
        a[1] * b[3] + a[4] * b[4] + a[7] * b[5],
        a[2] * b[3] + a[5] * b[4] + a[8] * b[5],

        a[0] * b[6] + a[3] * b[7] + a[6] * b[8],
        a[1] * b[6] + a[4] * b[7] + a[7] * b[8],
        a[2] * b[6] + a[5] * b[7] + a[8] * b[8],
    ];
}

/**
 * Invert an affine column-major 3×3 matrix (the bottom row is assumed
 * [0, 0, 1] — every transform we produce is affine). Returns null when the
 * linear part is singular (zero scale), where no inverse exists.
 */
export function invertMatrix(m: number[]): number[] | null {
    const [a, b, , c, d, , tx, ty] = m;
    const det = a * d - b * c;
    if (!det || !Number.isFinite(det)) return null;
    const ia = d / det;
    const ib = -b / det;
    const ic = -c / det;
    const id = a / det;
    return [ia, ib, 0, ic, id, 0, -(ia * tx + ic * ty), -(ib * tx + id * ty), 1];
}

/** Whether a column-major 3×3 matrix is (numerically) the identity. */
export function isIdentityMatrix(m: number[], eps = 1e-6): boolean {
    const I = identityMatrix();
    return m.length === 9 && m.every((v, i) => Math.abs(v - I[i]) <= eps);
}

/**
 * Transform a 2D point [x, y] by a column-major 3×3 matrix.
 * Returns [x', y'].
 */
export function transformPoint(m: number[], x: number, y: number): [number, number] {
    return [m[0] * x + m[3] * y + m[6], m[1] * x + m[4] * y + m[7]];
}

/**
 * Build a column-major 3×3 translation matrix.
 */
export function translateMatrix(tx: number, ty: number): number[] {
    return [1, 0, 0, 0, 1, 0, tx, ty, 1];
}

/**
 * Build a column-major 3×3 scale matrix.
 */
export function scaleMatrix(sx: number, sy: number): number[] {
    return [sx, 0, 0, 0, sy, 0, 0, 0, 1];
}

/**
 * Build a column-major 3×3 rotation matrix (angle in radians).
 */
function rotationMatrix(angle: number): number[] {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return [c, s, 0, -s, c, 0, 0, 0, 1];
}

/**
 * Build a column-major 3×3 skewX matrix (angle in radians).
 */
function skewXMatrix(angle: number): number[] {
    return [1, 0, 0, Math.tan(angle), 1, 0, 0, 0, 1];
}

/**
 * Build a column-major 3×3 skewY matrix (angle in radians).
 */
function skewYMatrix(angle: number): number[] {
    return [1, Math.tan(angle), 0, 0, 1, 0, 0, 0, 1];
}

/** Context for resolving relative CSS length units. */
export interface LengthContext {
    /** Reference length for `%` (e.g. the viewport dimension or parent font-size). */
    percentBasis?: number;
    /** Current font-size in user units, for `em`/`ex`. Defaults to 16. */
    fontSize?: number;
    /** Root font-size, for `rem`. Defaults to `fontSize`. */
    rootFontSize?: number;
}

/**
 * Parse an SVG/CSS length string to user units (CSS px, 96 per inch).
 *
 * Absolute units (px, pt, pc, in, cm, mm, Q) convert unconditionally. Relative
 * units use `ctx`: em/ex → fontSize, rem → rootFontSize, % → percentBasis.
 * A `%` with no `percentBasis` returns the raw number (non-regressive vs a bare
 * parseFloat), and an unknown unit is treated as user units. Empty/invalid
 * input returns `fallback`.
 */
export function parseSvgLength(
    value: string | null | undefined,
    fallback: number,
    ctx?: LengthContext,
): number {
    if (value == null) return fallback;
    const m = String(value)
        .trim()
        .match(/^([+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?)\s*([a-z%]*)$/i);
    if (!m) return fallback;
    const n = parseFloat(m[1]);
    if (Number.isNaN(n)) return fallback;
    const fs = ctx?.fontSize ?? 16;
    const rfs = ctx?.rootFontSize ?? fs;
    switch (m[2].toLowerCase()) {
        case '':
        case 'px':
            return n;
        case 'pt':
            return (n * 96) / 72;
        case 'pc':
            return n * 16;
        case 'in':
            return n * 96;
        case 'cm':
            return (n * 96) / 2.54;
        case 'mm':
            return (n * 96) / 25.4;
        case 'q':
            return (n * 96) / 101.6; // quarter-millimeter
        case 'em':
            return n * fs;
        case 'ex':
            return n * fs * 0.5; // approx x-height
        case 'rem':
            return n * rfs;
        case '%':
            return ctx?.percentBasis != null ? (n * ctx.percentBasis) / 100 : n;
        default:
            return n; // unknown unit → user units
    }
}

/**
 * Parse a full SVG `transform` attribute into a composed column-major 3×3 matrix.
 * Handles: translate, scale, rotate, matrix, skewX, skewY.
 * Multiple transforms are composed left-to-right (SVG spec: leftmost applied last).
 */
export function parseSVGTransform(attr: string): number[] {
    let result = identityMatrix();

    // Match each transform function in order
    const regex = /(translate|scale|rotate|matrix|skewX|skewY)\s*\(([^)]+)\)/gi;
    for (const match of attr.matchAll(regex)) {
        const fn = match[1].toLowerCase();
        const nums = tokenizeSVGNumbers(match[2]);
        let m: number[];

        switch (fn) {
            case 'translate': {
                const tx = nums[0] || 0;
                const ty = nums[1] || 0;
                m = translateMatrix(tx, ty);
                break;
            }
            case 'scale': {
                const sx = nums[0] || 1;
                const sy = nums.length >= 2 ? nums[1] : sx;
                m = scaleMatrix(sx, sy);
                break;
            }
            case 'rotate': {
                const angle = ((nums[0] || 0) * Math.PI) / 180;
                if (nums.length >= 3) {
                    // rotate(angle, cx, cy) = translate(cx,cy) * rotate(angle) * translate(-cx,-cy)
                    const cx = nums[1],
                        cy = nums[2];
                    m = composeMatrices(
                        translateMatrix(cx, cy),
                        composeMatrices(rotationMatrix(angle), translateMatrix(-cx, -cy)),
                    );
                } else {
                    m = rotationMatrix(angle);
                }
                break;
            }
            case 'matrix': {
                if (nums.length >= 6) {
                    // SVG matrix(a,b,c,d,e,f) maps to column-major:
                    // col0=[a,b,0], col1=[c,d,0], col2=[e,f,1]
                    m = [nums[0], nums[1], 0, nums[2], nums[3], 0, nums[4], nums[5], 1];
                } else {
                    m = identityMatrix();
                }
                break;
            }
            case 'skewx': {
                m = skewXMatrix(((nums[0] || 0) * Math.PI) / 180);
                break;
            }
            case 'skewy': {
                m = skewYMatrix(((nums[0] || 0) * Math.PI) / 180);
                break;
            }
            default:
                m = identityMatrix();
        }

        // SVG spec: transforms compose left-to-right
        result = composeMatrices(result, m);
    }

    return result;
}

/**
 * Convert a column-major [f32; 9] local transform to SVG matrix() attribute value.
 * Column-major: [a, b, _, c, d, _, tx, ty, _]
 * SVG matrix:   matrix(a, b, c, d, tx, ty)
 */
export function matrixToSVGTransform(m: number[]): string {
    return `matrix(${m[0]},${m[1]},${m[3]},${m[4]},${m[6]},${m[7]})`;
}

// ─── preserveAspectRatio ───────────────────────────────────────────────────

/**
 * Parse an SVG `preserveAspectRatio` attribute and compute the combined
 * translate + scale matrix that maps viewBox coordinates to viewport
 * coordinates.
 *
 * @param par     The `preserveAspectRatio` value (e.g. "xMidYMid meet").
 *                Defaults to "xMidYMid meet" when null/empty (SVG spec default).
 * @param vbMinX  viewBox min-X
 * @param vbMinY  viewBox min-Y
 * @param vbW     viewBox width
 * @param vbH     viewBox height
 * @param vpW     Viewport (element) width
 * @param vpH     Viewport (element) height
 * @returns       Column-major 3×3 matrix
 */
export function parsePreserveAspectRatio(
    par: string | null,
    vbMinX: number,
    vbMinY: number,
    vbW: number,
    vbH: number,
    vpW: number,
    vpH: number,
): number[] {
    if (vbW <= 0 || vbH <= 0 || vpW <= 0 || vpH <= 0) {
        // Degenerate — just translate the origin
        if (vbMinX !== 0 || vbMinY !== 0) {
            return translateMatrix(-vbMinX, -vbMinY);
        }
        return identityMatrix();
    }

    const value = (par || 'xMidYMid meet').trim();

    // "none" → non-uniform stretch
    if (value === 'none') {
        const sx = vpW / vbW;
        const sy = vpH / vbH;
        return composeMatrices(scaleMatrix(sx, sy), translateMatrix(-vbMinX, -vbMinY));
    }

    // Parse alignment + meetOrSlice
    const parts = value.split(/\s+/);
    const align = parts[0] || 'xMidYMid';
    const meetOrSlice = (parts[1] || 'meet').toLowerCase();

    // Compute uniform scale
    const scaleX = vpW / vbW;
    const scaleY = vpH / vbH;
    const s = meetOrSlice === 'slice' ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);

    // Parse x/y alignment from the combined token (e.g. "xMidYMid")
    const xAlign = align.slice(0, 4); // xMin, xMid, xMax
    const yAlign = align.slice(4, 8); // YMin, YMid, YMax

    let tx = 0;
    let ty = 0;

    // X alignment: how to distribute remaining horizontal space
    if (xAlign === 'xMid') {
        tx = (vpW - vbW * s) / 2;
    } else if (xAlign === 'xMax') {
        tx = vpW - vbW * s;
    }
    // xMin → tx = 0

    // Y alignment: how to distribute remaining vertical space
    if (yAlign === 'YMid') {
        ty = (vpH - vbH * s) / 2;
    } else if (yAlign === 'YMax') {
        ty = vpH - vbH * s;
    }
    // YMin → ty = 0

    // Result: translate(tx, ty) * scale(s, s) * translate(-vbMinX, -vbMinY)
    return composeMatrices(
        composeMatrices(translateMatrix(tx, ty), scaleMatrix(s, s)),
        translateMatrix(-vbMinX, -vbMinY),
    );
}

// ─── XML / Attribute Escaping ──────────────────────────────────────────────

/** Escape special XML characters for safe use in attributes and text content. */
export function escapeXml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/** Escape a string for safe interpolation into innerHTML. */
export function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ─── CSS Color Parsing ─────────────────────────────────────────────────────

/** CSS named colors (the common subset; canvas normalization is not available
 *  in the test environment, so this stays a pure lookup). */
const CSS_NAMED_COLORS: Record<string, string> = {
    black: '#000000',
    white: '#ffffff',
    red: '#ff0000',
    green: '#008000',
    blue: '#0000ff',
    yellow: '#ffff00',
    orange: '#ffa500',
    purple: '#800080',
    gray: '#808080',
    grey: '#808080',
    pink: '#ffc0cb',
    brown: '#a52a2a',
    cyan: '#00ffff',
    magenta: '#ff00ff',
    lime: '#00ff00',
    navy: '#000080',
    teal: '#008080',
    silver: '#c0c0c0',
    maroon: '#800000',
    olive: '#808000',
    aqua: '#00ffff',
    fuchsia: '#ff00ff',
    crimson: '#dc143c',
    coral: '#ff7f50',
    gold: '#ffd700',
    indigo: '#4b0082',
    violet: '#ee82ee',
    khaki: '#f0e68c',
    salmon: '#fa8072',
    turquoise: '#40e0d0',
    tan: '#d2b48c',
    orchid: '#da70d6',
    skyblue: '#87ceeb',
    steelblue: '#4682b4',
    tomato: '#ff6347',
    wheat: '#f5deb3',
    beige: '#f5f5dc',
    ivory: '#fffff0',
    lavender: '#e6e6fa',
    plum: '#dda0dd',
    darkred: '#8b0000',
    darkgreen: '#006400',
    darkblue: '#00008b',
    darkgray: '#a9a9a9',
    darkgrey: '#a9a9a9',
    lightgray: '#d3d3d3',
    lightgrey: '#d3d3d3',
    lightblue: '#add8e6',
    lightgreen: '#90ee90',
    lightyellow: '#ffffe0',
    lightpink: '#ffb6c1',
    dimgray: '#696969',
    dimgrey: '#696969',
    slategray: '#708090',
    slategrey: '#708090',
    royalblue: '#4169e1',
    dodgerblue: '#1e90ff',
    firebrick: '#b22222',
    forestgreen: '#228b22',
    seagreen: '#2e8b57',
    midnightblue: '#191970',
    goldenrod: '#daa520',
    chocolate: '#d2691e',
    sienna: '#a0522d',
    rebeccapurple: '#663399',
    hotpink: '#ff69b4',
    deeppink: '#ff1493',
    currentcolor: '#000000',
    inherit: '#000000',
};

/**
 * Parse any CSS color into a normalized 6-digit hex + alpha.
 * Handles: #rgb, #rgba, #rrggbb, #rrggbbaa, rgb(), rgba(), hsl(), hsla(),
 * named colors. Returns null for anything unparseable (url refs, var(), etc.)
 * — callers must NOT feed the raw string onward, that renders as black.
 */
export function parseCssColor(input: string): { hex: string; alpha: number } | null {
    const s = input.trim();
    const toHex = (r: number, g: number, b: number) =>
        '#' +
        [r, g, b]
            .map((v) =>
                Math.max(0, Math.min(255, Math.round(v)))
                    .toString(16)
                    .padStart(2, '0'),
            )
            .join('');

    // Hex forms
    if (s.startsWith('#')) {
        const h = s.slice(1);
        if (/^[0-9a-fA-F]{3}$/.test(h)) {
            return {
                hex:
                    '#' +
                    h
                        .split('')
                        .map((c) => c + c)
                        .join(''),
                alpha: 1,
            };
        }
        if (/^[0-9a-fA-F]{4}$/.test(h)) {
            const [r, g, b, a] = h.split('').map((c) => parseInt(c + c, 16));
            return { hex: toHex(r, g, b), alpha: a / 255 };
        }
        if (/^[0-9a-fA-F]{6}$/.test(h)) return { hex: s.toLowerCase(), alpha: 1 };
        if (/^[0-9a-fA-F]{8}$/.test(h)) {
            return {
                hex: `#${h.slice(0, 6).toLowerCase()}`,
                alpha: parseInt(h.slice(6, 8), 16) / 255,
            };
        }
        return null;
    }

    // rgb() / rgba() — ints or percentages, comma or space separated
    const rgbMatch = s.match(
        /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:[\s,/]+([\d.]+%?))?\s*\)$/i,
    );
    if (rgbMatch) {
        const chan = (v: string) => (v.endsWith('%') ? (parseFloat(v) / 100) * 255 : parseFloat(v));
        const alpha =
            rgbMatch[4] !== undefined
                ? rgbMatch[4].endsWith('%')
                    ? parseFloat(rgbMatch[4]) / 100
                    : parseFloat(rgbMatch[4])
                : 1;
        return { hex: toHex(chan(rgbMatch[1]), chan(rgbMatch[2]), chan(rgbMatch[3])), alpha };
    }

    // hsl() / hsla()
    const hslMatch = s.match(
        /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:[\s,/]+([\d.]+%?))?\s*\)$/i,
    );
    if (hslMatch) {
        const hDeg = ((parseFloat(hslMatch[1]) % 360) + 360) % 360;
        const sat = parseFloat(hslMatch[2]) / 100;
        const light = parseFloat(hslMatch[3]) / 100;
        const alpha =
            hslMatch[4] !== undefined
                ? hslMatch[4].endsWith('%')
                    ? parseFloat(hslMatch[4]) / 100
                    : parseFloat(hslMatch[4])
                : 1;
        const c = (1 - Math.abs(2 * light - 1)) * sat;
        const x = c * (1 - Math.abs(((hDeg / 60) % 2) - 1));
        const m = light - c / 2;
        let r = 0,
            g = 0,
            b = 0;
        if (hDeg < 60) {
            r = c;
            g = x;
        } else if (hDeg < 120) {
            r = x;
            g = c;
        } else if (hDeg < 180) {
            g = c;
            b = x;
        } else if (hDeg < 240) {
            g = x;
            b = c;
        } else if (hDeg < 300) {
            r = x;
            b = c;
        } else {
            r = c;
            b = x;
        }
        return { hex: toHex((r + m) * 255, (g + m) * 255, (b + m) * 255), alpha };
    }

    // Named colors
    const named = CSS_NAMED_COLORS[s.toLowerCase()];
    if (named) return { hex: named, alpha: 1 };

    return null;
}

// ─── Gradient Resolution ───────────────────────────────────────────────────

/** Parsed SVG gradient data ready for the engine's Paint::Gradient format. */
export interface SVGGradientData {
    gradient_type: 'Linear' | 'Radial';
    stops: { offset: number; color: { r: number; g: number; b: number; a: number } }[];
    /** Start point in local coordinate space */
    start_x: number;
    start_y: number;
    /** End point in local coordinate space */
    end_x: number;
    end_y: number;
    /** spreadMethod: 0 = pad, 1 = repeat, 2 = reflect. */
    spread: number;
    /** Radial focal point in local space; absent = concentric (focal = center). */
    focal?: { x: number; y: number; r: number };
    /** Gradient→local affine [a,b,c,d,e,f] for rotated / non-uniform (elliptical)
     *  radials. When present, start/end/focal are RAW gradient-space coordinates
     *  and the renderer applies this as the shader's local matrix. Absent = the
     *  baked circular/linear form (coordinates already in node-local space). */
    transform?: number[];
}

/**
 * Geometry context for mapping gradient coordinates into a node's LOCAL space
 * (the space its path is drawn in). SVG gradients come in two unit systems:
 *  - objectBoundingBox (the default): fraction f maps to `b{x,y} + f * b{w,h}`.
 *  - userSpaceOnUse: coordinates are in the element's user space and are mapped
 *    into node-local space by `userToLocal` (a column-major mat3).
 * The importer supplies the right descriptor per shape (rect/ellipse/path…).
 */
export interface GradientGeo {
    bx: number;
    by: number;
    bw: number;
    bh: number;
    userToLocal: number[];
}

/**
 * Resolve a `fill="url(#id)"` to full gradient data.
 * Parses <linearGradient> and <radialGradient> with their stops and coordinates.
 * Coordinates use objectBoundingBox by default (0–1 space), converted to local
 * coords using the provided geometry descriptor (defaults to a 100×100 box at
 * the origin when omitted, for legacy callers).
 */
export function resolveGradient(
    svgDoc: Document,
    fillUrl: string,
    geo?: GradientGeo,
): SVGGradientData | null {
    const g: GradientGeo = geo ?? { bx: 0, by: 0, bw: 100, bh: 100, userToLocal: identityMatrix() };
    // Accept quoted references too: url('#id') / url("#id") (Illustrator output)
    const idMatch = fillUrl.match(/url\(\s*['"]?#([^'")]+)['"]?\s*\)/);
    if (!idMatch) return null;

    const el = svgDoc.getElementById(idMatch[1]);
    if (!el) return null;

    const tag = el.tagName.toLowerCase();
    if (tag !== 'lineargradient' && tag !== 'radialgradient') return null;

    // Stops may live on a referenced template gradient (href / xlink:href
    // indirection, standard in Illustrator exports). Follow the chain.
    let stopSource: Element | null = el;
    for (
        let hops = 0;
        stopSource && stopSource.querySelectorAll('stop').length === 0 && hops < 4;
        hops++
    ) {
        const href: string | null | undefined =
            stopSource.getAttribute('href') ?? stopSource.getAttribute('xlink:href');
        stopSource = href?.startsWith('#') ? svgDoc.getElementById(href.slice(1)) : null;
    }
    if (!stopSource) return null;

    // Parse gradient stops
    const stopEls = stopSource.querySelectorAll('stop');
    const stops: SVGGradientData['stops'] = [];
    for (const stopEl of stopEls) {
        const offset = parseFloat(stopEl.getAttribute('offset') || '0');
        const opacity = parseFloat(stopEl.getAttribute('stop-opacity') || '1');

        let colorStr = stopEl.getAttribute('stop-color');
        if (!colorStr) {
            const styleAttr = stopEl.getAttribute('style');
            if (styleAttr) {
                const match = styleAttr.match(/stop-color\s*:\s*([^;]+)/);
                if (match) colorStr = match[1].trim();
                // Also check for stop-opacity in style
                const opMatch = styleAttr.match(/stop-opacity\s*:\s*([^;]+)/);
                if (opMatch) {
                    const styleOpacity = parseFloat(opMatch[1].trim());
                    if (!Number.isNaN(styleOpacity)) {
                        stops.push({
                            offset: Number.isNaN(offset) ? 0 : offset,
                            color: parseStopColor(colorStr || '#000000', styleOpacity),
                        });
                        continue;
                    }
                }
            }
        }

        stops.push({
            offset: Number.isNaN(offset) ? 0 : offset,
            color: parseStopColor(colorStr || '#000000', opacity),
        });
    }

    if (stops.length === 0) return null;

    // Per SVG: each stop offset is clamped to [0,1] AND must be >= every previous
    // offset ("if not equal to or greater than all previous, adjust to the largest
    // previous value"). A missing offset parses as 0, so without this a later stop
    // with no offset would sort BEFORE earlier stops and swap the color order.
    let runningMax = 0;
    for (const s of stops) {
        const clamped = Math.max(0, Math.min(1, s.offset));
        s.offset = Math.max(clamped, runningMax);
        runningMax = s.offset;
    }

    // Resolve an attribute through the href/xlink:href template chain — coords,
    // gradientUnits and gradientTransform (like stops) commonly live on a
    // referenced template gradient in Illustrator/Figma exports. Per spec the
    // href of a gradient must reference ANOTHER GRADIENT; we only inherit
    // through gradient elements (a href to e.g. a <rect> is invalid and ignored,
    // matching resvg) so we don't pull unrelated attributes off the wrong node.
    const isGradientEl = (e: Element): boolean => {
        const t = (e.localName || e.tagName).toLowerCase();
        return t === 'lineargradient' || t === 'radialgradient';
    };
    const resolveAttr = (name: string): string | null => {
        let cur: Element | null = el;
        for (let hops = 0; cur && hops < 5; hops++) {
            const v = cur.getAttribute(name);
            if (v !== null && v !== '') return v;
            const href: string | null | undefined =
                cur.getAttribute('href') ?? cur.getAttribute('xlink:href');
            const next: Element | null = href?.startsWith('#')
                ? svgDoc.getElementById(href.slice(1))
                : null;
            cur = next && isGradientEl(next) ? next : null;
        }
        return null;
    };

    // Parse a coordinate attribute, honoring a trailing % (→ 0–1 fraction).
    const num = (name: string, def: number): number => {
        const raw = resolveAttr(name);
        if (raw === null) return def;
        const v = parseFloat(raw);
        if (Number.isNaN(v)) return def;
        return raw.trim().endsWith('%') ? v / 100 : v;
    };

    const isOBB = (resolveAttr('gradientUnits') || 'objectBoundingBox') === 'objectBoundingBox';

    // gradientTransform is applied in the gradient's own coordinate space,
    // BEFORE the objectBoundingBox→local scaling. Rotated/skewed gradients are
    // common in real exports; without this they import axis-aligned and wrong.
    const gtAttr = resolveAttr('gradientTransform');
    const gt = gtAttr ? parseSVGTransform(gtAttr) : null;
    const applyGt = (x: number, y: number): [number, number] =>
        gt ? transformPoint(gt, x, y) : [x, y];

    // spreadMethod → engine spread code: pad=0, repeat=1, reflect=2.
    const spreadStr = resolveAttr('spreadMethod') || 'pad';
    const spread = spreadStr === 'repeat' ? 1 : spreadStr === 'reflect' ? 2 : 0;

    let start_x: number, start_y: number, end_x: number, end_y: number;

    if (tag === 'lineargradient') {
        // Default: x1=0, y1=0, x2=1, y2=0 (left to right)
        const [x1, y1] = applyGt(num('x1', 0), num('y1', 0));
        const [x2, y2] = applyGt(num('x2', 1), num('y2', 0));

        if (isOBB) {
            start_x = g.bx + x1 * g.bw;
            start_y = g.by + y1 * g.bh;
            end_x = g.bx + x2 * g.bw;
            end_y = g.by + y2 * g.bh;
        } else {
            [start_x, start_y] = transformPoint(g.userToLocal, x1, y1);
            [end_x, end_y] = transformPoint(g.userToLocal, x2, y2);
        }

        return { gradient_type: 'Linear', stops, start_x, start_y, end_x, end_y, spread };
    } else {
        // radialGradient — default cx=0.5, cy=0.5, r=0.5. Focal point defaults
        // to the center: fx=cx, fy=cy, fr=0.
        const cx = num('cx', 0.5),
            cy = num('cy', 0.5),
            r = num('r', 0.5);
        const fx = num('fx', cx),
            fy = num('fy', cy),
            fr = num('fr', 0);

        // Full gradient-space → node-local affine F (column-major mat3):
        // objectBoundingBox folds the bbox mapping; userSpaceOnUse uses the
        // element's user→local matrix. gradientTransform (gt) sits innermost.
        const gtM = gt ?? identityMatrix();
        const F = isOBB
            ? composeMatrices(
                  composeMatrices(translateMatrix(g.bx, g.by), scaleMatrix(g.bw, g.bh)),
                  gtM,
              )
            : composeMatrices(g.userToLocal, gtM);

        // Is F circle-preserving? Its two linear columns must be equal-length and
        // orthogonal (pure rotation + uniform scale). If so, the baked start/end/
        // focal form below represents the radial exactly. A non-uniform or skewed
        // F makes an ELLIPSE — carrying F through as the shader's local matrix
        // (with raw gradient-space coords) renders it correctly, instead of
        // collapsing to a circle (which read as a flat, mis-sized gradient).
        const la = F[0],
            lb = F[1],
            lc = F[3],
            ld = F[4];
        const col0 = la * la + lb * lb;
        const col1 = lc * lc + ld * ld;
        const dot = la * lc + lb * ld;
        const tol = 1e-6 * Math.max(col0, col1, 1);
        const isSimilarity = Math.abs(col0 - col1) < tol && Math.abs(dot) < tol;

        if (!isSimilarity) {
            const hasFocal = Math.abs(fx - cx) > 1e-6 || Math.abs(fy - cy) > 1e-6 || fr > 1e-6;
            return {
                gradient_type: 'Radial',
                stops,
                // Raw gradient-space: center (cx,cy), a +x edge at radius r.
                start_x: cx,
                start_y: cy,
                end_x: cx + r,
                end_y: cy,
                spread,
                ...(hasFocal ? { focal: { x: fx, y: fy, r: fr } } : {}),
                // SVG 2×3 affine [a,b,c,d,e,f] from the column-major F.
                transform: [F[0], F[1], F[3], F[4], F[6], F[7]],
            };
        }

        // Circle-preserving: bake center/radius/focal into node-local space.
        // Transform the center and a +x radius-edge point together, so the
        // gradientTransform's rotation/uniform scale affects the radius.
        const [c0x, c0y] = applyGt(cx, cy);
        const [e0x, e0y] = applyGt(cx + r, cy);
        const [f0x, f0y] = applyGt(fx, fy);
        const [fe0x] = applyGt(fx + fr, fy); // transformed focal-radius edge

        const toLocal = (px: number, py: number): [number, number] =>
            isOBB ? [g.bx + px * g.bw, g.by + py * g.bh] : transformPoint(g.userToLocal, px, py);

        [start_x, start_y] = toLocal(c0x, c0y);
        [end_x, end_y] = toLocal(e0x, e0y);
        const [flx, fly] = toLocal(f0x, f0y);
        // Focal radius scales with the same objectBoundingBox width the center
        // radius uses (keeps fr proportional to r under OBB).
        const [felx] = toLocal(fe0x, f0y);
        const focalR = Math.hypot(felx - flx, 0);

        // Only emit a focal when it actually differs from the center (avoids
        // perturbing the common concentric case).
        const hasFocal =
            Math.abs(flx - start_x) > 1e-4 || Math.abs(fly - start_y) > 1e-4 || focalR > 1e-4;
        return {
            gradient_type: 'Radial',
            stops,
            start_x,
            start_y,
            end_x,
            end_y,
            spread,
            ...(hasFocal ? { focal: { x: flx, y: fly, r: focalR } } : {}),
        };
    }
}

/** Named CSS colors for stop-color parsing (hoisted to module scope to avoid re-allocation). */
const NAMED_STOP_COLORS: Record<string, [number, number, number]> = {
    black: [0, 0, 0],
    white: [1, 1, 1],
    red: [1, 0, 0],
    green: [0, 0.5, 0],
    blue: [0, 0, 1],
    yellow: [1, 1, 0],
    orange: [1, 0.65, 0],
    purple: [0.5, 0, 0.5],
    gray: [0.5, 0.5, 0.5],
    grey: [0.5, 0.5, 0.5],
};

/** Parse a stop-color string into an RGBA color object (0–1 range). */
function parseStopColor(
    colorStr: string,
    opacity: number,
): { r: number; g: number; b: number; a: number } {
    // Hex
    if (colorStr.startsWith('#')) {
        let hex = colorStr.slice(1);
        if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        return {
            r: parseInt(hex.slice(0, 2), 16) / 255,
            g: parseInt(hex.slice(2, 4), 16) / 255,
            b: parseInt(hex.slice(4, 6), 16) / 255,
            a: opacity,
        };
    }
    // rgb()
    const rgbMatch = colorStr.match(/rgb\s*\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)\s*\)/);
    if (rgbMatch) {
        return {
            r: parseInt(rgbMatch[1], 10) / 255,
            g: parseInt(rgbMatch[2], 10) / 255,
            b: parseInt(rgbMatch[3], 10) / 255,
            a: opacity,
        };
    }
    // Named colors
    const named = NAMED_STOP_COLORS[colorStr.toLowerCase()];
    if (named) return { r: named[0], g: named[1], b: named[2], a: opacity };
    // Fallback: black
    return { r: 0, g: 0, b: 0, a: opacity };
}

/**
 * Resolve a `fill="url(#id)"` reference to the first stop color of the
 * referenced gradient element. Returns a hex color string or null.
 * (Legacy compatibility — use resolveGradient() for full gradient data.)
 */
export function resolveGradientColor(svgDoc: Document, fillUrl: string): string | null {
    const grad = resolveGradient(svgDoc, fillUrl);
    if (!grad || grad.stops.length === 0) return null;
    const c = grad.stops[0].color;
    const toHex = (v: number) =>
        Math.round(v * 255)
            .toString(16)
            .padStart(2, '0');
    return `#${toHex(c.r)}${toHex(c.g)}${toHex(c.b)}`;
}
