import { describe, expect, it, beforeEach } from 'vitest';
import type { SceneNodeInput } from '@/components/rcb/sceneNode';
import { shapeGeomFingerprint } from '@/components/rcb/render/vector/geomFingerprint';
import { tessellateFill } from '@/components/rcb/render/vector/tessellateFill';
import { tessellateStroke } from '@/components/rcb/render/vector/tessellateStroke';
import {
  clearShapeMeshCache,
  getOrBuildShapeMesh,
  getShapeMeshCacheSize,
} from '@/components/rcb/render/vector/meshCache';
import {
  contourFromNode,
  sampleEllipseRing,
  densifyPathDJs,
} from '@/components/rcb/render/vector/contour';
import { roundedRectPath, setLiveCornerRadiusPreview } from '@/components/rcb/scene/document/sceneRadii';
import { shapeInkForbidsAtlas } from '@/components/rcb/render/vector/inkBackend';

describe('vector ink', () => {
  beforeEach(() => {
    clearShapeMeshCache();
    setLiveCornerRadiusPreview(null);
  });

  it('shapeGeomFingerprint is stable for same geom and ignores zoom', () => {
    const node = {
      id: 'a',
      key: 'shape',
      width: 80,
      height: 60,
      attrs: { shapeType: 'rect', cornerRadius: 8, 'border-width': 2 },
    } as SceneNodeInput;
    const a = shapeGeomFingerprint(node);
    const b = shapeGeomFingerprint(node, { width: 80, height: 60 });
    expect(a).toBe(b);
    expect(a).toContain('rect');
    expect(a).toContain('80.00');
  });

  it('tessellateFill emits triangles for a unit square', () => {
    const mesh = tessellateFill([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
    expect(mesh).not.toBeNull();
    expect(mesh!.triangleCount).toBeGreaterThanOrEqual(2);
    expect(mesh!.positions.length).toBe(mesh!.triangleCount * 6);
  });

  it('tessellateStroke emits ribbon triangles', () => {
    const mesh = tessellateStroke(
      [
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 40, y: 20 },
      ],
      { width: 4, closed: false }
    );
    expect(mesh).not.toBeNull();
    expect(mesh!.triangleCount).toBeGreaterThanOrEqual(2);
    expect(mesh!.positions.length % 6).toBe(0);
  });

  it('tessellateStroke keeps width at sharp concave corners (no miter collapse)', () => {
    // V shape: sharp valley like a star indent — miter join (2 quads)
    const mesh = tessellateStroke(
      [
        { x: 0, y: 0 },
        { x: 20, y: 40 },
        { x: 40, y: 0 },
      ],
      { width: 8, closed: false, linejoin: 'miter', miterLimit: 100 }
    );
    expect(mesh).not.toBeNull();
    expect(mesh!.triangleCount).toBeGreaterThanOrEqual(4);
    // Shared miter tip should exist (not collapsed to centerline)
    const pos = mesh!.positions;
    let hasTip = false;
    for (let i = 0; i < pos.length; i += 2) {
      if (Math.abs(pos[i]! - 20) < 6 && pos[i + 1]! > 40) hasTip = true;
    }
    expect(hasTip).toBe(true);
  });

  it('tessellateStroke dual-side bevel covers convex outer corners', () => {
    const mesh = tessellateStroke(
      [
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 40, y: 40 },
        { x: 0, y: 40 },
      ],
      { width: 8, closed: true, linejoin: 'miter', miterLimit: 100 }
    );
    expect(mesh).not.toBeNull();
    const pos = mesh!.positions;
    // 90° miter outer tip ≈ (40+4√2? → (44, -4) for half=4
    let hasOuterTip = false;
    for (let i = 0; i < pos.length; i += 2) {
      if (pos[i]! > 43 && pos[i + 1]! < -3) hasOuterTip = true;
    }
    expect(hasOuterTip).toBe(true);
  });

  it('tessellateStroke bevel join stays flat when linejoin=bevel', () => {
    const mesh = tessellateStroke(
      [
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 40, y: 40 },
      ],
      { width: 8, closed: false, linejoin: 'bevel' }
    );
    expect(mesh).not.toBeNull();
    const pos = mesh!.positions;
    let hasOuterTip = false;
    for (let i = 0; i < pos.length; i += 2) {
      if (pos[i]! > 43 && pos[i + 1]! < -3) hasOuterTip = true;
    }
    expect(hasOuterTip).toBe(false);
  });

  it('full circle contour samples a dense ring (not coarse Bézier chords)', () => {
    const ring = sampleEllipseRing(100, 100, 0.4);
    expect(ring.length).toBeGreaterThanOrEqual(64);
    const node = {
      id: 'c1',
      key: 'shape',
      width: 100,
      height: 100,
      attrs: { shapeType: 'ellipse', 'fill-color': '#fff', 'border-width': 4 },
    } as SceneNodeInput;
    const c = contourFromNode(node, { width: 100, height: 100 });
    expect(c).not.toBeNull();
    expect(c!.points.length).toBeGreaterThanOrEqual(64);
  });

  it('rounded rect contour densifies corner arcs (not chamfer chords)', () => {
    const d = roundedRectPath(200, 160, { tl: 40, tr: 40, br: 40, bl: 40 });
    const jsPts = densifyPathDJs(d, 0.4);
    // 4 arcs × ≥8 samples + straight edges — not 4 chord endpoints only
    expect(jsPts.length).toBeGreaterThanOrEqual(36);
    const nearArcMid = jsPts.some((p) => p.x > 185 && p.y > 5 && p.y < 35 && p.x < 200);
    expect(nearArcMid).toBe(true);

    const node = {
      id: 'rr1',
      key: 'shape',
      width: 200,
      height: 160,
      attrs: { shapeType: 'rect', cornerRadius: 40, 'fill-color': '#fff', 'border-width': 4 },
    } as SceneNodeInput;
    const c = contourFromNode(node, { width: 200, height: 160 });
    expect(c).not.toBeNull();
    expect(c!.points.length).toBeGreaterThanOrEqual(36);
  });

  it('tessellateStroke round join fans outer corner (not miter tip)', () => {
    const mesh = tessellateStroke(
      [
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 40, y: 40 },
      ],
      { width: 8, closed: false, linejoin: 'round' }
    );
    expect(mesh).not.toBeNull();
    // Round join adds fan tris beyond the two segment quads
    expect(mesh!.triangleCount).toBeGreaterThan(4);
    const pos = mesh!.positions;
    let hasMiterTip = false;
    for (let i = 0; i < pos.length; i += 2) {
      if (pos[i]! > 43 && pos[i + 1]! < -3) hasMiterTip = true;
    }
    expect(hasMiterTip).toBe(false);
  });

  it('mesh cache rebuilds when live corner-radius preview changes', () => {
    const node = {
      id: 'live-r',
      key: 'shape',
      width: 200,
      height: 120,
      attrs: {
        shapeType: 'rect',
        cornerRadius: 0,
        'fill-color': '#fff',
        'border-width': 2,
        'stroke-enabled': true,
      },
    } as SceneNodeInput;
    const sharp = getOrBuildShapeMesh('live-r', node, { width: 200, height: 120 });
    expect(sharp).not.toBeNull();
    const sharpFill = sharp!.fill?.triangleCount ?? 0;

    setLiveCornerRadiusPreview({
      nodeId: 'live-r',
      display: 40,
      radii: { tl: 40, tr: 40, br: 40, bl: 40 },
    });
    const rounded = getOrBuildShapeMesh('live-r', node, { width: 200, height: 120 });
    setLiveCornerRadiusPreview(null);

    expect(rounded).not.toBeNull();
    expect(rounded).not.toBe(sharp);
    expect(rounded!.geomFp).not.toBe(sharp!.geomFp);
    // Rounded ring needs more fill triangles than a 2-tri sharp rect.
    expect((rounded!.fill?.triangleCount ?? 0)).toBeGreaterThan(sharpFill);
  });
  it('mesh cache hits on identical geom fingerprint', () => {
    const node = {
      id: 'r1',
      key: 'shape',
      width: 50,
      height: 40,
      attrs: { shapeType: 'rect', 'fill-color': '#fff', 'stroke-enabled': false },
    } as SceneNodeInput;
    const a = getOrBuildShapeMesh('r1', node, { width: 50, height: 40 });
    const b = getOrBuildShapeMesh('r1', node, { width: 50, height: 40 });
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(getShapeMeshCacheSize()).toBe(1);
  });

  it('shapeInkForbidsAtlas for shapes; not for text or media', () => {
    expect(
      shapeInkForbidsAtlas({ key: 'shape', attrs: { shapeType: 'rect' } })
    ).toBe(true);
    expect(
      shapeInkForbidsAtlas({ key: 'shape', attrs: { shapeType: 'arrow' } })
    ).toBe(true);
    // Text idle is MSDF glyphs — forbids media atlas bake.
    expect(shapeInkForbidsAtlas({ key: 'text', attrs: {} })).toBe(true);
    expect(shapeInkForbidsAtlas({ key: 'image', attrs: {} })).toBe(false);
    expect(shapeInkForbidsAtlas({ key: 'video', attrs: {} })).toBe(false);
  });

  it('stroke-only closed rect builds stroke mesh without fill', () => {
    const node = {
      id: 'so',
      key: 'shape',
      width: 40,
      height: 30,
      attrs: {
        shapeType: 'rect',
        'fill-color': 'transparent',
        'stroke-enabled': true,
        'border-width': 2,
        stroke: '#111',
      },
    } as SceneNodeInput;
    const mesh = getOrBuildShapeMesh('so', node, { width: 40, height: 30 });
    expect(mesh).not.toBeNull();
    expect(mesh!.fill).toBeNull();
    expect(mesh!.stroke).not.toBeNull();
  });

  it('arrow densify keeps NaN break between shaft and V (no zigzag bridge)', () => {
    const node = {
      id: 'ar',
      key: 'shape',
      width: 100,
      height: 24,
      attrs: {
        shapeType: 'arrow',
        stroke: '#111',
        'border-width': 4,
        'stroke-enabled': true,
        'fill-enabled': false,
      },
    } as SceneNodeInput;
    const c = contourFromNode(node, { width: 100, height: 24 });
    expect(c).not.toBeNull();
    expect(c!.closed).toBe(false);
    const breaks = c!.points.filter((p) => !Number.isFinite(p.x));
    expect(breaks.length).toBeGreaterThanOrEqual(1);

    const mesh = getOrBuildShapeMesh('ar', node, { width: 100, height: 24 });
    expect(mesh?.stroke).not.toBeNull();
    // Open chevron: stroke shaft + V only (matches live Canvas / SVG).
    expect(mesh?.fill).toBeNull();
    // Bridged shaft→wing would place verts far off the centerline mid=12.
    const pos = mesh!.stroke!.positions;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 1; i < pos.length; i += 2) {
      const y = pos[i]!;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    // Shaft is centerline ribbon around mid=12; half-width 2 → roughly [8, 16] + pad.
    expect(minY).toBeGreaterThan(0);
    expect(maxY).toBeLessThan(28);
    expect(maxY - minY).toBeLessThan(24);
  });

  it('densifyPathDJs inserts NaN between subpaths', () => {
    const pts = densifyPathDJs('M 0 0 L 10 0 M 20 5 L 30 5');
    expect(pts.some((p) => !Number.isFinite(p.x))).toBe(true);
  });

  it('pencil mesh prefers freehand silhouette fill (tapered tips)', () => {
    const node = {
      id: 'pen1',
      key: 'shape',
      width: 100,
      height: 40,
      attrs: {
        shapeType: 'pencil',
        path: 'M 10 20 L 40 20 L 70 25 L 90 18',
        brushStyle: 'vector-ink',
        'border-width': 8,
        'border-color': '#111',
        'fill-enabled': false,
        strokeLinecap: 'round',
      },
    } as SceneNodeInput;
    const mesh = getOrBuildShapeMesh('pen1', node, { width: 100, height: 40 });
    expect(mesh).not.toBeNull();
    // Short strokes keep silhouette fill (tapered tips match live preview).
    expect(mesh!.fill?.triangleCount ?? 0).toBeGreaterThan(4);
    const c = contourFromNode(node, { width: 100, height: 40 });
    expect(c?.pencilSilhouette).toBe(true);
    expect(c!.points.length).toBeGreaterThan(8);
  });

  it('thin pencil (1px) still emits silhouette fill or round ribbon — not empty', () => {
    const node = {
      id: 'pen-thin',
      key: 'shape',
      width: 120,
      height: 80,
      attrs: {
        shapeType: 'pencil',
        path: 'M 8 40 L 24 36 L 40 42 L 56 30 L 72 44 L 88 28 L 104 40',
        brushStyle: 'vector-ink',
        'border-width': 1,
        'border-color': '#111',
        'fill-enabled': false,
        strokeLinecap: 'round',
      },
    } as SceneNodeInput;
    const mesh = getOrBuildShapeMesh('pen-thin', node, { width: 120, height: 80, zoom: 5, dpr: 1 });
    expect(mesh).not.toBeNull();
    const hasFill = Boolean(mesh!.fill && mesh!.fill.triangleCount > 0);
    const hasStroke = Boolean(mesh!.stroke && mesh!.stroke.triangleCount > 0);
    expect(hasFill || hasStroke).toBe(true);
  });

  it('dense scribble pencil remesh stays interactive (no ribbon fallback)', () => {
    const center: string[] = [];
    for (let i = 0; i <= 200; i += 1) {
      center.push(
        `${i === 0 ? 'M' : 'L'} ${50 + Math.sin(i * 0.2) * 20} ${40 + Math.cos(i * 0.17) * 20}`
      );
    }
    const outline: string[] = [];
    for (let i = 0; i <= 600; i += 1) {
      const t = (i / 600) * Math.PI * 2;
      outline.push(
        `${i === 0 ? 'M' : 'L'} ${60 + Math.cos(t) * 40 + Math.sin(t * 7) * 8} ${40 + Math.sin(t) * 30}`
      );
    }
    outline.push('Z');
    const node = {
      id: 'pen-scribble',
      key: 'shape',
      width: 140,
      height: 100,
      attrs: {
        shapeType: 'pencil',
        path: center.join(' '),
        pencilOutlinePath: outline.join(' '),
        brushStyle: 'vector-ink',
        'border-width': 2,
        'border-color': '#111',
      },
    } as SceneNodeInput;
    const t0 = performance.now();
    const mesh = getOrBuildShapeMesh('pen-scribble', node, { width: 140, height: 100 });
    const ms = performance.now() - t0;
    expect(mesh).not.toBeNull();
    // Pencil never uses constant-width ribbon (blunt tips); WebGL bakes Path2D.
    expect(mesh!.stroke).toBeNull();
    expect(ms).toBeLessThan(250);
  });
});
