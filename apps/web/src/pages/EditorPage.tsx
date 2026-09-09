import { useCallback, useEffect, useMemo, useRef, useState, memo, useDeferredValue } from 'react';
import { useSelector } from '@/store';
import {
  useCurrentProjectId,
  useDocumentPatchToken,
  useEditorDocument,
  useEditorDocumentOnCommit,
  useLastPatchedNodeIds,
  useLastPatchTransformOnly,
  useSceneReloadToken,
  useSelectedFrameIds,
  useSelectedNodeId,
  useSelectedNodeIds,
} from '@/store/editorSelectors';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  message,
  advanceBootProgress,
  readBootProgress,
  resetBootProgress,
} from '@/components/base';
import type { SceneDocument } from '@/components/rcb/sceneNode';
import {
  peekHomeAgentBoot,
  clearHomeAgentBoot,
  attachmentsFromBoot,
  contextsFromBoot,
} from '@/utils/homeAgentBoot';
import { withReturnTo } from '@/utils/authReturnTo';
import {
  buildEditorProjectPath,
  clearEditorProjectNavigationLock,
  lockEditorProjectNavigation,
  publishEditorProjectLocally,
  readEditorProjectNavigationLock,
  shouldSyncEditorRoute,
} from '@/utils/editorProjectNavigation';
import {
  SESSION_CAMERA_EVENT,
  type SessionCameraDetail,
} from '@/utils/sessionCamera';
import { store } from '@/store';
import { useProjectCloudSync, flushCurrentProjectNow, ProjectRevisionConflictDialog, renameProjectOnCloud } from '@/components/editor/useProjectCloudSync';
import { useOpenProjectSession } from '@/hooks/useOpenProjectSession';
import { CollabRoomProvider } from '@/components/editor/collab/CollabRoomProvider';
import { McpCanvasBridge } from '@/components/editor/mcp/McpCanvasBridge';
import { isCollabActive } from '@/components/editor/collab/collabRuntime';
import type { ComposerContext } from '@/components/editor/panels/AgentComposerInput';
import AgentDock from '@/components/editor/panels/AgentDock';
import type { ComposerInteractionMode } from '@/components/editor/panels/agent/composer/AgentComposerShell';
import DevPropertiesPanel from '@/components/editor/panels/DevPropertiesPanel';
import ShareDialog from '@/components/editor/panels/ShareDialog';
import { apiClient } from '@/service/client';
import type { ShareDto } from '@/models/shares';
import EditorBootOverlay from '@/components/editor/chrome/EditorBootOverlay';
import {
  RCB_DEFAULT_CAMERA as DEFAULT_CAMERA,
  RCB_MAX_ZOOM,
  RCB_MIN_ZOOM,
  rcbFitCamera,
  rcbFitCameraInBand,
  rcbCenterCameraInBand,
  rcbViewportSceneBounds,
  zoomAtPoint,
  PENCIL_CURSOR,
  PEN_CURSOR,
  BUCKET_CURSOR,
  type RcbCamera as CanvasCamera,
} from '@/components/rcb';
import LayerPanel from '@/components/editor/panels/LayerPanel';
import EditorToolStrip from '@/components/editor/chrome/EditorToolStrip';
import { getDocumentGridSize } from '@/components/rcb/selection/alignGuides';
import { cn } from '@/utils/classnames';
import { fetchProject, syncProjectRowFromServer, refreshProjectsListAfterMutation } from '@/service/projects';
import { prefetchShareRecord } from '@/service/shareSession';
import {
  createEmptyDocument,
  listSceneNodes
} from '@/components/rcb/scene/document/sceneDocument';
import { parseAndValidateSceneJson } from '@/components/rcb/sceneNode';
import {
  getProjectDraft,
  getProjectSession,
  putProjectDraft,
  writeUnsyncedProjectDraft,
  putProjectSession,
} from '@/components/editor/projectDraftStore';
import {
  createTemplate,
  importDocument,
  openTemplate,
  renameTemplate,
  setActiveFrameId,
  setFrameChromeMode,
  setMixedSelection,
  setGridMode,
  setSelectedNodeId,
  setWorkspaceMode,
  bakeDocumentOrigin,
} from '@/store/modules/editor';
import type { ArtboardFrame } from '@/components/rcb/frames/types';
import type { FillPanelValue } from '@/components/editor/panels/FillPanel';
import { cssSolidWithOpacity } from '@/components/base/colorPanel';
import { nodeLeftTop } from '@/components/rcb/scene/layout/nodeLayout';
import {
  cssPreviewForGradient,
  fillImageFieldsFromDocumentBackground,
  parseFillGradient,
  parseFillType,
  type FillType,
} from '@/components/rcb/scene/document/sceneFill';
import EditorOnboardingTour, {
  hasCompletedEditorTour,
} from '@/components/editor/chrome/EditorOnboardingTour';
import EditorTopChrome, { flushAndGoHome } from '@/components/editor/page/EditorTopChrome';
import EditorToolDocks from '@/components/editor/page/EditorToolDocks';
import EditorBottomHud, { isThemeFollowCanvasBg } from '@/components/editor/page/EditorBottomHud';
import {
  useLeftDockWidth,
  useRightDockWidth,
} from '@/components/editor/page/editorBottomHudLayout';
import { loadFontCatalog } from '@/components/rcb/scene/document/fontCatalog';
import EditorStageWorld from '@/components/editor/page/EditorStageWorld';
import AnimationTimelineDock from '@/components/editor/nodes/AnimationNode/AnimationTimelineDock';
import AnimationTimelineFocusHost from '@/components/editor/nodes/AnimationNode/AnimationTimelineFocusHost';
import AnimationPrecompEditFocusHost from '@/components/editor/nodes/AnimationNode/AnimationPrecompEditFocusHost';
import { isArtboardVisibleInDocument } from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import {
  isAnimationFrameHostNode,
  isNodeStructurallyHiddenInDocument,
} from '@/components/rcb/scene/document/nodeCapabilities';

const BOOT_MIN_MS = 520;
const BOOT_EXIT_MS = 280;
const STAGE_LAYOUT_MIN = 40;

type StageLayout = { width: number; height: number };

/** Keep the scene point at the viewport center when the stage resizes (side panels). */
function compensateCameraForViewportResize(
  camera: CanvasCamera,
  prev: StageLayout,
  next: StageLayout
): CanvasCamera | null {
  if (
    prev.width <= STAGE_LAYOUT_MIN ||
    prev.height <= STAGE_LAYOUT_MIN ||
    (Math.abs(prev.width - next.width) <= 0.5 && Math.abs(prev.height - next.height) <= 0.5)
  ) {
    return null;
  }
  return {
    ...camera,
    x: camera.x + (next.width - prev.width) / 2,
    y: camera.y + (next.height - prev.height) / 2,
  };
}

function readStageLayout(el: HTMLElement): StageLayout {
  return {
    width: Math.max(1, el.clientWidth),
    height: Math.max(1, el.clientHeight),
  };
}


function documentToCanvasFill(document: SceneDocument, themeFallback: string): FillPanelValue {
  const raw = String(document?.backgroundColor || '').trim();
  const fillType = parseFillType(document?.backgroundFillType);
  const panelType = (
    fillType === 'linear' ||
    fillType === 'radial' ||
    fillType === 'angular' ||
    fillType === 'diffuse' ||
    fillType === 'image'
      ? fillType
      : 'solid'
  ) as FillType;

  return {
    fillType: panelType,
    fillColor: raw || themeFallback,
    fillOpacity: Number(document?.backgroundOpacity ?? 100),
    fillGradient: document?.backgroundGradient as FillPanelValue['fillGradient'],
    ...fillImageFieldsFromDocumentBackground(document),
  };
}

function computeWorldSurface(doc: SceneDocument, frames: ArtboardFrame[]) {
  let maxX = 3600;
  let maxY = 2400;
  for (const f of frames) {
    maxX = Math.max(maxX, f.x + f.width + 400);
    maxY = Math.max(maxY, f.y + f.height + 400);
  }
  const children: string[] = doc?.deltaSetLike?.ROOT?.children || [];
  for (const id of children) {
    const node = doc?.deltaSetLike?.[id];
    if (!node) continue;
    const x = Number(node.x) || 0;
    const y = Number(node.y) || 0;
    const w = Math.max(1, Number(node.width) || 0);
    const h = Math.max(1, Number(node.height) || 0);
    maxX = Math.max(maxX, x + w + 400);
    maxY = Math.max(maxY, y + h + 400);
  }
  return { x: 0, y: 0, width: Math.ceil(maxX), height: Math.ceil(maxY) };
}

function useThemeCanvasColor() {
  const [color, setColor] = useState('#f2f2f2');
  useEffect(() => {
    const read = () => {
      const v = getComputedStyle(document.documentElement)
        .getPropertyValue('--canvas')
        .trim();
      if (v) setColor(v);
    };
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    });
    return () => obs.disconnect();
  }, []);
  return color;
}

function useViewportMatch(query: string) {
  const read = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false;
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

type SceneBox = { x: number; y: number; width: number; height: number };

function unionSceneBox(a: SceneBox | null, b: SceneBox): SceneBox {
  if (!a) return { ...b };
  const minX = Math.min(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxX = Math.max(a.x + a.width, b.x + b.width);
  const maxY = Math.max(a.y + a.height, b.y + b.height);
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

/** Union of artboards + scene nodes for zoom-to-fit (respects workbench edit focus). */
function editorContentBounds(doc: SceneDocument, frames: ArtboardFrame[]): SceneBox {
  let box: SceneBox | null = null;
  for (const f of frames) {
    if (!isArtboardVisibleInDocument(f)) continue;
    box = unionSceneBox(box, {
      x: f.x,
      y: f.y,
      width: Math.max(1, f.width),
      height: Math.max(1, f.height),
    });
  }
  for (const { node } of listSceneNodes(doc)) {
    if (!node) continue;
    if (isAnimationFrameHostNode(node, doc)) continue;
    if (isNodeStructurallyHiddenInDocument(doc, node)) continue;
    const { left, top } = nodeLeftTop(doc, node);
    const w = Math.max(1, Number(node.width) || 0);
    const h = Math.max(1, Number(node.height) || 0);
    if (w < 2 && h < 2) continue;
    box = unionSceneBox(box, { x: left, y: top, width: w, height: h });
  }
  if (!box) return { x: 0, y: 0, width: 1200, height: 800 };
  return box;
}

/** True when the scene has real artboards/nodes — not the empty-doc fallback box. */
function editorHasFitContent(doc: SceneDocument, frames: ArtboardFrame[]): boolean {
  for (const f of frames) {
    if (!isArtboardVisibleInDocument(f)) continue;
    if ((Number(f.width) || 0) >= 2 && (Number(f.height) || 0) >= 2) return true;
  }
  for (const { node } of listSceneNodes(doc)) {
    if (!node) continue;
    if (isAnimationFrameHostNode(node, doc)) continue;
    if (isNodeStructurallyHiddenInDocument(doc, node)) continue;
    const w = Math.max(0, Number(node.width) || 0);
    const h = Math.max(0, Number(node.height) || 0);
    if (w >= 2 && h >= 2) return true;
  }
  return false;
}

function resolveHomeAgentInteractionMode(
  mode: unknown
): 'agent' | 'ask' | 'image' | 'video' | 'audio' | 'lottie' | null {
  if (mode === 'image') return 'image';
  if (mode === 'video') return 'video';
  if (mode === 'audio') return 'audio';
  if (mode === 'lottie') return 'lottie';
  if (mode === 'ask') return 'ask';
  if (mode === 'agent') return 'agent';
  return null;
}

function shouldApplyHomeAgentBoot(opts: {
  boot: ReturnType<typeof peekHomeAgentBoot>;
  fromFlag: boolean;
  alreadyApplied: boolean;
}): boolean {
  const { boot, fromFlag, alreadyApplied } = opts;
  if (!boot || alreadyApplied) return false;
  const hasPrompt = Boolean(boot.prompt?.trim());
  const hasChips =
    Boolean(boot.contexts?.length) || Boolean(boot.attachments?.length);
  if (!hasPrompt && !hasChips) return false;
  if (!fromFlag && !boot.autoSubmit && !hasChips) return false;
  return true;
}

function computeStageBackground(
  document: SceneDocument,
  followThemeCanvas: boolean,
  themeCanvas: string
): string | undefined {
  const type = parseFillType(document?.backgroundFillType);
  const opacity = Number(document?.backgroundOpacity ?? 100);
  const baseColor = followThemeCanvas
    ? themeCanvas
    : String(document?.backgroundColor || '').trim() || themeCanvas;

  if (followThemeCanvas && type === 'solid' && opacity >= 100) return undefined;

  if (type === 'solid' || !document?.backgroundFillType) {
    return cssSolidWithOpacity(baseColor, opacity);
  }
  if (type === 'image') {
    const src = String(document?.backgroundImageSrc || '');
    if (!src) return cssSolidWithOpacity(baseColor, opacity);
    return `url(${src}) center / cover no-repeat`;
  }
  const gradient = parseFillGradient(document?.backgroundGradient, type, baseColor);
  return cssPreviewForGradient({ ...gradient, type }, opacity);
}

function resolveEditorCanvasCursor(
  frameMode: boolean,
  activeTool: string,
  pickMode: { active: boolean; blocked: boolean }
): string | undefined {
  if (pickMode.active) return pickMode.blocked ? 'not-allowed' : 'copy';
  if (frameMode) return 'crosshair';
  if (activeTool === 'pencil') return PENCIL_CURSOR;
  if (activeTool === 'pen') return PEN_CURSOR;
  if (activeTool === 'bucket') return BUCKET_CURSOR;
  return undefined;
}

type EditorProjectDraft = Awaited<ReturnType<typeof getProjectDraft>>;

function shouldPreferLocalDraft(
  draft: EditorProjectDraft,
  proj: { document?: unknown; updatedAt?: number } | null | undefined
): boolean {
  if (!draft?.document) return false;
  const cloudUpdated = Number(proj?.updatedAt) || 0;
  const draftUpdated = Number(draft.updatedAt) || 0;
  return (
    !proj?.document ||
    draftUpdated > cloudUpdated ||
    (draftUpdated === cloudUpdated && !draft.syncedAt)
  );
}

function persistUnsyncedDraft(
  targetId: string,
  draft: NonNullable<EditorProjectDraft>,
  name: string
) {
  writeUnsyncedProjectDraft(targetId, name, draft.document);
}

/** Keep /editor/:id when cloud has no row yet — never mint a second nanoid. */
function seedLocalProjectForUrl(
  targetId: string,
  name: string,
  document: unknown
) {
  importDocument({
      id: targetId,
      name,
      document,
      source: 'user',
      dirty: true,
    });
  writeUnsyncedProjectDraft(targetId, name, document);
}

async function hydrateShareTarget(
  targetId: string,
  navigate: ReturnType<typeof useNavigate>,
  t: (key: string, opts?: Record<string, unknown>) => string,
  isCancelled: () => boolean
) {
  try {
    const res = (await apiClient.sharesSharesGet({
      params: { share_id: targetId },
    })) as { share: ShareDto };
    if (isCancelled()) return;
    const s = res.share;
    if (!s?.document || !s.viewerCanEdit) {
      message.warning(t('editor.shareNoEditAccess'));
      navigate(`/s/${encodeURIComponent(targetId)}`, { replace: true });
      return;
    }
    importDocument({
        id: s.id,
        name: s.name || t('home.untitled'),
        document: s.document,
        source: 'scratch',
      });
    setWorkspaceMode('design');
  } catch {
    if (isCancelled()) return;
    message.error(t('editor.shareOpenFailed'));
    navigate(`/s/${encodeURIComponent(targetId)}`, { replace: true });
  }
}

async function hydrateCloudProject(
  targetId: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
  isCancelled: () => boolean
) {
  let draft: Awaited<ReturnType<typeof getProjectDraft>> | null = null;
  try {
    draft = await getProjectDraft(targetId);
  } catch {
    draft = null;
  }
  // Local-only id (nanoid before first successful PUT): GET would always 404.
  if (draft?.document && !draft.syncedAt) {
    if (isCancelled()) return;
    const name = draft.name || t('home.untitled');
    importDocument({
        id: targetId,
        name,
        document: draft.document,
        source: 'user',
        dirty: true,
      });
    persistUnsyncedDraft(targetId, draft, name);
    return;
  }
  try {
    const res = await fetchProject(targetId);
    if (isCancelled()) return;
    const proj = res.project;
    const cloudUpdated = Number(proj?.updatedAt) || 0;
    const cloudRev = Number(proj?.revision);
    const revision = Number.isFinite(cloudRev) && cloudRev >= 1 ? cloudRev : null;

    if (shouldPreferLocalDraft(draft, proj) && draft?.document) {
      const needsUpload = !draft.syncedAt;
      const name = draft.name || proj?.name || t('home.untitled');
      importDocument({
          id: targetId,
          name,
          document: draft.document,
          source: 'user',
          dirty: needsUpload,
        });
      if (needsUpload) persistUnsyncedDraft(targetId, draft, name);
      syncProjectRowFromServer(proj);
      return;
    }

    if (!proj?.document) {
      if (draft?.document) {
    const name = draft.name || t('home.untitled');
        importDocument({
            id: targetId,
            name,
            document: draft.document,
            source: 'user',
            dirty: !draft.syncedAt,
          });
        if (!draft.syncedAt) persistUnsyncedDraft(targetId, draft, name);
        return;
      }
      seedLocalProjectForUrl(
        targetId, t('home.untitled'),
        createEmptyDocument({ emptyWorld: true })
      );
      return;
    }

    importDocument({
        id: proj.id,
        name: proj.name || t('home.untitled'),
        document: proj.document,
        source: 'user',
      });
    syncProjectRowFromServer(proj);
    void putProjectDraft({
      projectId: proj.id,
        name: proj.name || t('home.untitled'),
      document: proj.document,
      updatedAt: cloudUpdated || Date.now(),
      syncedAt: Date.now(),
      cloudRevision: revision,
      baseDocument: proj.document,
    });
  } catch {
    if (isCancelled()) return;
    if (draft?.document) {
    const name = draft.name || t('home.untitled');
      importDocument({
          id: targetId,
          name,
          document: draft.document,
          source: 'user',
          dirty: true,
        });
      persistUnsyncedDraft(targetId, draft, name);
      return;
    }
    seedLocalProjectForUrl(
      targetId, t('home.untitled'),
      createEmptyDocument({ emptyWorld: true })
    );
  }
}

/** Stable identity — inline `['image','video']` would churn AgentDock mode-coerce effects. */
const MOBILE_AGENT_INTERACTION_MODES: ComposerInteractionMode[] = ['agent'];

function EditorPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { projectId: routeProjectId } = useParams<{ projectId?: string }>();
  // Defer font catalog off home cold path (was eager in main.tsx).
  useEffect(() => {
    void loadFontCatalog();
  }, []);
  const [camera, setCamera] = useState<CanvasCamera>(DEFAULT_CAMERA);
  const [agentOpen, setAgentOpen] = useState(true);
  /** Bumps AgentDock hydrate (catalog/models) — first enter starts at 1; reopen via openAgentPanel. */
  const [agentOpenSignal, setAgentOpenSignal] = useState(1);
  const [inspectOpen, setInspectOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [agentDraft, setAgentDraft] = useState<string | null>(null);
  const [agentAutoSubmit, setAgentAutoSubmit] = useState(false);
  const [agentDraftAttachments, setAgentDraftAttachments] = useState<ComposerContext[]>([]);
  const [agentDraftContexts, setAgentDraftContexts] = useState<ComposerContext[]>([]);
  const [agentDraftModelId, setAgentDraftModelId] = useState<string | null>(null);
  const [agentDraftInteractionMode, setAgentDraftInteractionMode] = useState<
    'agent' | 'ask' | 'image' | 'video' | 'audio' | 'lottie' | null
  >(null);
  const [agentDraftImageAspect, setAgentDraftImageAspect] = useState<string | null>(null);
  const [agentDraftScene, setAgentDraftScene] = useState<
    'website' | 'mobile' | 'image' | 'poster' | 'drawing' | 'video' | null
  >(null);
  const [attachToChat, setAttachToChat] = useState<string | string[] | null>(null);
  // Layers / assets docks stay closed by default (open only via HUD toggle).
  const [layersOpen, setLayersOpen] = useState(false);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [minimapOpen, setMinimapOpen] = useState(false);
  const [canvasBgOpen, setCanvasBgOpen] = useState(false);
  /** Enter page / fit-to-canvas — menu highlights銆岄€傚簲鐢诲竷銆島ntil user picks another zoom. */
  const [zoomFitActive, setZoomFitActive] = useState(true);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [canvasMeshSelectedIndex, setCanvasMeshSelectedIndex] = useState(0);
  const [canvasMeshShowGuides, setCanvasMeshShowGuides] = useState(true);
  const themeCanvas = useThemeCanvasColor();
  const isMobileViewport = useViewportMatch('(max-width: 767px)');
  const isTabletViewport = useViewportMatch('(max-width: 1279px)');
  const useCompactTooling = isTabletViewport;
  const [bootOpen, setBootOpen] = useState(true);
  const [bootExiting, setBootExiting] = useState(false);
  const [bootProgress, setBootProgress] = useState(() => Math.max(8, readBootProgress()));
  const [tourActive, setTourActive] = useState(false);
  const bootStartedAt = useRef(Date.now());
  const bootOpenRef = useRef(true);
  const bootFinishingRef = useRef(false);
  const bootExitTimer = useRef<number | null>(null);
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const sessionCameraStackRef = useRef<CanvasCamera[]>([]);
  /** Local session: selection + grid. Camera fits once after stage layout (below). */
  const sessionReadyForIdRef = useRef<string | null>(null);
  const didInitialFitRef = useRef(false);
  /** Previous stage layout size — used to keep the viewport anchor when side panels open/close. */
  const prevStageLayoutRef = useRef({ width: 0, height: 0 });
  /** User pan/zoom — do not overwrite with auto-fit. */
  const cameraUserTouchedRef = useRef(false);
  const gridUserTouchedRef = useRef(false);
  /** Apply sessionStorage home boot at most once per EditorPage lifetime. */
  const homeAgentBootAppliedRef = useRef(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageEl, setStageEl] = useState<HTMLElement | null>(null);
  const document = useEditorDocument();
  // Docks / HUD lag until documentRevision (paste defers that bump). Do not
  // useDeferredValue(live document) — that still rebuilt BottomHud on every
  // Ctrl+V and blocked paste #2+ at 2k+.
  const committedDocument = useEditorDocumentOnCommit();
  const deferredDocument = useDeferredValue(committedDocument);
  useProjectCloudSync();
  const sceneReloadToken = useSceneReloadToken();
  const documentPatchToken = useDocumentPatchToken();
  const lastPatchedNodeIds = useLastPatchedNodeIds();
  const lastPatchTransformOnly = useLastPatchTransformOnly();
  const selectedNodeId = useSelectedNodeId();
  const selectedNodeIds = useSelectedNodeIds();
  const selectedFrameIds = useSelectedFrameIds();
  const currentId = useCurrentProjectId();
  useOpenProjectSession(currentId || routeProjectId);
  const authUserId = useSelector((s: any) => s.auth?.user?.id as string | undefined);
  const templates = useSelector((state: any) => state.editor.templates as any[]);
  const currentTemplate = useSelector((state: any) =>
    state.editor.templates.find((item: any) => item.id === state.editor.currentId)
  );

  // Persist share-edit sessions back to the shares API (not projects).
  // When a Yjs room is active, CollabRoomProvider owns the debounced write.
  const shareSaveTimer = useRef<number | null>(null);
  const renameCloudTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!currentId?.startsWith('share_') || !document) return undefined;
    if (isCollabActive()) return undefined;
    if (shareSaveTimer.current) window.clearTimeout(shareSaveTimer.current);
    const id = currentId;
    shareSaveTimer.current = window.setTimeout(() => {
      async function persistShareDocument() {
        try {
          await apiClient.sharesSharesUpdateDocument({
            params: { share_id: id },
            body: { document: document as Record<string, unknown> },
          });
        } catch {
          /* ignore */
        }
      }
      void persistShareDocument();
    }, 700);
    return () => {
      if (shareSaveTimer.current) window.clearTimeout(shareSaveTimer.current);
    };
  }, [currentId, document]);

  const activeTool = useSelector((state: any) => state.editor.activeTool);
  const canvasAttachPick = useSelector(
    (state: any) => state.editor.canvasAttachPick as null | { target: string }
  );
  const canvasAttachPickBlocked = useSelector((state: any) =>
    Boolean(state.editor.canvasAttachPickBlocked)
  );
  const isGridMode = useSelector((state: any) => Boolean(state.editor.isGridMode));
  const gridSize = getDocumentGridSize(document);
  const workspaceMode = useSelector(
    (state: any) => state.editor.workspaceMode || 'design'
  ) as 'design' | 'dev';
  const lottieTimelineNodeId = useSelector((state: any) =>
    String(state.editor.lottieTimelinePanel?.nodeId || '')
  );
  const lottieTimelineOpen = Boolean(lottieTimelineNodeId);

  const [toolsTimelineLiftPx, setToolsTimelineLiftPx] = useState(0);
  useEffect(() => {
    if (!lottieTimelineOpen) {
      setToolsTimelineLiftPx(0);
      return undefined;
    }
    let observed: Element | null = null;
    const ro = new ResizeObserver(() => {
      const el = window.document.querySelector(
        '[data-lottie-timeline-dock]'
      ) as HTMLElement | null;
      setToolsTimelineLiftPx(el ? Math.round(el.getBoundingClientRect().height) : 240);
    });
    const sync = () => {
      const el = window.document.querySelector(
        '[data-lottie-timeline-dock]'
      ) as HTMLElement | null;
      setToolsTimelineLiftPx(el ? Math.round(el.getBoundingClientRect().height) : 240);
      if (el !== observed) {
        if (observed) ro.unobserve(observed);
        observed = el;
        if (el) ro.observe(el);
      }
    };
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(window.document.body, { childList: true, subtree: true });
    const raf = window.requestAnimationFrame(sync);
    return () => {
      window.cancelAnimationFrame(raf);
      mo.disconnect();
      ro.disconnect();
    };
  }, [lottieTimelineOpen]);

  // Desktop docks overlay the stage — center tools in the free band between them.
  const desktop = !isMobileViewport;
  const toolsLeftDockPx = useLeftDockWidth(desktop && layersOpen);
  const toolsRightDockPx = useRightDockWidth(
    desktop && agentOpen,
    desktop && inspectOpen,
    workspaceMode
  );

  const followThemeCanvas = isThemeFollowCanvasBg(String(document?.backgroundColor || ''));
  const canvasFillValue = useMemo(
    () => documentToCanvasFill(document, themeCanvas),
    [document, themeCanvas]
  );
  const stageBackground = useMemo(
    () => computeStageBackground(document, followThemeCanvas, themeCanvas),
    [document, followThemeCanvas, themeCanvas]
  );

  /** Editor UI is design-only; hide Design/Dev toggle. */
  useEffect(() => {
    setWorkspaceMode('design');
  }, []);

  const isDevMode = workspaceMode === 'dev';
  const panMode = activeTool === 'pan';
  const frameMode = !isDevMode && activeTool === 'frame';
  const canvasCursor = resolveEditorCanvasCursor(frameMode, activeTool, {
    active: Boolean(canvasAttachPick),
    blocked: canvasAttachPickBlocked,
  });

  const frames: ArtboardFrame[] = Array.isArray(document?.frames) ? document.frames : [];
  const activeFrameId = document?.activeFrameId ?? null;
  const activeFrame = frames.find((f) => f.id === activeFrameId) ?? null;
  const selectedFrames = frames.filter(
    (f) => !f.hidden && selectedFrameIds.includes(f.id)
  );
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = stageEl;
    if (!el) return undefined;
    const apply = () => {
      const next = readStageLayout(el);
      const prev = prevStageLayoutRef.current;
      if (didInitialFitRef.current && !bootOpenRef.current) {
        const compensated = compensateCameraForViewportResize(cameraRef.current, prev, next);
        if (compensated) setCamera(compensated);
      }
      prevStageLayoutRef.current = next;
      setStageSize((prevSize) => {
        if (prevSize.width === next.width && prevSize.height === next.height) return prevSize;
        return next;
      });
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [stageEl]);


  // Scene paper follows content bounds only. Camera pan/zoom is CSS on RcbCanvas — 
  // never resize/slide SVG viewBox to chase the frustum.
  const worldSurface = document
    ? computeWorldSurface(document, frames)
    : { x: 0, y: 0, width: 3600, height: 2400 };
  // RcbCanvas autofit disabled here — we only center once on first load (below).
  const worldBounds = { x: 0, y: 0, width: 0, height: 0 };

  /** Stable embedded scene doc — avoid `document={{...}}` identity churn each render.
   * Paper fill is transparent here so SVG hosts don't paint over the stage CSS fill.
   * Reducers preserve real stage `backgroundColor` when this view doc is committed. */
  const canvasDocument = useMemo(() => {
    if (!document) return null;
    return {
      ...document,
      x: 0,
      y: 0,
      // Content bounds only — viewport coverage is handled by viewRect, not doc size.
      width: worldSurface.width,
      height: worldSurface.height,
      backgroundColor: 'transparent',
      backgroundFillType: 'solid' as const,
    };
  }, [document, worldSurface.width, worldSurface.height]);

  // Home "New project" / URL projectId / post-login ?from= intent (URL query).
  useEffect(() => {
    let cancelled = false;
    const cleanup = () => {
      cancelled = true;
    };
    const params = new URLSearchParams(location.search);
    const createNew = params.get('createNew') === '1';
    const fromHomeAgent = params.get('fromHomeAgent') === '1';
    const targetId = decodeURIComponent((routeProjectId || '').trim());

    if (createNew) {
      createTemplate({ emptyWorld: true });
      const ed = (store.getState() as any).editor as {
        currentId?: string | null;
        document?: unknown;
        templates?: { id: string; name?: string }[];
      };
      const id = String(ed?.currentId || '');
      if (id && ed.document) {
        const name =
          ed.templates?.find((x) => x.id === id)?.name || t('home.untitled');
        writeUnsyncedProjectDraft(id, name, ed.document);
      }
      if (id) {
        lockEditorProjectNavigation(id);
        navigate(buildEditorProjectPath(id, fromHomeAgent ? '?fromHomeAgent=1' : ''), {
          replace: true,
        });
      } else {
        navigate(fromHomeAgent ? '/editor?fromHomeAgent=1' : '/editor', { replace: true });
      }
      return cleanup;
    }

    if (targetId) {
      const navLockId = readEditorProjectNavigationLock();
      if (navLockId && currentId === navLockId) {
        if (document) {
          clearEditorProjectNavigationLock();
          if (targetId !== navLockId) {
            navigate(buildEditorProjectPath(navLockId, location.search), { replace: true });
          }
        }
        return cleanup;
      }

      if (currentId === targetId && document) return cleanup;

      const local = templates.find((x) => x.id === targetId);
      if (local?.document) {
        openTemplate(targetId);
        return cleanup;
      }

      if (targetId.startsWith('share_')) {
        void hydrateShareTarget(targetId, navigate, t, () => cancelled);
        return cleanup;
      }

      void hydrateCloudProject(targetId, t, () => cancelled);
      return cleanup;
    }

    if (!document) createTemplate({ emptyWorld: true });
    return cleanup;
    // Only re-run when route / nav intent changes — not on every doc edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeProjectId, location.search, navigate, t]);

  /** Local session: selection + grid. Camera fits once after stage layout (below). */
  useEffect(() => {
    sessionReadyForIdRef.current = null;
    didInitialFitRef.current = false;
    prevStageLayoutRef.current = { width: 0, height: 0 };
    cameraUserTouchedRef.current = false;
    gridUserTouchedRef.current = false;
    setZoomFitActive(true);
    // Keep previous camera until fit — snapping to DEFAULT here causes a visible jump.
    setGridMode(false);
  }, [currentId]);

  useEffect(() => {
    if (!currentId || !document) return;
    if (sessionReadyForIdRef.current === currentId) return;
    let cancelled = false;
    async function restoreSession() {
      let session: Awaited<ReturnType<typeof getProjectSession>> | null = null;
      try {
        session = await getProjectSession(currentId);
      } catch {
        session = null;
      }
      if (cancelled) return;
      // Do not restore session.camera — enter page always fits content once after load.
      if (!gridUserTouchedRef.current) {
        setGridMode(Boolean(session?.isGridMode));
      }
      const delta = document?.deltaSetLike || {};
      const nodeIds = (session?.selectedNodeIds || []).filter(
        (id) => id && id !== 'ROOT' && delta[id]
      );
      const frameValid = new Set(
        (Array.isArray(document?.frames) ? document.frames : [])
          .map((f: any) => String(f?.id || ''))
          .filter(Boolean)
      );
      const frameIds = (session?.selectedFrameIds || []).filter((id) =>
        frameValid.has(id)
      );
      if (nodeIds.length || frameIds.length) {
        setMixedSelection({ nodeIds, frameIds });
      }
      sessionReadyForIdRef.current = currentId;
    }
    restoreSession();
    return () => {
      cancelled = true;
    };
  }, [currentId, document]);

  useEffect(() => {
    if (!currentId) return;
    if (sessionReadyForIdRef.current !== currentId) return;
    const timer = window.setTimeout(() => {
      void putProjectSession({
        projectId: currentId,
        camera,
        selectedNodeIds,
        selectedFrameIds,
        isGridMode,
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [currentId, camera, selectedNodeIds, selectedFrameIds, isGridMode]);

  /** Home agent / plaza 銆屽仛鍚屾銆嶁€?prefill composer chips / prompt (peek until AgentDock consumes). */
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('createNew') === '1') return;

    const fromFlag = params.get('fromHomeAgent') === '1';
    const boot = peekHomeAgentBoot();

    if (fromFlag) {
      navigate({ pathname: location.pathname, search: '' }, { replace: true });
    }

    if (
      !shouldApplyHomeAgentBoot({
        boot,
        fromFlag,
        alreadyApplied: homeAgentBootAppliedRef.current,
      })
    ) {
      return;
    }

    const hasPrompt = Boolean(boot!.prompt?.trim());
    homeAgentBootAppliedRef.current = true;
    setAgentOpen(true);
    setAgentOpenSignal((n) => n + 1);
    setAgentDraft(hasPrompt ? boot!.prompt : '');
    setAgentAutoSubmit(Boolean(boot!.autoSubmit && hasPrompt));
    setAgentDraftAttachments(attachmentsFromBoot(boot!));
    setAgentDraftContexts(contextsFromBoot(boot!));
    setAgentDraftModelId(boot!.modelId ?? null);
    setAgentDraftInteractionMode(resolveHomeAgentInteractionMode(boot!.interactionMode));
    setAgentDraftImageAspect(boot!.imageAspectRatio ?? null);
    setAgentDraftScene(boot!.scene ?? null);
  }, [location.search, location.pathname, navigate]);

  // Keep /editor/:projectId in sync so refresh can reload the same project.
  useEffect(() => {
    if (!currentId) return;
    const pathId = decodeURIComponent((routeProjectId || '').trim());
    if (!shouldSyncEditorRoute(pathId, currentId)) return;
    navigate(buildEditorProjectPath(currentId, location.search), { replace: true });
  }, [currentId, routeProjectId, navigate, location.search]);

  const openAgentPanel = useCallback((opts?: { prompt?: string }) => {
    setAgentOpen(true);
    setAgentOpenSignal((n) => n + 1);
    if (opts?.prompt) setAgentDraft(opts.prompt);
  }, []);

  const openAgentForTour = useCallback(() => {
    setWorkspaceMode('design');
    // Ensure dock is visible; do not bump openSignal (avoids remount churn during tour).
    setAgentOpen(true);
  }, []);

  const clearAgentDraftBoot = useCallback(() => {
    clearHomeAgentBoot();
    setAgentDraft(null);
    setAgentAutoSubmit(false);
    setAgentDraftAttachments([]);
    setAgentDraftContexts([]);
    setAgentDraftModelId(null);
    setAgentDraftInteractionMode(null);
    setAgentDraftImageAspect(null);
    setAgentDraftScene(null);
  }, []);

  const clearAttachToChat = useCallback(() => {
    setAttachToChat(null);
  }, []);

  let holdForEditorTour = false;
  if (!isMobileViewport) {
    holdForEditorTour = tourActive || !hasCompletedEditorTour(authUserId);
  }
  const holdHomeAgentSubmit = bootOpen || holdForEditorTour;

  const goProjectsFromEditor = useCallback(() => {
    void flushAndGoHome(navigate, '/home?nav=mine', { refreshProjectsList: true });
  }, [navigate]);

  const newProjectFromEditor = useCallback(() => {
    void flushAndGoHome(navigate, '/editor?createNew=1');
  }, [navigate]);

  const duplicateProjectFromEditor = useCallback(async () => {
    try {
      await flushCurrentProjectNow({ force: true });
    } catch {
      /* still duplicate — local draft already holds bytes */
    }
    const editor = (store.getState() as any).editor;
    const doc = editor?.document;
    if (!doc) return;
    const current = editor.templates?.find((t: any) => t.id === editor.currentId);
    const baseName = current?.name || t('home.untitled');
    const newName = `${baseName} ${t('editor.projectMenu.duplicateSuffix')}`;
    createTemplate({
        name: newName,
        document: structuredClone(doc),
        source: 'user',
        dirty: true,
      });
    const newId = (store.getState() as any).editor?.currentId;
    const newDoc = (store.getState() as any).editor?.document;
    if (!newId || !newDoc) return;
    await publishEditorProjectLocally({
      projectId: newId,
      name: newName,
      document: newDoc,
      navigate,
      locationSearch: location.search,
    });
  }, [location.search, navigate, t]);

  const importJsonFromEditor = useCallback(
    async (file: File) => {
      try {
        const text = await file.text();
        const validation = parseAndValidateSceneJson(text);
        if (validation.valid === false) {
          console.error('Import JSON validation error:', validation.error);
          message.error(t('home.importJsonInvalid'));
          return;
        }
        const importedName = file.name.replace(/\.json$/i, '');
        importDocument({
            name: importedName,
            document: validation.data,
            source: 'import',
            dirty: true,
          });
        message.success(t('home.importSuccess'));
        const id = (store.getState() as any).editor?.currentId;
        const importedDoc = (store.getState() as any).editor?.document;
        if (!id || !importedDoc) return;
        await publishEditorProjectLocally({
          projectId: id,
          name: importedName,
          document: importedDoc,
          navigate,
          locationSearch: location.search,
        });
      } catch {
        message.error(t('home.importJsonFailed'));
      }
    },
    [location.search, navigate, t]
  );

  const renameProjectFromChrome = useCallback(
    (name: string) => {
      renameTemplate(name);
      const id = String((store.getState() as any).editor?.currentId || '').trim();
      if (!id) return;
      const nextName = String(name || '').trim() || 'Untitled';
      if (renameCloudTimer.current) clearTimeout(renameCloudTimer.current);
      renameCloudTimer.current = setTimeout(() => {
        renameCloudTimer.current = null;
        void renameProjectOnCloud(id, nextName).then(() =>
          refreshProjectsListAfterMutation(id)
        );
      }, 400);
    }, []
  );

  useEffect(
    () => () => {
      if (renameCloudTimer.current) clearTimeout(renameCloudTimer.current);
    },
    []
  );

  const agentOpenNonce = useSelector((s: any) => Number(s.editor.agentOpenNonce) || 0);
  const agentOpenNonceSeenRef = useRef(agentOpenNonce);
  useEffect(() => {
    if (agentOpenNonce <= agentOpenNonceSeenRef.current) return;
    agentOpenNonceSeenRef.current = agentOpenNonce;
    if (workspaceMode === 'dev') return;
    openAgentPanel();
  }, [agentOpenNonce, openAgentPanel, workspaceMode]);

  const closeLayersPanel = useCallback(() => setLayersOpen(false), []);

  /** Layer list click — pan/zoom so the target sits in view. */
  const locateSceneBounds = useCallback(
    (bounds: { x: number; y: number; width: number; height: number } | null) => {
      if (!bounds) return;
      const el = stageRef.current;
      const vw = el?.clientWidth || 0;
      const vh = el?.clientHeight || 0;
      if (vw < 40 || vh < 40) return;
      cameraUserTouchedRef.current = true;
      setZoomFitActive(false);
      setCamera(
        rcbFitCamera(
          { width: vw, height: vh },
          {
            x: bounds.x,
            y: bounds.y,
            width: Math.max(1, bounds.width),
            height: Math.max(1, bounds.height),
          },
          96,
          2
        )
      );
    },
    []
  );

  const locateNodeById = useCallback(
    (nodeId: string) => {
      const doc = (store.getState() as any).editor?.document as SceneDocument | null;
      const node = doc?.deltaSetLike?.[nodeId];
      if (!doc || !node) return;
      const { left, top } = nodeLeftTop(doc, node);
      locateSceneBounds({
        x: left,
        y: top,
        width: Math.max(1, Number(node.width) || 1),
        height: Math.max(1, Number(node.height) || 1),
      });
    },
    [locateSceneBounds]
  );

  const locateFrameById = useCallback(
    (frameId: string) => {
      const doc = (store.getState() as any).editor?.document as SceneDocument | null;
      const frame = (Array.isArray(doc?.frames) ? doc.frames : []).find(
        (f: ArtboardFrame) => String(f?.id) === frameId
      );
      if (!frame) return;
      locateSceneBounds({
        x: Number(frame.x) || 0,
        y: Number(frame.y) || 0,
        width: Math.max(1, Number(frame.width) || 1),
        height: Math.max(1, Number(frame.height) || 1),
      });
    },
    [locateSceneBounds]
  );

  const selectLayerFromPanel = useCallback(
    (nodeId: string) => {
      setSelectedNodeId(nodeId);
      locateNodeById(nodeId);
      if (isMobileViewport) setLayersOpen(false);
    },
    [isMobileViewport, locateNodeById]
  );

  const selectFrameFromPanel = useCallback(
    (frameId: string) => {
      setActiveFrameId(frameId);
      setFrameChromeMode('full');
      locateFrameById(frameId);
      if (isMobileViewport) setLayersOpen(false);
    },
    [isMobileViewport, locateFrameById]
  );

  useEffect(() => {
    if (!isMobileViewport) return;
    setLayersOpen(false);
    setAssetsOpen(false);
  }, [isMobileViewport, agentOpen]);

  const openShareDialog = useCallback(() => {
    const projectId = String(currentId || '').trim();
    const tpl = templates.find((item: { id: string }) => item.id === currentId);
    const name =
      tpl?.name ||
      String((document as { name?: string } | null)?.name || '') ||
      t('home.untitled', { defaultValue: '未命名作品' });
    if (document && projectId) {
      prefetchShareRecord({
        projectId,
        projectName: name,
        document,
        sourceProjectId: projectId,
      });
    }
    setShareOpen(true);
  }, [currentId, document, t, templates]);

  // Layers (left dock) and assets (floating HUD panel) can stay open together —
  const toggleLayersOpen = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setLayersOpen((prev) => (typeof v === 'function' ? v(prev) : v));
  }, []);

  const toggleAssetsOpen = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setAssetsOpen((prev) => (typeof v === 'function' ? v(prev) : v));
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

  // Empty / content fit + boot reveal are handled by the stage-layout initial-fit effect.

  useEffect(() => {
    if (!bootOpen || bootExiting) return undefined;
    const id = window.setInterval(() => {
      setBootProgress((p) => {
        if (p >= 90) return p;
        const step = 4 + Math.random() * 10;
        return advanceBootProgress(Math.min(90, p + step));
      });
    }, 380);
    return () => window.clearInterval(id);
  }, [bootOpen, bootExiting]);

  useEffect(() => {
    if (!bootOpen) return undefined;
    const failSafe = window.setTimeout(() => finishBoot(), 12000);
    return () => window.clearTimeout(failSafe);
  }, [bootOpen, finishBoot]);

  useEffect(
    () => () => {
      if (bootExitTimer.current) window.clearTimeout(bootExitTimer.current);
    },
    []
  );

  const zoomAtStageCenter = useCallback((nextZoom: number) => {
    const el = stageRef.current;
    if (!el) return;
    cameraUserTouchedRef.current = true;
    setZoomFitActive(false);
    // Layout px (clientWidth) — same space as camera.x/y. getBoundingClientRect is visual
    // and drifts under browser zoom / CSS scale, which makes content jump off-screen.
    setCamera((c) =>
      zoomAtPoint(c, nextZoom, el.clientWidth / 2, el.clientHeight / 2)
    );
  }, []);

  const onZoomIn = useCallback(() => {
    cameraUserTouchedRef.current = true;
    setZoomFitActive(false);
    setCamera((c) => {
      const el = stageRef.current;
      if (!el) return c;
      const next = Math.min(RCB_MAX_ZOOM, Number((c.zoom * 1.1).toFixed(4)));
      return zoomAtPoint(c, next, el.clientWidth / 2, el.clientHeight / 2);
    });
  }, []);

  const onZoomOut = useCallback(() => {
    cameraUserTouchedRef.current = true;
    setZoomFitActive(false);
    setCamera((c) => {
      const el = stageRef.current;
      if (!el) return c;
      const next = Math.max(RCB_MIN_ZOOM, Number((c.zoom / 1.1).toFixed(4)));
      return zoomAtPoint(c, next, el.clientWidth / 2, el.clientHeight / 2);
    });
  }, []);

  const onFitView = useCallback((): boolean => {
    const el = stageRef.current;
    const vw = el?.clientWidth || 0;
    const vh = el?.clientHeight || 0;
    // Match RcbCanvas autofit gate — tiny/unlaid-out stages must not count as fitted.
    if (vw < 40 || vh < 40) {
      return false;
    }
    const state = store.getState() as any;
    const doc = state.editor?.document;
    const fr: ArtboardFrame[] = Array.isArray(doc?.frames) ? doc.frames : [];
    // Empty scene — 100%. With content — fit visible artboards/nodes with 120px margins.
    if (!editorHasFitContent(doc, fr)) {
      const next = { ...DEFAULT_CAMERA, zoom: 1 };
      setCamera(next);
      setZoomFitActive(true);
      return true;
    }
    const bounds = editorContentBounds(doc, fr);
    // Fit into the free band (above timeline / between side docks), not the full stage.
    const left = toolsLeftDockPx;
    const right = toolsRightDockPx;
    const bottom = Math.max(0, toolsTimelineLiftPx);
    const next = rcbFitCameraInBand(
      { width: vw, height: vh },
      bounds,
      { top: 0, right, bottom, left },
      120,
      1,
      0.5
    );
    setCamera(next);
    setZoomFitActive(true);
    return true;
  }, [toolsLeftDockPx, toolsRightDockPx, toolsTimelineLiftPx]);

  /** Manual fit (toolbar / shortcut) — stop auto re-fit after this. */
  const onFitViewManual = useCallback((): boolean => {
    cameraUserTouchedRef.current = true;
    return onFitView();
  }, [onFitView]);

  /** Pan/zoom from the canvas — marks camera as user-owned. */
  const onCanvasCameraChange = useCallback((next: CanvasCamera) => {
    cameraUserTouchedRef.current = true;
    setZoomFitActive(false);
    setCamera(next);
  }, []);

  /** Tool sessions push a fit-to-node camera and pop on exit. */
  useEffect(() => {
    const fitFromDetail = (detail: Extract<SessionCameraDetail, { bounds: unknown }>) => {
      const el = stageRef.current;
      if (!el) return;
      const vw = el.clientWidth;
      const vh = el.clientHeight;
      if (vw < 40 || vh < 40) return;
      const band = {
        top: Math.max(0, Number(detail.bandInsets?.top) || 0),
        right: Math.max(0, Number(detail.bandInsets?.right) || 0),
        bottom: Math.max(0, Number(detail.bandInsets?.bottom) || 0),
        left: Math.max(0, Number(detail.bandInsets?.left) || 0),
      };
      const viewport = { width: vw, height: vh };
      const fitted = rcbFitCameraInBand(
        viewport,
        detail.bounds,
        band,
        detail.padding ?? 96,
        detail.maxZoom ?? 4,
        detail.bandAnchorY ?? 0.5
      );
      // 关键帧 / session push: never yank an intentional high zoom (e.g. 1700%)
      // down to the fit cap (old timeline focus maxZoom 1.4 → 140%).
      const curZoom = cameraRef.current.zoom;
      const next =
        detail.keepZoomIfLarger && curZoom > fitted.zoom + 1e-4
          ? rcbCenterCameraInBand(
              viewport,
              detail.bounds,
              band,
              curZoom,
              detail.bandAnchorY ?? 0.5
            )
          : fitted;
      setZoomFitActive(false);
      setCamera(next);
    };

    const onSessionCamera = (e: Event) => {
      const detail = (e as CustomEvent<SessionCameraDetail>).detail;
      if (!detail) return;

      if (detail.action === 'push') {
        sessionCameraStackRef.current.push(cameraRef.current);
        fitFromDetail(detail);
        return;
      }
      if (detail.action === 'fit') {
        fitFromDetail(detail);
        return;
      }
      if (detail.action === 'pop') {
        const prev = sessionCameraStackRef.current.pop();
        if (prev) setCamera(prev);
      }
    };
    window.addEventListener(SESSION_CAMERA_EVENT, onSessionCamera);
    return () => window.removeEventListener(SESSION_CAMERA_EVENT, onSessionCamera);
  }, []);

  /**
   * Fit camera **before** boot overlay dismisses — once content is visible, never
   * auto-adjust again (no post-reveal re-fit when AgentDock width settles).
   * Wait until the route project is actually in the editor store (not a leftover / null doc).
   */
  useEffect(() => {
    const routeId = decodeURIComponent((routeProjectId || '').trim());
    const projectReady = Boolean(
      document && currentId && (!routeId || currentId === routeId)
    );
    if (!projectReady) return;
    if (!document || !currentId) return;
    if (didInitialFitRef.current) return;

    // Bake store origin before first fit — canvasDocument paints at 0,0; a late
    // align remount would jump every host after the overlay lifts.
    const ox = Number(document.x) || 0;
    const oy = Number(document.y) || 0;
    if (ox !== 0 || oy !== 0) {
      bakeDocumentOrigin();
      return;
    }

    const hasContent = editorHasFitContent(document, frames);

    // Boot already gone (e.g. empty — agent added nodes): skip auto-fit to avoid jump.
    if (!bootOpenRef.current && hasContent) {
      didInitialFitRef.current = true;
      return;
    }

    let cancelled = false;
    let tries = 0;
    let lastW = 0;
    let lastH = 0;
    let stableFrames = 0;

    const finishOnce = (fitted: boolean) => {
      if (cancelled) return;
      didInitialFitRef.current = true;
      finishBoot();
    };

    const tick = () => {
      if (cancelled || didInitialFitRef.current) return;
      const el = stageRef.current;
      if (!el || el.clientWidth < 40 || el.clientHeight < 40) {
        if (tries++ < 90) {
          requestAnimationFrame(tick);
          return;
        }
        finishOnce(false);
        return;
      }

      const w = el.clientWidth;
      const h = el.clientHeight;
      // Wait until stage size stops changing (AgentDock flex) while boot still covers.
      if (Math.abs(w - lastW) <= 1 && Math.abs(h - lastH) <= 1) {
        stableFrames += 1;
      } else {
        stableFrames = 0;
        lastW = w;
        lastH = h;
      }
      if (stableFrames < 4) {
        if (tries++ < 90) {
          requestAnimationFrame(tick);
          return;
        }
      }

      if (!hasContent) {
        setCamera({ ...DEFAULT_CAMERA, zoom: 1 });
        setZoomFitActive(true);
        requestAnimationFrame(() => {
          if (cancelled) return;
          finishOnce(true);
        });
        return;
      }

      if (!onFitView()) {
        if (tries++ < 90) {
          requestAnimationFrame(tick);
          return;
        }
        finishOnce(false);
        return;
      }
      // One more frame so the camera transform paints under the overlay, then reveal.
      requestAnimationFrame(() => {
        if (cancelled) return;
        finishOnce(true);
      });
    };

    tick();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fit once per project/stage; finishBoot is stable
  }, [
    document,
    currentId,
    routeProjectId,
    frames.length,
    stageEl,
    stageSize.width,
    stageSize.height,
    onFitView,
    finishBoot, ]);

  /** SvgCanvas ready is no longer the fit trigger (see initial-fit effect above). */
  const onCanvasReady = useCallback(() => {
    if (didInitialFitRef.current) finishBoot();
  }, [finishBoot]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t?.isContentEditable
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
        onFitViewManual();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onFitViewManual, onZoomIn, onZoomOut, zoomAtStageCenter]);


  const zoomPercent = Math.round(camera.zoom * 100);
  const projectName = currentTemplate?.name || t('home.untitled');
  const agentDock =
    workspaceMode === 'dev' ? null : (
      <AgentDock
        open={agentOpen}
        openSignal={agentOpenSignal}
        onClose={() => setAgentOpen(false)}
        floating={isMobileViewport}
        allowedInteractionModes={
          isMobileViewport ? MOBILE_AGENT_INTERACTION_MODES : undefined
        }
        draftPrompt={agentDraft}
        autoSubmitDraft={agentAutoSubmit}
        holdAutoSubmit={holdHomeAgentSubmit}
        draftAttachments={agentDraftAttachments}
        draftContexts={agentDraftContexts}
        draftModelId={agentDraftModelId}
        draftInteractionMode={agentDraftInteractionMode}
        draftImageAspectRatio={agentDraftImageAspect}
        draftScene={agentDraftScene}
        onDraftConsumed={clearAgentDraftBoot}
        attachToChat={attachToChat}
        onAttachConsumed={clearAttachToChat}
        dataTour={agentOpen ? 'editor-agent' : undefined}
        projectName={isMobileViewport ? projectName : undefined}
        onGoHome={
          isMobileViewport
            ? async () => {
                try {
                  await flushCurrentProjectNow({ force: true });
                } catch {
                  /* ignore */
                }
                navigate('/home');
              }
            : undefined
        }
        canvasUi={{
          getZoom: () => camera.zoom,
          zoomIn: onZoomIn,
          zoomOut: onZoomOut,
          setZoom: (z) => zoomAtStageCenter(z),
          fitView: onFitViewManual,
          getViewportSceneBounds: () => {
            const w = stageSize.width;
            const h = stageSize.height;
            if (!(w > 8 && h > 8)) return null;
            const b = rcbViewportSceneBounds(camera, { width: w, height: h });
            return {
              x: b.x,
              y: b.y,
              width: b.width,
              height: b.height,
            };
          },
          setLayersOpen: toggleLayersOpen,
          setAssetsOpen: toggleAssetsOpen,
          setMinimapOpen,
          getLayersOpen: () => layersOpen,
          getAssetsOpen: () => assetsOpen,
          getMinimapOpen: () => minimapOpen,
          openAccountAgent: () => {
            const from = `${location.pathname}${location.search}${location.hash}`;
            navigate(withReturnTo('/account?tab=agent', from));
          },
        }}
      />
    );
  return (
    <CollabRoomProvider stageEl={stageEl} camera={camera} onCameraChange={setCamera}>
      <ProjectRevisionConflictDialog />
      <McpCanvasBridge
        projectId={currentId}
        enabled={import.meta.env.VITE_MCP_CANVAS_ENABLED === 'true'}
      />
      <div
        className={cn(
          'relative flex h-full flex-col overflow-hidden',
          followThemeCanvas && 'bg-[var(--canvas)]'
        )}
        style={stageBackground ? { background: stageBackground } : undefined}
      >
        <div className="relative min-h-0 min-w-0 flex-1">
          <div
            className={cn(
              'absolute inset-0 flex flex-col overflow-hidden',
              followThemeCanvas && 'bg-[var(--canvas)]'
            )}
            style={stageBackground ? { background: stageBackground } : undefined}
          >
            <EditorTopChrome
              projectName={projectName}
              workspaceMode={workspaceMode}
              inspectOpen={inspectOpen}
              agentOpen={agentOpen}
              layersOpen={layersOpen}
              onProjectList={goProjectsFromEditor}
              onNewProject={newProjectFromEditor}
              onDuplicateProject={duplicateProjectFromEditor}
              onImportJson={importJsonFromEditor}
              onRename={renameProjectFromChrome}
              onShare={openShareDialog}
              onOpenAgent={openAgentPanel}
              bandLeftPx={toolsLeftDockPx}
              bandRightPx={toolsRightDockPx}
            />

            {/* Pen / pencil / bucket options — top center (not above bottom tool strip) */}
            <div
              data-tour="editor-create-dock"
              className="pointer-events-none absolute z-30 -translate-x-1/2 hidden md:block"
              style={{
                left: `calc(${toolsLeftDockPx}px + (100% - ${toolsLeftDockPx + toolsRightDockPx}px) / 2)`,
                top: 12,
              }}
            >
              <EditorToolDocks
                isDevMode={isDevMode}
                activeTool={activeTool}
                zoom={camera.zoom}
                viewportWidth={stageEl?.clientWidth}
                docWidth={Number(document?.width) || undefined}
              />
            </div>

            <AnimationTimelineFocusHost
              document={deferredDocument}
              stageEl={stageEl}
              bandLeftPx={toolsLeftDockPx}
              bandRightPx={toolsRightDockPx}
            />
            <AnimationPrecompEditFocusHost
              document={deferredDocument}
              stageEl={stageEl}
              bandLeftPx={toolsLeftDockPx}
              bandRightPx={toolsRightDockPx}
            />

            <EditorStageWorld
              document={document}
              worldBounds={worldBounds}
              worldSurface={worldSurface}
              camera={camera}
              onCameraChange={onCanvasCameraChange}
              panMode={panMode}
              frameMode={frameMode}
              stageBackground={stageBackground}
              stageRef={stageRef}
              onViewportEl={setStageEl}
              stageEl={stageEl}
              canvasCursor={canvasCursor}
              gridSize={gridSize}
              isDevMode={isDevMode}
              isMobileViewport={isMobileViewport}
              activeTool={activeTool}
              canvasDocument={canvasDocument}
              sceneReloadToken={sceneReloadToken}
              documentPatchToken={documentPatchToken}
              lastPatchedNodeIds={lastPatchedNodeIds}
              lastPatchTransformOnly={lastPatchTransformOnly}
              selectedNodeId={selectedNodeId}
              selectedNodeIds={selectedNodeIds}
              selectedFrameIds={selectedFrameIds}
              frames={frames}
              selectedFrames={selectedFrames}
              activeFrame={activeFrame}
              canvasFillValue={canvasFillValue}
              canvasBgOpen={canvasBgOpen}
              canvasMeshSelectedIndex={canvasMeshSelectedIndex}
              setCanvasMeshSelectedIndex={setCanvasMeshSelectedIndex}
              canvasMeshShowGuides={canvasMeshShowGuides}
              onZoomIn={onZoomIn}
              onZoomOut={onZoomOut}
              onCanvasReady={onCanvasReady}
              onOpenAgent={(opts) => {
                if (workspaceMode === 'dev') return;
                openAgentPanel({ prompt: opts?.prompt });
              }}
              onAddToChat={(target) => {
                if (workspaceMode === 'dev') return;
                openAgentPanel();
                setAttachToChat(target);
              }}
            />

            <div
              data-tour="editor-tools"
              className="pointer-events-none absolute z-20 -translate-x-1/2"
              style={{
                // Free-band center: leftDock + (stage - left - right) / 2
                left: `calc(${toolsLeftDockPx}px + (100% - ${toolsLeftDockPx + toolsRightDockPx}px) / 2)`,
                bottom: Math.max(16, toolsTimelineLiftPx + 16),
              }}
            >
              <div className="pointer-events-auto">
                <EditorToolStrip
                  camera={camera}
                  stageEl={stageEl}
                  compact={false}
                  selectOnly={isDevMode}
                />
              </div>
            </div>

            <EditorBottomHud
              document={deferredDocument}
              frames={frames}
              camera={camera}
              stageEl={stageEl}
              stageBackground={stageBackground}
              activeFrameId={activeFrameId}
              selectedFrameIds={selectedFrameIds}
              selectedNodeIds={selectedNodeIds}
              onCameraChange={onCanvasCameraChange}
              isDevMode={isDevMode}
              useCompactTooling={useCompactTooling}
              layersOpen={layersOpen}
              setLayersOpen={toggleLayersOpen}
              assetsOpen={assetsOpen}
              setAssetsOpen={toggleAssetsOpen}
              minimapOpen={minimapOpen}
              setMinimapOpen={setMinimapOpen}
              shortcutsOpen={shortcutsOpen}
              setShortcutsOpen={setShortcutsOpen}
              toolsExpanded={toolsExpanded}
              setToolsExpanded={setToolsExpanded}
              canvasFillValue={canvasFillValue}
              canvasBgOpen={canvasBgOpen}
              setCanvasBgOpen={setCanvasBgOpen}
              canvasMeshSelectedIndex={canvasMeshSelectedIndex}
              setCanvasMeshSelectedIndex={setCanvasMeshSelectedIndex}
              canvasMeshShowGuides={canvasMeshShowGuides}
              setCanvasMeshShowGuides={setCanvasMeshShowGuides}
              zoomPercent={zoomPercent}
              zoomFitActive={zoomFitActive}
              onZoomIn={onZoomIn}
              onZoomOut={onZoomOut}
              onFitView={onFitViewManual}
              zoomAtStageCenter={zoomAtStageCenter}
            />
          </div>

          {layersOpen && !isMobileViewport ? (
            <div className="pointer-events-none absolute inset-y-0 left-0 z-30">
              <div className="pointer-events-auto h-full">
                <LayerPanel
                  onClose={closeLayersPanel}
                  onSelectNode={selectLayerFromPanel}
                  onSelectFrame={selectFrameFromPanel}
                />
              </div>
            </div>
          ) : null}

          {lottieTimelineOpen && !isMobileViewport ? (
            <AnimationTimelineDock
              layersOpen={layersOpen}
              agentOpen={agentOpen}
              workspaceMode={workspaceMode === 'dev' ? 'dev' : 'design'}
            />
          ) : null}

          {workspaceMode === 'dev' ? (
            inspectOpen && !isMobileViewport ? (
              <div className="pointer-events-none absolute inset-y-0 right-0 z-30">
                <div className="pointer-events-auto h-full">
                  <DevPropertiesPanel onClose={() => setInspectOpen(false)} />
                </div>
              </div>
            ) : null
          ) : agentOpen && !isMobileViewport ? (
            <div className="pointer-events-none absolute inset-y-0 right-0 z-30">
              <div className="pointer-events-auto h-full">{agentDock}</div>
            </div>
          ) : null}
        </div>

        {isMobileViewport && layersOpen ? (
          <>
            <button
              type="button"
              aria-label={t('editor.closePanel')}
              className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]"
              onClick={closeLayersPanel}
            />
            <div className="fixed inset-y-0 left-0 z-50">
              <LayerPanel
                mobile
                onClose={closeLayersPanel}
                onSelectNode={selectLayerFromPanel}
                onSelectFrame={selectFrameFromPanel}
              />
            </div>
          </>
        ) : null}

        {isMobileViewport && workspaceMode !== 'dev' ? agentDock : null}

        {isMobileViewport && agentOpen ? (
          <button
            type="button"
            aria-label={t('agent.closePanel')}
            className="fixed inset-0 z-40 bg-black/20"
            onClick={() => setAgentOpen(false)}
          />
        ) : null}

        {bootOpen ? <EditorBootOverlay progress={bootProgress} exiting={bootExiting} /> : null}
        {shareOpen ? (
          <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} />
        ) : null}
        {/* Mobile chrome differs (floating agent / no tool strip targets) — tour breaks layout. */}
        {!isMobileViewport && (
          <EditorOnboardingTour
            ready={!bootOpen}
            onOpenAgent={openAgentForTour}
            onActiveChange={setTourActive}
          />
        )}
      </div>
    </CollabRoomProvider>
  );

}

export default memo(EditorPage);
