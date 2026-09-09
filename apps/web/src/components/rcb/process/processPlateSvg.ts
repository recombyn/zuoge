/**
 * Process pill FO geometry sync during live resize.
 * SoftGlow bloom is Kit DropShadow — no SVG plate paths.
 */
import { processGlowForeignObjectBounds } from './processGlow';

/** Status pill foreignObject — label chrome only; bloom is Kit DropShadow. */
export function syncProcessPillForeignObject(
  host: SVGElement | null | undefined,
  width: number,
  height: number
): void {
  if (!host) return;
  const box = processGlowForeignObjectBounds(width, height);
  const fo = host.querySelector(
    'foreignObject[data-rcb-process-glow]'
  ) as SVGForeignObjectElement | null;
  if (!fo) return;
  fo.setAttribute('x', String(box.x));
  fo.setAttribute('y', String(box.y));
  fo.setAttribute('width', String(box.width));
  fo.setAttribute('height', String(box.height));
}
