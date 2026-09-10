import type { VideoGeomOverride } from '@/components/editor/nodes/VideoNode/VideoNodeOverlay';

/**
 * Coalesce HTML-media geometry publishes to one apply per animation frame.
 * Kit / DomHost geometry preview (noop under Kit); React setState must not
 * run on every pointermove (that re-reconciles SvgCanvas).
 */
export function createDragWriteCoalescer(
  apply: (batch: { videoGeom: Record<string, VideoGeomOverride> | null }) => void
) {
  let pendingVideo: Record<string, VideoGeomOverride> | null = null;
  let raf = 0;

  const flush = () => {
    raf = 0;
    apply({ videoGeom: pendingVideo });
  };

  return {
    queueVideoGeom(next: Record<string, VideoGeomOverride> | null) {
      pendingVideo = next;
      if (typeof requestAnimationFrame === 'undefined') {
        flush();
        return;
      }
      if (raf) return;
      raf = requestAnimationFrame(flush);
    },
    getPendingVideoGeom() {
      return pendingVideo;
    },
    /** Drop pending work without applying (commit owns the final document). */
    cancel() {
      pendingVideo = null;
      if (raf && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(raf);
      }
      raf = 0;
    },
  };
}
