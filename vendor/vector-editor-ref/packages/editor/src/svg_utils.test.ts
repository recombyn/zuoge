import { describe, expect, it } from 'vitest';
import {
    arcToCubicBeziers,
    composeMatrices,
    escapeXml,
    hexToRgb,
    identityMatrix,
    matrixToSVGTransform,
    parseCssColor,
    parseSVGPathD,
    parseSVGTransform,
    parseSvgLength,
    resolveGradient,
    resolveGradientColor,
    rgbToHex,
    tokenizeSVGNumbers,
    transformPoint,
    translateMatrix,
} from './svg_utils';

// ─── Color Conversion ───────────────────────────────────────────────────────

describe('hexToRgb', () => {
    it('converts black', () => {
        expect(hexToRgb('#000000')).toEqual({ r: 0, g: 0, b: 0, a: 1.0 });
    });

    it('converts white', () => {
        expect(hexToRgb('#ffffff')).toEqual({ r: 1, g: 1, b: 1, a: 1.0 });
    });

    it('converts Figma blue', () => {
        const c = hexToRgb('#0099ff');
        expect(c.r).toBeCloseTo(0, 1);
        expect(c.g).toBeCloseTo(0.6, 1);
        expect(c.b).toBeCloseTo(1.0, 1);
        expect(c.a).toBe(1.0);
    });
});

describe('rgbToHex', () => {
    it('converts black', () => {
        expect(rgbToHex({ r: 0, g: 0, b: 0 })).toBe('#000000');
    });

    it('converts white', () => {
        expect(rgbToHex({ r: 1, g: 1, b: 1 })).toBe('#ffffff');
    });

    it('round-trips correctly', () => {
        const hex = '#4285f4';
        const rgb = hexToRgb(hex);
        const result = rgbToHex(rgb);
        expect(result).toBe(hex);
    });
});

// ─── SVG Number Tokenizer ───────────────────────────────────────────────────

describe('tokenizeSVGNumbers', () => {
    it('parses simple positive numbers', () => {
        expect(tokenizeSVGNumbers('10 20 30')).toEqual([10, 20, 30]);
    });

    it('parses negative numbers', () => {
        expect(tokenizeSVGNumbers('-10-20-30')).toEqual([-10, -20, -30]);
    });

    it('parses decimals without leading digit', () => {
        expect(tokenizeSVGNumbers('.5.6.7')).toEqual([0.5, 0.6, 0.7]);
    });

    it('parses mixed positive, negative, decimal', () => {
        expect(tokenizeSVGNumbers('10.5-3.2 0.1')).toEqual([10.5, -3.2, 0.1]);
    });

    it('parses scientific notation', () => {
        expect(tokenizeSVGNumbers('1e2 -3.5e-1')).toEqual([100, -0.35]);
    });

    it('returns empty array for empty string', () => {
        expect(tokenizeSVGNumbers('')).toEqual([]);
    });
});

// ─── SVG Path Parsing ───────────────────────────────────────────────────────

describe('parseSVGPathD', () => {
    it('parses a simple triangle (M L L Z)', () => {
        const result = parseSVGPathD('M 0 0 L 100 0 L 50 100 Z', 0, 0);
        expect(result).toHaveLength(1);
        expect(result[0].closed).toBe(true);
        const pts = result[0].points;
        // 3 points: M(0,0) + L(100,0) + L(50,100). Z closes, no duplicate point.
        expect(pts).toHaveLength(3);
        expect(pts[0]).toEqual({ x: 0, y: 0, cp1: [0, 0], cp2: [0, 0] });
        expect(pts[1]).toEqual({ x: 100, y: 0, cp1: [100, 0], cp2: [100, 0] });
        expect(pts[2]).toEqual({ x: 50, y: 100, cp1: [50, 100], cp2: [50, 100] });
    });

    it('applies translation offset', () => {
        const result = parseSVGPathD('M 10 20', 5, 10);
        const pts = result[0].points;
        expect(pts[0].x).toBe(15);
        expect(pts[0].y).toBe(30);
    });

    it('handles relative moveto (m) and lineto (l)', () => {
        const result = parseSVGPathD('m 10 10 l 20 0 l 0 20', 0, 0);
        expect(result).toHaveLength(1);
        expect(result[0].closed).toBe(false);
        const pts = result[0].points;
        expect(pts).toHaveLength(3);
        expect(pts[0]).toEqual({ x: 10, y: 10, cp1: [10, 10], cp2: [10, 10] });
        expect(pts[1]).toEqual({ x: 30, y: 10, cp1: [30, 10], cp2: [30, 10] });
        expect(pts[2]).toEqual({ x: 30, y: 30, cp1: [30, 30], cp2: [30, 30] });
    });

    it('handles horizontal (H/h) and vertical (V/v) lines', () => {
        const result = parseSVGPathD('M 0 0 H 50 V 30', 0, 0);
        expect(result).toHaveLength(1);
        const pts = result[0].points;
        expect(pts).toHaveLength(3);
        expect(pts[1].x).toBe(50);
        expect(pts[1].y).toBe(0);
        expect(pts[2].x).toBe(50);
        expect(pts[2].y).toBe(30);
    });

    it('parses cubic bezier (C)', () => {
        const result = parseSVGPathD('M 0 0 C 10 20 30 40 50 60', 0, 0);
        expect(result).toHaveLength(1);
        const pts = result[0].points;
        expect(pts).toHaveLength(2);
        // First point's outgoing cp2 is set to C's first control point
        expect(pts[0].cp2).toEqual([10, 20]);
        // Second point
        expect(pts[1].x).toBe(50);
        expect(pts[1].y).toBe(60);
        // Second point's incoming cp1 is C's second control point
        expect(pts[1].cp1).toEqual([30, 40]);
    });

    it('parses quadratic bezier (Q) as cubic', () => {
        const result = parseSVGPathD('M 0 0 Q 50 50 100 0', 0, 0);
        expect(result).toHaveLength(1);
        const pts = result[0].points;
        expect(pts).toHaveLength(2);
        // Q(50,50) → cubic control points via 2/3 rule
        // CP1 = start + 2/3*(Q-start) = 0 + 2/3*50 = 33.33
        expect(pts[0].cp2[0]).toBeCloseTo(33.33, 1);
        expect(pts[0].cp2[1]).toBeCloseTo(33.33, 1);
    });

    it('does not add duplicate closing point for Z when already at start', () => {
        // A shape where the path returns to origin before Z
        const result = parseSVGPathD('M 0 0 L 10 0 L 10 10 L 0 0 Z', 0, 0);
        expect(result).toHaveLength(1);
        expect(result[0].closed).toBe(true);
        // M + L + L + L = 4 points, Z does not add any
        expect(result[0].points).toHaveLength(4);
    });

    it('handles empty path', () => {
        expect(parseSVGPathD('', 0, 0)).toEqual([]);
    });

    it('handles implicit lineTo after M', () => {
        // After M, subsequent coordinate pairs are implicit L
        const result = parseSVGPathD('M 0 0 10 10 20 20', 0, 0);
        expect(result).toHaveLength(1);
        const pts = result[0].points;
        expect(pts).toHaveLength(3);
        expect(pts[2].x).toBe(20);
        expect(pts[2].y).toBe(20);
    });

    // ─── New subpath tests ──────────────────────────────────────────────────

    it('two-subpath Z-closed paths', () => {
        const result = parseSVGPathD('M0 0 L10 0 L10 10 Z M20 20 L30 20 L30 30 Z', 0, 0);
        expect(result).toHaveLength(2);

        // First subpath
        expect(result[0].closed).toBe(true);
        expect(result[0].points).toHaveLength(3);
        expect(result[0].points[0]).toEqual({ x: 0, y: 0, cp1: [0, 0], cp2: [0, 0] });
        expect(result[0].points[1]).toEqual({ x: 10, y: 0, cp1: [10, 0], cp2: [10, 0] });
        expect(result[0].points[2]).toEqual({ x: 10, y: 10, cp1: [10, 10], cp2: [10, 10] });

        // Second subpath
        expect(result[1].closed).toBe(true);
        expect(result[1].points).toHaveLength(3);
        expect(result[1].points[0]).toEqual({ x: 20, y: 20, cp1: [20, 20], cp2: [20, 20] });
        expect(result[1].points[1]).toEqual({ x: 30, y: 20, cp1: [30, 20], cp2: [30, 20] });
        expect(result[1].points[2]).toEqual({ x: 30, y: 30, cp1: [30, 30], cp2: [30, 30] });
    });

    it('open path (no Z) has closed: false', () => {
        const result = parseSVGPathD('M 0 0 L 100 0 L 50 100', 0, 0);
        expect(result).toHaveLength(1);
        expect(result[0].closed).toBe(false);
        expect(result[0].points).toHaveLength(3);
    });

    it('multi-M without Z produces separate open subpaths', () => {
        const result = parseSVGPathD('M0 0 L10 10 M20 20 L30 30', 0, 0);
        expect(result).toHaveLength(2);
        expect(result[0].closed).toBe(false);
        expect(result[0].points).toHaveLength(2);
        expect(result[1].closed).toBe(false);
        expect(result[1].points).toHaveLength(2);
    });
});

// ─── Arc to Cubic Bezier ────────────────────────────────────────────────────

describe('arcToCubicBeziers', () => {
    it('returns line segment for degenerate arc (rx=0)', () => {
        const segs = arcToCubicBeziers(0, 0, 0, 50, 0, false, true, 100, 0);
        expect(segs).toHaveLength(1);
        expect(segs[0].ex).toBe(100);
        expect(segs[0].ey).toBe(0);
    });

    it('returns line segment for degenerate arc (ry=0)', () => {
        const segs = arcToCubicBeziers(0, 0, 50, 0, 0, false, true, 100, 0);
        expect(segs).toHaveLength(1);
    });

    it('creates semicircle segments for 180° arc', () => {
        // Semicircle from (0,0) to (100,0) with radius 50
        const segs = arcToCubicBeziers(0, 0, 50, 50, 0, false, true, 100, 0);
        // Should produce 2 segments (180° / 90° max per segment)
        expect(segs.length).toBeGreaterThanOrEqual(2);
        // Last segment should end at target point
        const last = segs[segs.length - 1];
        expect(last.ex).toBeCloseTo(100, 1);
        expect(last.ey).toBeCloseTo(0, 1);
    });

    it('creates correct number of segments for full circle', () => {
        // Full circle: large arc flag = true, sweep = true
        const segs = arcToCubicBeziers(50, 0, 50, 50, 0, true, true, 50, 0.001);
        // Full circle ≈ 360° → 4 segments
        expect(segs.length).toBe(4);
    });
});

// ─── Matrix & Transform Utilities ────────────────────────────────────────────

describe('composeMatrices / transformPoint', () => {
    it('identity composed with identity is identity', () => {
        expect(composeMatrices(identityMatrix(), identityMatrix())).toEqual(identityMatrix());
    });

    it('translation then scale applies in correct order', () => {
        // M = translate(10, 20) * scale(2) — scale applied first, then translate
        const t = parseSVGTransform('translate(10, 20)');
        const s = parseSVGTransform('scale(2)');
        const m = composeMatrices(t, s);
        expect(transformPoint(m, 5, 5)).toEqual([20, 30]); // (5*2)+10, (5*2)+20
    });
});

describe('parseSVGTransform', () => {
    it('parses translate', () => {
        const m = parseSVGTransform('translate(15, 25)');
        expect(transformPoint(m, 0, 0)).toEqual([15, 25]);
    });

    it('translate with single argument means ty = 0', () => {
        const m = parseSVGTransform('translate(15)');
        expect(transformPoint(m, 0, 0)).toEqual([15, 0]);
    });

    it('parses scale (uniform and non-uniform)', () => {
        expect(transformPoint(parseSVGTransform('scale(2)'), 3, 4)).toEqual([6, 8]);
        expect(transformPoint(parseSVGTransform('scale(2, 3)'), 3, 4)).toEqual([6, 12]);
    });

    it('parses rotate about origin', () => {
        const m = parseSVGTransform('rotate(90)');
        const [x, y] = transformPoint(m, 10, 0);
        expect(x).toBeCloseTo(0, 5);
        expect(y).toBeCloseTo(10, 5);
    });

    it('parses rotate about a point', () => {
        // rotate(45 50 50): the pivot itself must not move
        const m = parseSVGTransform('rotate(45 50 50)');
        const [px, py] = transformPoint(m, 50, 50);
        expect(px).toBeCloseTo(50, 4);
        expect(py).toBeCloseTo(50, 4);
        // A point directly right of the pivot rotates 45° down-right (SVG y-down)
        const [qx, qy] = transformPoint(m, 60, 50);
        expect(qx).toBeCloseTo(50 + 10 * Math.SQRT1_2, 4);
        expect(qy).toBeCloseTo(50 + 10 * Math.SQRT1_2, 4);
    });

    it('parses matrix()', () => {
        const m = parseSVGTransform('matrix(1, 0, 0, 1, 30, 40)');
        expect(transformPoint(m, 1, 2)).toEqual([31, 42]);
    });

    it('composes multiple transforms left-to-right', () => {
        // translate then rotate: rotate applies first to the point
        const m = parseSVGTransform('translate(100, 0) rotate(90)');
        const [x, y] = transformPoint(m, 10, 0);
        expect(x).toBeCloseTo(100, 4);
        expect(y).toBeCloseTo(10, 4);
    });

    it('returns identity for empty/garbage input', () => {
        expect(parseSVGTransform('')).toEqual(identityMatrix());
        expect(parseSVGTransform('nonsense')).toEqual(identityMatrix());
    });
});

describe('matrixToSVGTransform', () => {
    it('maps column-major to SVG matrix(a,b,c,d,e,f)', () => {
        // column-major: [a, b, 0, c, d, 0, tx, ty, 1]
        const m = [1, 2, 0, 3, 4, 0, 5, 6, 1];
        expect(matrixToSVGTransform(m)).toBe('matrix(1,2,3,4,5,6)');
    });

    it('round-trips through parseSVGTransform', () => {
        const original = parseSVGTransform('translate(12, 34) rotate(30) scale(1.5)');
        const reparsed = parseSVGTransform(matrixToSVGTransform(original));
        for (const [x, y] of [
            [0, 0],
            [10, 0],
            [0, 10],
            [7, -3],
        ] as const) {
            const a = transformPoint(original, x, y);
            const b = transformPoint(reparsed, x, y);
            expect(b[0]).toBeCloseTo(a[0], 4);
            expect(b[1]).toBeCloseTo(a[1], 4);
        }
    });
});

// ─── XML Escaping ────────────────────────────────────────────────────────────

describe('escapeXml', () => {
    it('escapes all five special characters', () => {
        expect(escapeXml(`<a href="x">&'y'</a>`)).toBe(
            '&lt;a href=&quot;x&quot;&gt;&amp;&apos;y&apos;&lt;/a&gt;',
        );
    });

    it('leaves plain text unchanged', () => {
        expect(escapeXml('Hello World 123')).toBe('Hello World 123');
    });
});

// ─── Gradient Resolution ─────────────────────────────────────────────────────

/** Minimal stub implementing the Document surface resolveGradient uses. */
function stubGradientDoc(tagName: string, stopColor: string | null, stopStyle?: string): Document {
    const stop =
        stopColor !== null || stopStyle
            ? {
                  getAttribute: (name: string) => {
                      if (name === 'stop-color') return stopColor;
                      if (name === 'style') return stopStyle ?? null;
                      return null;
                  },
              }
            : null;
    const stops = stop ? [stop] : [];
    const gradientEl = {
        tagName,
        getAttribute: () => null,
        querySelector: (sel: string) => (sel === 'stop' ? stop : null),
        querySelectorAll: (sel: string) => (sel === 'stop' ? stops : []),
    };
    return {
        getElementById: (id: string) => (id === 'grad1' ? gradientEl : null),
    } as unknown as Document;
}

describe('resolveGradientColor', () => {
    it('resolves first stop-color of a linear gradient', () => {
        const doc = stubGradientDoc('linearGradient', '#ff8800');
        expect(resolveGradientColor(doc, 'url(#grad1)')).toBe('#ff8800');
    });

    it('reads stop-color from inline style', () => {
        const doc = stubGradientDoc('radialGradient', null, 'stop-color: #00ff00; stop-opacity: 1');
        expect(resolveGradientColor(doc, 'url(#grad1)')).toBe('#00ff00');
    });

    it('converts rgb() stop colors to hex', () => {
        const doc = stubGradientDoc('linearGradient', 'rgb(255, 0, 128)');
        expect(resolveGradientColor(doc, 'url(#grad1)')).toBe('#ff0080');
    });

    it('returns null for unknown ids and non-gradient refs', () => {
        const doc = stubGradientDoc('linearGradient', '#ffffff');
        expect(resolveGradientColor(doc, 'url(#missing)')).toBeNull();
        expect(resolveGradientColor(doc, 'not-a-url')).toBeNull();
    });
});

describe('parseCssColor', () => {
    it('parses 6-digit and 3-digit hex', () => {
        expect(parseCssColor('#ff8800')).toEqual({ hex: '#ff8800', alpha: 1 });
        expect(parseCssColor('#f80')).toEqual({ hex: '#ff8800', alpha: 1 });
    });

    it('parses 8-digit and 4-digit hex with alpha', () => {
        expect(parseCssColor('#ff880080')?.hex).toBe('#ff8800');
        expect(parseCssColor('#ff880080')?.alpha).toBeCloseTo(0.5, 1);
        expect(parseCssColor('#f808')?.hex).toBe('#ff8800');
    });

    it('parses rgb() and rgba() — the Figma export formats', () => {
        expect(parseCssColor('rgb(255, 136, 0)')).toEqual({ hex: '#ff8800', alpha: 1 });
        expect(parseCssColor('rgba(255, 136, 0, 0.5)')).toEqual({ hex: '#ff8800', alpha: 0.5 });
        expect(parseCssColor('rgb(100% 50% 0%)')?.hex).toBe('#ff8000');
    });

    it('parses hsl() and hsla()', () => {
        expect(parseCssColor('hsl(0, 100%, 50%)')?.hex).toBe('#ff0000');
        expect(parseCssColor('hsl(120, 100%, 25%)')?.hex).toBe('#008000');
        expect(parseCssColor('hsla(240, 100%, 50%, 0.3)')).toEqual({ hex: '#0000ff', alpha: 0.3 });
    });

    it('parses named colors', () => {
        expect(parseCssColor('tomato')?.hex).toBe('#ff6347');
        expect(parseCssColor('RebeccaPurple')?.hex).toBe('#663399');
    });

    it('returns null for unparseable values instead of garbage', () => {
        expect(parseCssColor('var(--brand)')).toBeNull();
        expect(parseCssColor('url(#grad)')).toBeNull();
        expect(parseCssColor('#zzz')).toBeNull();
    });
});

// ─── Gradient Resolution ──────────────────────────────────────────────────────

describe('resolveGradient', () => {
    const parse = (svg: string): Document => new DOMParser().parseFromString(svg, 'image/svg+xml');

    it('resolves a userSpaceOnUse linear gradient coords verbatim', () => {
        const doc = parse(`<svg xmlns="http://www.w3.org/2000/svg"><defs>
            <linearGradient id="g" gradientUnits="userSpaceOnUse" x1="10" y1="20" x2="110" y2="20">
              <stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/>
            </linearGradient></defs></svg>`);
        const g = resolveGradient(doc, 'url(#g)')!;
        expect(g.gradient_type).toBe('Linear');
        expect(g.start_x).toBeCloseTo(10);
        expect(g.end_x).toBeCloseTo(110);
        expect(g.stops.length).toBe(2);
    });

    it('applies gradientTransform (90° rotation) to a userSpaceOnUse linear gradient', () => {
        // A horizontal gradient (0,0)->(100,0) rotated 90° about the origin
        // becomes vertical (0,0)->(0,100).
        const doc = parse(`<svg xmlns="http://www.w3.org/2000/svg"><defs>
            <linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0"
                gradientTransform="rotate(90)">
              <stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/>
            </linearGradient></defs></svg>`);
        const g = resolveGradient(doc, 'url(#g)')!;
        expect(g.start_x).toBeCloseTo(0);
        expect(g.start_y).toBeCloseTo(0);
        expect(g.end_x).toBeCloseTo(0);
        expect(g.end_y).toBeCloseTo(100);
    });

    it('applies gradientTransform translate to a radial gradient center', () => {
        const doc = parse(`<svg xmlns="http://www.w3.org/2000/svg"><defs>
            <radialGradient id="g" gradientUnits="userSpaceOnUse" cx="50" cy="50" r="25"
                gradientTransform="translate(10, 20)">
              <stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/>
            </radialGradient></defs></svg>`);
        const g = resolveGradient(doc, 'url(#g)')!;
        expect(g.gradient_type).toBe('Radial');
        expect(g.start_x).toBeCloseTo(60); // 50 + 10
        expect(g.start_y).toBeCloseTo(70); // 50 + 20
        // radius edge stays r=25 away on +x (translate doesn't scale)
        expect(Math.hypot(g.end_x - g.start_x, g.end_y - g.start_y)).toBeCloseTo(25);
    });

    it('inherits coords and stops through xlink:href template chain', () => {
        const doc =
            parse(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs>
            <linearGradient id="base" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="80" y2="0">
              <stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/>
            </linearGradient>
            <linearGradient id="g" xlink:href="#base"/>
            </defs></svg>`);
        const g = resolveGradient(doc, 'url(#g)')!;
        expect(g.stops.length).toBe(2);
        expect(g.end_x).toBeCloseTo(80); // inherited x2
    });

    it('parses spreadMethod repeat/reflect into the engine spread code', () => {
        const mk = (m: string) =>
            parse(`<svg xmlns="http://www.w3.org/2000/svg"><defs>
            <linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="50" y2="0" spreadMethod="${m}">
              <stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/>
            </linearGradient></defs></svg>`);
        expect(resolveGradient(mk('pad'), 'url(#g)')!.spread).toBe(0);
        expect(resolveGradient(mk('repeat'), 'url(#g)')!.spread).toBe(1);
        expect(resolveGradient(mk('reflect'), 'url(#g)')!.spread).toBe(2);
    });

    it('parses a radial focal point (fx/fy) offset from the center', () => {
        const doc = parse(`<svg xmlns="http://www.w3.org/2000/svg"><defs>
            <radialGradient id="g" gradientUnits="userSpaceOnUse" cx="50" cy="50" r="40" fx="30" fy="20">
              <stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/>
            </radialGradient></defs></svg>`);
        const g = resolveGradient(doc, 'url(#g)')!;
        expect(g.gradient_type).toBe('Radial');
        expect(g.start_x).toBeCloseTo(50); // center
        expect(g.focal).toBeTruthy();
        expect(g.focal!.x).toBeCloseTo(30);
        expect(g.focal!.y).toBeCloseTo(20);
    });

    it('omits the focal when it coincides with the center (concentric)', () => {
        const doc = parse(`<svg xmlns="http://www.w3.org/2000/svg"><defs>
            <radialGradient id="g" gradientUnits="userSpaceOnUse" cx="50" cy="50" r="40">
              <stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/>
            </radialGradient></defs></svg>`);
        const g = resolveGradient(doc, 'url(#g)')!;
        expect(g.focal).toBeUndefined();
        expect(g.spread).toBe(0);
    });

    it('maps a default objectBoundingBox linear gradient onto the geometry bbox', () => {
        // No coords → default OBB x1=0,y1=0,x2=1,y2=0. On a 160×160 box at the
        // origin the endpoints must span the full width, not a hardcoded 100.
        const doc = parse(`<svg xmlns="http://www.w3.org/2000/svg"><defs>
            <linearGradient id="g">
              <stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/>
            </linearGradient></defs></svg>`);
        const g = resolveGradient(doc, 'url(#g)', {
            bx: 0,
            by: 0,
            bw: 160,
            bh: 160,
            userToLocal: identityMatrix(),
        })!;
        expect(g.start_x).toBeCloseTo(0);
        expect(g.end_x).toBeCloseTo(160);
        expect(g.end_y).toBeCloseTo(0);
    });

    it('offsets an objectBoundingBox gradient by the bbox origin (centered ellipse)', () => {
        // An ellipse's geometry is centered at the origin: bbox top-left is
        // (-rx,-ry). OBB fraction 0 must map there, not to (0,0).
        const doc = parse(`<svg xmlns="http://www.w3.org/2000/svg"><defs>
            <linearGradient id="g">
              <stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/>
            </linearGradient></defs></svg>`);
        const g = resolveGradient(doc, 'url(#g)', {
            bx: -40,
            by: -40,
            bw: 80,
            bh: 80,
            userToLocal: identityMatrix(),
        })!;
        expect(g.start_x).toBeCloseTo(-40);
        expect(g.end_x).toBeCloseTo(40);
    });

    it('maps a userSpaceOnUse gradient through userToLocal (element offset)', () => {
        // A rect at x=20 keeps geometry at the origin with x baked into the
        // transform, so a USOU coord of 20 must become 0 in local space.
        const doc = parse(`<svg xmlns="http://www.w3.org/2000/svg"><defs>
            <linearGradient id="g" gradientUnits="userSpaceOnUse" x1="20" y1="20" x2="180" y2="20">
              <stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/>
            </linearGradient></defs></svg>`);
        const g = resolveGradient(doc, 'url(#g)', {
            bx: 0,
            by: 0,
            bw: 160,
            bh: 160,
            userToLocal: translateMatrix(-20, -20),
        })!;
        expect(g.start_x).toBeCloseTo(0);
        expect(g.start_y).toBeCloseTo(0);
        expect(g.end_x).toBeCloseTo(160);
    });
});

// ─── Length / unit parsing ────────────────────────────────────────────────────

describe('parseSvgLength', () => {
    it('passes through unitless and px values', () => {
        expect(parseSvgLength('42', 0)).toBe(42);
        expect(parseSvgLength('42px', 0)).toBe(42);
        expect(parseSvgLength('3.5', 0)).toBe(3.5);
        expect(parseSvgLength('-1.5px', 0)).toBe(-1.5);
    });

    it('converts absolute units to user px (96/in)', () => {
        expect(parseSvgLength('12pt', 0)).toBeCloseTo(16); // 12 * 96/72
        expect(parseSvgLength('1in', 0)).toBe(96);
        expect(parseSvgLength('1pc', 0)).toBe(16); // 1pc = 12pt = 16px
        expect(parseSvgLength('2.54cm', 0)).toBeCloseTo(96);
        expect(parseSvgLength('25.4mm', 0)).toBeCloseTo(96);
        expect(parseSvgLength('40Q', 0)).toBeCloseTo((96 * 40) / 101.6);
    });

    it('resolves em/ex/rem against the context font-size', () => {
        expect(parseSvgLength('2em', 0, { fontSize: 10 })).toBe(20);
        expect(parseSvgLength('2ex', 0, { fontSize: 20 })).toBe(20); // 2 * 20 * 0.5
        expect(parseSvgLength('1.5rem', 0, { fontSize: 12, rootFontSize: 16 })).toBe(24);
        expect(parseSvgLength('1em', 0)).toBe(16); // default fontSize 16
    });

    it('resolves % against percentBasis, else returns the raw number', () => {
        expect(parseSvgLength('50%', 0, { percentBasis: 200 })).toBe(100);
        expect(parseSvgLength('50%', 0)).toBe(50); // non-regressive: no basis
    });

    it('is tolerant of whitespace and unknown units', () => {
        expect(parseSvgLength('  10pt  ', 0)).toBeCloseTo((10 * 96) / 72);
        expect(parseSvgLength('7wtf', 0)).toBe(7); // unknown unit → user units
    });

    it('returns the fallback for empty / invalid input', () => {
        expect(parseSvgLength(null, 5)).toBe(5);
        expect(parseSvgLength('', 5)).toBe(5);
        expect(parseSvgLength('auto', 5)).toBe(5);
        expect(parseSvgLength('none', 5)).toBe(5);
    });
});
