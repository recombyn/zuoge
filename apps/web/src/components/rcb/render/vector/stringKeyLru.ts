/**
 * O(1) string-key LRU via ES Map insertion order (delete + set moves to newest).
 * Prefer this over array `indexOf`/`splice` at cache sizes of thousands.
 */

export type StringKeyLruMap<V> = Map<string, V>;

/** Move `key` to most-recent; no-op if missing. */
export function lruTouch<V>(map: StringKeyLruMap<V>, key: string): void {
  const hit = map.get(key);
  if (hit === undefined) return;
  map.delete(key);
  map.set(key, hit);
}

/**
 * Insert/update then mark most-recent. Evicts oldest while `size > max`,
 * calling `onEvict` before each delete (e.g. dispose GPU resources).
 */
export function lruSet<V>(
  map: StringKeyLruMap<V>,
  key: string,
  value: V,
  max: number,
  onEvict?: (key: string, value: V) => void
): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  const cap = Math.max(1, Math.floor(Number(max) || 1));
  while (map.size > cap) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest == null) break;
    const dropped = map.get(oldest);
    map.delete(oldest);
    if (dropped !== undefined) onEvict?.(oldest, dropped);
  }
}

export function lruDelete<V>(map: StringKeyLruMap<V>, key: string): boolean {
  return map.delete(key);
}
