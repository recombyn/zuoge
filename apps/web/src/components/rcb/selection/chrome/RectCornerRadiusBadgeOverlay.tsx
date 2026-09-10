/**
 * 「圆角 N」 value tip for Kit-drawn rectangle corner-radius handles.
 * Kit owns the four dots + drag; this mirrors polygon/star WorldScreenBadge.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRcbCamera } from '@/components/rcb/camera/context';
import {
  getKitCornerRadiusChrome,
  kitSelectionGestureActive,
  type KitCornerRadiusChrome,
} from '@/components/rcb/canvas/kitBridge';
import {
  CHROME_HANDLE_VIS_PX,
  WorldScreenBadge,
} from './shapeHandleChrome';

function sameChrome(
  a: KitCornerRadiusChrome | null,
  b: KitCornerRadiusChrome | null
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.mode === b.mode &&
    a.radius === b.radius &&
    Math.abs(a.x - b.x) < 0.25 &&
    Math.abs(a.y - b.y) < 0.25
  );
}

function RectCornerRadiusBadgeOverlay({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const camera = useRcbCamera();
  const inv = 1 / Math.max(0.05, camera.zoom || 1);
  const [chrome, setChrome] = useState<KitCornerRadiusChrome | null>(null);

  useEffect(() => {
    if (!enabled) {
      setChrome(null);
      return;
    }
    let raf = 0;
    let alive = true;
    const pull = () => {
      if (!alive) return;
      const next = getKitCornerRadiusChrome();
      setChrome((prev) => (sameChrome(prev, next) ? prev : next));
      if (next || kitSelectionGestureActive()) {
        raf = requestAnimationFrame(pull);
      }
    };
    pull();
    const onPtr = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(pull);
    };
    window.addEventListener('pointermove', onPtr, true);
    window.addEventListener('pointerdown', onPtr, true);
    window.addEventListener('pointerup', onPtr, true);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onPtr, true);
      window.removeEventListener('pointerdown', onPtr, true);
      window.removeEventListener('pointerup', onPtr, true);
    };
  }, [enabled]);

  if (!enabled || !chrome) return null;

  const label = t('editor.imageToolbar.cornerRadius', { defaultValue: '圆角' });
  const halfVis = (CHROME_HANDLE_VIS_PX / 2) * inv;

  return (
    <WorldScreenBadge
      text={`${label} ${chrome.radius}`}
      x={chrome.x}
      y={chrome.y}
      inv={inv}
      anchor="above"
      clearance={halfVis + 2 * inv}
    />
  );
}

export default RectCornerRadiusBadgeOverlay;
