import { useMemo, useState, type CSSProperties, type ReactNode, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { HiOutlineCheck, HiOutlineChevronDown } from 'react-icons/hi2';
import { MdOutlineOpacity } from 'react-icons/md';
import { Dropdown } from '@/components/base';
import type { MenuItemType } from '@/components/base/dropdown';
import { useSelector } from '@/store';
import {
  closeImageToolPanel,
  openImageToolPanel,
  type ImageToolPanelState,
} from '@/store/modules/editor';
import { cn } from '@/utils/classnames';
import { SEL_ICON_BTN_ACTIVE, SEL_TOOL_BTN } from './ToolbarValueSlider';

/** Layer blend modes (CSS mix-blend-mode). */
export type BlendModeId =
  | 'pass-through'
  | 'normal'
  | 'darken'
  | 'multiply'
  | 'color-burn'
  | 'lighten'
  | 'screen'
  | 'color-dodge'
  | 'overlay'
  | 'soft-light'
  | 'hard-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

export type BlendModeOption = {
  id: BlendModeId;
  groupStart?: boolean;
};

export const BLEND_MODE_OPTIONS: BlendModeOption[] = [
  { id: 'pass-through' },
  { id: 'normal' },
  { id: 'darken', groupStart: true },
  { id: 'multiply' },
  { id: 'color-burn' },
  { id: 'lighten', groupStart: true },
  { id: 'screen' },
  { id: 'color-dodge' },
  { id: 'overlay', groupStart: true },
  { id: 'soft-light' },
  { id: 'hard-light' },
  { id: 'difference', groupStart: true },
  { id: 'exclusion' },
  { id: 'hue', groupStart: true },
  { id: 'saturation' },
  { id: 'color' },
  { id: 'luminosity' },
];

const BLEND_MODE_SET = new Set(BLEND_MODE_OPTIONS.map((o) => o.id));

export function parseBlendMode(raw: unknown, opts?: { allowPassThrough?: boolean }): BlendModeId {
  const s = String(raw || '').trim().toLowerCase();
  const normalized =
    s === 'passthrough' || s === 'pass_through' ? 'pass-through' : s;
  if (BLEND_MODE_SET.has(normalized as BlendModeId)) {
    const id = normalized as BlendModeId;
    if (id === 'pass-through' && !opts?.allowPassThrough) return 'normal';
    return id;
  }
  return 'normal';
}

export function blendModeToCss(id: BlendModeId): string {
  if (id === 'pass-through') return '';
  return id;
}

export function parseLayerOpacity(raw: unknown, fallback = 1): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n > 1) return Math.min(1, Math.max(0, n / 100));
  return Math.min(1, Math.max(0, n));
}

export function layerOpacityToPct(opacity01: number): number {
  return Math.round(Math.min(1, Math.max(0, opacity01)) * 100);
}

/** Mini two-circle preview — monochrome so it matches the rest of the toolbar. */
export function BlendModeIcon({ mode, className }: { mode: BlendModeId; className?: string }) {
  const cssMode: CSSProperties['mixBlendMode'] =
    mode === 'pass-through' ? 'normal' : (mode as CSSProperties['mixBlendMode']);
  return (
    <span
      className={cn(
        'relative inline-block h-3.5 w-3.5 shrink-0 overflow-hidden rounded-[2px] bg-[var(--canvas)] ring-1 ring-[var(--line)]',
        className
      )}
      style={{ isolation: 'isolate' }}
      aria-hidden
    >
      <span
        className="absolute left-0 top-0 h-[10px] w-[10px] rounded-full"
        style={{ background: '#737373' }}
      />
      <span
        className="absolute bottom-0 right-0 h-[10px] w-[10px] rounded-full"
        style={{ background: '#b0b0b0', mixBlendMode: cssMode }}
      />
    </span>
  );
}

/**
 * Opens the same right-of-node OpacityToolPanel as images (via ImageToolPanelHost).
 * Multi-select without a single nodeId is not supported here — pass nodeId for side dock.
 */
export function OpacityControl({
  nodeId,
  className,
}: {
  /** Docks OpacityToolPanel to this node's top-right (same as image). */
  nodeId: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const imageToolPanel = useSelector(
    (s: any) => s.editor.imageToolPanel as ImageToolPanelState | null
  );
  const open =
    imageToolPanel?.kind === 'opacity' && imageToolPanel?.nodeId === nodeId;
  const opacityLabel = t('editor.imageToolbar.opacity');

  return (
    <div className={cn('inline-flex', className)}>
      <button
        type="button"
        aria-label={opacityLabel}
        aria-pressed={open}
        className={cn(SEL_TOOL_BTN, open && SEL_ICON_BTN_ACTIVE)}
        onClick={() => {
          if (open) closeImageToolPanel();
          else openImageToolPanel({ nodeId, kind: 'opacity' });
        }}
      >
        <MdOutlineOpacity className="h-4 w-4" />
        <span>{opacityLabel}</span>
      </button>
    </div>
  );
}

type Props = {
  blendMode?: unknown;
  /** Pass-through is only meaningful for groups/frames. */
  allowPassThrough?: boolean;
  onBlendModeChange: (mode: BlendModeId) => void;
  /** Single-node dock for opacity (same as image). */
  opacityNodeId?: string;
  /** Inserted between blend-mode dropdown and opacity (e.g. corner radius). */
  afterBlendSlot?: ReactNode;
  className?: string;
};

function BlendModeControl({
  blendMode,
  allowPassThrough = false,
  onBlendModeChange,
  opacityNodeId,
  afterBlendSlot,
  className,
}: Props) {
  const { t } = useTranslation();
  const [blendOpen, setBlendOpen] = useState(false);
  const mode = parseBlendMode(blendMode, { allowPassThrough });
  const labelOf = (id: BlendModeId) => t(`editor.blendMode.${id}`);

  const items: MenuItemType[] = useMemo(() => {
    const out: MenuItemType[] = [];
    for (const opt of BLEND_MODE_OPTIONS) {
      if (opt.id === 'pass-through' && !allowPassThrough) continue;
      if (opt.groupStart && out.length > 0) {
        out.push({ key: `div-${opt.id}`, type: 'divider', label: '' });
      }
      out.push({
        key: opt.id,
        label: (
          <span className="flex w-full items-center gap-2">
            <BlendModeIcon mode={opt.id} />
            <span className="min-w-0 flex-1 truncate">{labelOf(opt.id)}</span>
            {mode === opt.id ? (
              <HiOutlineCheck className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
            ) : (
              <span className="h-3.5 w-3.5 shrink-0" />
            )}
          </span>
        ),
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t + mode drive labels
  }, [mode, t, allowPassThrough]);

  return (
    <div className={cn('inline-flex h-8 items-center gap-0.5', className)}>
      <Dropdown
        trigger="click"
        open={blendOpen}
        onOpenChange={setBlendOpen}
        placement="bottom-start"
        offset={6}
        strategy="fixed"
        items={items}
        selectedKeys={[mode]}
        onClick={(key) => {
          if (key.startsWith('div-')) return;
          onBlendModeChange(parseBlendMode(key, { allowPassThrough }));
          setBlendOpen(false);
        }}
        popupClassName="min-w-[11rem] max-h-[min(70vh,22rem)] overflow-y-auto"
        floatingClassName="z-[80]"
        referenceClassName="inline-flex"
      >
        <button
          type="button"
          aria-label={t('editor.imageToolbar.blendMode')}
          aria-expanded={blendOpen}
          className={cn(
            'inline-flex h-8 max-w-[8.5rem] items-center gap-1.5 rounded-[4px] px-1.5 text-[12px] text-[var(--ink)] transition-colors hover:bg-[var(--accent-soft)]',
            blendOpen && 'bg-[var(--accent-soft)]'
          )}
        >
          <BlendModeIcon mode={mode} />
          <span className="min-w-0 truncate">{labelOf(mode)}</span>
          <HiOutlineChevronDown className="h-3.5 w-3.5 shrink-0 text-current" />
        </button>
      </Dropdown>
      {afterBlendSlot}
      {opacityNodeId ? (
        <OpacityControl nodeId={opacityNodeId} />
      ) : null}
    </div>
  );
}

export default memo(BlendModeControl);
