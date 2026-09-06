import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeProjectOpenElsewhere, probeRequestId } from '@/utils/openProjectSessions';

describe('probeRequestId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back when crypto.randomUUID is missing (insecure HTTP)', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (arr: Uint8Array) => arr,
    });
    const id = probeRequestId();
    expect(id.length).toBeGreaterThan(4);
  });
});

describe('probeProjectOpenElsewhere', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('still runs probe when crypto.randomUUID is missing (server HTTP)', async () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (arr: Uint8Array) => arr,
    });

    // No editor peer → times out as not open (probe still executed).
    await expect(probeProjectOpenElsewhere('proj-1')).resolves.toBe(false);
  });
});
