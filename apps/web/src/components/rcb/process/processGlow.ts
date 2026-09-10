import type { SceneDocument } from '@/components/rcb/sceneNode';

/** Optional plate edge color for process chrome (HTML pill / Kit path). */
export const PROCESS_PLATE_STROKE = '#c5d3e4';

/** Scene-unit bleed so foreignObject covers the plate during camera zoom (subpixel gaps). */
export const PROCESS_GLOW_BLEED_PX = 3;

export function processGlowForeignObjectBounds(
  width: number,
  height: number
): { x: number; y: number; width: number; height: number } {
  const bleed = PROCESS_GLOW_BLEED_PX;
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  return {
    x: -bleed,
    y: -bleed,
    width: w + bleed * 2,
    height: h + bleed * 2,
  };
}

/** Screen px inset from plate bottom to pill bottom (inside, bottom-center). */
export const PROCESS_PILL_BOTTOM_PAD_PX = 10;

export const PROCESS_PILL_CLASS =
  'inline-flex h-7 w-max max-w-[min(280px,70vw)] items-center justify-center overflow-hidden text-ellipsis whitespace-nowrap rounded-full bg-[rgba(55,55,55,0.72)] px-2.5 text-[11px] font-medium leading-none text-white shadow-[0_2px_8px_rgba(15,23,42,0.18)]';

/** All nodes with in-flight `processStatus === 'running'`. */
export function listProcessingNodeIds(
  document: SceneDocument | null | undefined
): string[] {
  const children = document?.deltaSetLike?.ROOT?.children;
  if (!Array.isArray(children)) return [];
  const out: string[] = [];
  for (const id of children) {
    const node = document?.deltaSetLike?.[id];
    if (id && node && String(node?.attrs?.processStatus || '') === 'running') {
      out.push(String(id));
    }
  }
  return out;
}
