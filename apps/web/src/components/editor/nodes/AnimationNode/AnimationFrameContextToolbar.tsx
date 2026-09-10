/**
 * — ——frame toolbar — plate chrome + shared playback strip.
 * Order: fill — — —transport — FPS — lock — export (last).
 * clipContent stays on by default — no overflow eye toggle.
 */
import { memo, useMemo, useState, type ReactNode } from 'react';
import { useSelector } from '@/store';
import { useEditorDocumentOnCommit } from '@/store/editorSelectors';
import { useTranslation } from 'react-i18next';
import {
  HiOutlineLockClosed,
  HiOutlineLockOpen,
} from 'react-icons/hi2';
import { ColorPanelPopover, FILL_ALPHA_PRESETS } from '@/components/base/colorPanel';
import Tooltip from '@/components/base/tooltip';
import { imageToolBtn, ImageToolSep } from '@/components/editor/nodes/ImageNode/imageToolbarShared';
import AnimationToolbarEditTools from '@/components/editor/nodes/AnimationNode/AnimationToolbarEditTools';
import { findFrameAnimationMediaId } from '@/components/editor/nodes/AnimationNode/resolveAnimationFrameId';
import { ExportSelectionPopover } from '@/components/editor/panels/ExportSelectionPanel';
import {
  closeAnimationFramePanel,
  ensureAnimationFrameMedia,
  openLottieTimelinePanel,
  updateArtboardFrame,
  type ArtboardFrame,
} from '@/store/modules/editor';
import store from '@/store';
import { SEL_ICON_BTN, SEL_SIZE_INPUT } from '@/components/rcb/selection/chrome/ToolbarValueSlider';
import { SelectionToolbarShell } from '@/components/rcb/selection/chrome/SelectionToolbarShell';
import { cn } from '@/utils/classnames';

type Props = {
  frame: ArtboardFrame;
  box?: { left: number; top: number; width: number; height: number };
};

const TOOL_ICON_SLOT =
  'pointer-events-none inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center [&>svg]:block [&>svg]:h-full [&>svg]:w-full';

function ToolIconSlot({ children }: { children: ReactNode }) {
  return <span className={TOOL_ICON_SLOT}>{children}</span>;
}

function Tool({
  label,
  onClick,
  children,
  tip,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  tip?: string;
}) {
  const btn = (
    <button type="button" className={cn(imageToolBtn)} onClick={onClick}>
      <ToolIconSlot>{children}</ToolIconSlot>
      <span>{label}</span>
    </button>
  );
  if (!tip) return btn;
  return (
    <Tooltip tip={tip} placement="top">
      {btn}
    </Tooltip>
  );
}

function LottieFrameContextToolbar({ frame, box }: Props) {
  const { t } = useTranslation();  const document = useEditorDocumentOnCommit();
  const timelinePanel = useSelector(
    (s: any) => s.editor.lottieTimelinePanel as null | { nodeId: string }
  );
  const mediaId = useMemo(
    () => findFrameAnimationMediaId(document, frame.id),
    [document, frame.id]
  );
  const mediaNode = mediaId ? document?.deltaSetLike?.[mediaId] : null;
  const loop = !(
    mediaNode?.attrs?.lottieLoop === false ||
    mediaNode?.attrs?.lottieLoop === 'false' ||
    mediaNode?.attrs?.lottieLoop === 0 ||
    mediaNode?.attrs?.lottieLoop === '0'
  );
  const speed = Math.max(0.25, Number(mediaNode?.attrs?.lottieSpeed) || 1);

  const canvasLocked = Boolean(frame.locked);
  const timelineOpen = Boolean(timelinePanel?.nodeId);

  const patch = (next: Partial<ArtboardFrame>) => {
    updateArtboardFrame({ id: frame.id, patch: next });
  };

  const onTimeline = () => {
    ensureAnimationFrameMedia({ frameId: frame.id });
    const id =
      findFrameAnimationMediaId(store.getState()?.editor?.document, frame.id) ||
      mediaId;
    if (!id) return;
    closeAnimationFramePanel();
    openLottieTimelinePanel({ nodeId: id });
  };

  const fill = frame.backgroundColor || '#FFFFFF';
  const fillHex = fill === 'transparent' ? '#FFFFFF' : fill;
  const fillOpacity =
    fill === 'transparent'
      ? 0
      : Math.max(0, Math.min(100, Number(frame.backgroundOpacity ?? 100)));
  const resolveFrameColorForOpacity = (opacity: number) => {
    if (opacity <= 0) return 'transparent';
    if (frame.backgroundColor === 'transparent') return '#FFFFFF';
    return frame.backgroundColor || '#FFFFFF';
  };

  const fps = Math.max(1, Math.round(Number(frame.fps) || 30));
  const [fpsDraft, setFpsDraft] = useState<string | null>(null);

  // Bottom timeline dock owns transport — hide floating bar so the two don't stack.
  if (timelineOpen) return null;
  // Plate already deleted (stale selection / Kit AABB lag) — do not leave the strip.
  if (!document?.frames?.some((f) => String(f?.id) === String(frame.id))) {
    return null;
  }

  return (
    <SelectionToolbarShell
      box={box || { left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
      hasTitleLabel
      isFrameToolbar
      zIndexClassName="z-[30]"
    >
      <ColorPanelPopover
        value={fillHex}
        opacity={fillOpacity}
        showAlpha
        presets={FILL_ALPHA_PRESETS}
        onChange={(hex) => {
          if (hex === 'transparent') {
            patch({ backgroundColor: 'transparent', backgroundOpacity: 0 });
            return;
          }
          patch({
            backgroundColor: hex,
            backgroundOpacity: fillOpacity > 0 ? fillOpacity : 100,
          });
        }}
        onOpacityChange={(opacity) => {
          const nextOpacity = Math.max(0, Math.min(100, Math.round(opacity)));
          const nextColor = resolveFrameColorForOpacity(nextOpacity);
          patch({ backgroundColor: nextColor, backgroundOpacity: nextOpacity });
        }}
        title={t('editor.frameToolbar.canvasColor')}
        placement="bottom-start"
        className={SEL_ICON_BTN}
      >
        <span
          className="relative inline-flex h-3.5 w-3.5 overflow-hidden rounded-full ring-1 ring-[var(--line)]"
          style={{ background: fill === 'transparent' ? undefined : fill }}
        >
          {fill === 'transparent' ? (
            <span
              aria-hidden
              className="absolute inset-0"
              style={{
                backgroundImage:
                  'linear-gradient(45deg,#9ca3af 25%,transparent 25%,transparent 75%,#9ca3af 75%),linear-gradient(45deg,#9ca3af 25%,transparent 25%,transparent 75%,#9ca3af 75%)',
                backgroundSize: '6px 6px',
                backgroundPosition: '0 0, 3px 3px',
              }}
            />
          ) : null}
        </span>
      </ColorPanelPopover>
      {mediaId ? (
        <AnimationToolbarEditTools nodeId={mediaId} loop={loop} speed={speed} />
      ) : (
        <>
          <Tool
            label={t('editor.lottieToolbar.timeline')}
            tip={t('editor.lottieToolbar.timelineTip')}
            onClick={onTimeline}
          >
            <span
              aria-hidden
              className="block h-2.5 w-2.5 shrink-0 rotate-45 border-[1.5px] border-current bg-transparent"
            />
          </Tool>
        </>
      )}
      <ImageToolSep />
      <label className="inline-flex h-8 items-center gap-1 rounded-md px-1.5 text-[11px] text-[var(--muted)]">
        FPS
        <input
          type="number"
          min={1}
          step={1}
          className={SEL_SIZE_INPUT}
          value={fpsDraft ?? String(fps)}
          onChange={(e) => setFpsDraft(e.target.value)}
          onBlur={() => {
            const n = Number(fpsDraft);
            setFpsDraft(null);
            if (!Number.isFinite(n)) return;
            const next = Math.max(1, Math.round(n));
            if (next === fps) return;
            patch({ fps: next });
            ensureAnimationFrameMedia({ frameId: frame.id });
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            (e.target as HTMLInputElement).blur();
          }}
        />
      </label>
      <ImageToolSep />
      <button
        type="button"
        className={SEL_ICON_BTN}
        title={
          canvasLocked
            ? t('editor.frameToolbar.unlockCanvas')
            : t('editor.frameToolbar.lockCanvas')
        }
        aria-label={
          canvasLocked
            ? t('editor.frameToolbar.unlockCanvas')
            : t('editor.frameToolbar.lockCanvas')
        }
        onClick={() => patch({ locked: !canvasLocked })}
      >
        {canvasLocked ? (
          <HiOutlineLockClosed className="h-3.5 w-3.5" />
        ) : (
          <HiOutlineLockOpen className="h-3.5 w-3.5" />
        )}
      </button>
      {mediaId ? (
        <>
          <ImageToolSep />
          <ExportSelectionPopover
            nodeIds={[mediaId]}
            triggerClassName={imageToolBtn}
            intent="animation"
            animationFrameId={frame.id}
            crop={{
              x: Number(frame.x) || 0,
              y: Number(frame.y) || 0,
              width: Math.max(1, Number(frame.width) || 1),
              height: Math.max(1, Number(frame.height) || 1),
              backgroundColor: frame.backgroundColor,
            }}
            baseName={String(frame.name || 'animation').trim() || 'animation'}
          />
        </>
      ) : null}
    </SelectionToolbarShell>
  );
}

export default memo(LottieFrameContextToolbar);
