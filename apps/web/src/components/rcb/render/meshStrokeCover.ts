/**
 * Pure JS mirror of mesh stroke coverage AA (SOA_WEBGL_MESH_FS).
 * Keeps the analytic formula testable without a WebGL context.
 */
export function meshStrokeCover(absEdge: number, fwidthD: number): number {
  const d = Math.abs(absEdge);
  if (d <= 1e-4) return 1;
  const w = Math.max(fwidthD, 1e-4);
  return Math.min(1, Math.max(0, (1 - d) / w + 0.5));
}
