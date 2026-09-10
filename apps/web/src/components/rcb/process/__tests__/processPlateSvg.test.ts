import { describe, expect, it } from 'vitest';
import { ensureDefs, svgEl } from '@/components/rcb/scene/dom/svgDom';
import {
  appendProcessPlatePaths,
  processPlateGradientIds,
  resolveProcessPlatePalette,
  syncProcessPlateGeometry,
} from '../processPlateSvg';

describe('processPlateSvg', () => {
  it('creates SMIL-animated gradient defs and three plate paths', () => {
    const root = svgEl('svg');
    ensureDefs(root);
    const g = svgEl('g');
    root.appendChild(g);

    const palette = appendProcessPlatePaths(g, root, 'node-a', 'M0 0 H100 V50 H0 Z', 100, 50, {
      color: '#c5d3e4',
      width: 1,
    });

    const ids = processPlateGradientIds('node-a');
    const coreGrad = root.querySelector(`#${ids.coreId}`);
    const softGrad = root.querySelector(`#${ids.softId}`);
    expect(coreGrad).toBeTruthy();
    expect(softGrad).toBeTruthy();
    expect(coreGrad?.querySelectorAll('animate').length).toBe(3);
    expect(softGrad?.querySelectorAll('animate').length).toBe(3);

    expect(g.querySelectorAll('[data-process-plate-base]').length).toBe(1);
    expect(g.querySelectorAll('[data-process-plate-glow]').length).toBe(2);
    expect(g.getAttribute('data-process-plate-tone')).toBe(palette.tone);
  });

  it('picks a stable seeded tone per plate key', () => {
    const a = resolveProcessPlatePalette('upload-node-1');
    const b = resolveProcessPlatePalette('upload-node-1');
    expect(a.tone).toBe(b.tone);
    expect(['rose', 'sky', 'peach', 'lilac', 'mint']).toContain(a.tone);
  });

  it('syncProcessPlateGeometry updates all plate paths together', () => {
    const root = svgEl('svg');
    ensureDefs(root);
    const g = svgEl('g');
    root.appendChild(g);
    appendProcessPlatePaths(g, root, 'node-b', 'M0 0 H10 V10 H0 Z', 10, 10);

    syncProcessPlateGeometry(g, 'M0 0 H200 V100 H0 Z');
    const paths = Array.from(g.querySelectorAll('path')).map((p) => p.getAttribute('d'));
    expect(paths).toEqual(['M0 0 H200 V100 H0 Z', 'M0 0 H200 V100 H0 Z', 'M0 0 H200 V100 H0 Z']);
  });
});
