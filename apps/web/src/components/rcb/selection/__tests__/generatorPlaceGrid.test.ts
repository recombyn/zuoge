import { describe, expect, it } from 'vitest';
import {
  rcbFitImageIntoViewport,
  rcbLayoutGeneratorPlate,
  generatorEmptyIconSize,
  generatorEmptyIconVisible,
  GENERATOR_EMPTY_STROKE_OUTSET,
} from '../../core/layout';
import {
  createImageGeneratorNode,
  createVideoGeneratorNode,
  createVideoNode
} from '../../scene/document/nodeFactories';
import { inflateBoxByVisualOutset, strokeVisualOutset } from '../../scene/document/sceneEffects';
import { snapCoordToGrid } from '../alignGuides';

describe('generator plate place size + grid', () => {
  it('at 4000% zoom, video fit stays within ~half the visible scene', () => {
    const zoom = 40;
    const viewport = { width: 800, height: 600 };
    const sized = rcbFitImageIntoViewport(
      { width: 1280, height: 720 },
      viewport,
      zoom,
      { minRatio: 0.28, maxRatio: 0.48 }
    );
    const sceneW = viewport.width / zoom;
    const sceneH = viewport.height / zoom;
    // eslint-disable-next-line no-console
    console.log('[test:generator-fit@4000%]', { sized, sceneW, sceneH, zoom });
    expect(sized.width).toBeLessThanOrEqual(sceneW * 0.5 + 1);
    expect(sized.height).toBeLessThanOrEqual(sceneH * 0.5 + 1);
    expect(sized.width).toBeLessThan(80);
    expect(sized.height).toBeLessThan(80);
  });

  it('createVideoGeneratorNode does not floor 10×6 up to 160×120', () => {
    const { node } = createVideoGeneratorNode({ x: 1, y: 2, width: 10, height: 6 });
    // eslint-disable-next-line no-console
    console.log('[test:createVideoGenerator]', { w: node.width, h: node.height });
    expect(node.width).toBe(10);
    expect(node.height).toBe(6);
    expect(node.x).toBe(1);
    expect(node.y).toBe(2);
  });

  it('createVideoNode keeps high-zoom place aspect (no 80×60 floor)', () => {
    // 9:16 phone clip placed tiny at ~1200% zoom — old floor made 80×60 → squash.
    const { node } = createVideoNode({ x: 3, y: 4, width: 9, height: 16 });
    // eslint-disable-next-line no-console
    console.log('[test:createVideo-upload-aspect]', {
      w: node.width,
      h: node.height,
      aspect: node.width / node.height,
    });
    expect(node.width).toBe(9);
    expect(node.height).toBe(16);
    expect(node.width / node.height).toBeCloseTo(9 / 16, 6);
    expect(node.x).toBe(3);
    expect(node.y).toBe(4);
  });

  it('createImageGeneratorNode does not floor 12×12 up to 120', () => {
    const { node } = createImageGeneratorNode({ width: 12, height: 12 });
    expect(node.width).toBe(12);
    expect(node.height).toBe(12);
  });

  it('empty-gen icon fits inside a small high-zoom plate (no 72px floor)', () => {
    const box = 18;
    const icon = generatorEmptyIconSize(box, box);
    const oldFloor = Math.max(72, box * 0.34);
    // eslint-disable-next-line no-console
    console.log('[test:gen-icon@small]', { box, icon, oldFloor });
    expect(icon).toBeLessThan(box);
    expect(icon).toBeCloseTo(box * 0.28, 6);
    expect(oldFloor).toBeGreaterThan(box);
  });

  it('caps empty-gen Lucide size so large plates keep title-like stroke weight', () => {
    // 360×0.28 = 100.8 would stroke at ~8 CSS px — too dark / chunky.
    expect(generatorEmptyIconSize(360, 360, 1)).toBeCloseTo(48, 5);
    expect(generatorEmptyIconSize(360, 360, 2)).toBeCloseTo(24, 5);
  });

  it('tiny high-zoom plates (5×5) still paint a visible glyph', () => {
    const icon = generatorEmptyIconSize(5, 5);
    expect(icon).toBeCloseTo(1.4, 5);
    // Old `icon >= 4` skipped this — plate looks empty when zoomed in.
    expect(icon < 4).toBe(true);
    expect(generatorEmptyIconVisible(icon)).toBe(true);
  });

  it('generator plates have no visual stroke outset (inset border === path)', () => {
    const { node: img } = createImageGeneratorNode({ x: 0, y: 0, width: 20, height: 20 });
    const { node: vid } = createVideoGeneratorNode({ x: 0, y: 0, width: 20, height: 12 });
    expect(strokeVisualOutset(img)).toBe(0);
    expect(strokeVisualOutset(vid)).toBe(0);
    expect(GENERATOR_EMPTY_STROKE_OUTSET).toBe(0);
  });

  it('rcbLayoutGeneratorPlate: path edges on integer grid (no half-cell)', () => {
    const zoom = 40;
    const viewport = { width: 900, height: 700 };
    const laid = rcbLayoutGeneratorPlate({
      natural: { width: 1280, height: 720 },
      viewport,
      zoom,
      center: { x: 100.37, y: 50.61 },
      gridSize: 1,
      visualOutset: GENERATOR_EMPTY_STROKE_OUTSET,
      fit: { minRatio: 0.28, maxRatio: 0.48 },
    });
    const { node } = createVideoGeneratorNode({
      x: laid.left,
      y: laid.top,
      width: laid.width,
      height: laid.height,
    });
    const box = { left: node.x, top: node.y, width: node.width, height: node.height };
    const ink = inflateBoxByVisualOutset(box, node);
    // eslint-disable-next-line no-console
    console.log('[test:generator-layout@4000%]', { laid, node: box, ink });
    expect(node.x).toBe(snapCoordToGrid(node.x, 1));
    expect(node.y).toBe(snapCoordToGrid(node.y, 1));
    expect(node.width).toBe(snapCoordToGrid(node.width, 1));
    expect(node.height).toBe(snapCoordToGrid(node.height, 1));
    expect(ink.left).toBe(node.x);
    expect(ink.top).toBe(node.y);
    expect(node.width).toBeLessThan(80);
    // Must not resurrect the old 160 floor.
    expect(node.width).toBe(laid.width);
    expect(node.height).toBe(laid.height);
  });

  it('at 100% zoom, video plate is a sensible fraction of the stage', () => {
    const sized = rcbFitImageIntoViewport(
      { width: 1280, height: 720 },
      { width: 1200, height: 800 },
      1,
      { minRatio: 0.28, maxRatio: 0.48 }
    );
    // eslint-disable-next-line no-console
    console.log('[test:generator-fit@100%]', sized);
    expect(sized.width).toBeGreaterThan(200);
    expect(sized.width).toBeLessThanOrEqual(1200 * 0.48 + 1);
  });
});
