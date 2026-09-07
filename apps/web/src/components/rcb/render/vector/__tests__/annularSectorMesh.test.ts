import { describe, it, expect, beforeEach } from 'vitest';
import type { SceneNodeInput } from '@/components/rcb/sceneNode';
import { getOrBuildShapeMesh, clearShapeMeshCache } from '@/components/rcb/render/vector/meshCache';
import { PathBuilder } from '@/components/rcb/core/geometry/PathBuilder';
import { densifyPathD } from '@/components/rcb/render/vector/contour';

function covers(pos: Float32Array, hx: number, hy: number): boolean {
  for (let i = 0; i + 5 < pos.length; i += 6) {
    const ax = pos[i]!, ay = pos[i+1]!, bx = pos[i+2]!, by = pos[i+3]!, cx = pos[i+4]!, cy = pos[i+5]!;
    const v0x = cx-ax, v0y = cy-ay, v1x = bx-ax, v1y = by-ay, v2x = hx-ax, v2y = hy-ay;
    const dot00 = v0x*v0x+v0y*v0y, dot01 = v0x*v1x+v0y*v1y, dot02 = v0x*v2x+v0y*v2y;
    const dot11 = v1x*v1x+v1y*v1y, dot12 = v1x*v2x+v1y*v2y;
    const inv = 1/(dot00*dot11-dot01*dot01+1e-20);
    const u = (dot11*dot02-dot01*dot12)*inv;
    const v = (dot00*dot12-dot01*dot02)*inv;
    if (u >= 0 && v >= 0 && u + v <= 1) return true;
  }
  return false;
}

/** True if stroke mesh has a long edge near the open-gap chord (outer start→outer end). */
function strokeHasGapChord(strokePos: Float32Array, ox0: number, oy0: number, ox1: number, oy1: number): boolean {
  const mx = (ox0 + ox1) / 2;
  const my = (oy0 + oy1) / 2;
  const chordLen = Math.hypot(ox1 - ox0, oy1 - oy0);
  // Sample verts near chord midpoint — a fake closing chord would put ribbon verts here.
  for (let i = 0; i + 1 < strokePos.length; i += 2) {
    const d = Math.hypot(strokePos[i]! - mx, strokePos[i+1]! - my);
    if (d < chordLen * 0.08) return true;
  }
  return false;
}

describe('annular sector mesh', () => {
  beforeEach(() => clearShapeMeshCache());

  it('does not bridge a chord across the open gap', () => {
    const w = 200, h = 200;
    const d = PathBuilder.ellipseVariant(w, h, {
      innerRatio: 0.42,
      arcPercent: 75,
      startDeg: 90,
    }).toD();
    const pts = densifyPathD(d, 0.4);
    expect(pts.length).toBeGreaterThan(16);

    const node = {
      id: 'ann-sec',
      key: 'shape',
      width: w,
      height: h,
      attrs: {
        shapeType: 'circle',
        'fill-color': '#ccc',
        ellipseInnerRatio: 0.42,
        ellipseArcPercent: 75,
        ellipseStartDeg: 90,
        'border-width': 2,
        'border-color': '#111',
      },
    } as SceneNodeInput;

    const mesh = getOrBuildShapeMesh('ann-sec', node, { width: w, height: h });
    expect(mesh?.fill?.triangleCount ?? 0).toBeGreaterThan(4);
    expect(covers(mesh!.fill!.positions, 100, 100)).toBe(false);

    // Open gap for startDeg=90, 75% sweep: missing ~90° wedge — chord mid is in that wedge.
    const cx = 100, cy = 100, rx = 100, ry = 100;
    const a0 = (90 * Math.PI) / 180;
    const sweep = 0.75 * Math.PI * 2;
    const a1 = a0 + sweep;
    const ox0 = cx + rx * Math.cos(a0);
    const oy0 = cy + ry * Math.sin(a0);
    const ox1 = cx + rx * Math.cos(a1);
    const oy1 = cy + ry * Math.sin(a1);
    expect(mesh?.stroke).not.toBeNull();
    expect(strokeHasGapChord(mesh!.stroke!.positions, ox0, oy0, ox1, oy1)).toBe(false);
  });
});
