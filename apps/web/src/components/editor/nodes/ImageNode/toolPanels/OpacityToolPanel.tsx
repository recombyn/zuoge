import { memo } from 'react';
import { HiOutlineArrowPath } from 'react-icons/hi2';
import { useTranslation } from 'react-i18next';
import Slider from '@/components/base/slider';
import ImageToolPanelShell, { PanelIconBtn } from './ImageToolPanelShell';

/** Opacity: live slider (same as blend / effects). */
function OpacityToolPanel({
  opacityPct,
  onOpacityPctChange,
  onReset,
  onClose,
}: {
  opacityPct: number;
  onOpacityPctChange: (v: number) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const safe = Math.min(100, Math.max(0, Math.round(opacityPct)));
  return (
    <ImageToolPanelShell
      title={t('editor.imageToolbar.opacity')}
      width={240}
      onClose={onClose}
      headerRight={
        <PanelIconBtn title={t('editor.imageToolbar.reset')} onClick={onReset}>
          <HiOutlineArrowPath className="h-4 w-4" />
        </PanelIconBtn>
      }
    >
      <div className="flex flex-col items-stretch gap-3 py-1">
        <Slider
          min={0}
          max={100}
          step={1}
          value={safe}
          onChange={onOpacityPctChange}
          /* Thick black pill + white ring thumb — shared opacity chrome. */
          trackHeight={10}
          thumbWidth={16}
          thumbHeight={16}
        />
      </div>
    </ImageToolPanelShell>
  );
}

export default memo(OpacityToolPanel);
