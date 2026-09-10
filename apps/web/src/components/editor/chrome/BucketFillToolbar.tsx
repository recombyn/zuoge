import { memo, useMemo } from 'react';
import { useSelector } from '@/store';
import { useTranslation } from 'react-i18next';
import Tooltip from '@/components/base/tooltip';
import { FloatingToolbar } from '@/components/editor/chrome/FloatingToolbar';
import {
  FillPanelPopover,
  fillPanelPreview,
  type FillPanelValue,
} from '@/components/editor/panels/FillPanel';
import { FillColorSwatch } from '@/components/rcb/selection/chrome';
import { setBucketFill } from '@/store/modules/editor';
import { cn } from '@/utils/classnames';

/**
 * Quick solids on the bucket dock — same palette as ColorPanel / FillPanel,
 * trimmed to one toolbar row (grays + primaries). Full picker stays for
 * gradient / image / custom hex (common colours within reach).
 */
const BUCKET_QUICK_COLORS = [
  '#FFFFFF',
  '#E5E5E5',
  '#808080',
  '#383838',
  '#000000',
  '#D43030',
  '#FF8D1A',
  '#FFEB3B',
  '#43CF7C',
  '#2A82E4',
  '#7948EA',
  '#AC33C1',
] as const;

function bucketFillToPanelValue(raw: any): FillPanelValue {
  return {
    fillType: raw?.fillType || 'solid',
    fillColor: String(raw?.fillColor || '#333333'),
    fillOpacity: Number.isFinite(Number(raw?.fillOpacity)) ? Number(raw.fillOpacity) : 100,
    fillGradient: raw?.fillGradient != null ? String(raw.fillGradient) : undefined,
    fillImageSrc: raw?.fillImageSrc != null ? String(raw.fillImageSrc) : undefined,
    fillImageFit: raw?.fillImageFit,
    fillImageRotate: raw?.fillImageRotate,
    fillImageScale: raw?.fillImageScale,
    fillImageOffsetX: raw?.fillImageOffsetX,
    fillImageOffsetY: raw?.fillImageOffsetY,
    fillImageAdjust: raw?.fillImageAdjust,
  };
}

function normalizeSolidHex(raw: string): string {
  const s = String(raw || '').trim().toUpperCase();
  if (!s || s === 'TRANSPARENT' || s === 'NONE') return '';
  if (/^#[0-9A-F]{6}$/.test(s)) return s;
  if (/^#[0-9A-F]{8}$/.test(s)) return s.slice(0, 7);
  if (/^[0-9A-F]{6}$/.test(s)) return `#${s}`;
  return s.startsWith('#') ? s : '';
}

function isNoneFill(value: FillPanelValue): boolean {
  const t = String(value.fillType || '').toLowerCase();
  if (t === 'none') return true;
  const c = String(value.fillColor || '').trim().toLowerCase();
  if (c === 'none' || c === 'transparent') return true;
  return Number(value.fillOpacity) <= 0 && t === 'solid';
}

function applySolid(hex: string) {
  setBucketFill({
    fillType: 'solid',
    fillColor: hex,
    fillOpacity: 100,
    fillGradient: undefined,
    fillImageSrc: undefined,
  });
}

function applyNone() {
  setBucketFill({
    fillType: 'solid',
    fillColor: 'transparent',
    fillOpacity: 0,
    fillGradient: undefined,
    fillImageSrc: undefined,
  });
}

/**
 * Paint-bucket dock: None + common solids + FillPanel for
 * custom / gradient / image. Product FloatingToolbar chrome.
 */
function BucketFillToolbar({
  className,
  chrome = 'pill',
}: {
  className?: string;
  /** `flat` when embedded in the timeline top rail (no pill border/shadow). */
  chrome?: 'pill' | 'flat';
}) {
  const { t } = useTranslation();
  const bucketFill = useSelector((s: any) => s.editor.bucketFill);
  const value = useMemo(() => bucketFillToPanelValue(bucketFill), [bucketFill]);
  const preview = fillPanelPreview(value);
  const noneActive = isNoneFill(value);
  const activeSolid =
    !noneActive && String(value.fillType || 'solid') === 'solid'
      ? normalizeSolidHex(String(value.fillColor || ''))
      : '';

  const chipClass =
    'inline-flex h-6 w-6 items-center justify-center rounded-[4px] transition-colors hover:bg-[var(--accent-soft)]';

  return (
    <div className={cn('pointer-events-auto', className)}>
      <FloatingToolbar variant={chrome} className="h-8 gap-1 px-2 py-0">
        <Tooltip tip={t('editor.selectionToolbar.clearFill')} placement="bottom">
          <button
            type="button"
            aria-label={t('editor.selectionToolbar.clearFill')}
            aria-pressed={noneActive}
            className={cn(chipClass, noneActive && 'bg-[var(--accent-soft)]')}
            onClick={() => applyNone()}
          >
            <span className="relative h-3.5 w-3.5 overflow-hidden rounded-full ring-1 ring-[#b3b3b3]">
              <span
                aria-hidden
                className="absolute inset-0"
                style={{
                  backgroundImage:
                    'linear-gradient(45deg, #d0d0d0 25%, transparent 25%), linear-gradient(-45deg, #d0d0d0 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #d0d0d0 75%), linear-gradient(-45deg, transparent 75%, #d0d0d0 75%)',
                  backgroundSize: '6px 6px',
                  backgroundPosition: '0 0, 0 3px, 3px -3px, -3px 0',
                }}
              />
              <span
                aria-hidden
                className="absolute left-[-2px] top-[6px] h-[1.5px] w-[18px] rotate-[-45deg] bg-[#E11D48]"
              />
            </span>
          </button>
        </Tooltip>

        <span className="mx-0.5 h-4 w-px shrink-0 bg-[var(--line)]" aria-hidden />

        {BUCKET_QUICK_COLORS.map((hex) => {
          const selected = activeSolid === hex;
          return (
            <Tooltip key={hex} tip={hex} placement="bottom">
              <button
                type="button"
                aria-label={hex}
                aria-pressed={selected}
                className={cn(chipClass, selected && 'bg-[var(--accent-soft)]')}
                onClick={() => applySolid(hex)}
              >
                <FillColorSwatch color={hex} />
              </button>
            </Tooltip>
          );
        })}

        <span className="mx-0.5 h-4 w-px shrink-0 bg-[var(--line)]" aria-hidden />

        <FillPanelPopover
          value={value}
          onChange={(next) => setBucketFill(next)}
          title={t('editor.selectionToolbar.color')}
          placement="bottom"
          offset={10}
          shiftMainAxis={false}
          className="inline-flex"
        >
          {({ open }) => (
            <Tooltip tip={t('editor.selectionToolbar.fillColor')} placement="bottom" disabled={open}>
              <span
                className={cn(
                  chipClass,
                  open || (!noneActive && !activeSolid) ? 'bg-[var(--accent-soft)]' : null
                )}
              >
                <span
                  className="relative h-3.5 w-3.5 overflow-hidden rounded-full border border-black/15"
                  style={{ background: preview }}
                />
              </span>
            </Tooltip>
          )}
        </FillPanelPopover>
      </FloatingToolbar>
    </div>
  );
}

export default memo(BucketFillToolbar);
