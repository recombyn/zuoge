import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { GuideMarkX } from '../chrome/SmartGuidesOverlay';

describe('GuideMarkX', () => {
  it('renders an × mark (two diagonals) instead of a filled circle', () => {
    const { container } = render(
      <GuideMarkX x={10} y={20} r={4} strokeWidth={1} />
    );
    const mark = container.querySelector('[data-rcb-guide-mark="x"]');
    expect(mark).toBeTruthy();
    expect(mark?.querySelectorAll('[data-rcb-guide-line="1"]').length).toBe(2);
    expect(container.querySelector('circle')).toBeNull();
  });
});
