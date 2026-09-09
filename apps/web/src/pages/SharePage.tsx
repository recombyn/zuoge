import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSelector } from '@/store';
import {
  useDocumentPatchToken,
  useEditorDocument,
  useLastPatchedNodeIds,
  useSceneReloadToken,
  useSelectedFrameIds,
  useSelectedNodeId,
  useSelectedNodeIds,
} from '@/store/editorSelectors';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { SceneDocument } from '@/components/rcb/sceneNode';
import { coerceSceneDocumentInput, parseAndValidateSceneJson } from '@/components/rcb/sceneNode';
import DevPropertiesPanel from '@/components/editor/panels/DevPropertiesPanel';
import {
  RCB_DEFAULT_CAMERA as DEFAULT_CAMERA,
  RCB_MAX_ZOOM,
  RCB_MIN_ZOOM,
  rcbFitCamera,
  zoomAtPoint,
  type RcbCamera as CanvasCamera,
} from '@/components/rcb';
import {
  advanceBootProgress,
  message,
  readBootProgress,
  resetBootProgress,
} from '@/components/base';
import EditorBootOverlay from '@/components/editor/chrome/EditorBootOverlay';
import {
  listSceneNodes,
  normalizeDocument
} from '@/components/rcb/scene/document/sceneDocument';
import {
  documentForSharePreview
} from '@/components/rcb/scene/document/mediaLifecycle';
import {
  isExportableSceneNode
} from '@/components/rcb/scene/document/nodeCapabilities';
import { nodeLeftTop } from '@/components/rcb/scene/layout/nodeLayout';
import {
  setActiveTool,
  setDocument,
  setSelectedNodeIds,
  setWorkspaceMode,
  applyCollabDocument,
  createTemplate,
  importDocument,
  type ArtboardFrame,
} from '@/store/modules/editor';
import { store } from '@/store';
import type { ShareDto } from '@/models/shares';
import { apiQuery } from '@/service/client';
import { prepareProjectsListNavigation } from '@/service/projects';
import { buildLoginUrl } from '@/utils/authReturnTo';
import { cssSolidWithOpacity } from '@/components/base/colorPanel';
import ShareTopChrome from '@/components/share/ShareTopChrome';
import SharePreviewStage from '@/components/share/SharePreviewStage';
import ShareGateStates from '@/components/share/ShareGateStates';

/** Preview tabs poll so linked shares pick up source-project edits without a hard refresh. */
const SHARE_PREVIEW_POLL_MS = 2500;
const BOOT_MIN_MS = 520;
const BOOT_EXIT_MS = 280;

type SceneBox = { x: number; y: number; width: number; height: number };

function useViewportMatch(query: string) {
  const read = () => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia(query).matches;
  };
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

function shareDocumentFingerprint(doc: unknown): string {
  try {
    return JSON.stringify(doc);
  } catch {
    return '';
  }
}

function unionSceneBox(a: SceneBox | null, b: SceneBox): SceneBox {
  if (!a) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/** Same as editor: artboards + finished scene nodes for zoom-to-fit (no generators). */
function previewContentBounds(doc: SceneDocument, frames: ArtboardFrame[]): SceneBox {
  let box: SceneBox | null = null;
  for (const f of frames) {
    box = unionSceneBox(box, {
      x: f.x,
      y: f.y,
      width: Math.max(1, f.width),
      height: Math.max(1, f.height),
    });
  }
  for (const { node } of listSceneNodes(doc)) {
    if (!isExportableSceneNode(node)) continue;
    const { left, top } = nodeLeftTop(doc, node);
    const w = Math.max(1, Number(node.width) || 0);
    const h = Math.max(1, Number(node.height) || 0);
    if (w < 2 && h < 2) continue;
    box = unionSceneBox(box, { x: left, y: top, width: w, height: h });
  }
  if (!box) return { x: 0, y: 0, width: 1200, height: 800 };
  return box;
}

/**
 * Public / ACL share viewer (preview / inspect).
 * Authorized editors redirect into the normal EditorPage.
 */
function SharePage() {
  const { shareId = '' } = useParams();
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const viewerId = useSelector((s: any) => s.auth?.user?.id as string | undefined);
  const document = useEditorDocument();
  const selectedNodeId = useSelectedNodeId();
  const selectedNodeIds = useSelectedNodeIds();
  const selectedFrameIds = useSelectedFrameIds();
  const documentPatchToken = useDocumentPatchToken();
  const lastPatchedNodeIds = useLastPatchedNodeIds();
  const sceneReloadToken = useSceneReloadToken();
  const [record, setRecord] = useState<ShareDto | null>(null);
  const [missing, setMissing] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [camera, setCamera] = useState<CanvasCamera>(DEFAULT_CAMERA);
  const [inspectOpen, setInspectOpen] = useState(true);
  const [zoomFitActive, setZoomFitActive] = useState(true);
  const [bootOpen, setBootOpen] = useState(true);
  const [bootExiting, setBootExiting] = useState(false);
  const [bootProgress, setBootProgress] = useState(() => Math.max(8, readBootProgress()));
  /** Narrow preview chrome: icon-only actions so title + buttons do not overlap. */
  const compactTopBar = useViewportMatch('(max-width: 900px)');
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageEl, setStageEl] = useState<HTMLElement | null>(null);
  const docFingerprintRef = useRef('');
  const hydratedShareIdRef = useRef<string | null>(null);
  const didInitialFitRef = useRef(false);
  const bootOpenRef = useRef(true);
  const bootFinishingRef = useRef(false);
  const bootStartedAt = useRef(Date.now());
  const bootExitTimer = useRef<number | null>(null);
  useEffect(() => {
    setStageEl(stageRef.current);
  }, []);

  const finishBoot = useCallback(() => {
    if (!bootOpenRef.current || bootFinishingRef.current) return;
    bootFinishingRef.current = true;
    const wait = Math.max(0, BOOT_MIN_MS - (Date.now() - bootStartedAt.current));
    window.setTimeout(() => {
      setBootProgress(advanceBootProgress(100));
      setBootExiting(true);
      bootExitTimer.current = window.setTimeout(() => {
        bootOpenRef.current = false;
        setBootOpen(false);
        setBootExiting(false);
        bootExitTimer.current = null;
        resetBootProgress();
      }, BOOT_EXIT_MS);
    }, wait);
  }, []);

  useEffect(() => {
    didInitialFitRef.current = false;
    bootOpenRef.current = true;
    bootFinishingRef.current = false;
    bootStartedAt.current = Date.now();
    setBootOpen(true);
    setBootExiting(false);
    resetBootProgress();
    setBootProgress(Math.max(8, readBootProgress()));
    setZoomFitActive(true);
    setCamera(DEFAULT_CAMERA);
    if (bootExitTimer.current) {
      window.clearTimeout(bootExitTimer.current);
      bootExitTimer.current = null;
    }
  }, [shareId]);

  useEffect(
    () => () => {
      if (bootExitTimer.current) window.clearTimeout(bootExitTimer.current);
    },
    []
  );

  useEffect(() => {
    if (!bootOpen || bootExiting) return undefined;
    const id = window.setInterval(() => {
      setBootProgress((p) => {
        if (p >= 90) return p;
        return advanceBootProgress(Math.min(90, p + 4 + Math.random() * 10));
      });
    }, 380);
    return () => window.clearInterval(id);
  }, [bootOpen, bootExiting]);

  useEffect(() => {
    if (!bootOpen) return undefined;
    const failSafe = window.setTimeout(() => finishBoot(), 12000);
    return () => window.clearTimeout(failSafe);
  }, [bootOpen, finishBoot]);

  const canEdit = Boolean(record?.viewerCanEdit);
  const canView = Boolean(record?.viewerCanView);
  /** Anyone who can open the share may export finished scene content (same gate as editor inspect). */
  const canExport = canView;
  const loginUrl = buildLoginUrl(location.pathname + location.search);

  const goProjectsFromShare = useCallback(() => {
    void (async () => {
      try {
        await prepareProjectsListNavigation();
      } catch {
        /* navigate anyway */
      }
      navigate('/home?nav=mine');
    })();
  }, [navigate]);

  const newProjectFromShare = useCallback(() => {
    navigate('/editor?createNew=1');
  }, [navigate]);

  const duplicateShareDocument = useCallback(() => {
    const doc = (store.getState() as any).editor?.document as SceneDocument | null;
    if (!doc) return;
    const baseName = record?.name || t('home.untitled');
    createTemplate({
        name: `${baseName} ${t('editor.projectMenu.duplicateSuffix')}`,
        document: structuredClone(doc),
        source: 'user',
      });
    const newId = (store.getState() as any).editor?.currentId;
    if (newId) navigate(`/editor/${encodeURIComponent(newId)}`, { replace: true });
  }, [navigate, record?.name, t]);

  const importJsonFromShare = useCallback(
    async (file: File) => {
      try {
        const text = await file.text();
        const validation = parseAndValidateSceneJson(text);
        if (validation.valid === false) {
          message.error(t('home.importJsonInvalid'));
          return;
        }
        importDocument({
            name: file.name.replace(/\.json$/i, ''),
            document: validation.data,
            source: 'import',
          });
        message.success(t('home.importSuccess'));
        const id = (store.getState() as any).editor?.currentId;
        if (id) navigate(`/editor/${encodeURIComponent(id)}`, { replace: true });
      } catch {
        message.error(t('home.importJsonFailed'));
      }
    },
    [navigate, t]
  );

  const shareMenuProps = {
    onProjectList: goProjectsFromShare,
    onNewProject: newProjectFromShare,
    onDuplicateProject: duplicateShareDocument,
    onImportJson: importJsonFromShare,
  };

  const zoomAtStageCenter = useCallback((nextZoom: number) => {
    const el = stageRef.current;
    if (!el) return;
    setZoomFitActive(false);
    setCamera((c) =>
      zoomAtPoint(c, nextZoom, el.clientWidth / 2, el.clientHeight / 2)
    );
  }, []);

  const onZoomIn = useCallback(() => {
    setZoomFitActive(false);
    setCamera((c) => {
      const el = stageRef.current;
      if (!el) return c;
      const next = Math.min(RCB_MAX_ZOOM, Number((c.zoom * 1.1).toFixed(4)));
      return zoomAtPoint(c, next, el.clientWidth / 2, el.clientHeight / 2);
    });
  }, []);

  const onZoomOut = useCallback(() => {
    setZoomFitActive(false);
    setCamera((c) => {
      const el = stageRef.current;
      if (!el) return c;
      const next = Math.max(RCB_MIN_ZOOM, Number((c.zoom / 1.1).toFixed(4)));
      return zoomAtPoint(c, next, el.clientWidth / 2, el.clientHeight / 2);
    });
  }, []);

  const onFitView = useCallback(() => {
    const el = stageRef.current;
    const vw = el?.clientWidth || 0;
    const vh = el?.clientHeight || 0;
    if (vw < 1 || vh < 1) return;
    const fr: ArtboardFrame[] = Array.isArray(document?.frames) ? document.frames : [];
    setCamera(rcbFitCamera({ width: vw, height: vh }, previewContentBounds(document, fr), 120, 1));
    setZoomFitActive(true);
  }, [document]);

  // Fit once when content is on the stage — do not re-fit when panels resize.
  useEffect(() => {
    if (!document || !record?.viewerCanView || canEdit) return;
    const el = stageRef.current || stageEl;
    if (!el || el.clientWidth < 40 || el.clientHeight < 40) return;
    if (didInitialFitRef.current) return;
    didInitialFitRef.current = true;
    onFitView();
    finishBoot();
  }, [document, record?.viewerCanView, canEdit, stageEl, onFitView, finishBoot]);

  const zoomPercent = Math.round(camera.zoom * 100);

  const onShareCameraChange = useCallback((next: CanvasCamera) => {
    setZoomFitActive(false);
    setCamera(next);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable
      ) {
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        onZoomIn();
        return;
      }
      if (mod && e.key === '-') {
        e.preventDefault();
        onZoomOut();
        return;
      }
      if (mod && e.key === '0') {
        e.preventDefault();
        zoomAtStageCenter(1);
        return;
      }
      if (e.shiftKey && !mod && !e.altKey && (e.key === '1' || e.code === 'Digit1')) {
        e.preventDefault();
        onFitView();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onFitView, onZoomIn, onZoomOut, zoomAtStageCenter]);

  const shareQuery = useQuery({
    ...apiQuery.sharesSharesGet.queryOptions({
      input: { params: { share_id: shareId } },
      enabled: Boolean(shareId),
    }),
    staleTime: 0,
  });
  const refetchShareRef = useRef(shareQuery.refetch);
  refetchShareRef.current = shareQuery.refetch;

  useEffect(() => {
    setMissing(false);
    setForbidden(false);
    setRecord(null);
    docFingerprintRef.current = '';
    hydratedShareIdRef.current = null;
  }, [shareId]);

  useEffect(() => {
    if (!shareId || shareQuery.isPending) return;
    if (shareQuery.isError) {
      setMissing(true);
      setRecord(null);
      return;
    }
    const res = shareQuery.data as { share?: ShareDto } | undefined;
    const s = res?.share;
    if (!s) {
      setMissing(true);
      return;
    }
    // Only edit-ACL links jump into the editor. View / download stay here.
    if (s.permission === 'edit' && s.viewerCanEdit) {
      const isOwner = Boolean(viewerId && s.ownerId === viewerId);
      const src = String(s.sourceProjectId || '').trim();
      const dest = isOwner && src ? src : s.id;
      navigate(`/editor/${encodeURIComponent(dest)}`, { replace: true });
      return;
    }
    if (!s.viewerCanView || !s.document) {
      setRecord(s);
      setForbidden(true);
      return;
    }
    setRecord(s);
    setForbidden(false);
    setMissing(false);
    const fp = shareDocumentFingerprint(s.document);
    const firstHydrate = hydratedShareIdRef.current !== shareId;
    if (!fp) return;
    if (!firstHydrate && fp === docFingerprintRef.current) return;
    docFingerprintRef.current = fp;
    const preview = documentForSharePreview(
      normalizeDocument(coerceSceneDocumentInput(s.document))
    );
    if (firstHydrate) {
      hydratedShareIdRef.current = shareId;
      setDocument(preview);
      setSelectedNodeIds([]);
      setWorkspaceMode('dev');
      setActiveTool('select');
    } else {
      applyCollabDocument(preview);
    }
  }, [
    shareId,
    shareQuery.data,
    shareQuery.isPending,
    shareQuery.isError, navigate,
    viewerId,
  ]);

  // Keep inspect mode sticky — other routes may flip workspaceMode back to design.
  useEffect(() => {
    setWorkspaceMode('dev');
    setActiveTool('select');
  }, [shareId]);

  // Keep preview in sync with the source project (API returns live doc when linked).
  useEffect(() => {
    if (!shareId || !record?.viewerCanView || missing || forbidden) return undefined;
    if (record.permission === 'edit' && record.viewerCanEdit) return undefined;
    const poll = () => {
      void refetchShareRef.current();
    };
    const timer = window.setInterval(poll, SHARE_PREVIEW_POLL_MS);
    window.addEventListener('focus', poll);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', poll);
    };
  }, [
    shareId,
    record?.viewerCanView,
    record?.permission,
    record?.viewerCanEdit,
    missing,
    forbidden,
  ]);

  const frames: ArtboardFrame[] = Array.isArray(document?.frames) ? document.frames : [];
  // Disable RcbCanvas one-shot autofit — we fit to finished scene content below.
  const worldBounds = { x: 0, y: 0, width: 0, height: 0 };
  const contentBounds = previewContentBounds(document, frames);
  const worldSurface = {
    x: 0,
    y: 0,
    width: Math.max(3600, contentBounds.x + contentBounds.width + 800, Number(document?.width) || 0),
    height: Math.max(2400, contentBounds.y + contentBounds.height + 800, Number(document?.height) || 0),
  };

  const stageBackground = useMemo(() => {
    const raw = String(document?.backgroundColor || '').trim();
    if (!raw || raw === 'none') return undefined;
    return cssSolidWithOpacity(raw, Number(document?.backgroundOpacity ?? 100));
  }, [document?.backgroundColor, document?.backgroundOpacity]);

  if (missing) {
    return <ShareGateStates kind="missing" loginUrl={loginUrl} {...shareMenuProps} />;
  }

  if (forbidden || (record && !canView)) {
    return (
      <ShareGateStates kind="forbidden" viewerId={viewerId} loginUrl={loginUrl} {...shareMenuProps} />
    );
  }

  if (!record || !document || canEdit) {
    return (
      <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[var(--canvas)]">
        <EditorBootOverlay progress={bootProgress} exiting={bootExiting} />
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[var(--canvas)]">
      <ShareTopChrome
        shareName={record.name}
        compactTopBar={compactTopBar}
        inspectOpen={inspectOpen}
        canExport={canExport}
        onToggleInspect={() => setInspectOpen((v) => !v)}
        {...shareMenuProps}
      />

      <div className="relative flex min-h-0 flex-1">
        <SharePreviewStage
          document={document}
          frames={frames}
          worldBounds={worldBounds}
          worldSurface={worldSurface}
          camera={camera}
          onCameraChange={onShareCameraChange}
          stageBackground={stageBackground}
          stageRef={stageRef}
          onViewportEl={setStageEl}
          stageEl={stageEl}
          sceneReloadToken={sceneReloadToken}
          documentPatchToken={documentPatchToken}
          lastPatchedNodeIds={lastPatchedNodeIds}
          selectedNodeId={selectedNodeId}
          selectedNodeIds={selectedNodeIds}
          selectedFrameIds={selectedFrameIds}
          zoomPercent={zoomPercent}
          zoomFitActive={zoomFitActive}
          onZoomIn={onZoomIn}
          onZoomOut={onZoomOut}
          onFitView={onFitView}
          zoomAtStageCenter={zoomAtStageCenter}
        />

        {inspectOpen ? (
          <DevPropertiesPanel
            onClose={() => setInspectOpen(false)}
            allowExport={canExport}
          />
        ) : null}
      </div>

      {bootOpen ? <EditorBootOverlay progress={bootProgress} exiting={bootExiting} /> : null}
    </div>
  );

}

export default memo(SharePage);
