/**
 * SVG-like stroke-dasharray splitting for polylines (WebGL mesh + pencil).
 */
export type DashPt = { x: number; y: number };

/** Split a polyline into dash / gap segments (dasharray like SVG: "8 4"). */
export function splitPolylineByDash(points: DashPt[], dasharray: string): DashPt[][] {
  const raw = dasharray
    .trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (points.length < 2 || raw.length === 0) return [points];
  const pattern = raw.map((n) => Math.max(0.5, n));
  if (pattern.length % 2 === 1) pattern.push(pattern[pattern.length - 1]!);

  const dashes: DashPt[][] = [];
  let patternIdx = 0;
  let remaining = pattern[0]!;
  let drawing = true;
  let current: DashPt[] = drawing ? [{ ...points[0]! }] : [];

  const flush = () => {
    if (current.length >= 2) dashes.push(current);
    current = [];
  };

  for (let i = 1; i < points.length; i += 1) {
    let ax = points[i - 1]!.x;
    let ay = points[i - 1]!.y;
    const bx = points[i]!.x;
    const by = points[i]!.y;
    let left = Math.hypot(bx - ax, by - ay);
    if (left <= 1e-6) continue;
    while (left > 1e-6) {
      const take = Math.min(left, remaining);
      const full = Math.hypot(bx - ax, by - ay) || 1;
      const mx = ax + ((bx - ax) / full) * take;
      const my = ay + ((by - ay) / full) * take;
      if (drawing) {
        if (!current.length) current.push({ x: ax, y: ay });
        current.push({ x: mx, y: my });
      }
      ax = mx;
      ay = my;
      left -= take;
      remaining -= take;
      if (remaining <= 1e-6) {
        if (drawing) flush();
        patternIdx = (patternIdx + 1) % pattern.length;
        remaining = pattern[patternIdx]!;
        drawing = !drawing;
        if (drawing) current = [{ x: ax, y: ay }];
      }
    }
  }
  if (drawing) flush();
  return dashes.length ? dashes : [points];
}

/** Close a ring for dash splitting (append first point if needed). */
export function closePolylineForDash(points: DashPt[]): DashPt[] {
  if (points.length < 2) return points.slice();
  const a = points[0]!;
  const b = points[points.length - 1]!;
  if (Math.abs(a.x - b.x) > 1e-5 || Math.abs(a.y - b.y) > 1e-5) {
    return [...points, { ...a }];
  }
  return points.slice();
}
