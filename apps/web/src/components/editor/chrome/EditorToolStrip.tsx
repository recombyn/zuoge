import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode, type SVGProps, memo } from 'react';
import { useSelector } from '@/store';
import { useEditorDocumentOnCommit } from '@/store/editorSelectors';
import { useTranslation } from 'react-i18next';
import {
  LuCircle,
  LuFrame,
  LuHand,
  LuHexagon,
  LuImage,
  LuImagePlus,
  LuImageUp,
  LuMinus,
  LuFileJson,
  LuMusic2,
  LuMousePointer2,
  LuPenTool,
  LuPencil,
  LuSquare,
  LuStar,
  LuTriangle,
  LuType,
} from 'react-icons/lu';
import { RiImageUploadLine, RiVideoUploadLine, RiVideoAiLine } from 'react-icons/ri';
import { AnimationOutlineIcon } from '@/components/editor/nodes/AnimationNode/AnimationOutlineIcon';
import { resolveAnimationFrameId } from '@/components/editor/nodes/AnimationNode/resolveAnimationFrameId';
import {
  warnIfAvBlockedByAnimationWorkbenchFocus,
  warnIfNewPlateBlockedByAnimationWorkbenchFocus,
} from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import { Dropdown, Tooltip, message } from '@/components/base';
import type { MenuItemType } from '@/components/base/dropdown/MenuItem';
import { FloatingToolbar } from '@/components/editor/chrome/FloatingToolbar';
import { createFilePreviewUrl, isUploadAbortError, revokeNodePreviewSrc } from '@/utils/uploadImage';
import { uploadCanvasPlaceholderFile } from '@/utils/canvasUploadFlow';
import store from '@/store';
import {
  setActiveTool,
  setShapeKind,
  startImageUploadPlaceholder,
  startVideoUploadPlaceholder,
  startAudioUploadPlaceholder,
  spawnImageGenerator,
  spawnVideoGenerator,
  spawnAnimationBoard,
  spawnLottie,
  spawnAudioGenerator,
  finishImageProcess,
  failImageProcess,
  patchDocumentNode,
} from '@/store/modules/editor';
import {
  ensureCanvasPlugins,
  listCanvasToolbarButtons,
  buildCanvasPluginRuntime,
  type CanvasToolbarButton,
} from '@/plugins/canvas/host';
import {
  fitImageSize,
  measureImageNaturalSize,
  prepareVideoUploadPreview,
  parseLottieAnimationData,
  serializeLottieAnimationData,
  MEDIA_PLACE_DEFAULT,
} from '@/components/rcb/scene/document/nodeFactories';
import { sceneToDocumentCoords } from '@/components/rcb/scene/layout/coords';
import {
  rcbLayoutGeneratorPlate,
  rcbScreenToScene,
  GENERATOR_EMPTY_STROKE_OUTSET,
  type RcbCamera,
} from '@/components/rcb';
import {
  getDocumentGridSize,
} from '@/components/rcb/selection/alignGuides';
import { cn } from '@/utils/classnames';
import { getHttpErrorMessage } from '@/service/client';
import type { SceneDocument } from '@/components/rcb/sceneNode';

const MENU_ICON_CLASS = 'h-4 w-4';
const TOOL_ICON_CLASS = 'h-4 w-4 shrink-0';
const STROKE = 1.5;
const MENU_POPUP = 'min-w-[11rem]';

/** Keyboard hints shown in toolbar menus / tooltips — keep in sync with the keydown handler below. */
const TOOL_SHORTCUT = {
  select: 'V',
  pan: 'H',
  frame: 'F',
  text: 'T',
  pen: 'P',
  pencil: 'Shift P',
  rect: 'R',
  line: 'L',
  circle: 'O',
  polygon: 'G',
  star: 'S',
  upload: 'Shift I',
  imageGenerator: 'A',
  videoGenerator: 'Shift A',
  lottieGenerator: 'M',
  animationBoard: 'M',
  audioGenerator: 'Shift U',
} as const;

function toolTipWithShortcut(label: string, shortcut?: string) {
  return shortcut ? `${label} (${shortcut})` : label;
}

function resolveToolbarShapeKind(shapeKind: string | null | undefined): string {
  if (!shapeKind || shapeKind === 'image') return 'rect';
  // Arrow create tool retired — treat leftover store value as line.
  if (shapeKind === 'arrow') return 'line';
  return layerIconByKind[shapeKind] ? shapeKind : 'rect';
}

function pickGeneratorAction(
  key: string,
  actions: {
    image: () => void;
    video: () => void;
    audio: () => void;
  }
) {
  if (key === 'video') {
    actions.video();
    return;
  }
  if (key === 'audio') {
    actions.audio();
    return;
  }
  actions.image();
}

function pickUploadAction(
  key: string,
  actions: {
    image: () => void;
    video: () => void;
    audio: () => void;
    lottie: () => void;
  }
) {
  if (key === 'video') {
    actions.video();
    return;
  }
  if (key === 'audio') {
    actions.audio();
    return;
  }
  if (key === 'lottie') {
    actions.lottie();
    return;
  }
  actions.image();
}

/**
 * Fit a generator plate into the visible stage, center it, snap painted outer
 * ink to the document grid (then inset 0.5 for the empty-state center stroke).
 */
function layoutGeneratorPlateInView(opts: {
  document: SceneDocument;
  camera: RcbCamera;
  stageEl: HTMLElement;
  natural: { width: number; height: number };
  fit?: { minRatio?: number; maxRatio?: number };
}): { x: number; y: number; width: number; height: number } {
  const view = opts.stageEl.getBoundingClientRect();
  const zoom = Math.max(0.05, opts.camera.zoom || 1);
  const center = rcbScreenToScene(
    opts.camera,
    opts.stageEl,
    view.left + view.width / 2,
    view.top + view.height / 2
  );
  const gridSize = getDocumentGridSize(opts.document);
  const laid = rcbLayoutGeneratorPlate({
    natural: opts.natural,
    viewport: { width: view.width, height: view.height },
    zoom,
    center,
    gridSize,
    visualOutset: GENERATOR_EMPTY_STROKE_OUTSET,
    fit: opts.fit,
  });
  const origin = sceneToDocumentCoords(opts.document, laid.left, laid.top);
  return {
    x: origin.x,
    y: origin.y,
    width: laid.width,
    height: laid.height,
  };
}

type LayerIconComponent = ComponentType<SVGProps<SVGSVGElement> & { className?: string }>;

/** Layer glyphs share one stroke weight / optical size. */
const layerIconByKind: Record<string, LayerIconComponent> = {
  text: LuType,
  image: LuImage,
  rect: LuSquare,
  line: LuMinus,
  circle: LuCircle,
  triangle: LuTriangle,
  star: LuStar,
  polygon: LuHexagon,
  pen: LuPenTool,
  pencil: LuPencil,
  path: LuPenTool,
};

function MenuLabel({
  iconKey,
  label,
  icon,
  shortcut,
}: {
  iconKey?: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
}) {
  const IconComp = iconKey ? layerIconByKind[iconKey] || layerIconByKind.rect : null;
  return (
    <span className="flex w-full items-center gap-2">
      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-[var(--ink)]">
        {icon ||
          (IconComp ? (
            <IconComp className={cn('block shrink-0', MENU_ICON_CLASS)} strokeWidth={STROKE} />
          ) : null)}
      </span>
      <span className="min-w-0 flex-1 text-[12px] text-[var(--ink)]">{label}</span>
      {shortcut ? (
        <span className="shrink-0 text-[11px] font-normal tabular-nums text-[var(--muted)]">
          {shortcut}
        </span>
      ) : null}
    </span>
  );
}

function ToolIcon({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'pointer-events-none inline-flex items-center justify-center',
        TOOL_ICON_CLASS,
        '[&>svg]:block [&>svg]:h-full [&>svg]:w-full',
        className
      )}
    >
      {children}
    </span>
  );
}

function ToolBtn({
  tip,
  ariaLabel,
  active,
  disabled,
  onClick,
  children,
}: {
  /** When omitted, no hover tip (use for tools that open a secondary panel). */
  tip?: string;
  ariaLabel?: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  const label = ariaLabel || tip;
  const btn = (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors',
        disabled && 'pointer-events-none opacity-40',
        active
          ? 'bg-[var(--ink)] text-[var(--on-brand)]'
          : 'text-[var(--ink)] hover:bg-[var(--accent-soft)]'
      )}
    >
      {children}
    </button>
  );
  if (!tip) return btn;
  return (
    <Tooltip tip={tip} placement="top">
      {btn}
    </Tooltip>
  );
}

/** Click activates tool; hover shows variant panel (no corner chevron). No tip — panel is the hint. */
function SplitToolButton({
  tip,
  active,
  disabled,
  menuOpen,
  onMenuOpenChange,
  items,
  selectedKeys,
  onMenuPick,
  onPrimaryClick,
  menuOffset = 10,
  children,
}: {
  /** Accessible name only; no hover tip (dropdown is the secondary panel). */
  tip: string;
  active?: boolean;
  disabled?: boolean;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  items: MenuItemType[];
  selectedKeys: string[];
  onMenuPick: (key: string) => void;
  /** Click the icon → select / re-activate the current sub-tool. */
  onPrimaryClick: () => void;
  /** Gap between trigger and dropdown (px). */
  menuOffset?: number;
  children: ReactNode;
}) {
  return (
    <Dropdown
      trigger="hover"
      open={disabled ? false : menuOpen}
      onOpenChange={(open) => {
        if (disabled) return;
        onMenuOpenChange(open);
      }}
      placement="top"
      offset={menuOffset}
      items={items}
      selectedKeys={selectedKeys}
      onClick={onMenuPick}
      popupClassName={MENU_POPUP}
      floatingClassName="z-50"
      referenceClassName={cn(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors',
        disabled && 'pointer-events-none opacity-40',
        active
          ? 'bg-[var(--ink)] text-[var(--on-brand)]'
          : 'text-[var(--ink)] hover:bg-[var(--accent-soft)]'
      )}
    >
      <button
        type="button"
        aria-label={tip}
        disabled={disabled}
        onClick={(e) => {
          e.preventDefault();
          if (disabled) return;
          onPrimaryClick();
        }}
        className="inline-flex size-full items-center justify-center"
      >
        {children}
      </button>
    </Dropdown>
  );
}

/**
 * Bottom-center tool dock (Kit rail order):
 * Select · 画板 · 钢笔/画笔 · 形状 · 文字 · | · 油漆桶 · 吸管 · | · 动画 · 上传 · 生成器
 */
function EditorToolStrip({
  className,
  camera,
  stageEl = null,
  compact = false,
  selectOnly = false,
  chrome = 'pill',
}: {
  className?: string;
  /** Used to place toolbar image uploads at the visible viewport center. */
  camera?: RcbCamera;
  stageEl?: HTMLElement | null;
  compact?: boolean;
  /** Preview / inspect: keep the dock visible but only Select / Pan stay active. */
  selectOnly?: boolean;
  /** `flat` when nested in the timeline-docked tool rail (no pill chrome). */
  chrome?: 'pill' | 'flat';
}) {
  const { t } = useTranslation();
  const activeTool = useSelector((state: any) => state.editor.activeTool);
  const shapeKind = useSelector((state: any) => state.editor.shapeKind);
  const document = useEditorDocumentOnCommit();
  const timelineOpen = useSelector((state: any) =>
    Boolean(state.editor.lottieTimelinePanel?.nodeId)
  );
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const lottieInputRef = useRef<HTMLInputElement>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  /** Last pen/pencil so the flyout icon stays useful when another tool is active. */
  const [lastInkTool, setLastInkTool] = useState<'pen' | 'pencil'>('pen');
  useEffect(() => {
    if (activeTool === 'pen' || activeTool === 'pencil') setLastInkTool(activeTool);
  }, [activeTool]);
  const [pluginButtons, setPluginButtons] = useState<CanvasToolbarButton[]>([]);
  const toolsLocked = Boolean(selectOnly);
  const newPlateLocked = toolsLocked || timelineOpen;

  useEffect(() => {
    let cancelled = false;
    async function loadPlugins() {
      await ensureCanvasPlugins();
      if (cancelled) return;
      setPluginButtons(listCanvasToolbarButtons());
    }
    void loadPlugins();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!toolsLocked) return;
    if (activeTool === 'select' || activeTool === 'pan') return;
    setActiveTool('select');
  }, [toolsLocked, activeTool]);

  useEffect(() => {
    if (!timelineOpen) return;
    if (activeTool !== 'frame') return;
    setActiveTool('select');
  }, [timelineOpen, activeTool]);

  // Bucket / eyedropper / mesh hidden from rail — bounce leftover active tool.
  useEffect(() => {
    if (
      activeTool !== 'bucket' &&
      activeTool !== 'eyedropper' &&
      activeTool !== 'mesh'
    ) {
      return;
    }
    setActiveTool('select');
  }, [activeTool]);

  const L = useMemo(
    () => ({
      select: t('editor.tools.select'),
      pan: t('editor.tools.pan'),
      frame: t('editor.tools.frame', { defaultValue: '画板' }),
      shape: t('editor.tools.shape'),
      pen: t('editor.tools.pen'),
      pencil: t('editor.tools.pencil'),
      text: t('editor.tools.text'),
      rect: t('editor.tools.rect'),
      line: t('editor.tools.line'),
      circle: t('editor.tools.circle'),
      polygon: t('editor.tools.polygon'),
      star: t('editor.tools.star'),
      uploadImage: t('editor.tools.uploadImage'),
      uploadVideo: t('editor.tools.uploadVideo', {
        defaultValue: '视频上传',
      }),
      uploadAudio: t('editor.tools.uploadAudio', {
        defaultValue: 'Upload audio',
      }),
      uploadLottie: t('editor.tools.uploadLottie', {
        defaultValue: 'Upload Lottie',
      }),
      uploadMedia: t('editor.tools.uploadMedia', {
        defaultValue: '上传文件',
      }),
      imageGenerator: t('editor.tools.imageGenerator'),
      videoGenerator: t('editor.tools.videoGenerator'),
      lottieGenerator: t('editor.tools.lottieGenerator'),
      animationBoard: t('editor.tools.animationBoard', { defaultValue: '动画工作台' }),
      audioGenerator: t('editor.tools.audioGenerator'),
      uploading: t('editor.tools.uploading'),
      uploadFail: t('editor.tools.uploadFail'),
    }),
    [t]
  );

  const selectItems: MenuItemType[] = useMemo(
    () => [
      {
        key: 'select',
        label: (
          <MenuLabel
            label={L.select}
            shortcut={TOOL_SHORTCUT.select}
            icon={<LuMousePointer2 className={MENU_ICON_CLASS} strokeWidth={STROKE} />}
          />
        ),
      },
      {
        key: 'pan',
        label: (
          <MenuLabel
            label={L.pan}
            shortcut={TOOL_SHORTCUT.pan}
            icon={<LuHand className={MENU_ICON_CLASS} strokeWidth={STROKE} />}
          />
        ),
      },
    ],
    [L.pan, L.select]
  );

  const shapeItems: MenuItemType[] = useMemo(
    () => [
      { key: 'rect', label: <MenuLabel iconKey="rect" label={L.rect} shortcut={TOOL_SHORTCUT.rect} /> },
      { key: 'line', label: <MenuLabel iconKey="line" label={L.line} shortcut={TOOL_SHORTCUT.line} /> },
      {
        key: 'circle',
        label: <MenuLabel iconKey="circle" label={L.circle} shortcut={TOOL_SHORTCUT.circle} />,
      },
      { key: 'polygon', label: <MenuLabel iconKey="polygon" label={L.polygon} shortcut={TOOL_SHORTCUT.polygon} /> },
      { key: 'star', label: <MenuLabel iconKey="star" label={L.star} shortcut={TOOL_SHORTCUT.star} /> },
    ],
    [L.circle, L.line, L.polygon, L.rect, L.star]
  );

  const inkItems: MenuItemType[] = useMemo(
    () => [
      {
        key: 'pen',
        label: <MenuLabel iconKey="pen" label={L.pen} shortcut={TOOL_SHORTCUT.pen} />,
      },
      {
        key: 'pencil',
        label: <MenuLabel iconKey="pencil" label={L.pencil} shortcut={TOOL_SHORTCUT.pencil} />,
      },
    ],
    [L.pen, L.pencil]
  );

  const uploadItems: MenuItemType[] = useMemo(
    () => {
      const items: MenuItemType[] = [
        {
          key: 'image',
          label: (
            <MenuLabel
              label={L.uploadImage}
              icon={<RiImageUploadLine className={MENU_ICON_CLASS} />}
            />
          ),
        },
      ];
      // Timeline focus: no AV onto the workbench — hide entries entirely.
      if (!timelineOpen) {
        items.push(
          {
            key: 'video',
            label: (
              <MenuLabel
                label={L.uploadVideo}
                icon={<RiVideoUploadLine className={MENU_ICON_CLASS} />}
              />
            ),
          },
          {
            key: 'audio',
            label: (
              <MenuLabel
                label={L.uploadAudio}
                icon={<LuMusic2 className={MENU_ICON_CLASS} strokeWidth={1.8} />}
              />
            ),
          }
        );
      }
      items.push({
        key: 'lottie',
        label: (
          <MenuLabel
            label={L.uploadLottie}
            icon={<LuFileJson className={MENU_ICON_CLASS} strokeWidth={1.8} />}
          />
        ),
      });
      return items;
    },
    [L.uploadAudio, L.uploadImage, L.uploadLottie, L.uploadVideo, timelineOpen]
  );

  const generatorItems: MenuItemType[] = useMemo(
    () => {
      const items: MenuItemType[] = [
        {
          key: 'image',
          label: (
            <MenuLabel
              label={L.imageGenerator}
              shortcut={TOOL_SHORTCUT.imageGenerator}
              icon={<LuImagePlus className={MENU_ICON_CLASS} strokeWidth={STROKE} />}
            />
          ),
        },
      ];
      if (!timelineOpen) {
        items.push(
          {
            key: 'video',
            label: (
              <MenuLabel
                label={L.videoGenerator}
                shortcut={TOOL_SHORTCUT.videoGenerator}
                icon={<RiVideoAiLine className={MENU_ICON_CLASS} />}
              />
            ),
          },
          {
            key: 'audio',
            label: (
              <MenuLabel
                label={L.audioGenerator}
                shortcut={TOOL_SHORTCUT.audioGenerator}
                icon={<LuMusic2 className={MENU_ICON_CLASS} strokeWidth={STROKE} />}
              />
            ),
          }
        );
      }
      return items;
    },
    [L.audioGenerator, L.imageGenerator, L.videoGenerator, timelineOpen]
  );

  const spawnPlateAtView = (opts: {
    defaults: { width: number; height: number };
    natural: { width: number; height: number };
    fit?: { minRatio?: number; maxRatio?: number };
    spawn: (box: { x: number; y: number; width: number; height: number; name: string }) => void;
    name: string;
  }) => {
    if (!document) return;
    let { width, height } = opts.defaults;
    let x = 40;
    let y = 40;
    if (camera && stageEl) {
      const view = stageEl.getBoundingClientRect();
      if (view.width > 0 && view.height > 0) {
        const laid = layoutGeneratorPlateInView({
          document,
          camera,
          stageEl,
          natural: opts.natural,
          fit: opts.fit,
        });
        width = laid.width;
        height = laid.height;
        x = laid.x;
        y = laid.y;
      }
    }
    opts.spawn({ x, y, width, height, name: opts.name });
  };

  const spawnImageGeneratorAtView = () => {
    spawnPlateAtView({
      defaults: { width: 360, height: 360 },
      natural: { width: 1024, height: 1024 },
      fit: { minRatio: 0.28, maxRatio: 0.42 },
      spawn: spawnImageGenerator,
      name: L.imageGenerator,
    });
  };

  const spawnVideoGeneratorAtView = () => {
    if (warnIfAvBlockedByAnimationWorkbenchFocus(message.warning, t)) return;
    spawnPlateAtView({
      defaults: { width: 640, height: 360 },
      natural: { width: 1280, height: 720 },
      fit: { minRatio: 0.28, maxRatio: 0.48 },
      spawn: spawnVideoGenerator,
      name: L.videoGenerator,
    });
  };

  const spawnAnimationBoardAtView = () => {
    if (warnIfNewPlateBlockedByAnimationWorkbenchFocus(message.warning, t, 'animationBoard')) {
      return;
    }
    spawnPlateAtView({
      defaults: { width: 364, height: 364 },
      natural: { width: 364, height: 364 },
      fit: { minRatio: 0.22, maxRatio: 0.42 },
      spawn: spawnAnimationBoard,
      name: L.animationBoard,
    });
  };

  const spawnAudioGeneratorAtView = () => {
    if (warnIfAvBlockedByAnimationWorkbenchFocus(message.warning, t)) return;
    spawnPlateAtView({
      defaults: { width: 360, height: 200 },
      natural: { ...MEDIA_PLACE_DEFAULT },
      fit: { minRatio: 0.22, maxRatio: 0.4 },
      spawn: spawnAudioGenerator,
      name: L.audioGenerator,
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable ||
        target?.closest?.(
          '[contenteditable="true"],[data-agent-composer],[data-image-generator],[data-video-generator],[data-lottie-generator],[data-audio-generator]'
        )
      ) {
        return;
      }
      const key = e.key.toLowerCase();
      if (key === 'v' && !e.shiftKey) {
        window.dispatchEvent(new Event('resume:exit-path-edit'));
        setActiveTool('select');
      }
      if (key === 'h' && !e.shiftKey) {
        window.dispatchEvent(new Event('resume:exit-path-edit'));
        setActiveTool('pan');
      }
      if (toolsLocked) {
        if (key === 'escape') {
          window.dispatchEvent(new Event('resume:exit-path-edit'));
          setActiveTool('select');
        }
        return;
      }
      if (key === 'f' && !e.shiftKey) {
        if (newPlateLocked) return;
        if (warnIfNewPlateBlockedByAnimationWorkbenchFocus(message.warning, t, 'artboard')) return;
        setActiveTool('frame');
      }
      if (key === 't' && !e.shiftKey) setActiveTool('text');
      if (key === 'r' && !e.shiftKey) setShapeKind('rect');
      if (key === 'l' && !e.shiftKey) setShapeKind('line');
      if (key === 'o' && !e.shiftKey) setShapeKind('circle');
      if (key === 'g' && !e.shiftKey) setShapeKind('polygon');
      if (key === 's' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        setShapeKind('star');
      }
      if (key === 'i' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        setOpenMenu('upload');
      }
      // Eyedropper (I) / mesh (U) / bucket (B) — hidden from rail for now.
      if (key === 'a' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        spawnImageGeneratorAtView();
      }
      if (key === 'a' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (timelineOpen) return;
        spawnVideoGeneratorAtView();
      }
      if (key === 'm' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (newPlateLocked) return;
        spawnAnimationBoardAtView();
      }
      if (key === 'u' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (timelineOpen) return;
        spawnAudioGeneratorAtView();
      }
      if (key === 'p' && !e.shiftKey) setActiveTool('pen');
      if (key === 'p' && e.shiftKey) setActiveTool('pencil');
      if (key === 'escape') {
        window.dispatchEvent(new Event('resume:exit-path-edit'));
        setActiveTool('select');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // Intentionally stable: always call latest spawn via closure from this render's effect re-run when deps change.
  }, [
    camera, document,
    L.imageGenerator,
    L.videoGenerator,
    L.animationBoard,
    L.audioGenerator,
    stageEl,
    toolsLocked,
    newPlateLocked,
    timelineOpen,
  ]);

  const placeAtViewportCenter = (
    natural: { width: number; height: number }
  ): { width: number; height: number; x?: number; y?: number } => {
    const view = stageEl?.getBoundingClientRect() || null;
    const placeable =
      camera && stageEl && document && view && view.width > 0 && view.height > 0
        ? { camera, stageEl, document, view }
        : null;
    if (placeable) {
      const laid = layoutGeneratorPlateInView({
        document: placeable.document,
        camera: placeable.camera,
        stageEl: placeable.stageEl,
        natural,
      });
      return { width: laid.width, height: laid.height, x: laid.x, y: laid.y };
    }
    const { width, height } = fitImageSize(natural.width, natural.height, 2400);
    return { width, height };
  };

  const onPickImage = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const preview = createFilePreviewUrl(file);
      const natural = await measureImageNaturalSize(preview);
      const { width, height, x, y } = placeAtViewportCenter(natural);
      startImageUploadPlaceholder({
          src: preview,
          width,
          height,
          x,
          y,
          label: L.uploading,
          name: file.name?.replace(/\.[^.]+$/, '') || 'Image',
        });
      const spawnedId = String(
        (store.getState() as any).editor?.pendingImageProcessId || ''
      );
      await uploadCanvasPlaceholderFile({ nodeId: spawnedId, file });
    } catch (err: any) {
      if (isUploadAbortError(err)) return;
      const failedId = String((store.getState() as any).editor?.pendingImageProcessId || '');
      revokeNodePreviewSrc((store.getState() as any).editor?.document, failedId || undefined);
      failImageProcess({ nodeId: failedId || undefined });
      message.error(getHttpErrorMessage(err, L.uploadFail));
    }
  };

  const onPickVideo = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (warnIfAvBlockedByAnimationWorkbenchFocus(message.warning, t)) return;
    try {
      const prepared = await prepareVideoUploadPreview(file);
      const { width, height, x, y } = placeAtViewportCenter({
        width: prepared.width,
        height: prepared.height,
      });
      startVideoUploadPlaceholder({
          src: prepared.preview,
          poster: prepared.poster,
          width,
          height,
          x,
          y,
          label: L.uploading,
          name: prepared.name,
          duration: prepared.duration,
        });
      const spawnedId = String(
        (store.getState() as any).editor?.pendingImageProcessId || ''
      );
      await uploadCanvasPlaceholderFile({
        nodeId: spawnedId,
        file,
        waitDecode: false,
        extraAttrs: {
          ...(prepared.poster ? { poster: prepared.poster } : {}),
          ...(Number.isFinite(prepared.duration) && prepared.duration > 0
            ? { duration: prepared.duration }
            : {}),
          assetKind: 'video',
        },
      });
    } catch (err: any) {
      if (isUploadAbortError(err)) return;
      const failedId = String((store.getState() as any).editor?.pendingImageProcessId || '');
      revokeNodePreviewSrc((store.getState() as any).editor?.document, failedId || undefined);
      failImageProcess({ nodeId: failedId || undefined });
      message.error(getHttpErrorMessage(err, L.uploadFail));
    }
  };

  const onPickAudio = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (warnIfAvBlockedByAnimationWorkbenchFocus(message.warning, t)) return;
    try {
      const preview = createFilePreviewUrl(file);
      const duration = await new Promise<number | undefined>((resolve) => {
        const audio = new Audio();
        audio.preload = 'metadata';
        audio.onloadedmetadata = () =>
          resolve(Number.isFinite(audio.duration) ? audio.duration : undefined);
        audio.onerror = () => resolve(undefined);
        audio.src = preview;
      });
      const { width, height, x, y } = placeAtViewportCenter({ ...MEDIA_PLACE_DEFAULT });
      startAudioUploadPlaceholder({
          src: preview,
          width,
          height: Math.max(140, height),
          x,
          y,
          label: L.uploading,
          name: file.name?.replace(/\.[^.]+$/, '') || 'Audio',
          duration,
        });
      const spawnedId = String(
        (store.getState() as any).editor?.pendingImageProcessId || ''
      );
      await uploadCanvasPlaceholderFile({
        nodeId: spawnedId,
        file,
        waitDecode: false,
        extraAttrs: {
          ...(duration ? { duration } : {}),
          assetKind: 'audio',
        },
      });
    } catch (err: any) {
      if (isUploadAbortError(err)) return;
      const failedId = String((store.getState() as any).editor?.pendingImageProcessId || '');
      revokeNodePreviewSrc((store.getState() as any).editor?.document, failedId || undefined);
      failImageProcess({ nodeId: failedId || undefined });
      message.error(getHttpErrorMessage(err, L.uploadFail));
    }
  };

  const onPickLottie = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const name = file.name || '';
    if (/\.lottie$/i.test(name)) {
      message.warning(
        t('editor.tools.lottieGenNeedJson', {
          defaultValue: '请上传 Bodymovin JSON（.json / .lot），暂不支持 .lottie 压缩包',
        })
      );
      return;
    }
    try {
      const animationData = parseLottieAnimationData(await file.text());
      if (!animationData) throw new Error('invalid lottie');
      const state = store.getState() as any;
      const doc = state?.editor?.document;
      const timelineHostId = String(state?.editor?.lottieTimelinePanel?.nodeId || '').trim();
      const timelineHost = timelineHostId ? doc?.deltaSetLike?.[timelineHostId] : null;
      const timelineOnWorkbench = Boolean(resolveAnimationFrameId(doc, timelineHost));
      const importName = name.replace(/\.(json|lot)$/i, '') || undefined;
      // Replace JSON only when editing an existing free preview plate (not workbench).
      if (timelineHostId && timelineHost?.key === 'lottie' && !timelineOnWorkbench) {
        const json = serializeLottieAnimationData(animationData);
        if (!json) throw new Error('invalid lottie');
        patchDocumentNode({
            nodeId: timelineHostId,
            patch: {
              attrs: {
                animationData: json,
                ...(importName ? { name: importName } : {}),
              },
            },
          });
        return;
      }
      const natural = {
        width: Math.max(1, Number(animationData.w) || 200),
        height: Math.max(1, Number(animationData.h) || 200),
      };
      const { width, height, x, y } = placeAtViewportCenter(natural);
      // Always independent preview plate — open 「关键帧」 to promote into a workbench.
      spawnLottie({
          width,
          height,
          x,
          y,
          name: importName || 'Lottie',
          animationData,
        });
    } catch {
      message.error(t('editor.tools.lottieGenInvalidJson', { defaultValue: 'Invalid Lottie JSON' }));
    }
  };

  const openImageUpload = () => {
    imageInputRef.current?.click();
  };

  const openVideoUpload = () => {
    if (warnIfAvBlockedByAnimationWorkbenchFocus(message.warning, t)) return;
    videoInputRef.current?.click();
  };

  const openAudioUpload = () => {
    if (warnIfAvBlockedByAnimationWorkbenchFocus(message.warning, t)) return;
    audioInputRef.current?.click();
  };

  const openLottieUpload = () => {
    lottieInputRef.current?.click();
  };

  const pickUpload = (key: string) => {
    setOpenMenu(null);
    pickUploadAction(key, {
      image: openImageUpload,
      video: openVideoUpload,
      audio: openAudioUpload,
      lottie: openLottieUpload,
    });
  };

  const pickGenerator = (key: string) => {
    setOpenMenu(null);
    pickGeneratorAction(key, {
      image: spawnImageGeneratorAtView,
      video: spawnVideoGeneratorAtView,
      audio: spawnAudioGeneratorAtView,
    });
  };

  const pickSelect = (key: string) => {
    // Bottom Select / Pan: leave path-edit if open (✓ / Esc also exit).
    window.dispatchEvent(new Event('resume:exit-path-edit'));
    setActiveTool(key === 'pan' ? 'pan' : 'select');
  };
  const pickShape = (id: string) => {
    if (id === 'image') return;
    setShapeKind(id);
  };
  const pickInk = (id: string) => {
    if (id !== 'pen' && id !== 'pencil') return;
    setLastInkTool(id);
    setActiveTool(id);
  };

  const shapeIconKind = resolveToolbarShapeKind(shapeKind);
  const ShapeIcon = layerIconByKind[shapeIconKind];
  const inkKind =
    activeTool === 'pen' || activeTool === 'pencil' ? activeTool : lastInkTool;
  const InkIcon = layerIconByKind[inkKind] || layerIconByKind.pen;
  const TextIcon = layerIconByKind.text;

  const selectActive = activeTool === 'select' || activeTool === 'pan';
  const frameActive = activeTool === 'frame';
  const shapeActive = activeTool === 'shape';
  const imageActive = activeTool === 'image';
  const inkActive = activeTool === 'pen' || activeTool === 'pencil';
  const textActive = activeTool === 'text';

  return (
    <div className="relative">
      <FloatingToolbar
        bare={chrome === 'flat'}
        variant={chrome === 'flat' ? 'flat' : 'pill'}
        className={cn(
          chrome === 'flat'
            ? 'gap-[15px] px-0 py-0'
            : compact
              ? 'gap-1.5 px-2.5 py-1.5'
              : 'gap-2.5 px-3.5 py-2',
          className
        )}
      >
      {/* Order (ref): select → shape → pen/pencil → text → frame → animation | upload → generator.
          Pen + pencil stay one SplitToolButton (not separate slots). */}
      <SplitToolButton
        tip={`${L.select} / ${L.pan}`}
        active={selectActive}
        menuOpen={openMenu === 'select'}
        onMenuOpenChange={(open) => {
          setOpenMenu(open ? 'select' : null);
        }}
        items={selectItems}
        selectedKeys={[activeTool === 'pan' ? 'pan' : 'select']}
        onMenuPick={pickSelect}
        onPrimaryClick={() =>
          setActiveTool(activeTool === 'pan' ? 'pan' : 'select')
        }
      >
        <ToolIcon>
          {activeTool === 'pan' ? (
            <LuHand className={TOOL_ICON_CLASS} strokeWidth={STROKE} />
          ) : (
            <LuMousePointer2 className={TOOL_ICON_CLASS} strokeWidth={STROKE} />
          )}
        </ToolIcon>
      </SplitToolButton>

      {/* 形状 — click draws current shape, hover to switch */}
      <SplitToolButton
        tip={L.shape}
        active={shapeActive}
        disabled={toolsLocked}
        menuOpen={openMenu === 'shape'}
        onMenuOpenChange={(open) => {
          setOpenMenu(open ? 'shape' : null);
        }}
        items={shapeItems}
        selectedKeys={[shapeKind]}
        onMenuPick={pickShape}
        onPrimaryClick={() =>
          setShapeKind(resolveToolbarShapeKind(shapeKind))
        }
      >
        <ToolIcon>
          <ShapeIcon className={TOOL_ICON_CLASS} strokeWidth={STROKE} />
        </ToolIcon>
      </SplitToolButton>

      {/* 钢笔 / 画笔 — one slot; hover to switch */}
      {!compact ? (
        <SplitToolButton
          tip={`${L.pen} / ${L.pencil}`}
          active={inkActive}
          disabled={toolsLocked}
          menuOpen={openMenu === 'ink'}
          onMenuOpenChange={(open) => {
            setOpenMenu(open ? 'ink' : null);
          }}
          items={inkItems}
          selectedKeys={[inkKind]}
          onMenuPick={pickInk}
          onPrimaryClick={() => {
            setLastInkTool(inkKind);
            setActiveTool(inkKind);
          }}
        >
          <ToolIcon>
            <InkIcon className={TOOL_ICON_CLASS} strokeWidth={STROKE} />
          </ToolIcon>
        </SplitToolButton>
      ) : null}

      {/* 文字 */}
      <ToolBtn
        tip={toolTipWithShortcut(L.text, TOOL_SHORTCUT.text)}
        active={textActive}
        disabled={toolsLocked}
        onClick={() => setActiveTool('text')}
      >
        <ToolIcon>
          <TextIcon className={TOOL_ICON_CLASS} strokeWidth={STROKE} />
        </ToolIcon>
      </ToolBtn>

      {/* 智能画板 — Kit artboard; toolbar appears on the frame after commit */}
      {timelineOpen ? null : (
        <ToolBtn
          tip={toolTipWithShortcut(L.frame, TOOL_SHORTCUT.frame)}
          active={frameActive}
          disabled={toolsLocked}
          onClick={() => {
            if (warnIfNewPlateBlockedByAnimationWorkbenchFocus(message.warning, t, 'artboard')) {
              return;
            }
            setActiveTool('frame');
          }}
        >
          <ToolIcon className="h-3.5 w-3.5">
            <LuFrame className="h-full w-full" strokeWidth={STROKE} />
          </ToolIcon>
        </ToolBtn>
      )}

      {/* 动画工作台 — with create tools (before media divider) */}
      {timelineOpen ? null : (
        <ToolBtn
          tip={toolTipWithShortcut(L.animationBoard, TOOL_SHORTCUT.animationBoard)}
          disabled={toolsLocked}
          onClick={spawnAnimationBoardAtView}
        >
          <ToolIcon>
            <AnimationOutlineIcon className={TOOL_ICON_CLASS} strokeWidth={STROKE} />
          </ToolIcon>
        </ToolBtn>
      )}

      {/* Bucket / eyedropper / mesh — hidden for now (tools + hotkeys retired from rail). */}

      {chrome === 'flat' ? null : (
        <span className="mx-0.5 h-4 w-px shrink-0 bg-[var(--line)]" aria-hidden />
      )}

      <div
        className={cn(
          chrome === 'flat' ? 'relative flex items-center gap-[15px]' : 'contents'
        )}
      >
        {chrome === 'flat' ? (
          <span
            className="absolute -left-[8px] top-1/2 h-4 w-px -translate-y-1/2 bg-[var(--line)]"
            aria-hidden
          />
        ) : null}

      {/* 图片/视频上传 — hover opens panel (同形状工具) */}
      <SplitToolButton
        tip={toolTipWithShortcut(L.uploadMedia, TOOL_SHORTCUT.upload)}
        active={imageActive}
        disabled={toolsLocked}
        menuOpen={openMenu === 'upload'}
        onMenuOpenChange={(open) => {
          setOpenMenu(open ? 'upload' : null);
        }}
        items={uploadItems}
        selectedKeys={[]}
        onMenuPick={pickUpload}
        onPrimaryClick={() => {
          /* Toolbar icon only opens the panel; upload runs from menu rows. */
        }}
      >
        <ToolIcon>
          <LuImageUp className={TOOL_ICON_CLASS} strokeWidth={STROKE} />
        </ToolIcon>
      </SplitToolButton>

      {/* Generators — image / video / audio only (Lottie is a separate artboard tool). */}
      <SplitToolButton
        tip={toolTipWithShortcut(L.imageGenerator, TOOL_SHORTCUT.imageGenerator)}
        disabled={toolsLocked}
        menuOpen={openMenu === 'generator'}
        onMenuOpenChange={(open) => {
          setOpenMenu(open ? 'generator' : null);
        }}
        items={generatorItems}
        selectedKeys={[]}
        onMenuPick={pickGenerator}
        onPrimaryClick={() => {
          /* Toolbar icon only opens the panel; spawn runs from menu rows. */
        }}
      >
        <ToolIcon>
          <LuImagePlus className={TOOL_ICON_CLASS} strokeWidth={STROKE} />
        </ToolIcon>
      </SplitToolButton>

      {pluginButtons.map((btn) => (
        <ToolBtn
          key={btn.id}
          tip={btn.tip}
          disabled={toolsLocked}
          onClick={() => {
            const runtime = buildCanvasPluginRuntime(() => store.getState(), {
              camera,
              stageEl,
            });
            btn.onClick(runtime);
          }}
        >
          <ToolIcon>
            {btn.icon ? (
              btn.icon
            ) : btn.iconSrc ? (
              <img src={btn.iconSrc} alt="" className={TOOL_ICON_CLASS} />
            ) : (
              <LuHexagon className={TOOL_ICON_CLASS} strokeWidth={STROKE} />
            )}
          </ToolIcon>
        </ToolBtn>
      ))}
      </div>
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onPickImage}
      />
      <input
        ref={videoInputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={onPickVideo}
      />
      <input
        ref={audioInputRef}
        type="file"
        accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac"
        className="hidden"
        onChange={onPickAudio}
      />
      <input
        ref={lottieInputRef}
        type="file"
        accept="application/json,.json,.lot,text/plain"
        className="hidden"
        onChange={onPickLottie}
      />
      </FloatingToolbar>
    </div>
  );
}

export default memo(EditorToolStrip);
