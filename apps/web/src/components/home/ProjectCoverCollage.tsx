import { useMemo, useState, useEffect, useRef, useCallback, type ReactNode, memo } from 'react';
import { SoftGlowSurface } from '@/components/base';
import TemplateThumbnail from '@/components/templates/TemplateThumbnail';
import LazyTemplateThumb from '@/components/home/LazyTemplateThumb';
import {
  projectThumbFrameClass,
  projectThumbZoomLayerClass,
  stableThumbnailSrcKey,
  withThumbCacheBust,
} from '@/utils/projectThumb';
import {
  extractFrameDocument,
  extractPlazaCoverDocument,
  findPlazaCoverFrame,
  listArtboardFrames,
} from '@/utils/plazaCover';
import {
  extractElementCoverDocument,
  pickCoverElementIds,
} from '@/utils/renderProjectThumbnail';
import { cn } from '@/utils/classnames';

const MAX_TILES = 4;
const IMG_TILE_LOAD_TIMEOUT_MS = 15_000;
const GRID_2_CLASS = 'absolute inset-0 grid grid-cols-2 gap-0 overflow-hidden';
const GRID_4_CLASS = 'absolute inset-0 grid grid-cols-2 grid-rows-2 gap-0 overflow-hidden';

export function normalizeThumbnailUrls(
  input: string | string[] | null | undefined
): string[] {
  if (Array.isArray(input)) {
    return input.map((u) => String(u || '').trim()).filter(Boolean).slice(0, MAX_TILES);
  }
  const one = String(input || '').trim();
  return one ? [one] : [];
}

type DocTile = { id: string; document: unknown };

function collectDocTiles(document: unknown): DocTile[] {
  if (!document || typeof document !== 'object') return [];

  const frames = listArtboardFrames(document);
  if (frames.length >= 2) {
    const out: DocTile[] = [];
    for (const frame of frames.slice(0, MAX_TILES)) {
      const id = String(frame.id || '').trim() || `frame-${out.length}`;
      const slice = extractFrameDocument(document, frame, { contentFit: true });
      if (slice) out.push({ id, document: slice });
    }
    return out;
  }

  const elementIds = pickCoverElementIds(document);
  if (elementIds.length) {
    const out: DocTile[] = [];
    for (const id of elementIds.slice(0, MAX_TILES)) {
      const slice = extractElementCoverDocument(document, id);
      if (slice) out.push({ id, document: slice });
    }
    if (out.length) return out;
  }

  const frame = findPlazaCoverFrame(document);
  const board = extractFrameDocument(document, frame, { contentFit: true });
  if (board) {
    return [{ id: String(frame?.id || 'board'), document: board }];
  }

  const full = extractPlazaCoverDocument(document, { contentFit: true });
  if (full) return [{ id: 'cover', document: full }];
  return [];
}

type Props = {
  /** Up to 4 cover image URLs from API. */
  urls?: string | string[] | null;
  version?: number | string | null;
  /** Live document — fallback when server URLs are missing or broken. */
  document?: unknown;
  /** Rasterize immediately (dialogs) — skip lazy intersection mount. */
  eager?: boolean;
  className?: string;
  children?: ReactNode;
};

type Mode = 'urls' | 'docs' | 'doc-full' | 'empty';

function CollageCells({
  count,
  renderCell,
}: {
  count: number;
  renderCell: (index: number, className?: string) => ReactNode;
}) {
  if (count <= 0) return null;
  if (count === 1) {
    return <div className="absolute inset-0 overflow-hidden">{renderCell(0)}</div>;
  }
  if (count === 2) {
    return (
      <div className={GRID_2_CLASS}>
        {renderCell(0)}
        {renderCell(1)}
      </div>
    );
  }
  if (count === 3) {
    return (
      <div className={GRID_4_CLASS}>
        {renderCell(0, 'row-span-2')}
        {renderCell(1)}
        {renderCell(2)}
      </div>
    );
  }
  return (
    <div className={GRID_4_CLASS}>
      {renderCell(0)}
      {renderCell(1)}
      {renderCell(2)}
      {renderCell(3)}
    </div>
  );
}

/**
 * Project card cover for 最近打开 / 我的项目 — multi `<img>` collage (max 4).
 * Layout: 1 full · 2 side-by-side · 3 tall-left · 4 = 2×2 flush grid (edge-to-edge fill).
 */
function ProjectCoverCollage({
  urls,
  version,
  document,
  eager = false,
  className,
  children,
}: Props) {
  const [urlTilesDead, setUrlTilesDead] = useState(false);
  const urlTiles = useMemo(
    () =>
      normalizeThumbnailUrls(urls)
        .map((u) => withThumbCacheBust(u, version))
        .filter(Boolean),
    [urls, version]
  );
  const docTiles = useMemo(() => collectDocTiles(document), [document]);
  const urlTilesKey = urlTiles.join('\0');

  useEffect(() => {
    setUrlTilesDead(false);
  }, [urlTilesKey]);

  const onUrlTilesDead = useCallback(() => {
    setUrlTilesDead(true);
  }, []);

  const { mode, imgList } = useMemo((): { mode: Mode; imgList: string[] } => {
    if (urlTiles.length >= 1 && !urlTilesDead) {
      return { mode: 'urls', imgList: urlTiles };
    }
    if (docTiles.length >= 1) return { mode: 'docs', imgList: [] };
    if (document) return { mode: 'doc-full', imgList: [] };
    return { mode: 'empty', imgList: [] };
  }, [urlTiles, urlTilesDead, docTiles, document]);

  if (mode === 'doc-full') {
    if (eager) {
      return (
        <div className={projectThumbFrameClass(className)}>
          <div className={cn('absolute inset-0', projectThumbZoomLayerClass)}>
            <TemplateThumbnail document={document} fit="cover" />
          </div>
          {children}
        </div>
      );
    }
    return (
      <LazyTemplateThumb document={document} fit="cover" className={className}>
        {children}
      </LazyTemplateThumb>
    );
  }

  let collage: ReactNode = null;
  if (mode === 'urls') {
    collage = <ImgCollage urls={imgList} eager={eager} onAllFailed={onUrlTilesDead} />;
  } else if (mode === 'docs') {
    collage = <DocCollage tiles={docTiles} eager={eager} />;
  }

  return (
    <div className={projectThumbFrameClass(className)}>
      {collage ? (
        <div className={cn('absolute inset-0', projectThumbZoomLayerClass)}>{collage}</div>
      ) : null}
      {children}
    </div>
  );
}

/** Grid cell: min-h-0 so tall imgs cannot blow past the 170px frame; overflow clips. */
function ImgTile({
  src,
  className,
  eager = false,
  onFailed,
}: {
  src: string;
  className?: string;
  eager?: boolean;
  onFailed?: () => void;
}) {
  const [errored, setErrored] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const loadTimerRef = useRef<number | null>(null);
  const srcKey = stableThumbnailSrcKey(src);

  const clearLoadTimer = () => {
    if (loadTimerRef.current != null) {
      window.clearTimeout(loadTimerRef.current);
      loadTimerRef.current = null;
    }
  };

  const failedRef = useRef(false);

  const reportFailed = useCallback(() => {
    if (failedRef.current) return;
    failedRef.current = true;
    onFailed?.();
  }, [onFailed]);

  useEffect(() => {
    failedRef.current = false;
    setErrored(false);
    setLoaded(false);
    clearLoadTimer();
    loadTimerRef.current = window.setTimeout(() => {
      setErrored(true);
      reportFailed();
    }, IMG_TILE_LOAD_TIMEOUT_MS);
    return clearLoadTimer;
  }, [reportFailed, srcKey]);

  if (errored) return null;
  return (
    <div className={cn('relative min-h-0 min-w-0 overflow-hidden', className)}>
      {!loaded ? (
        <SoftGlowSurface
          className="absolute inset-0 h-full w-full !rounded-none"
          seed={src}
          aria-hidden
        />
      ) : null}
      <img
        src={src}
        alt=""
        className={cn(
          // Slight overscale crops legacy shape-tile letterbox (~6% pad) without
          // waiting for cover re-upload; new edge-to-edge tiles stay near-full.
          'absolute inset-0 h-full w-full scale-[1.12] object-cover transition-opacity duration-200',
          loaded ? 'opacity-100' : 'opacity-0'
        )}
        loading={eager ? 'eager' : 'lazy'}
        onLoad={() => {
          clearLoadTimer();
          setLoaded(true);
        }}
        onError={() => {
          clearLoadTimer();
          setErrored(true);
          reportFailed();
        }}
      />
    </div>
  );
}

/** Multi-tile collage — always map ``thumbnailUrl`` list to ``<img>`` (max 4). */
function ImgCollage({
  urls,
  eager = false,
  onAllFailed,
}: {
  urls: string[];
  eager?: boolean;
  onAllFailed?: () => void;
}) {
  const list = urls.filter(Boolean).slice(0, MAX_TILES);
  const [failed, setFailed] = useState(0);

  useEffect(() => {
    setFailed(0);
  }, [list.join('\0')]);

  useEffect(() => {
    if (list.length > 0 && failed >= list.length) onAllFailed?.();
  }, [failed, list.length, onAllFailed]);

  const markFailed = useCallback(() => {
    setFailed((n) => n + 1);
  }, []);

  return (
    <CollageCells
      count={list.length}
      renderCell={(index, cellClass) => (
        <ImgTile
          key={list[index]}
          src={list[index]!}
          className={cellClass}
          eager={eager}
          onFailed={markFailed}
        />
      )}
    />
  );
}

function DocCollage({ tiles, eager = false }: { tiles: DocTile[]; eager?: boolean }) {
  const list = tiles.slice(0, MAX_TILES);
  return (
    <CollageCells
      count={list.length}
      renderCell={(index, cellClass) => {
        const tile = list[index]!;
        return (
          <div
            key={tile.id}
            className={cn('relative min-h-0 min-w-0 overflow-hidden', cellClass)}
          >
            <TemplateThumbnail document={tile.document} fit="cover" />
          </div>
        );
      }}
    />
  );
}

export default memo(ProjectCoverCollage);
