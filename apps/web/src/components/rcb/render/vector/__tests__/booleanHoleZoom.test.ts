import { describe, it, expect, beforeEach } from 'vitest';
import type { SceneNodeInput } from '@/components/rcb/sceneNode';
import { sceneFlatness } from '@/components/rcb/render/vector/densifyPathDJs';
import { getOrBuildShapeMesh, clearShapeMeshCache } from '@/components/rcb/render/vector/meshCache';

function circlePath(cx: number, cy: number, r: number, n = 48): string {
  let d = '';
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const x = cx + Math.cos(t) * r;
    const y = cy + Math.sin(t) * r;
    d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2);
  }
  return d + 'Z';
}

describe('boolean hole remesh across zoom', () => {
  beforeEach(() => clearShapeMeshCache());

  it('large rect-minus-circle keeps fill at many zooms', () => {
    const W = 2066;
    const H = 1045;
    const path = `M0 0H${W}V${H}H0Z ` + circlePath(W / 2, H / 2, 220, 64);
    const node = {
      id: 'zoom-hole',
      key: 'shape',
      width: W,
      height: H,
      attrs: {
        shapeType: 'path',
        path,
        closed: 'true',
        'fill-rule': 'evenodd',
        'fill-color': '#ffffff',
        'stroke-enabled': false,
      },
    } as SceneNodeInput;

    for (const zoom of [0.5, 0.85, 1, 2, 4, 8]) {
      clearShapeMeshCache();
      const m = getOrBuildShapeMesh('zoom-hole', node, { width: W, height: H, zoom, dpr: 1 });
      const tris = m?.fill?.triangleCount ?? 0;
      expect(tris, `zoom=${zoom} flat=${sceneFlatness(zoom, 1)}`).toBeGreaterThan(2);
    }
  });
});
