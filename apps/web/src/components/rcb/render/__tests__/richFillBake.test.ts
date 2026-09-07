import { describe, expect, it } from 'vitest';
import type { SceneNodeInput } from '@/components/rcb/sceneNode';
import {
  nodeHasRichFill,
  parseFillType,
} from '@/components/rcb/scene/document/sceneFill';
import {
  bakeShapeRichInkForWebgl,
  richShapeTextureFingerprint,
} from '@/components/rcb/render/sceneRenderer';
import { getOrBuildShapeMesh, invalidateShapeMesh } from '@/components/rcb/render/vector/meshCache';

describe('rich fill WebGL bake', () => {
  it('nodeHasRichFill detects gradient / image / diffuse', () => {
    expect(parseFillType('linear')).toBe('linear');
    expect(
      nodeHasRichFill({
        key: 'shape',
        attrs: { 'fill-type': 'linear', 'fill-enabled': 'true' },
      } as SceneNodeInput)
    ).toBe(true);
    expect(
      nodeHasRichFill({
        key: 'shape',
        attrs: { 'fill-type': 'image', 'fill-image-src': 'data:x' },
      } as SceneNodeInput)
    ).toBe(true);
    expect(
      nodeHasRichFill({
        key: 'shape',
        attrs: { 'fill-type': 'solid', 'fill-color': '#fff' },
      } as SceneNodeInput)
    ).toBe(false);
    expect(
      nodeHasRichFill({
        key: 'shape',
        attrs: { 'fill-type': 'linear', 'fill-enabled': 'false' },
      } as SceneNodeInput)
    ).toBe(false);
  });

  it('bakeShapeRichInkForWebgl returns a bake when 2d context is available', () => {
    const node = {
      id: 'g1',
      key: 'shape',
      width: 40,
      height: 30,
      attrs: {
        shapeType: 'rect',
        'fill-type': 'linear',
        'fill-gradient': JSON.stringify({
          type: 'linear',
          angle: 0,
          colorStops: [
            { offset: 0, color: '#ff0000' },
            { offset: 1, color: '#0000ff' },
          ],
        }),
        'border-width': 0,
        'stroke-enabled': 'false',
      },
    } as SceneNodeInput;

    // setupTests stubs HTMLCanvasElement.getContext → null; provide OffscreenCanvas.
    class FakeOffscreen {
      width: number;
      height: number;
      constructor(w: number, h: number) {
        this.width = w;
        this.height = h;
      }
      getContext() {
        const ops: string[] = [];
        return {
          setTransform: () => undefined,
          clearRect: () => undefined,
          save: () => undefined,
          restore: () => undefined,
          translate: () => undefined,
          beginPath: () => undefined,
          rect: () => undefined,
          moveTo: () => undefined,
          lineTo: () => undefined,
          closePath: () => undefined,
          quadraticCurveTo: () => undefined,
          bezierCurveTo: () => undefined,
          arc: () => undefined,
          ellipse: () => undefined,
          fill: () => {
            ops.push('fill');
          },
          stroke: () => undefined,
          fillRect: () => undefined,
          createLinearGradient: () => ({
            addColorStop: () => {
              ops.push('stop');
            },
          }),
          createRadialGradient: () => ({
            addColorStop: () => undefined,
          }),
          createPattern: () => null,
          setLineDash: () => undefined,
          clip: () => undefined,
          fillStyle: '',
          strokeStyle: '',
          lineWidth: 1,
          lineCap: 'butt',
          lineJoin: 'miter',
          miterLimit: 10,
          globalAlpha: 1,
          shadowBlur: 0,
          shadowColor: '',
          shadowOffsetX: 0,
          shadowOffsetY: 0,
          _ops: ops,
        };
      }
    }
    const prev = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
    (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = FakeOffscreen;
    try {
      const baked = bakeShapeRichInkForWebgl(node, 40, 30, 1, 1);
      expect(baked).not.toBeNull();
      expect(baked!.worldW).toBeGreaterThanOrEqual(40);
      expect(baked!.worldH).toBeGreaterThanOrEqual(30);
    } finally {
      if (prev) (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = prev;
      else delete (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
    }
  });

  it('richShapeTextureFingerprint changes when gradient stops change', () => {
    const base = {
      id: 'g2',
      key: 'shape',
      attrs: {
        shapeType: 'rect',
        'fill-type': 'linear',
        'fill-gradient': JSON.stringify({
          type: 'linear',
          colorStops: [
            { offset: 0, color: '#ffffff' },
            { offset: 1, color: '#000000' },
          ],
        }),
      },
    } as SceneNodeInput;
    const a = richShapeTextureFingerprint(base, 'g2', 40, 30, 1, 0);
    const b = richShapeTextureFingerprint(
      {
        ...base,
        attrs: {
          ...base.attrs,
          'fill-gradient': JSON.stringify({
            type: 'linear',
            colorStops: [
              { offset: 0, color: '#ff0000' },
              { offset: 1, color: '#0000ff' },
            ],
          }),
        },
      } as SceneNodeInput,
      'g2',
      40,
      30,
      1,
      0
    );
    expect(a).not.toBe(b);
  });

  it('mesh cache rebuilds stroke when linejoin changes on sharp rect', () => {
    invalidateShapeMesh('join-r');
    const miterNode = {
      id: 'join-r',
      key: 'shape',
      width: 80,
      height: 60,
      attrs: {
        shapeType: 'rect',
        'fill-color': '#fff',
        'fill-type': 'solid',
        'border-width': 12,
        'border-color': '#000',
        'stroke-enabled': 'true',
        strokeLinejoin: 'miter',
        cornerRadius: 0,
      },
    } as SceneNodeInput;
    const miter = getOrBuildShapeMesh('join-r', miterNode, { width: 80, height: 60 });
    expect(miter?.stroke).not.toBeNull();

    const bevelNode = {
      ...miterNode,
      attrs: { ...miterNode.attrs, strokeLinejoin: 'bevel' },
    } as SceneNodeInput;
    const bevel = getOrBuildShapeMesh('join-r', bevelNode, { width: 80, height: 60 });
    expect(bevel?.stroke).not.toBeNull();
    expect(bevel!.geomFp).not.toBe(miter!.geomFp);
    expect(bevel!.stroke!.triangleCount).not.toBe(miter!.stroke!.triangleCount);
  });
});
