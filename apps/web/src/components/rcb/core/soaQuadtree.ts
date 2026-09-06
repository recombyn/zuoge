/**
 * Axis-aligned quadtree for SoA / spatial broad-phase (world scene units).
 *
 * Items that span multiple quadrants are referenced in each overlapping leaf
 * (same multi-bucket idea as the former uniform grid). Lookup is by id via
 * {@link SoaQuadtree} — pan/zoom never rebuilds; queries transform the rect.
 */

export type SoaQuadItem = {
  id: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

type QuadNode = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Leaf storage; null when subdivided. */
  items: SoaQuadItem[] | null;
  /** NW, NE, SW, SE — null while leaf. */
  kids: [QuadNode, QuadNode, QuadNode, QuadNode] | null;
};

function aabbIntersects(
  aMinX: number,
  aMinY: number,
  aMaxX: number,
  aMaxY: number,
  bMinX: number,
  bMinY: number,
  bMaxX: number,
  bMaxY: number
): boolean {
  return !(aMaxX < bMinX || aMinX > bMaxX || aMaxY < bMinY || aMinY > bMaxY);
}

function normalizeItem(item: SoaQuadItem): SoaQuadItem {
  const minX = Math.min(item.minX, item.maxX);
  const maxX = Math.max(item.minX, item.maxX);
  const minY = Math.min(item.minY, item.maxY);
  const maxY = Math.max(item.minY, item.maxY);
  return { id: item.id, minX, minY, maxX, maxY };
}

function makeLeaf(minX: number, minY: number, maxX: number, maxY: number): QuadNode {
  return { minX, minY, maxX, maxY, items: [], kids: null };
}

/** Root large enough to hold `item`, with padding so early splits stay useful. */
function rootAround(item: SoaQuadItem): QuadNode {
  const w = Math.max(64, item.maxX - item.minX);
  const h = Math.max(64, item.maxY - item.minY);
  const pad = Math.max(w, h) * 2;
  const cx = (item.minX + item.maxX) * 0.5;
  const cy = (item.minY + item.maxY) * 0.5;
  return makeLeaf(cx - pad, cy - pad, cx + pad, cy + pad);
}

function containsItem(node: QuadNode, item: SoaQuadItem): boolean {
  return (
    item.minX >= node.minX &&
    item.minY >= node.minY &&
    item.maxX <= node.maxX &&
    item.maxY <= node.maxY
  );
}

/** Root AABB that covers every item (plus padding). */
function rootFitting(items: Iterable<SoaQuadItem>): QuadNode {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const it of items) {
    if (it.minX < minX) minX = it.minX;
    if (it.minY < minY) minY = it.minY;
    if (it.maxX > maxX) maxX = it.maxX;
    if (it.maxY > maxY) maxY = it.maxY;
  }
  if (!Number.isFinite(minX)) return makeLeaf(-1024, -1024, 1024, 1024);
  const w = Math.max(64, maxX - minX);
  const h = Math.max(64, maxY - minY);
  const pad = Math.max(w, h) * 0.5 + 64;
  return makeLeaf(minX - pad, minY - pad, maxX + pad, maxY + pad);
}

function splitNode(node: QuadNode): void {
  const midX = (node.minX + node.maxX) * 0.5;
  const midY = (node.minY + node.maxY) * 0.5;
  node.kids = [
    makeLeaf(node.minX, node.minY, midX, midY), // NW
    makeLeaf(midX, node.minY, node.maxX, midY), // NE
    makeLeaf(node.minX, midY, midX, node.maxY), // SW
    makeLeaf(midX, midY, node.maxX, node.maxY), // SE
  ];
  node.items = null;
}

function itemIntersectsNode(item: SoaQuadItem, node: QuadNode): boolean {
  return aabbIntersects(
    item.minX,
    item.minY,
    item.maxX,
    item.maxY,
    node.minX,
    node.minY,
    node.maxX,
    node.maxY
  );
}

function insert(
  node: QuadNode,
  item: SoaQuadItem,
  depth: number,
  maxItems: number,
  maxDepth: number
): void {
  if (node.kids) {
    for (let i = 0; i < 4; i += 1) {
      const kid = node.kids[i];
      if (!itemIntersectsNode(item, kid)) continue;
      insert(kid, item, depth + 1, maxItems, maxDepth);
    }
    return;
  }
  const items = node.items!;
  items.push(item);
  if (items.length <= maxItems || depth >= maxDepth) return;
  const spanX = node.maxX - node.minX;
  const spanY = node.maxY - node.minY;
  if (spanX <= 1e-6 || spanY <= 1e-6) return;
  const pending = items.slice();
  splitNode(node);
  for (const it of pending) {
    insert(node, it, depth + 1, maxItems, maxDepth);
  }
}

function removeFromNode(node: QuadNode, id: string): boolean {
  if (node.kids) {
    let any = false;
    for (let i = 0; i < 4; i += 1) {
      if (removeFromNode(node.kids[i], id)) any = true;
    }
    return any;
  }
  const items = node.items;
  if (!items?.length) return false;
  let wrote = 0;
  let removed = false;
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].id === id) {
      removed = true;
      continue;
    }
    items[wrote] = items[i];
    wrote += 1;
  }
  if (removed) items.length = wrote;
  return removed;
}

function queryNode(
  node: QuadNode,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  seen: Set<string>,
  out: SoaQuadItem[]
): void {
  if (!aabbIntersects(minX, minY, maxX, maxY, node.minX, node.minY, node.maxX, node.maxY)) {
    return;
  }
  if (node.kids) {
    for (let i = 0; i < 4; i += 1) {
      queryNode(node.kids[i], minX, minY, maxX, maxY, seen, out);
    }
    return;
  }
  const items = node.items;
  if (!items) return;
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    if (seen.has(it.id)) continue;
    if (!itemIntersectsQuery(it, minX, minY, maxX, maxY)) continue;
    seen.add(it.id);
    out.push(it);
  }
}

function itemIntersectsQuery(
  item: SoaQuadItem,
  qMinX: number,
  qMinY: number,
  qMaxX: number,
  qMaxY: number
): boolean {
  return aabbIntersects(
    qMinX,
    qMinY,
    qMaxX,
    qMaxY,
    item.minX,
    item.minY,
    item.maxX,
    item.maxY
  );
}

function rebuildRoot(
  items: Iterable<SoaQuadItem>,
  maxItems: number,
  maxDepth: number
): QuadNode {
  const list = [...items];
  const root = rootFitting(list);
  for (const it of list) {
    insert(root, it, 0, maxItems, maxDepth);
  }
  return root;
}

export class SoaQuadtree {
  private root: QuadNode | null = null;
  private readonly byId = new Map<string, SoaQuadItem>();
  /** Stale tree membership — resolve live AABB on search; rebuild when large. */
  private readonly dirtyIds = new Set<string>();
  private readonly maxItems: number;
  private readonly maxDepth: number;

  constructor(opts?: { maxItems?: number; maxDepth?: number }) {
    this.maxItems = Math.max(4, opts?.maxItems ?? 12);
    this.maxDepth = Math.max(4, opts?.maxDepth ?? 14);
  }

  get size(): number {
    return this.byId.size;
  }

  get dirtySize(): number {
    return this.dirtyIds.size;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  ids(): IterableIterator<string> {
    return this.byId.keys();
  }

  clear(): void {
    this.root = null;
    this.byId.clear();
    this.dirtyIds.clear();
  }

  /**
   * Mark id dirty without tree surgery. Search uses `liveAabb` for dirty ids;
   * restamp via upsert / replaceAll / bulkUpsert when the gesture ends.
   */
  markDirty(id: string): void {
    if (!id || !this.byId.has(id)) return;
    this.dirtyIds.add(id);
  }

  markDirtyMany(ids: Iterable<string>): void {
    for (const id of ids) this.markDirty(id);
  }

  /**
   * Update AABB in `byId` without tree surgery. Search rescues dirty ids from
   * `byId` (or `liveAabb`). Prefer over {@link upsert} during paste/flag storms.
   */
  restamp(item: SoaQuadItem): void {
    if (!item?.id) return;
    const normalized = normalizeItem(item);
    this.byId.set(normalized.id, normalized);
    this.dirtyIds.add(normalized.id);
  }

  /** Insert or replace AABB for `item.id` (world scene units). */
  upsert(item: SoaQuadItem): void {
    if (this.byId.has(item.id)) this.remove(item.id);
    const normalized = normalizeItem(item);
    this.byId.set(normalized.id, normalized);
    this.dirtyIds.delete(normalized.id);
    if (!this.root) {
      this.root = rootAround(normalized);
      insert(this.root, normalized, 0, this.maxItems, this.maxDepth);
      return;
    }
    if (!containsItem(this.root, normalized)) {
      this.root = null;
      this.root = rebuildRoot(this.byId.values(), this.maxItems, this.maxDepth);
      return;
    }
    insert(this.root, normalized, 0, this.maxItems, this.maxDepth);
  }

  /**
   * Replace the whole tree in one rebuild (full SoA sync / large batch).
   * Avoids O(n²) from repeated expand-rebuild during sequential upsert.
   */
  replaceAll(items: Iterable<SoaQuadItem>): void {
    this.root = null;
    this.byId.clear();
    this.dirtyIds.clear();
    for (const raw of items) {
      const normalized = normalizeItem(raw);
      this.byId.set(normalized.id, normalized);
    }
    if (this.byId.size === 0) return;
    this.root = rebuildRoot(this.byId.values(), this.maxItems, this.maxDepth);
  }

  /**
   * Merge `items` into byId via restamp; compact only when dirty storm exceeds threshold.
   * Prefer over many {@link upsert} calls when the batch is large or spread out.
   */
  bulkUpsert(items: Iterable<SoaQuadItem>, compactAt = 512): void {
    let any = false;
    for (const raw of items) {
      this.restamp(raw);
      any = true;
    }
    if (!any) return;
    if (this.dirtySize >= compactAt) this.compact();
  }

  /** Rebuild the tree from `byId` and clear dirty marks. */
  compact(): void {
    this.root = null;
    if (this.byId.size === 0) {
      this.dirtyIds.clear();
      return;
    }
    this.root = rebuildRoot(this.byId.values(), this.maxItems, this.maxDepth);
    this.dirtyIds.clear();
  }

  remove(id: string): void {
    if (!this.byId.has(id)) return;
    this.byId.delete(id);
    this.dirtyIds.delete(id);
    if (this.root) removeFromNode(this.root, id);
  }

  /**
   * Items whose AABB intersects the query rect.
   * When `liveAabb` is set, dirty ids are filtered / rescued with the live box
   * so TransformPreview need not upsert every frame.
   */
  search(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    opts?: {
      liveAabb?: (id: string) => SoaQuadItem | null | undefined;
    }
  ): SoaQuadItem[] {
    const out: SoaQuadItem[] = [];
    if (!this.root && this.dirtyIds.size === 0) return out;
    const qMinX = Math.min(minX, maxX);
    const qMaxX = Math.max(minX, maxX);
    const qMinY = Math.min(minY, maxY);
    const qMaxY = Math.max(minY, maxY);
    const seen = new Set<string>();
    const liveAabb = opts?.liveAabb;

    if (this.root) {
      queryNode(this.root, qMinX, qMinY, qMaxX, qMaxY, seen, out);
    }
    if (this.dirtyIds.size === 0) return out;

    if (liveAabb) {
      const kept: SoaQuadItem[] = [];
      for (const hit of out) {
        if (!this.dirtyIds.has(hit.id)) {
          kept.push(hit);
          continue;
        }
        const live = resolveLiveInQuery(hit.id, liveAabb, qMinX, qMinY, qMaxX, qMaxY);
        if (live) kept.push(live);
      }
      for (const id of this.dirtyIds) {
        if (seen.has(id)) continue;
        const live = resolveLiveInQuery(id, liveAabb, qMinX, qMinY, qMaxX, qMaxY);
        if (!live) continue;
        seen.add(id);
        kept.push(live);
      }
      return kept;
    }

    // No liveAabb — rescue from byId (restamp path). Dirty tree hits may still
    // carry stale AABBs; replace with byId and drop misses.
    const kept: SoaQuadItem[] = [];
    for (const hit of out) {
      if (!this.dirtyIds.has(hit.id)) {
        kept.push(hit);
        continue;
      }
      const box = this.byId.get(hit.id);
      if (!box) continue;
      if (!itemIntersectsQuery(box, qMinX, qMinY, qMaxX, qMaxY)) continue;
      kept.push(box);
    }
    for (const id of this.dirtyIds) {
      if (seen.has(id)) continue;
      const box = this.byId.get(id);
      if (!box) continue;
      if (!itemIntersectsQuery(box, qMinX, qMinY, qMaxX, qMaxY)) continue;
      seen.add(id);
      kept.push(box);
    }
    return kept;
  }

  searchPoint(
    x: number,
    y: number,
    pad = 0,
    opts?: {
      liveAabb?: (id: string) => SoaQuadItem | null | undefined;
    }
  ): SoaQuadItem[] {
    return this.search(x - pad, y - pad, x + pad, y + pad, opts);
  }
}

function resolveLiveInQuery(
  id: string,
  liveAabb: (id: string) => SoaQuadItem | null | undefined,
  qMinX: number,
  qMinY: number,
  qMaxX: number,
  qMaxY: number
): SoaQuadItem | null {
  const live = liveAabb(id);
  if (!live) return null;
  const box = normalizeItem(live);
  if (!itemIntersectsQuery(box, qMinX, qMinY, qMaxX, qMaxY)) return null;
  return box;
}
