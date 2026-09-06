import { useMemo, type ReactNode, memo } from 'react';
import {
  WorldScreenChromeRoot,
  orientedBoxAabb,
} from '@/components/rcb/selection/chrome/SelectionToolbarShell';
import {
  PROCESS_PILL_BOTTOM_PAD_PX,
  PROCESS_PILL_CLASS,
} from './processGlow';

export type ProcessGlowShellProps = {
  /** Stable id for DOM markers (node / frame). */
  seed: string;
  label: string;
  /** Scene-space plate AABB (world). */
  box: { left: number; top: number; width: number; height: number };
  /** Degrees — dock uses oriented AABB like titles / toolbars. */
  angle?: number;
  labelDataAttr?: string;
  className?: string;
};

/**
 * Status pill for canvas processing chrome (nodes + artboards).
 * Gradient bloom stays on the SVG plate; this shell is label-only.
 *
 * Docked with {@link WorldScreenChromeRoot} **inside** the plate: bottom-center,
 * screen-constant `edgeGapPx` inset from the bottom edge (same chrome contract
 * as toolbars / titles — not zoom-scaled FO padding).
 */
export function ProcessGlowShell({
  seed,
  label,
  box,
  angle = 0,
  labelDataAttr = 'data-image-process-label',
  className,
}: ProcessGlowShellProps): ReactNode {
  const dock = useMemo(
    () =>
      orientedBoxAabb(
        {
          left: Number(box.left) || 0,
          top: Number(box.top) || 0,
          width: Math.max(1, Number(box.width) || 1),
          height: Math.max(1, Number(box.height) || 1),
        },
        angle
      ),
    [box.left, box.top, box.width, box.height, angle]
  );

  return (
    <WorldScreenChromeRoot
      left={dock.left}
      top={dock.top + dock.height}
      railWidth={dock.width}
      anchor="bottom"
      hAlign="center"
      edgeGapPx={PROCESS_PILL_BOTTOM_PAD_PX}
      className={className}
    >
      <div {...{ [labelDataAttr]: true }} data-rcb-process-pill={seed} className={PROCESS_PILL_CLASS}>
        {label}
      </div>
    </WorldScreenChromeRoot>
  );
}

export default memo(ProcessGlowShell);
