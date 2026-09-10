import { useEffect, useMemo, useState, type ReactNode, memo } from 'react';
import { useSelector } from '@/store';
import { useTranslation } from 'react-i18next';
import {
  HiOutlineBold,
  HiOutlineChevronDown,
  HiOutlineCodeBracket,
  HiOutlineItalic,
  HiOutlineLink,
  HiOutlineLinkSlash,
  HiOutlineStrikethrough,
  HiOutlineUnderline,
} from 'react-icons/hi2';
import {
  MdFormatAlignCenter,
  MdFormatAlignLeft,
  MdFormatAlignRight,
  MdFormatOverline,
  MdOutlineWrapText,
} from 'react-icons/md';
import AppLogo from '@/components/base/AppLogo';
import { ColorPanelPopover, INPUT_NO_SPIN } from '@/components/base/colorPanel';
import { DropdownPanel, DropdownPanelItem, message } from '@/components/base';
import Tooltip from '@/components/base/tooltip';
import {
  openShapeStylePanel,
  patchDocumentNode,
  startImageProcess,
  openImageToolPanel,
  openVideoToolPanel,
  openAudioToolPanel,
  isImageToolSidePanelKind,
  isQuickEditMarkPanel,
  type ImageToolPanelState,
} from '@/store/modules/editor';
import FlipRotateToolbar from '@/components/editor/nodes/ImageNode/FlipRotateToolbar';
import VideoQuickEditComposer from '@/components/editor/nodes/VideoNode/VideoQuickEditComposer';
import AudioQuickEditComposer from '@/components/editor/nodes/AudioNode/AudioQuickEditComposer';
import AnimationToolbarEditTools from '@/components/editor/nodes/AnimationNode/AnimationToolbarEditTools';
import AnimationFrameChildToolbar from '@/components/editor/nodes/AnimationNode/AnimationFrameChildToolbar';
import { resolveAnimationFrameId } from '@/components/editor/nodes/AnimationNode/resolveAnimationFrameId';
import { ExportSelectionPopover } from '@/components/editor/panels/ExportSelectionPanel';
import { ImageToolSep, imageToolBtn } from '@/components/editor/nodes/ImageNode/imageToolbarShared';
import {
  buildMarkdownTextAttrs,
  buildTextAttrsPreservingMarkdown,
  defaultTextWrapWidthForFontSize,
  isTextBold,
  isTextItalic,
  isTextOverline,
  isTextStrike,
  isTextUnderline,
  measurePlainTextSize,
  measureTextFrameExitBox,
  measureTextNodeBoxAfterStyleChange,
  measureWrappedTextSize,
  normalizeTextFontSize,
  parseNodeMarkdown,
  parseNodeText,
  parseNodeTextStyle,
  toggleTextDecoration,
} from '@/components/rcb/scene/document/sceneText';
import { markdownToPlain } from '@/components/rcb/scene/document/sceneMarkdown';
import { TEXT_FRAME_PADDING, TEXT_FRAME_RADIUS } from '@/components/rcb/scene/document/sceneEffects';
import { clearNodeTransformPreviews } from '@/components/rcb/core/transformPreview';
import { getSharedNodeEls } from '@/components/rcb/shapes/shapeHostRegistry';
import {
  isAudioGeneratorNode,
  isIconImageNode,
  isImageGeneratorNode,
  isImageProcessRunning,
  isLottieGeneratorNode,
  isAnimationFrameHostNode,
  isTextFrameNode,
  isVideoGeneratorNode,
  supportsCornerRadius,
} from '@/components/rcb/scene/document/nodeCapabilities';
import ImageGeneratorCard from '@/components/editor/nodes/ImageGeneratorNode/ImageGeneratorCard';
import VideoGeneratorCard from '@/components/editor/nodes/VideoGeneratorNode/VideoGeneratorCard';
import AnimationGeneratorCard from '@/components/editor/nodes/AnimationGeneratorNode/AnimationGeneratorCard';
import AudioGeneratorCard from '@/components/editor/nodes/AudioGeneratorNode/AudioGeneratorCard';
import { type ImageProcessKind } from '@/components/rcb/scene/document/mediaLifecycle';
import ToolbarMenuSelect from './ToolbarMenuSelect';
import { BlendModeIcon, OpacityControl } from './BlendModeControl';
import {
  SEL_ICON_BTN,
  SEL_ICON_BTN_ACTIVE,
  SEL_SIZE_INPUT,
  SEL_TOOL_BTN,
} from './ToolbarValueSlider';
import FontFamilyPicker from '@/components/editor/nodes/TextNode/FontFamilyPicker';
import TextEditDialog from '@/components/editor/nodes/TextNode/TextEditDialog';
import IconAnnotateToolbar from '@/components/editor/nodes/ImageNode/IconAnnotateToolbar';
import ImageToolbarEditTools from '@/components/editor/nodes/ImageNode/ImageToolbarEditTools';
import { canMarkNode } from '@/components/editor/nodes/ImageNode/mark/markGeometry';
import { expandPuppetTimelineLayer } from '@/components/editor/nodes/ImageNode/puppet/puppetTimeline';
import { AI_IMAGE_PROCESS_KINDS } from '@/service/imageTools';
import ImageToolbarMoreDownload, {
  ToolbarMoreMenu,
  type ImageMoreAction,
  type ToolbarMoreItem,
} from '@/components/editor/nodes/ImageNode/ImageToolbarMoreDownload';
import ImageFullscreenPreviewButton from '@/components/editor/nodes/ImageNode/ImageFullscreenPreviewButton';
import VideoDownloadButton from '@/components/editor/nodes/VideoNode/VideoDownloadButton';
import VideoFullscreenPreviewButton from '@/components/editor/nodes/VideoNode/VideoFullscreenPreviewButton';
import VideoToolbarEditTools from '@/components/editor/nodes/VideoNode/VideoToolbarEditTools';
import { getVideoHoverHost } from '@/components/editor/nodes/VideoNode/VideoHoverPlayback';
import AudioToolbarEditTools from '@/components/editor/nodes/AudioNode/AudioToolbarEditTools';
import { getAudioHost } from '@/components/editor/nodes/AudioNode/AudioNodeOverlay';
import ShapeSelectionToolbar from '@/components/editor/nodes/ShapeNode/ShapeSelectionToolbar';
import { SelectionToolbarShell } from './SelectionToolbarShell';
import { enterKitPathEditForRcbId } from '@/components/rcb/canvas/kitBridge';
import {
  loadFontCatalog,
  parseWeightSelectValue,
  resolveWeightSelectValue,
  toggleCatalogTextBold,
  weightOptionsForFamily,
} from '@/components/rcb/scene/document/fontCatalog';
import { MdOutlineFlip } from 'react-icons/md';
import { TbDroplet, TbVectorBezier } from 'react-icons/tb';
import { cn } from '@/utils/classnames';
import type { SceneDocument, SceneNode, SceneNodeInput } from '@/components/rcb/sceneNode';

type SceneBox = { left: number; top: number; width: number; height: number };

type Props = {
  document: SceneDocument;
  nodeId: string;
  box: SceneBox;
  /** True node geometry used for W/H; box is only the toolbar placement box. */
  valueBox?: SceneBox;
  /** Scene pad beyond chrome for outer stroke ink (center stroke half-width). */
  edgePadScene?: number;
  /** Live control-box angle — dock to visual AABB; toolbar stays screen-upright (Kit context bar is never CSS-rotated). */
  angle?: number;
  onOpenAgent?: (opts?: { prompt?: string }) => void;
};

const btn = SEL_TOOL_BTN;

function Sep() {
  return <div className="mx-0.5 h-4 w-px shrink-0 bg-[var(--line)]" aria-hidden />;
}

/** Prefer attrs.lockAspect; default locked for image/video. */
function resolveImageAspectLocked(node: SceneNodeInput, kind: string): boolean {
  const raw = node?.attrs?.lockAspect;
  if (raw === true || raw === 'true' || raw === 1 || raw === '1') return true;
  if (raw === false || raw === 'false' || raw === 0 || raw === '0') return false;
  return kind === 'image' || kind === 'video' || kind === 'lottie' || kind === 'audio';
}

/** Solid MD glyphs — outline bars-3 reads too light next to B/I/U. */
function AlignIcon({ align }: { align: string }) {
  const cls = 'h-3.5 w-3.5 text-current';
  if (align === 'center') return <MdFormatAlignCenter className={cls} />;
  if (align === 'right') return <MdFormatAlignRight className={cls} />;
  return <MdFormatAlignLeft className={cls} />;
}

function DecorationsTriggerIcon({
  underline,
  overline,
  strike,
}: {
  underline: boolean;
  overline: boolean;
  strike: boolean;
}) {
  const cls = 'h-3.5 w-3.5 text-current';
  if (underline && !overline && !strike) return <HiOutlineUnderline className={cls} strokeWidth={2} />;
  if (overline && !underline && !strike) return <MdFormatOverline className={cls} />;
  if (strike && !underline && !overline) {
    return <HiOutlineStrikethrough className={cls} strokeWidth={2} />;
  }
  return <HiOutlineUnderline className={cls} strokeWidth={2} />;
}

type TextAlignValue = 'left' | 'center' | 'right';
type TextDecorationToken = 'underline' | 'overline' | 'line-through';

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

function textAlignOptions(t: TranslateFn) {
  return [
    { value: 'left' as const, label: t('editor.imageToolbar.alignLeft'), Icon: MdFormatAlignLeft },
    {
      value: 'center' as const,
      label: t('editor.imageToolbar.alignCenter'),
      Icon: MdFormatAlignCenter,
    },
    { value: 'right' as const, label: t('editor.imageToolbar.alignRight'), Icon: MdFormatAlignRight },
  ];
}

function textDecorationOptions(
  t: TranslateFn,
  style: NonNullable<ReturnType<typeof parseNodeTextStyle>>
) {
  return [
    {
      token: 'underline' as const,
      label: t('editor.imageToolbar.underline'),
      Icon: HiOutlineUnderline,
      on: isTextUnderline(style),
    },
    {
      token: 'overline' as const,
      label: t('editor.imageToolbar.overline'),
      Icon: MdFormatOverline,
      on: isTextOverline(style),
    },
    {
      token: 'line-through' as const,
      label: t('editor.imageToolbar.strike'),
      Icon: HiOutlineStrikethrough,
      on: isTextStrike(style),
    },
  ];
}

function TextAlignMenuItems({
  textAlign,
  t,
  onPick,
}: {
  textAlign: string;
  t: TranslateFn;
  onPick: (value: TextAlignValue) => void;
}) {
  return textAlignOptions(t).map(({ value, label, Icon }) => (
    <DropdownPanelItem
      key={value}
      selected={textAlign === value}
      className="gap-2 whitespace-nowrap"
      onClick={() => onPick(value)}
    >
      <Icon className="h-4 w-4 shrink-0 text-[var(--ink)]" />
      <span className="whitespace-nowrap">{label}</span>
      {textAlign === value ? (
        <span className="ml-auto text-[11px] text-[var(--muted)]">✓</span>
      ) : null}
    </DropdownPanelItem>
  ));
}

function TextDecorationMenuItems({
  style,
  t,
  onToggle,
}: {
  style: NonNullable<ReturnType<typeof parseNodeTextStyle>>;
  t: TranslateFn;
  onToggle: (token: TextDecorationToken) => void;
}) {
  return textDecorationOptions(t, style).map(({ token, label, Icon, on }) => (
    <DropdownPanelItem
      key={token}
      selected={on}
      className="gap-2 whitespace-nowrap"
      onClick={() => onToggle(token)}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="whitespace-nowrap">{label}</span>
      {on ? <span className="ml-auto text-[11px] text-[var(--muted)]">✓</span> : null}
    </DropdownPanelItem>
  ));
}

function isPanelKindOnNode(
  panel: { nodeId: string; kind: string } | null | undefined,
  nodeId: string,
  kind: string,
  nodeKey: string,
  allowedKeys: readonly string[]
): boolean {
  if (!panel || panel.nodeId !== nodeId || panel.kind !== kind) return false;
  return allowedKeys.includes(nodeKey);
}

function openImageMoreTool(
  nodeId: string,
  key: ImageMoreAction,
  document?: SceneDocument,
  t?: (key: string, opts?: { defaultValue?: string }) => string
) {
  if (key === 'cornerRadius') {
    openShapeStylePanel({ kind: 'radius', nodeIds: [nodeId] });
    return;
  }
  if (key === 'mockup') {
    const node = document?.deltaSetLike?.[nodeId];
    const active =
      node?.attrs?.mockupEnabled === true || node?.attrs?.mockupEnabled === 'true';
    const src = String(node?.attrs?.src || '').trim();
    if (!active) {
      patchDocumentNode({
          nodeId,
          patch: {
            attrs: {
              mockupEnabled: 'true',
              mockupTemplateId: 'auto-bake',
              ...(src && !node?.attrs?.mockupBaseSrc ? { mockupBaseSrc: src } : {}),
            },
          },
        });
      return;
    }
    // Already in mockup mode — enter adjust / re-process, never toggle off.
    patchDocumentNode({
        nodeId,
        patch: {
          attrs: {
            mockupAdjust: String(Date.now()),
          },
        },
        skipHostReload: true,
      });
    return;
  }
  if (key === 'vectorize') {
    if (!AI_IMAGE_PROCESS_KINDS.has('vector')) {
      message.warning(
        t
          ? t('editor.lottieToolbar.vectorizeUnavailable', {
              defaultValue: '矢量化暂不可用',
            })
          : '矢量化暂不可用'
      );
      return;
    }
    startImageProcess({
        sourceId: nodeId,
        kind: 'vector',
        label: t
          ? t('editor.imageToolbar.vectorize', { defaultValue: '矢量化' })
          : '矢量化',
      });
    return;
  }
  if (key === 'expand') {
    openImageToolPanel({ nodeId, kind: 'expand' });
    return;
  }
  switch (key) {
    case 'crop':
    case 'adjust':
    case 'blendMode':
    case 'effects':
    case 'flipRotate':
    case 'opacity':
      openImageToolPanel({ nodeId, kind: key });
      return;
    default:
      return;
  }
}

async function outlineSelectedNode(opts: {
  nodeId: string;
  failLabel: string;
}) {
  if (!enterKitPathEditForRcbId(opts.nodeId)) {
    message.error(opts.failLabel);
  }
}

function SelectionContextToolbar(props: Props): ReactNode {
  const { document, nodeId, box, valueBox, edgePadScene = 0, angle: angleProp } = props;
  const { t } = useTranslation();
  const [decorationOpen, setDecorationOpen] = useState(false);
  const [alignOpen, setAlignOpen] = useState(false);
  const imageToolPanel = useSelector(
    (s: any) => s.editor.imageToolPanel as ImageToolPanelState | null
  );
  const mockupEnabled = true;
  const node = document?.deltaSetLike?.[nodeId];
  const kind = node?.key || 'shape';
  const isVectorKind =
    kind === 'shape' || kind === 'rect' || kind === 'ellipse' || kind === 'path' || kind === 'svg';
  const flipRotateOpen = isPanelKindOnNode(
    imageToolPanel,
    nodeId,
    'flipRotate',
    kind,
    ['image', 'video', 'shape', 'rect', 'ellipse', 'path', 'svg']
  );
  const quickEditMarkPaused = isQuickEditMarkPanel(imageToolPanel, nodeId, kind);
  const quickEditOpen = isPanelKindOnNode(
    imageToolPanel,
    nodeId,
    'quickEdit',
    kind,
    ['image', 'video', 'audio', 'lottie']
  );
  const quickEditComposerOpen = quickEditOpen || quickEditMarkPaused;
  const lottieEditOpen = isPanelKindOnNode(
    imageToolPanel,
    nodeId,
    'lottieEdit',
    kind,
    ['lottie']
  );
  const imageSidePanelOpen =
    imageToolPanel?.nodeId != null &&
    isImageToolSidePanelKind(imageToolPanel.kind) &&
    // Keep image toolbar mounted in puppet mode (pins + density panel).
    imageToolPanel.kind !== 'puppet';
  const [mdOpen, setMdOpen] = useState(false);
  const [fontCatalogTick, setFontCatalogTick] = useState(0);
  const style = useMemo(
    () => (kind === 'text' ? parseNodeTextStyle(node?.attrs || {}) : null),
    [kind, node?.attrs]
  );

  useEffect(() => {
    let cancelled = false;
    async function loadCatalog() {
      await loadFontCatalog();
      if (!cancelled) setFontCatalogTick((n) => n + 1);
    }
    loadCatalog();
    const onFontsUpdated = () => {
      void loadCatalog();
    };
    window.addEventListener('recombyn:font-catalog-updated', onFontsUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener('recombyn:font-catalog-updated', onFontsUpdated);
    };
  }, []);

  useEffect(() => {
    if (!decorationOpen && !alignOpen) return;
    const onPointer = (e: PointerEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest?.('[data-text-toolbar-menu]')) return;
      setDecorationOpen(false);
      setAlignOpen(false);
    };
    window.addEventListener('pointerdown', onPointer, true);
    return () => window.removeEventListener('pointerdown', onPointer, true);
  }, [decorationOpen, alignOpen]);

  if (!node || !box) return null;
  // Timeline host under 动画工作——select frame instead; no node chrome.
  if (isAnimationFrameHostNode(node, document)) return null;

  const placementAngle = angleProp ?? (Number(node?.attrs?.angle) || 0);
  const genBox = { x: box.left, y: box.top, width: box.width, height: box.height };

  // 动画工作台内子元素：对齐 / 人偶 / 属性（含嵌套 LOT；点 LOT 页签才进内部编辑）。
  const animationFrameId = resolveAnimationFrameId(document, node);
  if (animationFrameId) {
    return (
      <AnimationFrameChildToolbar
        document={document}
        nodeId={nodeId}
        box={box}
        valueBox={valueBox}
        edgePadScene={edgePadScene}
        angle={placementAngle}
      />
    );
  }

  // Same mount gate as image/video toolbars (SelectionFeature). Content only differs.
  if (isImageGeneratorNode(node)) {
    return <ImageGeneratorCard nodeId={nodeId} sceneBox={genBox} />;
  }
  if (isVideoGeneratorNode(node)) {
    return <VideoGeneratorCard nodeId={nodeId} sceneBox={genBox} />;
  }
  if (isLottieGeneratorNode(node)) {
    return <AnimationGeneratorCard nodeId={nodeId} sceneBox={genBox} />;
  }
  if (isAudioGeneratorNode(node)) {
    return <AudioGeneratorCard nodeId={nodeId} sceneBox={genBox} />;
  }

  if (isImageProcessRunning(node)) return null;

  if (imageSidePanelOpen) return null;

  if (quickEditComposerOpen || lottieEditOpen) {
    if (kind === 'image') return null;
    if (kind === 'video') {
      return <VideoQuickEditComposer document={document} nodeId={nodeId} box={box} />;
    }
    if (kind === 'audio') {
      return <AudioQuickEditComposer document={document} nodeId={nodeId} box={box} />;
    }
    // Lottie: use right-side Agent chat — no on-canvas quick-edit composer.
  }

  const fontSizePx = normalizeTextFontSize(style?.fontSize);

  const patchTextStyle = (partial: Record<string, unknown>) => {
    const mergedStyle = {
      ...parseNodeTextStyle(node.attrs || {}),
      ...partial,
    };
    if (partial.fontSize != null) {
      mergedStyle.fontSize = normalizeTextFontSize(partial.fontSize);
    }
    const nextAttrs = buildTextAttrsPreservingMarkdown(node.attrs || {}, mergedStyle);
    const { width, height } = measureTextNodeBoxAfterStyleChange(node, mergedStyle);
    const nodeEls = getSharedNodeEls();
    if (nodeEls) {
      const el = nodeEls.get(nodeId) as
        | (SVGElement & {
            __sceneDragBaseW?: number;
            __sceneDragBaseH?: number;
            __sceneDragBaseFontSize?: number;
            __sceneDragBaseLetterSpacing?: number;
            __sceneFontSize?: number;
          })
        | undefined;
      if (el) {
        delete el.__sceneDragBaseW;
        delete el.__sceneDragBaseH;
        delete el.__sceneDragBaseFontSize;
        delete el.__sceneDragBaseLetterSpacing;
        el.__sceneFontSize = Number(mergedStyle.fontSize) || undefined;
      }
    }
    patchDocumentNode({
        nodeId,
        patch: {
          attrs: nextAttrs,
          width,
          height,
        },
        // Noop preview always returned false — remount host from document.
        skipHostReload: false,
      });
    clearNodeTransformPreviews([nodeId]);
  };

  const commitFontSize = (raw: string) => {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return;
    const next = normalizeTextFontSize(trimmed, fontSizePx);
    if (next === fontSizePx) return;
    patchTextStyle({ fontSize: next });
  };

  const isTextBoxMode = String(node?.attrs?.textFrame ?? '') === 'true';

  /** Plain text — fixed plate with scrollable content (image-like W×H). */
  const toggleTextBoxMode = () => {
    if (!node || !style) return;
    const plain = parseNodeText(node.attrs || {}) || ' ';
    if (isTextBoxMode) {
      const measured = measureTextFrameExitBox(node, style);
      patchDocumentNode({
          nodeId,
          patch: {
            attrs: { textFrame: null, autoSize: 'false', lockAspect: null },
            width: measured.width,
            height: measured.height,
          },
        });
      return;
    }
    const fs = Math.max(1, Number(style.fontSize) || 14);
    const wrapW = defaultTextWrapWidthForFontSize(fs);
    const content = measureWrappedTextSize(plain, style, wrapW);
    const pad = TEXT_FRAME_PADDING * 2;
    const side = Math.min(
      wrapW * 4,
      Math.max(
        wrapW,
        content.width + pad,
        content.height + pad,
        Number(node.width) || 0,
        Number(node.height) || 0
      )
    );
    const titleName =
      String(node.attrs?.name || '').trim() ||
      plain.replace(/\s+/g, ' ').trim().slice(0, 48) ||
      'Text';
    patchDocumentNode({
        nodeId,
        patch: {
          attrs: {
            textFrame: 'true',
            autoSize: 'false',
            lockAspect: 'true',
            name: titleName,
            'fill-color': '#FFFFFF',
            radiusTL: TEXT_FRAME_RADIUS,
            radiusTR: TEXT_FRAME_RADIUS,
            radiusBR: TEXT_FRAME_RADIUS,
            radiusBL: TEXT_FRAME_RADIUS,
            radiusLinked: 'true',
          },
          width: Math.round(side),
          height: Math.round(side),
        },
      });
  };

  const commitTextBoxSize = (axis: 'w' | 'h', raw: string) => {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return;
    const n = Math.round(Number(trimmed));
    if (!Number.isFinite(n) || n < 1) return;
    const curW = Math.max(1, Math.round(Number(node?.width) || 1));
    const curH = Math.max(1, Math.round(Number(node?.height) || 1));
    if (n === curW && n === curH) return;
    patchDocumentNode({
        nodeId,
        patch: {
          attrs: { textFrame: 'true', autoSize: 'false', lockAspect: 'true' },
          width: n,
          height: n,
        },
      });
  };

  const textAlign = String(style?.textAlign || 'left');
  const fontFamily = String(style?.fontFamily || 'Alibaba PuHuiTi');
  // fontCatalogTick bumps after catalog load so weight options re-resolve.
  const weightFaces = weightOptionsForFamily(fontFamily);
  const weightSelectOptions = weightFaces.map((o) => ({ value: o.value, label: o.label }));
  const weightSelectValue = resolveWeightSelectValue(fontFamily, style?.fontWeight);
  const weightDisplayLabel =
    weightFaces.find((o) => o.value === weightSelectValue)?.label ||
    weightFaces[0]?.label ||
    'Regular';
  const showWeightSelect = weightFaces.length > 1;
  const showBoldToggle = true;
  const fontCatalogEpoch = fontCatalogTick;

  const runImageProcess = (
    kind: ImageProcessKind,
    label: string,
    size?: { targetWidth?: number; targetHeight?: number },
    meta?: Record<string, unknown>
  ) => {
    startImageProcess({
        sourceId: nodeId,
        kind,
        label,
        targetWidth: size?.targetWidth,
        targetHeight: size?.targetHeight,
        meta,
      });
  };

  const showLayerChrome = kind !== 'image';
  const supportsEffects = !['image', 'video', 'audio', 'lottie', 'frame', 'group'].includes(kind);
  const showOutline = isVectorKind;
  const imageAspectLocked = resolveImageAspectLocked(node, kind);
  const opacityControl = showLayerChrome ? (
    <OpacityControl nodeId={nodeId} />
  ) : null;
  const elementMoreItems: ToolbarMoreItem[] = [];
  if (showOutline) {
    elementMoreItems.push({
      key: 'outline',
      icon: <TbVectorBezier className="h-4 w-4" />,
      label: t('editor.imageToolbar.outline'),
    });
  }
  if (isVectorKind) {
    elementMoreItems.push({
      key: 'flipRotate',
      icon: <MdOutlineFlip className="h-4 w-4" />,
      label: t('editor.imageToolbar.flipRotate'),
    });
  }
  if (showLayerChrome) {
    elementMoreItems.push({
      key: 'blendMode',
      icon: <BlendModeIcon mode="normal" className="h-4 w-4" />,
      label: t('editor.imageToolbar.blendMode'),
    });
  }
  if (supportsEffects) {
    elementMoreItems.push({
      key: 'effects',
      icon: <TbDroplet className="h-4 w-4" />,
      label: t('editor.imageToolbar.effects'),
    });
  }
  if (kind === 'text') {
    elementMoreItems.push({
      key: 'textFrame',
      icon: <MdOutlineWrapText className="h-4 w-4" />,
      label: isTextBoxMode ? t('editor.textBoxModeOff') : t('editor.textBoxModeOn'),
    });
  }
  const runElementMore = (key: string) => {
    if (key === 'textFrame') {
      toggleTextBoxMode();
      return;
    }
    if (key === 'outline') {
      void outlineSelectedNode({
        nodeId,
        failLabel: t('editor.imageToolbar.outlineFailed'),
      });
      return;
    }
    if (key === 'flipRotate' || key === 'blendMode' || key === 'effects') {
      openImageToolPanel({ nodeId, kind: key });
    }
  };
  const elementLayerChrome =
    opacityControl || elementMoreItems.length ? (
      <>
        {opacityControl}
        <ToolbarMoreMenu
          items={elementMoreItems}
          onAction={runElementMore}
          triggerClassName={SEL_TOOL_BTN}
        />
      </>
    ) : null;

  const flipRotateToolbar = (
    <FlipRotateToolbar
      nodeId={nodeId}
      angle={Number(node?.attrs?.angle) || 0}
      flipX={node?.attrs?.flipX === true || node?.attrs?.flipX === 'true'}
      flipY={node?.attrs?.flipY === true || node?.attrs?.flipY === 'true'}
    />
  );

  let imageToolbarChrome: ReactNode = null;
  if (kind === 'image') {
    if (flipRotateOpen) {
      imageToolbarChrome = flipRotateToolbar;
    } else if (isIconImageNode(node)) {
      imageToolbarChrome = (
        <IconAnnotateToolbar
          downloadSlot={
            <ExportSelectionPopover
              nodeIds={[nodeId]}
              triggerClassName={cn(imageToolBtn, 'text-white/85 hover:bg-white/10')}
            />
          }
        />
      );
    } else {
      imageToolbarChrome = (
        <>
          <button
            type="button"
            className={imageToolBtn}
            data-media-quick-edit-trigger
            aria-label={t('editor.imageToolbar.chat')}
            onClick={() => openImageToolPanel({ nodeId, kind: 'quickEdit' })}
          >
            <AppLogo size={16} />
            <span>{t('editor.imageToolbar.chat')}</span>
          </button>
          <ImageToolSep />
          <ImageToolbarEditTools
            onUpscale={() => openImageToolPanel({ nodeId, kind: 'upscale' })}
            onTranslateImage={() =>
              openImageToolPanel({ nodeId, kind: 'translateImage' })
            }
            onProductScene={() =>
              openImageToolPanel({ nodeId, kind: 'productScene' })
            }
            onRemoveBg={() =>
              runImageProcess(
                'removeBg',
                t('editor.imageToolbar.processingRemoveBg'),
                undefined,
                { scene: 'general' }
              )
            }
            onEraser={() => openImageToolPanel({ nodeId, kind: 'eraser' })}
            onMark={
              canMarkNode(node)
                ? () =>
                    openImageToolPanel({
                        nodeId,
                        kind: 'mark',
                        ...(quickEditOpen ? { markSink: 'quickEdit' as const } : {}),
                      })
                : undefined
            }
            onPuppet={
              animationFrameId
                ? () => {
                    openImageToolPanel({ nodeId, kind: 'puppet' });
                    patchDocumentNode({
                        nodeId,
                        patch: { attrs: { puppetEnabled: true } },
                      });
                    expandPuppetTimelineLayer(node);
                  }
                : undefined
            }
            puppetActive={
              Boolean(animationFrameId) &&
              imageToolPanel?.kind === 'puppet' &&
              imageToolPanel?.nodeId === nodeId
            }
            onReplaceText={
              String(node?.attrs?.letteringText || '').trim()
                ? () => openImageToolPanel({ nodeId, kind: 'replaceText' })
                : undefined
            }
            onEditText={() =>
              runImageProcess('editText', t('editor.imageToolbar.processingEditText'))
            }
            onEditElements={() =>
              runImageProcess(
                'editElements',
                t('editor.imageToolbar.processingEditElements')
              )
            }
            onMultiAngle={() =>
              openImageToolPanel({ nodeId, kind: 'multiAngle' })
            }
          />
          <ImageToolbarMoreDownload
            mockupEnabled={mockupEnabled}
            showCornerRadius={supportsCornerRadius(node)}
            vectorizeEnabled={AI_IMAGE_PROCESS_KINDS.has('vector')}
            expandEnabled
            onAction={(key) => openImageMoreTool(nodeId, key, document, t)}
          />
          <Sep />
          <Tooltip
            tip={
              imageAspectLocked
                ? t('editor.imageToolbar.unlockAspect')
                : t('editor.imageToolbar.lockAspect')
            }
            placement="top"
          >
            <button
              type="button"
              aria-label={
                imageAspectLocked
                ? t('editor.imageToolbar.unlockAspect')
                : t('editor.imageToolbar.lockAspect')
              }
              aria-pressed={imageAspectLocked}
              className={cn(
                'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--ink)]',
                imageAspectLocked && 'bg-[var(--accent-soft)] text-[var(--ink)]'
              )}
              onClick={() =>
                patchDocumentNode({
                    nodeId,
                    patch: {
                      attrs: { lockAspect: imageAspectLocked ? 'false' : 'true' },
                    },
                  })
              }
            >
              {imageAspectLocked ? (
                <HiOutlineLink className="h-3.5 w-3.5" strokeWidth={1.75} />
              ) : (
                <HiOutlineLinkSlash className="h-3.5 w-3.5" strokeWidth={1.75} />
              )}
            </button>
          </Tooltip>
          <ImageFullscreenPreviewButton src={String(node?.attrs?.src || '')} />
          <ExportSelectionPopover nodeIds={[nodeId]} triggerClassName={imageToolBtn} />
        </>
      );
    }
  }

  let videoToolbarChrome: ReactNode = null;
  if (kind === 'video') {
    if (flipRotateOpen) {
      videoToolbarChrome = (
        <FlipRotateToolbar
          nodeId={nodeId}
          angle={Number(node?.attrs?.angle) || 0}
          flipX={node?.attrs?.flipX === true || node?.attrs?.flipX === 'true'}
          flipY={node?.attrs?.flipY === true || node?.attrs?.flipY === 'true'}
          hideRotate
        />
      );
    } else {
      videoToolbarChrome = (
        <VideoToolbarEditTools
          nodeId={nodeId}
          onQuickEdit={() =>
            openImageToolPanel({ nodeId, kind: 'quickEdit' })
          }
          onTrim={() => {
            // Capture playhead before trim UI hides the hover host / remounts preview.
            const host = getVideoHoverHost(nodeId);
            const video = host?.getVideo?.();
            const vals = [host?.getFreezeAt?.(), host?.getMediaTime?.(), video?.currentTime]
              .map((x) => Number(x))
              .filter((x) => Number.isFinite(x) && x >= 0);
            const keepTime = vals.length ? Math.max(...vals) : 0;
            openVideoToolPanel({ nodeId, kind: 'trim', keepTime });
          }}
          onCrop={() => openImageToolPanel({ nodeId, kind: 'crop' })}
          onFlipRotate={() =>
            openImageToolPanel({ nodeId, kind: 'flipRotate' })
          }
          downloadSlot={
            <VideoDownloadButton
              src={String(node?.attrs?.src || '')}
              name={String(node?.attrs?.name || 'video')}
              uploadKey={
                String(node?.attrs?.uploadKey || node?.attrs?.key || '').trim() || null
              }
              cropX={Number(node?.attrs?.cropX)}
              cropY={Number(node?.attrs?.cropY)}
              cropW={Number(node?.attrs?.cropW)}
              cropH={Number(node?.attrs?.cropH)}
              trimStart={Number(node?.attrs?.trimStart)}
              trimEnd={Number(node?.attrs?.trimEnd)}
              flipX={node?.attrs?.flipX === true || node?.attrs?.flipX === 'true'}
              flipY={node?.attrs?.flipY === true || node?.attrs?.flipY === 'true'}
            />
          }
          fullscreenSlot={
            <VideoFullscreenPreviewButton
              src={String(node?.attrs?.src || '')}
              poster={String(node?.attrs?.poster || '').trim() || null}
              uploadKey={
                String(node?.attrs?.uploadKey || node?.attrs?.key || '').trim() || null
              }
              aspectWidth={Number(node?.width) || undefined}
              aspectHeight={Number(node?.height) || undefined}
              cropX={Number(node?.attrs?.cropX)}
              cropY={Number(node?.attrs?.cropY)}
              cropW={Number(node?.attrs?.cropW)}
              cropH={Number(node?.attrs?.cropH)}
              trimStart={Number(node?.attrs?.trimStart)}
              trimEnd={Number(node?.attrs?.trimEnd)}
              flipX={node?.attrs?.flipX === true || node?.attrs?.flipX === 'true'}
              flipY={node?.attrs?.flipY === true || node?.attrs?.flipY === 'true'}
              duration={Number(node?.attrs?.duration)}
            />
          }
        />
      );
    }
  }

  const isShapeKind =
    kind === 'shape' || kind === 'rect' || kind === 'ellipse' || kind === 'path';
  const hasTitleLabel =
    kind === 'image' ||
    kind === 'video' ||
    kind === 'lottie' ||
    kind === 'audio' ||
    (kind === 'text' && isTextFrameNode(node));

  let lottieToolbarChrome: ReactNode = null;
  if (kind === 'lottie') {
    lottieToolbarChrome = (
      <>
        <AnimationToolbarEditTools
          nodeId={nodeId}
          loop={!(
            node?.attrs?.lottieLoop === false ||
            node?.attrs?.lottieLoop === 'false' ||
            node?.attrs?.lottieLoop === 0 ||
            node?.attrs?.lottieLoop === '0'
          )}
          speed={Math.max(0.25, Number(node?.attrs?.lottieSpeed) || 1)}
        />
        <Sep />
        <ExportSelectionPopover nodeIds={[nodeId]} />
      </>
    );
  }

  let audioToolbarChrome: ReactNode = null;
  if (kind === 'audio') {
    audioToolbarChrome = (
      <AudioToolbarEditTools
        onQuickEdit={() => openImageToolPanel({ nodeId, kind: 'quickEdit' })}
        onTrim={() => {
          const host = getAudioHost(nodeId);
          const keepTime = Math.max(0, Number(host?.getMediaTime()) || 0);
          openAudioToolPanel({ nodeId, kind: 'trim', keepTime });
        }}
        onSpeed={() => openAudioToolPanel({ nodeId, kind: 'speed' })}
      />
    );
  }

  let shapeToolbarChrome: ReactNode = null;
  if (isShapeKind) {
    if (flipRotateOpen) {
      shapeToolbarChrome = flipRotateToolbar;
    } else {
      shapeToolbarChrome = (
        <>
          <ShapeSelectionToolbar
            nodeId={nodeId}
            node={node}
            box={box}
            valueBox={valueBox}
            document={document}
            hideExport
          />
          {elementLayerChrome}
          <Sep />
          <ExportSelectionPopover nodeIds={[nodeId]} />
        </>
      );
    }
  }

  let svgToolbarChrome: ReactNode = null;
  if (kind === 'svg') {
    if (flipRotateOpen) {
      svgToolbarChrome = flipRotateToolbar;
    } else {
      svgToolbarChrome = (
        <>
          {elementLayerChrome ? (
            <>
              {elementLayerChrome}
              <Sep />
            </>
          ) : null}
          <ExportSelectionPopover nodeIds={[nodeId]} />
        </>
      );
    }
  }

  let textToolbarChrome: ReactNode = null;
  if (kind === 'text' && style) {
    textToolbarChrome = (
            <>
              <ColorPanelPopover
                value={String(style.fill || '#333333')}
                opacity={style.fillOpacity ?? 100}
                showAlpha
                onChange={(hex) => patchTextStyle({ fill: hex })}
                onOpacityChange={(opacity) => patchTextStyle({ fillOpacity: opacity })}
                title={'文字颜色'}
                placement="bottom-start"
                className={btn}
              />
              <FontFamilyPicker
                key={fontCatalogEpoch}
                value={fontFamily}
                onChange={({ fontFamily: nextFamily, fontWeight }) => {
                  patchTextStyle({ fontFamily: nextFamily, fontWeight });
                  setFontCatalogTick((n) => n + 1);
                }}
              />
              {showWeightSelect ? (
                <ToolbarMenuSelect
                  value={weightSelectValue}
                  options={weightSelectOptions}
                  onChange={(v) => {
                    const parsed = parseWeightSelectValue(v);
                    patchTextStyle({ fontFamily: parsed.family, fontWeight: parsed.weight });
                  }}
                  displayLabel={weightDisplayLabel}
                  className="max-w-[6.5rem] shrink-0 justify-between"
                  popupClassName="max-w-[9rem]"
                />
              ) : null}
              <label className="inline-flex h-8 items-center gap-1 rounded-lg px-1.5 text-[12px] text-[var(--ink)]">
                <span className="text-[var(--muted)]">S</span>
                <input
                  type="text"
                  inputMode="numeric"
                  aria-label={t('editor.fontSize')}
                  className={cn(SEL_SIZE_INPUT, INPUT_NO_SPIN)}
                  defaultValue={fontSizePx}
                  key={`s-${nodeId}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => commitFontSize(e.target.value)}
                  onBlur={(e) => {
                    const next = normalizeTextFontSize(e.target.value, fontSizePx);
                    e.target.value = String(next);
                    commitFontSize(String(next));
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitFontSize((e.target as HTMLInputElement).value);
                      (e.target as HTMLInputElement).blur();
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      (e.target as HTMLInputElement).value = String(fontSizePx);
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                />
              </label>
              {showBoldToggle ? (
                <Tooltip tip={t('editor.imageToolbar.bold')} placement="top">
                  <button
                    type="button"
                    aria-label={t('editor.imageToolbar.bold')}
                    className={cn(SEL_ICON_BTN, isTextBold(style) && SEL_ICON_BTN_ACTIVE)}
                    aria-pressed={isTextBold(style)}
                    onClick={() => {
                      const next = toggleCatalogTextBold(fontFamily, style?.fontWeight);
                      patchTextStyle({
                        fontFamily: next.fontFamily,
                        fontWeight: next.fontWeight,
                      });
                    }}
                  >
                    <HiOutlineBold className="h-3.5 w-3.5" strokeWidth={2} />
                  </button>
                </Tooltip>
              ) : null}
              <Tooltip tip={t('editor.imageToolbar.italic')} placement="top">
                <button
                  type="button"
                  aria-label={t('editor.imageToolbar.italic')}
                  className={cn(SEL_ICON_BTN, isTextItalic(style) && SEL_ICON_BTN_ACTIVE)}
                  aria-pressed={isTextItalic(style)}
                  onClick={() =>
                    patchTextStyle({ fontStyle: isTextItalic(style) ? 'normal' : 'italic' })
                  }
                >
                  <HiOutlineItalic className="h-3.5 w-3.5" strokeWidth={2} />
                </button>
              </Tooltip>
              <div className="relative" data-text-toolbar-menu>
                <Tooltip tip={t('editor.imageToolbar.decoration')} placement="top">
                  <button
                    type="button"
                    aria-label={t('editor.imageToolbar.decoration')}
                    aria-expanded={decorationOpen}
                    className={cn(
                      SEL_ICON_BTN,
                      'gap-0.5 px-1',
                      (decorationOpen ||
                        isTextUnderline(style) ||
                        isTextOverline(style) ||
                        isTextStrike(style)) &&
                        SEL_ICON_BTN_ACTIVE
                    )}
                    onClick={() => {
                      setAlignOpen(false);
                      setDecorationOpen((v) => !v);
                    }}
                  >
                    <DecorationsTriggerIcon
                      underline={isTextUnderline(style)}
                      overline={isTextOverline(style)}
                      strike={isTextStrike(style)}
                    />
                    <HiOutlineChevronDown className="h-3 w-3 text-current" />
                  </button>
                </Tooltip>
                {decorationOpen ? (
                  <DropdownPanel className="absolute left-0 top-[calc(100%+6px)] z-40 min-w-max">
                    <TextDecorationMenuItems
                      style={style!}
                      t={t}
                      onToggle={(token) =>
                        patchTextStyle({
                          textDecoration: toggleTextDecoration(style!.textDecoration, token),
                        })
                      }
                    />
                  </DropdownPanel>
                ) : null}
              </div>
              <div className="relative" data-text-toolbar-menu>
                <Tooltip tip={t('editor.imageToolbar.align')} placement="top">
                  <button
                    type="button"
                    aria-label={t('editor.imageToolbar.align')}
                    aria-expanded={alignOpen}
                    className={cn(SEL_ICON_BTN, 'gap-0.5 px-1', alignOpen && SEL_ICON_BTN_ACTIVE)}
                    onClick={() => {
                      setDecorationOpen(false);
                      setAlignOpen((v) => !v);
                    }}
                  >
                    <AlignIcon align={textAlign} />
                    <HiOutlineChevronDown className="h-3 w-3 text-current" />
                  </button>
                </Tooltip>
                {alignOpen ? (
                  <DropdownPanel className="absolute left-0 top-[calc(100%+6px)] z-40 min-w-max">
                    <TextAlignMenuItems
                      textAlign={textAlign}
                      t={t}
                      onPick={(value) => {
                        patchTextStyle({ textAlign: value });
                        setAlignOpen(false);
                      }}
                    />
                  </DropdownPanel>
                ) : null}
              </div>
              <Tooltip tip={t('editor.openTextEditor')} placement="top">
                <button
                  type="button"
                  aria-label={t('editor.openTextEditor')}
                  className={SEL_ICON_BTN}
                  onClick={() => setMdOpen(true)}
                >
                  <HiOutlineCodeBracket className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
              {isTextBoxMode ? (
                <>
                  <label className="inline-flex h-8 items-center gap-1 rounded-lg px-1.5 text-[12px] text-[var(--ink)]">
                    <span className="text-[var(--muted)]">W</span>
                    <input
                      className={cn(SEL_SIZE_INPUT, INPUT_NO_SPIN)}
                      defaultValue={Math.round(Number(node?.width) || 0)}
                      key={`tw-${nodeId}-${Math.round(Number(node?.width) || 0)}`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onBlur={(e) => commitTextBoxSize('w', e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          commitTextBoxSize('w', (e.target as HTMLInputElement).value);
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                    />
                  </label>
                  <label className="inline-flex h-8 items-center gap-1 rounded-lg px-1.5 text-[12px] text-[var(--ink)]">
                    <span className="text-[var(--muted)]">H</span>
                    <input
                      className={cn(SEL_SIZE_INPUT, INPUT_NO_SPIN)}
                      defaultValue={Math.round(Number(node?.height) || 0)}
                      key={`th-${nodeId}-${Math.round(Number(node?.height) || 0)}`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onBlur={(e) => commitTextBoxSize('h', e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          commitTextBoxSize('h', (e.target as HTMLInputElement).value);
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                    />
                  </label>
                </>
              ) : null}
              {elementLayerChrome}
              <Sep />
              <ExportSelectionPopover nodeIds={[nodeId]} />
            </>
    );
  }

  return (
    <>
      <SelectionToolbarShell
        box={box}
        angle={placementAngle}
        edgePadScene={edgePadScene}
        hasTitleLabel={hasTitleLabel}
        bare={kind === 'image' && isIconImageNode(node)}
      >
          {/* Order: Style/Edit — Geometry — Opacity — More — Actions */}
          {textToolbarChrome}
          {imageToolbarChrome}
          {videoToolbarChrome}
          {lottieToolbarChrome}
          {audioToolbarChrome}
          {shapeToolbarChrome}
          {svgToolbarChrome}
      </SelectionToolbarShell>

      {kind === 'text' ? (
        <TextEditDialog
          open={mdOpen}
          initialMarkdown={parseNodeMarkdown(node.attrs || {})}
          onClose={() => setMdOpen(false)}
          onSave={(md) => {
            const textStyle = parseNodeTextStyle(node.attrs || {});
            const attrs = buildMarkdownTextAttrs(md, textStyle);
            const plain = markdownToPlain(md);
            const measured = measurePlainTextSize(plain || ' ', textStyle);
            patchDocumentNode({
                nodeId,
                patch: {
                  attrs,
                  width: Math.max(measured.width, 8),
                  height: Math.max(
                    measured.height,
                    Math.ceil((textStyle.fontSize || 16) * (textStyle.lineHeight || 1.4))
                  ),
                },
              });
          }}
        />
      ) : null}
    </>
  );
}

export default memo(SelectionContextToolbar);
