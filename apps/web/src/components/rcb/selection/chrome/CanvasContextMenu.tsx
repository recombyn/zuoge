import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  memo,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { HiOutlineChevronRight } from 'react-icons/hi2';

/** Absorb the browser click that lands under a just-unmounted menu / backdrop. */
const CLICK_THROUGH_GUARD_MS = 320;

type CtxAction =
  | 'upload'
  | 'replace'
  | 'addToChat'
  | 'spawnImageGenerator'
  | 'spawnVideoGenerator'
  | 'spawnAudioGenerator'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'duplicate'
  | 'group'
  | 'ungroup'
  | 'front'
  | 'forward'
  | 'backward'
  | 'back'
  | 'toggleHidden'
  | 'toggleLocked'
  | 'exportPng'
  | 'exportJpg'
  | 'exportSvg'
  | 'exportMp4'
  | 'exportMp3'
  | 'delete';

type GeneratorPickAction =
  | 'spawnImageGenerator'
  | 'spawnVideoGenerator'
  | 'spawnAudioGenerator';

export type ContextMenuState = {
  clientX: number;
  clientY: number;
  sceneX: number;
  sceneY: number;
  nodeId: string | null;
  /** Artboard under cursor / selected when opening the menu. */
  frameId?: string | null;
};

type CanvasContextMenuProps = {
  menu: ContextMenuState | null;
  hasNode: boolean;
  /** Enable 「替换」 for a single image / video node. */
  canReplace?: boolean;
  /** Enable 「添加到 Chat」 for selected node or artboard. */
  canAddToChat?: boolean;
  /** Nodes or active artboard frame. */
  canDelete?: boolean;
  /** Show/hide + lock — node or frame target. */
  canLayerActions?: boolean;
  /** Export selection — false for image/video-generator plates (no pixels to export). */
  canExport?: boolean;
  /** Show/hide — false for generator-only selection. */
  canToggleHidden?: boolean;
  /** Lock — false for generator-only selection (frames still ok). */
  canToggleLocked?: boolean;
  /** Current visibility of the menu target (all hidden → show action). */
  targetHidden?: boolean;
  /** Current lock of the menu target (all locked → unlock action). */
  targetLocked?: boolean;
  /** Video-only selection → MP4 / MP3 instead of PNG / JPG / SVG. */
  exportKind?: 'image' | 'video';
  /** Box / multi-select that is not already one shared group. */
  canGroup?: boolean;
  /** Selection is exactly one shared group. */
  canUngroup?: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canPaste?: boolean;
  /** Cut / copy / duplicate / reorder / group — false while upload or AI process is running. */
  canMutateSelection?: boolean;
  modLabel: string;
  onAction: (action: CtxAction) => void;
  onClose: () => void;
};

const itemClass =
  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[var(--ink)] hover:bg-[var(--accent-soft)] disabled:pointer-events-none disabled:opacity-40';

const PAD = 8;

type ExportPickAction =
  | 'exportPng'
  | 'exportJpg'
  | 'exportSvg'
  | 'exportMp4'
  | 'exportMp3';

function clampFixedMenuPos(opts: {
  left: number;
  top: number;
  menuW: number;
  menuH: number;
}): { left: number; top: number } {
  const viewW = Math.max(1, window.innerWidth);
  const viewH = Math.max(1, window.innerHeight);
  const h = Math.max(1, opts.menuH);
  const w = Math.min(Math.max(1, opts.menuW), Math.max(1, viewW - PAD * 2));
  let left = opts.left;
  let top = opts.top;
  if (left + w > viewW - PAD) left = viewW - PAD - w;
  if (left < PAD) left = PAD;
  if (top + h > viewH - PAD) top = viewH - PAD - h;
  if (top < PAD) top = PAD;
  return { left, top };
}

function exportFlyoutHeight(kind: 'image' | 'video') {
  return kind === 'video' ? 88 : 120;
}

function ExportFormatButtons({
  kind,
  onPick,
}: {
  kind: 'image' | 'video';
  onPick: (action: ExportPickAction) => void;
}) {
  if (kind === 'video') {
    return (
      <>
        <button type="button" className={itemClass} onClick={() => onPick('exportMp4')}>
          MP4
        </button>
        <button type="button" className={itemClass} onClick={() => onPick('exportMp3')}>
          MP3
        </button>
      </>
    );
  }
  return (
    <>
      <button type="button" className={itemClass} onClick={() => onPick('exportPng')}>
        PNG
      </button>
      <button type="button" className={itemClass} onClick={() => onPick('exportJpg')}>
        JPG
      </button>
      <button type="button" className={itemClass} onClick={() => onPick('exportSvg')}>
        SVG
      </button>
    </>
  );
}

function MenuItem({
  label,
  shortcut,
  disabled,
  onClick,
}: {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={itemClass}
      disabled={disabled}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcut ? (
        <kbd className="shrink-0 text-[10px] text-[var(--muted)]">{shortcut}</kbd>
      ) : null}
    </button>
  );
}

const GENERATOR_MENU_SHORTCUT: Record<GeneratorPickAction, string> = {
  spawnImageGenerator: 'A',
  spawnVideoGenerator: 'Shift A',
  spawnAudioGenerator: 'U',
};

function GeneratorFlyoutButtons({
  onPick,
}: {
  onPick: (action: GeneratorPickAction) => void;
}) {
  const { t } = useTranslation();
  // Match toolbar Generators: image / video / audio only (animation + Lottie elsewhere).
  const rows: Array<{ action: GeneratorPickAction; label: string }> = [
    {
      action: 'spawnImageGenerator',
      label: t('editor.tools.imageGenerator'),
    },
    {
      action: 'spawnVideoGenerator',
      label: t('editor.tools.videoGenerator'),
    },
    {
      action: 'spawnAudioGenerator',
      label: t('editor.tools.audioGenerator'),
    },
  ];
  return (
    <>
      {rows.map((row) => (
        <MenuItem
          key={row.action}
          label={row.label}
          shortcut={GENERATOR_MENU_SHORTCUT[row.action] || undefined}
          onClick={() => onPick(row.action)}
        />
      ))}
    </>
  );
}

function GeneratorSubmenu({
  onPick,
}: {
  onPick: (action: GeneratorPickAction) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [flyoutPos, setFlyoutPos] = useState<{ left: number; top: number } | null>(null);

  const clearCloseTimer = () => {
    if (closeTimerRef.current == null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };

  const scheduleClose = () => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
    }, 120);
  };

  const openMenu = () => {
    clearCloseTimer();
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!open || !rowRef.current) {
      setFlyoutPos(null);
      return;
    }
    const rect = rowRef.current.getBoundingClientRect();
    const flyoutW = 216;
    const flyoutH = 152;
    const preferRight = window.innerWidth - rect.right >= flyoutW + 8;
    const left = preferRight ? rect.right + 4 : Math.max(PAD, rect.left - flyoutW - 4);
    let top = rect.top;
    if (top + flyoutH > window.innerHeight - PAD) {
      top = Math.max(PAD, rect.bottom - flyoutH);
    }
    setFlyoutPos({ left, top });
  }, [open]);

  useEffect(
    () => () => {
      clearCloseTimer();
    },
    []
  );

  const pick = (action: GeneratorPickAction) => {
    clearCloseTimer();
    setOpen(false);
    onPick(action);
  };

  const showFlyout = open && flyoutPos;

  return (
    <div
      ref={rowRef}
      className="relative"
      onMouseEnter={openMenu}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className={itemClass}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (open) {
            setOpen(false);
            return;
          }
          openMenu();
        }}
      >
        <span className="min-w-0 flex-1 truncate">{t('editor.contextMenu.generators')}</span>
        <HiOutlineChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--muted)]" />
      </button>
      {showFlyout
        ? createPortal(
            <div
              role="menu"
              data-ctx-menu-flyout
              className="fixed z-[80] min-w-[13.5rem] overflow-hidden rounded-xl bg-[var(--surface)] py-1 shadow-lg ring-1 ring-[var(--line)]"
              style={{ left: flyoutPos.left, top: flyoutPos.top }}
              onMouseEnter={openMenu}
              onMouseLeave={scheduleClose}
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              <GeneratorFlyoutButtons onPick={pick} />
            </div>,
            window.document.body
          )
        : null}
    </div>
  );
}

function ExportSubmenu({
  disabled,
  kind = 'image',
  onPick,
}: {
  disabled?: boolean;
  kind?: 'image' | 'video';
  onPick: (action: ExportPickAction) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [flyoutPos, setFlyoutPos] = useState<{ left: number; top: number } | null>(null);

  const clearCloseTimer = () => {
    if (closeTimerRef.current == null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };

  const scheduleClose = () => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
    }, 120);
  };

  const openMenu = () => {
    if (disabled) return;
    clearCloseTimer();
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!open || !rowRef.current) {
      setFlyoutPos(null);
      return;
    }
    const rect = rowRef.current.getBoundingClientRect();
    const flyoutW = 128;
    const flyoutH = exportFlyoutHeight(kind);
    const preferRight = window.innerWidth - rect.right >= flyoutW + 8;
    const left = preferRight ? rect.right + 4 : Math.max(PAD, rect.left - flyoutW - 4);
    let top = rect.top;
    if (top + flyoutH > window.innerHeight - PAD) {
      top = Math.max(PAD, rect.bottom - flyoutH);
    }
    setFlyoutPos({ left, top });
  }, [kind, open]);

  useEffect(
    () => () => {
      clearCloseTimer();
    },
    []
  );

  const pick = (action: ExportPickAction) => {
    clearCloseTimer();
    setOpen(false);
    onPick(action);
  };

  const showFlyout = open && !disabled && flyoutPos;

  return (
    <div
      ref={rowRef}
      className="relative"
      onMouseEnter={openMenu}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className={itemClass}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open && !disabled}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (disabled) return;
          if (open) {
            setOpen(false);
            return;
          }
          openMenu();
        }}
      >
        <span className="min-w-0 flex-1 truncate">{t('editor.contextMenu.export')}</span>
        <HiOutlineChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--muted)]" />
      </button>
      {showFlyout
        ? createPortal(
            <div
              role="menu"
              data-ctx-menu-flyout
              className="fixed z-[80] min-w-[8rem] overflow-hidden rounded-xl bg-[var(--surface)] py-1 shadow-lg ring-1 ring-[var(--line)]"
              style={{ left: flyoutPos.left, top: flyoutPos.top }}
              onMouseEnter={openMenu}
              onMouseLeave={scheduleClose}
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              <ExportFormatButtons kind={kind} onPick={pick} />
            </div>,
            window.document.body
          )
        : null}
    </div>
  );
}

/** Right-click menu — `fixed` on body with viewport client coords (not scene space). */
function CanvasContextMenu({
  menu,
  hasNode,
  canReplace = false,
  canAddToChat,
  canDelete,
  canLayerActions,
  canExport,
  canToggleHidden,
  canToggleLocked,
  targetHidden = false,
  targetLocked = false,
  exportKind = 'image',
  canGroup = false,
  canUngroup = false,
  canUndo,
  canRedo,
  canPaste = false,
  canMutateSelection = true,
  modLabel,
  onAction,
  onClose,
}: CanvasContextMenuProps) {
  const { t } = useTranslation();
  const deleteEnabled = canDelete ?? hasNode;
  const addToChatEnabled = canAddToChat ?? hasNode;
  const layerEnabled = canLayerActions ?? hasNode;
  const exportEnabled = canExport ?? layerEnabled;
  const hideEnabled = canToggleHidden ?? hasNode;
  const lockEnabled = canToggleLocked ?? layerEnabled;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // Keep a full-screen shield after dismiss so the leftover click cannot hit
  // the bottom tool strip under Delete / Export (classic menu click-through).
  const [guardOpen, setGuardOpen] = useState(false);
  const guardTimerRef = useRef<number | null>(null);

  const armClickThroughGuard = () => {
    setGuardOpen(true);
    if (guardTimerRef.current != null) window.clearTimeout(guardTimerRef.current);
    guardTimerRef.current = window.setTimeout(() => {
      guardTimerRef.current = null;
      setGuardOpen(false);
    }, CLICK_THROUGH_GUARD_MS);
  };

  const runAction = (action: CtxAction) => {
    armClickThroughGuard();
    onAction(action);
  };

  const dismiss = () => {
    armClickThroughGuard();
    onClose();
  };

  const stopPanelPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
  };

  const onBackdropPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const target = e.target as HTMLElement | null;
    if (target?.closest?.('[data-ctx-menu-flyout]')) return;
    if (menu) dismiss();
  };

  const visibilityLabel = targetHidden
    ? t('editor.contextMenu.show')
    : t('editor.contextMenu.hide');
  const lockLabel = targetLocked
    ? t('editor.contextMenu.unlock')
    : t('editor.contextMenu.lock');

  useLayoutEffect(() => {
    if (!menu) {
      setPos(null);
      return;
    }
    const el = panelRef.current;
    setPos(
      clampFixedMenuPos({
        left: menu.clientX,
        top: menu.clientY,
        menuW: el?.offsetWidth || 200,
        menuH: el?.offsetHeight || 420,
      })
    );
  }, [menu]);

  useEffect(() => {
    if (!menu) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      armClickThroughGuard();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // armClickThroughGuard is local and always fresh enough for Escape dismiss
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, onClose]);

  useEffect(
    () => () => {
      if (guardTimerRef.current != null) window.clearTimeout(guardTimerRef.current);
    },
    []
  );

  if (!menu && !guardOpen) return null;

  return createPortal(
    <>
      <div
        data-ctx-menu
        className="fixed inset-0 z-[60]"
        onPointerDown={onBackdropPointerDown}
        aria-hidden
      />
      {menu ? (
        <div
          ref={panelRef}
          data-ctx-menu
          data-ctx-menu-panel
          className="fixed z-[70] min-w-[200px] overflow-hidden rounded-xl bg-[var(--surface)] py-1 shadow-lg ring-1 ring-[var(--line)]"
          style={{
            left: pos?.left ?? menu.clientX,
            top: pos?.top ?? menu.clientY,
          }}
          onPointerDown={stopPanelPointer}
          onPointerUp={stopPanelPointer}
        >
          <MenuItem
            label={t('editor.contextMenu.addToChat')}
            shortcut={`${modLabel}+Shift+L`}
            disabled={!addToChatEnabled}
            onClick={() => runAction('addToChat')}
          />
          <MenuItem
            label={t('editor.contextMenu.uploadMedia')}
            shortcut={`${modLabel}+Shift+I`}
            disabled={Boolean(menu.nodeId)}
            onClick={() => runAction('upload')}
          />
          {canReplace ? (
            <MenuItem
              label={t('editor.contextMenu.replaceMedia')}
              onClick={() => runAction('replace')}
            />
          ) : null}
          <GeneratorSubmenu onPick={(action) => runAction(action)} />
          <MenuItem
            label={t('editor.contextMenu.undo')}
            shortcut={`${modLabel}+Z`}
            disabled={!canUndo}
            onClick={() => runAction('undo')}
          />
          <MenuItem
            label={t('editor.contextMenu.redo')}
            shortcut={`${modLabel}+Y`}
            disabled={!canRedo}
            onClick={() => runAction('redo')}
          />
          <div className="my-1 h-px bg-[var(--line)]" />
          <MenuItem
            label={t('editor.contextMenu.cut')}
            shortcut={`${modLabel}+X`}
            disabled={!hasNode || !canMutateSelection}
            onClick={() => runAction('cut')}
          />
          <MenuItem
            label={t('editor.contextMenu.copy')}
            shortcut={`${modLabel}+C`}
            disabled={!hasNode || !canMutateSelection}
            onClick={() => runAction('copy')}
          />
          <MenuItem
            label={t('editor.contextMenu.duplicate')}
            shortcut={`${modLabel}+D`}
            disabled={!hasNode || !canMutateSelection}
            onClick={() => runAction('duplicate')}
          />
          <MenuItem
            label={t('editor.contextMenu.paste')}
            shortcut={`${modLabel}+V`}
            disabled={!canPaste}
            onClick={() => runAction('paste')}
          />
          <div className="my-1 h-px bg-[var(--line)]" />
          <MenuItem
            label={t('editor.contextMenu.group')}
            shortcut={`${modLabel}+G`}
            disabled={!canGroup || !canMutateSelection}
            onClick={() => runAction('group')}
          />
          <MenuItem
            label={t('editor.contextMenu.ungroup')}
            shortcut={`${modLabel}+Shift+G`}
            disabled={!canUngroup || !canMutateSelection}
            onClick={() => runAction('ungroup')}
          />
          <div className="my-1 h-px bg-[var(--line)]" />
          <MenuItem
            label={t('editor.contextMenu.bringToFront')}
            shortcut="]"
            disabled={!hasNode || !canMutateSelection}
            onClick={() => runAction('front')}
          />
          <MenuItem
            label={t('editor.contextMenu.bringForward')}
            shortcut={`${modLabel}+]`}
            disabled={!hasNode || !canMutateSelection}
            onClick={() => runAction('forward')}
          />
          <MenuItem
            label={t('editor.contextMenu.sendBackward')}
            shortcut={`${modLabel}+[`}
            disabled={!hasNode || !canMutateSelection}
            onClick={() => runAction('backward')}
          />
          <MenuItem
            label={t('editor.contextMenu.sendToBack')}
            shortcut="["
            disabled={!hasNode || !canMutateSelection}
            onClick={() => runAction('back')}
          />
          <div className="my-1 h-px bg-[var(--line)]" />
          <MenuItem
            label={visibilityLabel}
            shortcut={`${modLabel}+Shift+H`}
            disabled={!hideEnabled || !canMutateSelection}
            onClick={() => runAction('toggleHidden')}
          />
          <MenuItem
            label={lockLabel}
            shortcut={`${modLabel}+Shift+K`}
            disabled={!lockEnabled || !canMutateSelection}
            onClick={() => runAction('toggleLocked')}
          />
          <div className="my-1 h-px bg-[var(--line)]" />
          <ExportSubmenu
            disabled={!exportEnabled}
            kind={exportKind}
            onPick={(action) => runAction(action)}
          />
          <div className="my-1 h-px bg-[var(--line)]" />
          <MenuItem
            label={t('editor.contextMenu.delete')}
            shortcut="Del"
            disabled={!deleteEnabled}
            onClick={() => runAction('delete')}
          />
        </div>
      ) : null}
    </>,
    document.body
  );
}

export type { CtxAction };

export default memo(CanvasContextMenu);
