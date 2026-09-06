/**
 * Append world-space triangle meshes for WebGL vector ink batches.
 */

export type AppendMeshLocalOpts = {
  /** Rotation in degrees around local pivot (default node center). */
  angleDeg?: number;
  /** Local-space pivot; defaults to (pivotW/2, pivotH/2) when sizes given. */
  pivotX?: number;
  pivotY?: number;
  pivotW?: number;
  pivotH?: number;
  /**
   * Per-vertex stroke rim attribute (±1). Length must match localXY verts.
   * Fills omit this (edge 0 → full coverage in mesh FS).
   */
  edges?: Float32Array | null;
};

/**
 * Helper: append local-space XY triangles into world mesh arrays (+ox,+oy).
 * Optional rotation around local pivot (for angled line/arrow).
 */
export function appendMeshLocal(
  localXY: Float32Array | null | undefined,
  ox: number,
  oy: number,
  rgba: readonly [number, number, number, number],
  clip: readonly [number, number, number, number] | null | undefined,
  meshPos: number[],
  meshCol: number[],
  meshClip: number[],
  opts?: AppendMeshLocalOpts,
  meshEdge?: number[]
): number {
  if (!localXY || localXY.length < 6) return 0;
  const c0 = clip?.[0] ?? -1e8;
  const c1 = clip?.[1] ?? -1e8;
  const c2 = clip?.[2] ?? 1e8;
  const c3 = clip?.[3] ?? 1e8;
  const angleDeg = Number(opts?.angleDeg) || 0;
  const hasRot = Math.abs(angleDeg) > 0.5;
  const pw = Math.max(0, Number(opts?.pivotW) || 0);
  const ph = Math.max(0, Number(opts?.pivotH) || 0);
  const px = Number.isFinite(opts?.pivotX) ? Number(opts!.pivotX) : pw * 0.5;
  const py = Number.isFinite(opts?.pivotY) ? Number(opts!.pivotY) : ph * 0.5;
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const srcEdges = opts?.edges;
  let n = 0;
  for (let i = 0; i + 1 < localXY.length; i += 2) {
    let lx = localXY[i]!;
    let ly = localXY[i + 1]!;
    if (hasRot) {
      const dx = lx - px;
      const dy = ly - py;
      lx = px + cos * dx - sin * dy;
      ly = py + sin * dx + cos * dy;
    }
    meshPos.push(lx + ox, ly + oy);
    meshCol.push(rgba[0], rgba[1], rgba[2], rgba[3]);
    meshClip.push(c0, c1, c2, c3);
    if (meshEdge) {
      const ei = n;
      meshEdge.push(srcEdges && ei < srcEdges.length ? srcEdges[ei]! : 0);
    }
    n += 1;
  }
  return n;
}
