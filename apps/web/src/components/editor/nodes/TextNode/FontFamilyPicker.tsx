import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, memo } from 'react';
import { useSelector } from '@/store';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
} from '@floating-ui/react';
import {
  HiOutlineChevronDown,
  HiOutlineMagnifyingGlass,
  HiOutlinePlus,
  HiOutlineTrash,
} from 'react-icons/hi2';
import { message, Dialog, Button } from '@/components/base';
import { DropdownPanelItem } from '@/components/base';
import {
  applyFontFamilySelection,
  fontDisplayName,
  getBaseFontFamily,
  getFontCatalogSync,
  getPreviewFontFamily,
  markMineFonts,
  reloadFontCatalog,
  type FontFamilyNode,
} from '@/components/rcb/scene/document/fontCatalog';
import {
  deleteUserFont,
  fontFileAccept,
  uploadUserFontFile,
  USER_FONT_LIMIT,
} from '@/service/fonts';
import { getHttpErrorMessage } from '@/service/client';
import { getToken } from '@/utils/token';
import { cn } from '@/utils/classnames';
import { SEL_TOOL_BTN } from '@/components/rcb/selection/chrome/ToolbarValueSlider';

type Props = {
  value: string;
  onChange: (next: { fontFamily: string; fontWeight: string }) => void;
  className?: string;
};

type UploadGate = 'login' | 'limit' | null;

type AuthSlice = { authed: boolean; userId?: string };

function selectAuthSlice(state: { auth?: { user?: { id?: string } } }): AuthSlice {
  const user = state.auth?.user;
  return { authed: Boolean(user && getToken()), userId: user?.id };
}

function getUploadGate(authed: boolean, atLimit: boolean): UploadGate {
  if (!authed) return 'login';
  if (atLimit) return 'limit';
  return null;
}

function uploadGateLabel(gate: UploadGate, t: TFunction, uploading: boolean): string {
  if (gate === 'login') return t('editor.fontLoginToUpload');
  if (gate === 'limit') return t('editor.fontUploadLimitReached', { limit: USER_FONT_LIMIT });
  if (uploading) return t('editor.fontUploading');
  return t('editor.fontUpload');
}

function showUploadGateToast(gate: UploadGate, t: TFunction): void {
  if (!gate) return;
  message.warning(uploadGateLabel(gate, t, false));
}

function fontUploadError(err: unknown, t: TFunction): string {
  const detail = getHttpErrorMessage(err, '').toLowerCase();
  if (detail.includes('font already uploaded')) return t('editor.fontAlreadyExists');
  if (detail.includes('font name already exists')) return t('editor.fontNameExists');
  return getHttpErrorMessage(err, t('editor.fontUploadFailed'));
}

function fileStem(name: string): string {
  return name.replace(/\.[^.]+$/, '').trim().toLowerCase();
}

function hasLocalDuplicateName(file: File, catalog: FontFamilyNode[]): boolean {
  const stem = fileStem(file.name);
  if (!stem) return false;
  return catalog.some((font) => {
    if (!font.isMine) return false;
    const family = String(font.family || '').toLowerCase();
    const display = String(font.displayName || '').toLowerCase();
    return family === stem || display === stem;
  });
}

function notifyFontCatalogUpdated(): void {
  try {
    window.dispatchEvent(new CustomEvent('recombyn:font-catalog-updated'));
  } catch {
    /* ignore */
  }
}

function sortFonts(fonts: FontFamilyNode[], query: string): FontFamilyNode[] {
  const q = query.trim().toLowerCase();
  const list = q
    ? fonts.filter(
        (f) => f.family.toLowerCase().includes(q) || f.displayName.toLowerCase().includes(q)
      )
    : fonts;
  return [...list].sort((a, b) => {
    if (Boolean(a.isMine) !== Boolean(b.isMine)) {
      if (a.isMine) return -1;
      return 1;
    }
    return fontDisplayName(a).localeCompare(fontDisplayName(b));
  });
}

function resetFileInput(input: HTMLInputElement | null): void {
  if (input) input.value = '';
}

const UPLOAD_BTN_BASE =
  'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition text-[var(--muted)]';
const UPLOAD_BTN_IDLE = 'hover:bg-[var(--accent-soft)] hover:text-[var(--ink)]';
const UPLOAD_BTN_BUSY = 'cursor-wait opacity-60';

/** Font picker: catalog from API + per-user uploads (max 10). */
function FontFamilyPicker({ value, onChange, className }: Props): ReactNode {
  const { t } = useTranslation();
  const { authed, userId } = useSelector(selectAuthSlice);
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<FontFamilyNode[]>(() => getFontCatalogSync());
  const [query, setQuery] = useState('');
  const [uploading, setUploading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<FontFamilyNode | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const userFontCount = useMemo(() => catalog.filter((f) => f.isMine).length, [catalog]);
  const uploadGate = getUploadGate(authed, userFontCount >= USER_FONT_LIMIT);
  const uploadTitle = uploadGateLabel(uploadGate, t, uploading);

  const applyCatalog = useCallback(
    (list: FontFamilyNode[]) => setCatalog(markMineFonts(list, userId)),
    [userId]
  );

  const refreshCatalog = useCallback(async () => {
    applyCatalog(await reloadFontCatalog());
    notifyFontCatalogUpdated();
  }, [applyCatalog]);

  useEffect(() => {
    let cancelled = false;
    void reloadFontCatalog().then((list) => {
      if (!cancelled) applyCatalog(list);
    });
    return () => {
      cancelled = true;
    };
  }, [authed, applyCatalog]);

  const base = getBaseFontFamily(value, catalog);
  const triggerLabel = fontDisplayName(
    catalog.find((f) => f.family === base) ?? { family: base, displayName: base }
  );
  const filtered = useMemo(() => sortFonts(catalog, query), [catalog, query]);
  const triggerFont = catalog.find((f) => f.family === base) ?? {
    family: base,
    displayName: base,
    children: [],
  };

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: (next) => {
      setOpen(next);
      if (!next) setQuery('');
    },
    placement: 'bottom-start',
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [offset(8), flip({ padding: 12 }), shift({ padding: 12 })],
  });
  const dismiss = useDismiss(context);
  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss]);

  const blockUpload = (): boolean => {
    if (!uploadGate) return false;
    showUploadGateToast(uploadGate, t);
    return true;
  };

  const pick = (font: FontFamilyNode) => {
    onChange(applyFontFamilySelection(font.family, catalog));
    setOpen(false);
    setQuery('');
  };

  const onUploadClick = () => {
    if (blockUpload()) return;
    fileInputRef.current?.click();
  };

  const onPickFile = async (file: File | null | undefined) => {
    if (!file || uploading || blockUpload()) return;
    if (hasLocalDuplicateName(file, catalog)) {
      message.warning(t('editor.fontNameExists'));
      resetFileInput(fileInputRef.current);
      return;
    }
    setUploading(true);
    try {
      const res = await uploadUserFontFile(file);
      await refreshCatalog();
      if (res.item?.family) {
        onChange(applyFontFamilySelection(res.item.family, getFontCatalogSync()));
      }
      message.success(t('editor.fontUploadOk'));
    } catch (err) {
      message.warning(fontUploadError(err, t));
    } finally {
      setUploading(false);
      resetFileInput(fileInputRef.current);
    }
  };

  const requestDelete = (font: FontFamilyNode, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!font.isMine || uploading) return;
    setDeleteTarget(font);
  };

  const confirmDelete = async () => {
    const font = deleteTarget;
    if (!font || uploading) return;
    setUploading(true);
    try {
      await deleteUserFont(font.family);
      await refreshCatalog();
      const latest = getFontCatalogSync();
      if (getBaseFontFamily(value, latest) === font.family) {
        const fallback = latest.find((f) => !f.isMine);
        if (fallback) onChange(applyFontFamilySelection(fallback.family, latest));
      }
      setDeleteTarget(null);
      message.success(t('editor.fontDeleteOk'));
    } catch (err) {
      const msg =
        err instanceof Error && err.message.trim()
          ? err.message
          : t('editor.fontDeleteFailed');
      message.error(msg);
    } finally {
      setUploading(false);
    }
  };

  const uploadBtnClass = cn(UPLOAD_BTN_BASE, uploading ? UPLOAD_BTN_BUSY : UPLOAD_BTN_IDLE);

  return (
    <>
      <button
        type="button"
        ref={refs.setReference}
        {...getReferenceProps({ onClick: () => setOpen((v) => !v) })}
        className={cn(
          SEL_TOOL_BTN,
          'max-w-[9rem] justify-between gap-1',
          open && 'bg-[var(--accent-soft)]',
          className
        )}
        aria-label={triggerLabel || t('editor.fontFamily')}
      >
        <span
          className="min-w-0 flex-1 truncate text-left"
          style={{ fontFamily: getPreviewFontFamily(triggerFont) }}
        >
          {triggerLabel || t('editor.fontFamily')}
        </span>
        <HiOutlineChevronDown
          className={cn(
            'h-3 w-3 shrink-0 text-current transition-transform',
            open && 'rotate-180'
          )}
        />
      </button>

      <input
        ref={fileInputRef}
        type="file"
        accept={fontFileAccept()}
        className="hidden"
        onChange={(e) => void onPickFile(e.target.files?.[0])}
      />

      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            className="z-[80] w-[260px] overflow-hidden rounded-xl bg-[var(--surface)] shadow-[0_12px_40px_rgba(15,23,42,0.18)] ring-1 ring-[var(--line)]"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="px-2.5 pb-2 pt-2">
              <div className="flex h-8 items-center gap-1 rounded-lg bg-[var(--canvas)] px-2 text-[var(--muted)]">
                <HiOutlineMagnifyingGlass className="h-3.5 w-3.5 shrink-0" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('editor.searchFonts')}
                  className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--ink)] outline-none placeholder:text-[var(--muted)]"
                />
                <button
                  type="button"
                  aria-label={uploadTitle}
                  title={uploadTitle}
                  disabled={uploading}
                  onClick={onUploadClick}
                  className={uploadBtnClass}
                >
                  <HiOutlinePlus className="h-3.5 w-3.5" strokeWidth={2} />
                </button>
              </div>
            </div>

            <div className="max-h-[280px] overflow-y-auto px-1 py-0.5">
              {filtered.length === 0 ? (
                <p className="px-2 py-4 text-left text-[12px] text-[var(--muted)]">
                  {t('editor.noFontsFound')}
                </p>
              ) : (
                filtered.map((font) => (
                  <FontRow
                    key={font.family}
                    font={font}
                    selected={font.family === base}
                    uploading={uploading}
                    t={t}
                    onPick={pick}
                    onRequestDelete={requestDelete}
                  />
                ))
              )}
            </div>
          </div>
        </FloatingPortal>
      )}

      <Dialog
        show={Boolean(deleteTarget)}
        onClose={() => {
          if (uploading) return;
          setDeleteTarget(null);
        }}
        width={400}
        title={t('editor.fontDeleteConfirmTitle')}
        titleClassName="!text-[16px] !font-semibold !pb-2"
        className="!bg-[var(--surface)] !p-5"
        bodyClassName="min-w-0"
        footer={
          <>
            <Button
              size="small"
              type="default"
              disabled={uploading}
              onClick={() => setDeleteTarget(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              size="small"
              type="primary"
              destructive
              loading={uploading}
              onClick={() => void confirmDelete()}
            >
              {t('common.delete')}
            </Button>
          </>
        }
      >
        <p className="min-w-0 text-[13px] leading-relaxed text-[var(--muted)]">
          {t('editor.fontDeleteConfirmBody')}
        </p>
        {deleteTarget ? (
          <p className="mt-2 min-w-0 break-all rounded-md bg-[var(--canvas)] px-2 py-1.5 text-[13px] font-medium leading-relaxed text-[var(--ink)]">
            {fontDisplayName(deleteTarget)}
          </p>
        ) : null}
      </Dialog>
    </>
  );
}

type FontRowProps = {
  font: FontFamilyNode;
  selected: boolean;
  uploading: boolean;
  t: TFunction;
  onPick: (font: FontFamilyNode) => void;
  onRequestDelete: (font: FontFamilyNode, e: MouseEvent) => void;
};

function FontRow({ font, selected, uploading, t, onPick, onRequestDelete }: FontRowProps) {
  const preview = getPreviewFontFamily(font);
  const deletable = Boolean(font.isMine);
  return (
    <div className="group relative flex items-stretch">
      <DropdownPanelItem
        selected={selected}
        onClick={() => onPick(font)}
        className={cn('text-[14px]', deletable && 'pr-8')}
        style={{ fontFamily: `'${preview}', ${preview}, sans-serif` }}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="min-w-0 truncate">{fontDisplayName(font)}</span>
          {deletable && (
            <span className="shrink-0 rounded px-1 text-[10px] text-[var(--muted)] ring-1 ring-[var(--line)]">
              {t('editor.fontMineBadge')}
            </span>
          )}
        </span>
      </DropdownPanelItem>
      {deletable && (
        <button
          type="button"
          aria-label={t('editor.fontDelete')}
          title={t('editor.fontDelete')}
          disabled={uploading}
          onClick={(e) => onRequestDelete(font, e)}
          className={cn(
            'absolute right-1 top-1/2 z-[1] inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-[var(--muted)] transition',
            'opacity-0 hover:bg-[var(--accent-soft)] hover:text-[var(--ink)] group-hover:opacity-100 focus-visible:opacity-100'
          )}
        >
          <HiOutlineTrash className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

export default memo(FontFamilyPicker);
