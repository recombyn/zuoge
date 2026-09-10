import { useCallback, useEffect, useRef, memo } from 'react';
import { useSelector } from '@/store';
import { useTranslation } from 'react-i18next';
import { ColorPanelPopover } from '@/components/base/colorPanel';
import { Icon } from '@/components/base/icon';
import Tooltip from '@/components/base/tooltip';
import { FloatingToolbar } from '@/components/editor/chrome/FloatingToolbar';
import { FillColorSwatch, StrokeColorSwatch } from '@/components/rcb/selection/chrome';
import {
  setActiveTool,
  setPenFillColor,
  setPenStrokeColor,
  setPenStrokeOpacity,
  setPenStrokeWidth,
} from '@/store/modules/editor';
import {
  RCB_PLACE_STROKE_SCREEN_PX,
  rcbPlaceStrokeWidth,
} from '@/components/rcb/core/layout';
import { cn } from '@/utils/classnames';

type PenStrokeToolbarProps = {
  /** Which tool's options to show. */
  mode: 'pen' | 'pencil';
  /** Camera zoom — fits default ~1p stroke into scene units. */
  zoom?: number;
  /** Stage viewport width (CSS px) for fit-to-board zoom inference. */
  viewportWidth?: number;
  /** Document / artboard width (scene px). */
  docWidth?: number;
  /**
   * `anchor` — self-position above a relative parent (legacy).
   * `dock` — content only; parent places at page top-center (or timeline rail).
   */
  placement?: 'anchor' | 'dock';
  /** `flat` when embedded in the timeline top rail (no pill border/shadow). */
  chrome?: 'pill' | 'flat';
  className?: string;
};

/**
 * Pen / pencil stroke bar: color + width via editor attrs (Kit paints ink).
 */
function PenStrokeToolbar({
  mode,
  zoom = 1,
  viewportWidth,
  docWidth,
  placement = 'anchor',
  chrome = 'pill',
  className,
}: PenStrokeToolbarProps) {
  const { t } = useTranslation();
  const isPencil = mode === 'pencil';
  const docked = placement === 'dock';
  const tipSide = 'bottom';
  const color = useSelector((s: any) => String(s.editor.penStrokeColor || '#000000'));
  const fillColor = useSelector((s: any) => String(s.editor.penFillColor ?? 'transparent'));
  const width = useSelector((s: any) => {
    const n = Number(s.editor.penStrokeWidth);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 1;
  });
  const opacity = useSelector((s: any) => {
    const n = Number(s.editor.penStrokeOpacity);
    return Number.isFinite(n) ? Math.max(1, Math.min(100, n)) : 100;
  });
  const rootRef = useRef<HTMLDivElement>(null);
  /** Manual edits pin width until the tool remounts / mode switches. */
  const userPinnedRef = useRef(false);
  const prevModeRef = useRef(mode);

  // Fit ~1 screen px into scene units and write the toolbar attribute.
  useEffect(() => {
    if (prevModeRef.current !== mode) {
      prevModeRef.current = mode;
      userPinnedRef.current = false;
    }
    if (userPinnedRef.current) return;
    const next = rcbPlaceStrokeWidth(zoom, RCB_PLACE_STROKE_SCREEN_PX, {
      viewportWidth: viewportWidth && viewportWidth > 0 ? viewportWidth : undefined,
      docWidth: docWidth && docWidth > 0 ? docWidth : undefined,
    });
    if (width !== next) setPenStrokeWidth(next);
  }, [zoom, viewportWidth, docWidth, width, mode]);

  const exitPenEdit = useCallback(() => {
    window.dispatchEvent(new Event('resume:exit-pen'));
    setActiveTool('select');
  }, []);

  const pinStrokeWidth = useCallback((n: number) => {
    userPinnedRef.current = true;
    setPenStrokeWidth(Math.max(1, Math.round(n) || 1));
  }, []);

  const swatchClass =
    'inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--accent-soft)]';
  const colorPanelProps = {
    placement: tipSide as 'bottom' | 'top',
    offset: 10,
    shiftMainAxis: false,
    className: swatchClass,
  };

  return (
    <div
      ref={rootRef}
      className={cn(
        docked
          ? 'pointer-events-auto'
          : 'pointer-events-auto absolute bottom-[calc(100%+10px)] left-1/2 z-30 -translate-x-1/2',
        className
      )}
    >
      <FloatingToolbar variant={chrome} className="relative h-8 gap-1 px-2 py-0">
        {isPencil ? (
          <ColorPanelPopover
            {...colorPanelProps}
            value={color}
            onChange={(hex) => setPenStrokeColor(hex)}
            opacity={opacity}
            onOpacityChange={(pct) => setPenStrokeOpacity(pct)}
            showAlpha
            title={t('editor.stroke', { defaultValue: '描边' })}
          >
            <StrokeColorSwatch color={color} />
          </ColorPanelPopover>
        ) : (
          <>
            <ColorPanelPopover
              {...colorPanelProps}
              value={fillColor}
              onChange={(hex) => setPenFillColor(hex)}
              showAlpha
              title={t('editor.fill', { defaultValue: '背景' })}
            >
              <FillColorSwatch color={fillColor} />
            </ColorPanelPopover>
            <ColorPanelPopover
              {...colorPanelProps}
              value={color}
              onChange={(hex) => setPenStrokeColor(hex)}
              title={t('editor.stroke', { defaultValue: '描边' })}
            >
              <StrokeColorSwatch color={color} />
            </ColorPanelPopover>
          </>
        )}

        <span className="mx-0.5 h-3.5 w-px bg-[var(--line)]" aria-hidden />

        <label
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-[4px] bg-[var(--accent-soft)] px-1.5"
          onPointerDown={(e) => e.stopPropagation()}
          title={isPencil ? t('editor.pencilBrushSize') : t('editor.pencilBrushWidth')}
        >
          <Icon name="editor-stroke-weight" className="h-3.5 w-3.5 shrink-0 text-[var(--ink)]" />
          <input
            type="number"
            min={1}
            max={200}
            value={width}
            onChange={(e) => pinStrokeWidth(Number(e.target.value))}
            step={1}
            className="h-full w-10 min-w-0 bg-transparent text-[11px] leading-none tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <span className="shrink-0 text-[10px] text-[var(--muted)]">{t('editor.unitPx')}</span>
        </label>

        <span className="mx-0.5 h-3.5 w-px bg-[var(--line)]" aria-hidden />
        <Tooltip tip={`${t('editor.pathEditExit')} (Esc)`} placement={tipSide}>
          <button
            type="button"
            aria-label={t('editor.pathEditExit')}
            onClick={exitPenEdit}
            onPointerDown={(e) => e.stopPropagation()}
            className="inline-flex h-6 items-center justify-center rounded-md px-2 text-[12px] text-[var(--ink)] transition-colors hover:bg-[var(--accent-soft)]"
          >
            {t('editor.pathEditExit')}
          </button>
        </Tooltip>
      </FloatingToolbar>
    </div>
  );
}

export default memo(PenStrokeToolbar);
