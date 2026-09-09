import { describe, expect, it } from 'vitest';
import {
  rcbToolToEngine,
  resolveEngineTool,
  ENGINE_DRAW_TOOLS,
  kitOwnsStagePointer,
  KIT_SHAPE_KINDS,
  KIT_STANDALONE_TOOLS,
} from '../toolMap';

describe('Kit tool ownership map', () => {
  it('maps every product shapeKind to a Kit draw tool', () => {
    const expected: Record<string, string> = {
      rect: 'rect',
      line: 'line',
      circle: 'ellipse',
      ellipse: 'ellipse',
      polygon: 'polygon',
      star: 'star',
    };
    for (const kind of KIT_SHAPE_KINDS) {
      expect(resolveEngineTool('shape', kind)).toBe(expected[kind]);
      expect(ENGINE_DRAW_TOOLS.has(expected[kind])).toBe(true);
      expect(kitOwnsStagePointer('shape', kind)).toBe(true);
    }
  });

  it('still maps retired arrow create tool to Kit line (legacy docs)', () => {
    expect(resolveEngineTool('shape', 'arrow')).toBe('line');
    expect(kitOwnsStagePointer('shape', 'arrow')).toBe(true);
  });

  it('maps standalone toolbar tools', () => {
    expect(resolveEngineTool('select')).toBe('selection');
    expect(resolveEngineTool('pen')).toBe('pen');
    expect(resolveEngineTool('pencil')).toBe('pencil');
    expect(resolveEngineTool('text')).toBe('text');
    expect(resolveEngineTool('frame')).toBe('artboard');
    expect(resolveEngineTool('bucket')).toBe('paint-bucket');
    expect(resolveEngineTool('eyedropper')).toBe('eyedropper');
    expect(resolveEngineTool('mesh')).toBe('mesh');
    expect(resolveEngineTool('direct')).toBe('direct');
    for (const tool of KIT_STANDALONE_TOOLS) {
      expect(kitOwnsStagePointer(tool)).toBe(true);
    }
  });

  it('keeps media place off Kit interactive (placeImage is a thin listener)', () => {
    expect(kitOwnsStagePointer('image')).toBe(false);
    expect(kitOwnsStagePointer('video')).toBe(false);
    expect(kitOwnsStagePointer('audio')).toBe(false);
    expect(kitOwnsStagePointer('lottie')).toBe(false);
    expect(kitOwnsStagePointer('pan')).toBe(false);
  });

  it('does not leave activeTool=shape stuck on selection', () => {
    // Bug: rcbToolToEngine('shape') used to fall through to selection.
    expect(rcbToolToEngine('shape')).toBe('rect');
    expect(resolveEngineTool('shape', 'polygon')).toBe('polygon');
    expect(kitOwnsStagePointer('shape', 'star')).toBe(true);
  });
});
