import { describe, expect, it } from 'vitest';
import { composerConsumesWheel, wheelShouldStayLocal } from '../wheelScrollOwners';

function wheel(overrides: Partial<WheelEvent> = {}): WheelEvent {
  return {
    deltaY: 10,
    deltaMode: 0,
    ctrlKey: false,
    metaKey: false,
    ...overrides,
  } as WheelEvent;
}

function mockScrollEl(
  size: { scrollHeight: number; clientHeight: number; scrollTop?: number },
  closestMap: Record<string, unknown>
) {
  const el = {
    scrollHeight: size.scrollHeight,
    clientHeight: size.clientHeight,
    scrollTop: size.scrollTop ?? 0,
    closest: (sel: string) => closestMap[sel] ?? null,
    querySelector: () => null,
  };
  return el as unknown as HTMLElement;
}

describe('composerConsumesWheel', () => {
  it('does not consume when composer is not scrollable', () => {
    const composer = mockScrollEl(
      { scrollHeight: 40, clientHeight: 40 },
      { '[data-agent-composer]': null }
    );
    (composer as any).closest = (sel: string) =>
      sel === '[data-agent-composer]' ? composer : null;
    expect(composerConsumesWheel(composer, wheel())).toBe(false);
  });

  it('does not consume pinch / ctrl+wheel so canvas can zoom', () => {
    const composer = mockScrollEl(
      { scrollHeight: 200, clientHeight: 80 },
      {}
    );
    (composer as any).closest = (sel: string) =>
      sel === '[data-agent-composer]' ? composer : null;
    expect(composerConsumesWheel(composer, wheel({ ctrlKey: true }))).toBe(false);
    expect(composerConsumesWheel(composer, wheel({ metaKey: true }))).toBe(false);
  });

  it('consumes wheel when composer can scroll in that direction', () => {
    const composer = mockScrollEl(
      { scrollHeight: 200, clientHeight: 80, scrollTop: 0 },
      {}
    );
    (composer as any).closest = (sel: string) =>
      sel === '[data-agent-composer]' ? composer : null;
    expect(composerConsumesWheel(composer, wheel({ deltaY: 10 }))).toBe(true);
    expect(composerConsumesWheel(composer, wheel({ deltaY: -10 }))).toBe(false);
  });
});

describe('wheelShouldStayLocal', () => {
  it('stays local for known scroll-owner panels', () => {
    const panel = mockScrollEl({ scrollHeight: 100, clientHeight: 100 }, {});
    (panel as any).closest = (sel: string) =>
      sel.includes('data-image-tool-panel') ? panel : null;
    expect(wheelShouldStayLocal(panel, wheel())).toBe(true);
  });
});
