import { useEffect, useLayoutEffect, useRef, useState, memo } from 'react';
import {
  RcbOverlayPortal,
  useRcbCamera,
  rcbSceneToScreen,
} from '@/components/rcb';
import { toFabricFontFamily } from '@/components/rcb/scene/document/sceneText';
import {
  buildMarkdownTextAttrs,
  DEFAULT_TEXT_STYLE,
  measurePlainTextSize,
  measureWrappedTextSize,
  parseNodeMarkdown,
  parseNodeTextStyle,
  resolveTextBoxWidth,
  textVerticalOriginY,
  wrapPlainTextLines,
  measureTextEmBoxHeight,
} from '@/components/rcb/scene/document/sceneText';
import { nodeLeftTop } from '@/components/rcb/scene/layout/nodeLayout';
import { TEXT_SELECTION_PAD } from '@/components/rcb/scene/document/sceneEffects';
import type { SceneDocument } from '@/components/rcb/sceneNode';

type Props = {
  document: SceneDocument;
  nodeId: string;
  onCommit: (next: {
    attrs: Record<string, unknown>;
    width: number;
    height: number;
    /** Scene-space left when L-edge drag moved the box. */
    left?: number;
  }) => void;
  /** Live wrap-width while editing (L/R handles) — keeps node box in sync. */
  onLiveSize?: (next: {
    width: number;
    height: number;
    left?: number;
    autoSize?: boolean;
  }) => void;
  /** Empty cancel / Escape — caller may delete the node. */
  onCancel: () => void;
};

const BORDER_PX = 1.5;
const HANDLE_VIS = 8;
const HANDLE_HIT = 16;

/**
 * Inline text caret editor (screen-space).
 * Control box matches selection chrome (TEXT_SELECTION_PAD — flush with glyphs).
 */
function TextInlineEditor({
  document,
  nodeId,
  onCommit,
  onLiveSize,
  onCancel,
}: Props) {
  const camera = useRcbCamera();
  const node = document?.deltaSetLike?.[nodeId];
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const style = parseNodeTextStyle(node?.attrs || {});
  const initial = parseNodeMarkdown(node?.attrs || {}) || '';
  const [value, setValue] = useState(initial);
  const autoSize0 = String(node?.attrs?.autoSize ?? 'true') !== 'false';
  const [autoSize, setAutoSize] = useState(autoSize0);
  const committedRef = useRef(false);
  /** Ignore outside pointerdown / blur races from the opening click & store remount. */
  const openedAtRef = useRef(
    typeof performance !== 'undefined' ? performance.now() : Date.now()
  );
  const valueRef = useRef(value);
  valueRef.current = value;
  const styleRef = useRef(style);
  styleRef.current = style;
  const autoSizeRef = useRef(autoSize);
  autoSizeRef.current = autoSize;
  const boxWidthRef = useRef(resolveTextBoxWidth(node?.width, true, style.fontSize));
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const onLiveSizeRef = useRef(onLiveSize);
  onLiveSizeRef.current = onLiveSize;
  const dragRef = useRef<{
    side: 'e' | 'w';
    startX: number;
    width0: number;
    left0: number;
  } | null>(null);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [dragLeft, setDragLeft] = useState<number | null>(null);
  const [isEdgeDragging, setIsEdgeDragging] = useState(false);
  const dragLeftRef = useRef<number | null>(null);

  const { left: nodeLeft, top: nodeTop } = node
    ? nodeLeftTop(document, node)
    : { left: 0, top: 0 };
  const left = dragLeft ?? nodeLeft;
  const top = nodeTop;
  const fontSize = style.fontSize || DEFAULT_TEXT_STYLE.fontSize;
  const lineH = Math.max(0.8, Number(style.lineHeight) || 1.4);
  const z = Math.max(0.05, camera.zoom || 1);
  const hasContent = Boolean(value.trim());
  const nodeW = Math.max(1, Number(node?.width) || 0);
  const nodeH = Math.max(1, Number(node?.height) || 0);

  // Keep the same scene box as selection chrome. Only grow when content needs it
  // (or when L/R drag sets a wrap width) — never remasure with extra pad that jumps sides.
  const widthWorld =
    dragWidth ??
    (autoSize
      ? hasContent
        ? Math.max(nodeW, Math.ceil(measurePlainTextSize(value, style).width))
        : Math.max(2, nodeW)
      : resolveTextBoxWidth(node?.width, true, fontSize));
  boxWidthRef.current = widthWorld;

  const contentBox = autoSize
    ? hasContent
      ? measurePlainTextSize(value, style)
      :       // Caret line — same hug as measurePlainTextSize (line box, not bare 1em).
        { width: widthWorld, height: Math.ceil(fontSize * lineH) }
    : measureWrappedTextSize(
        value || 'M',
        style,
        Math.max(Math.ceil(fontSize), widthWorld)
      );

  // Prefer content height (tight, even top/bottom). Keep authored nodeH so
  // textVerticalOriginY matches idle ink (taller boxes stay centered).
  const heightWorld = Math.max(
    Math.ceil(fontSize),
    Math.ceil(contentBox.height),
    nodeH
  );
  // Same pad as selection chrome (flush with glyphs).
  const pad = TEXT_SELECTION_PAD;
  const chromeLeft = left - pad;
  const chromeTop = top - pad;
  const chromeW = widthWorld + pad * 2;
  const chromeH = heightWorld + pad * 2;
  const stage = rcbSceneToScreen(camera, chromeLeft, chromeTop);

  const finish = (nextValue: string) => {
    if (committedRef.current) return;
    committedRef.current = true;
    const trimmed = nextValue.replace(/\s+$/g, '');
    if (!trimmed.length) {
      onCancelRef.current();
      return;
    }
    const s = styleRef.current;
    const boxW = Math.max(Math.ceil(s.fontSize || 14), boxWidthRef.current);
    const measured = autoSizeRef.current
      ? measurePlainTextSize(trimmed, s)
      : measureWrappedTextSize(trimmed, s, boxW);
    const attrs = buildMarkdownTextAttrs(trimmed, s) as Record<string, unknown>;
    attrs.autoSize = autoSizeRef.current ? 'true' : 'false';
    const width = autoSizeRef.current ? measured.width : boxW;
    const height = measured.height;
    onCommitRef.current({
      attrs,
      width,
      height,
      left: dragLeftRef.current ?? undefined,
    });
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  const focusCaret = () => {
    const el = textareaRef.current;
    if (!el || committedRef.current) return;
    el.focus({ preventScroll: true });
    const len = el.value.length;
    try {
      el.setSelectionRange(len, len);
    } catch {
      /* ignore */
    }
  };

  useLayoutEffect(() => {
    openedAtRef.current =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    committedRef.current = false;
    focusCaret();
    // Document remount / dock focus can steal caret on the same tick as place.
    const t0 = window.setTimeout(focusCaret, 0);
    const t1 = window.setTimeout(focusCaret, 50);
    return () => {
      window.clearTimeout(t0);
      window.clearTimeout(t1);
    };
  }, [nodeId]);

  // Entering edit: grow the node box to content if needed. Do not shrink height —
  // idle ink vertically centers in a taller box; shrinking would jump the glyphs.
  useLayoutEffect(() => {
    if (!node || node.key !== 'text') return;
    const s = styleRef.current;
    const plain = valueRef.current;
    const has = Boolean(plain.trim());
    const fixedW = resolveTextBoxWidth(node.width, has, s.fontSize);
    const box = autoSizeRef.current
      ? measurePlainTextSize(has ? plain : 'M', s)
      : measureWrappedTextSize(plain || 'M', s, fixedW);
    let nextW: number;
    if (!autoSizeRef.current) {
      nextW = Math.round(fixedW);
    } else if (has) {
      nextW = Math.max(Math.round(Number(node.width) || 0), Math.round(box.width));
    } else {
      nextW = Math.max(1, Math.round(Number(node.width) || Math.ceil((s.fontSize || 14) * 0.15)));
    }
    const nextH = Math.max(
      Math.ceil(s.fontSize || 14),
      Math.round(box.height),
      Math.round(Number(node.height) || 0)
    );
    const curW = Math.round(Number(node.width) || 0);
    const curH = Math.round(Number(node.height) || 0);
    if (nextW !== curW || nextH !== curH) {
      onLiveSizeRef.current?.({ width: nextW, height: nextH });
    }
    // Only once when opening this node for edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        committedRef.current = true;
        onCancelRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const OPEN_GRACE_MS = 320;
    const onPointerDownCapture = (e: PointerEvent) => {
      if (committedRef.current) return;
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (now - openedAtRef.current < OPEN_GRACE_MS) return;
      const t = e.target as Element | null;
      if (t?.closest?.('[data-text-inline-editor]')) return;
      finishRef.current(valueRef.current);
    };
    window.addEventListener('pointerdown', onPointerDownCapture, true);
    return () => window.removeEventListener('pointerdown', onPointerDownCapture, true);
  }, []);

  useEffect(() => {
    if (!isEdgeDragging) return undefined;
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = (e.clientX - d.startX) / z;
      let nextW = d.width0;
      let nextL = d.left0;
      if (d.side === 'e') {
        nextW = Math.max(fontSize, d.width0 + dx);
      } else {
        nextW = Math.max(fontSize, d.width0 - dx);
        nextL = d.left0 + (d.width0 - nextW);
      }
      setDragWidth(nextW);
      setDragLeft(nextL);
      dragLeftRef.current = nextL;
      boxWidthRef.current = nextW;
    };
    const onUp = () => {
      const w = boxWidthRef.current;
      const h = Math.max(
        1,
        Math.round(measureWrappedTextSize(valueRef.current || 'M', styleRef.current, w).height)
      );
      const nextL = dragLeftRef.current;
      setAutoSize(false);
      autoSizeRef.current = false;
      onLiveSizeRef.current?.({
        width: Math.round(w),
        height: h,
        left: nextL ?? undefined,
        autoSize: false,
      });
      dragRef.current = null;
      setIsEdgeDragging(false);
      setDragWidth(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [isEdgeDragging, z, fontSize]);

  if (!node || node.key !== 'text') return null;

  const fontFamily = toFabricFontFamily(style.fontFamily);
  const screenW = Math.max(8, chromeW * z);
  const screenH = Math.max(fontSize * z, chromeH * z);
  const contentScreenW = Math.max(8, widthWorld * z);
  const contentScreenH = Math.max(fontSize * z, heightWorld * z);
  const padScreen = pad * z;
  const trackLeft = padScreen;
  const trackTop = padScreen;
  const trackW = Math.max(8, contentScreenW);
  const trackH = Math.max(fontSize * z, contentScreenH);
  // Match idle WebGL/Canvas textVerticalOriginY so glyphs do not jump on edit open.
  const editLines = wrapPlainTextLines(value || ' ', style, Math.max(1, widthWorld));
  const originYWorld = textVerticalOriginY(
    heightWorld,
    fontSize,
    lineH,
    Math.max(1, editLines.length),
    measureTextEmBoxHeight(style, (value || '永').slice(0, 1) || '永')
  );
  const padTopScreen = originYWorld * z;

  const startEdgeDrag = (side: 'e' | 'w') => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Switch to wrap mode immediately so L/R resize reflows live (not only on pointerup).
    setAutoSize(false);
    autoSizeRef.current = false;
    dragRef.current = {
      side,
      startX: e.clientX,
      width0: widthWorld,
      left0: left,
    };
    setDragWidth(widthWorld);
    setDragLeft(left);
    dragLeftRef.current = left;
    setIsEdgeDragging(true);
  };

  return (
    <RcbOverlayPortal>
      <div
        data-text-inline-editor
        className="pointer-events-auto absolute z-[40]"
        style={{ left: stage.x, top: stage.y, width: screenW, height: screenH }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* selection outline while editing */}
        <div
          className="pointer-events-none absolute inset-0 border-[#3388ff]"
          style={{
            borderWidth: BORDER_PX,
            borderStyle: 'solid',
            boxShadow: `0 0 0 ${BORDER_PX}px rgba(255,255,255,0.9)`,
          }}
        />
        {/* L/R wrap handles */}
        {(['w', 'e'] as const).map((side) => (
              <div
                key={side}
                role="button"
                aria-label={side === 'e' ? 'resize-e' : 'resize-w'}
                className="pointer-events-auto absolute z-[2]"
                style={{
                  left: side === 'w' ? -HANDLE_HIT / 2 : screenW - HANDLE_HIT / 2,
                  top: screenH / 2 - HANDLE_HIT / 2,
                  width: HANDLE_HIT,
                  height: HANDLE_HIT,
                  cursor: 'ew-resize',
                }}
                onPointerDown={startEdgeDrag(side)}
              >
                <span
                  className="pointer-events-none absolute bg-white"
                  style={{
                    left: (HANDLE_HIT - HANDLE_VIS) / 2,
                    top: (HANDLE_HIT - HANDLE_VIS) / 2,
                    width: HANDLE_VIS,
                    height: HANDLE_VIS,
                    border: `${BORDER_PX}px solid #3388ff`,
                    boxSizing: 'border-box',
                  }}
                />
              </div>
            ))}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={(e) => {
            const next = e.relatedTarget as Node | null;
            if (next && e.currentTarget.closest('[data-text-inline-editor]')?.contains(next)) {
              return;
            }
            // Defer: place/open remounts often blur then re-focus in the same frame.
            window.requestAnimationFrame(() => {
              if (committedRef.current) return;
              const active = window.document.activeElement;
              if (active === textareaRef.current) return;
              if (
                active &&
                textareaRef.current
                  ?.closest('[data-text-inline-editor]')
                  ?.contains(active)
              ) {
                return;
              }
              const now =
                typeof performance !== 'undefined' ? performance.now() : Date.now();
              if (now - openedAtRef.current < 320) {
                focusCaret();
                return;
              }
              finishRef.current(valueRef.current);
            });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              finish(value);
            }
            e.stopPropagation();
          }}
          spellCheck={false}
          className="absolute z-[1] resize-none overflow-hidden border-0 bg-transparent p-0 shadow-none outline-none ring-0"
          style={{
            left: trackLeft,
            top: trackTop,
            width: trackW,
            height: trackH,
            // Top pad matches idle textVerticalOriginY (centered stack).
            paddingTop: padTopScreen || 0,
            paddingLeft: 0,
            paddingRight: 0,
            paddingBottom: 0,
            fontSize: fontSize * z,
            // Unitless line-height matches SVG.js `leading` (fontSize × lineH).
            lineHeight: lineH,
            fontFamily: `"${fontFamily}", sans-serif`,
            fontWeight: style.fontWeight as any,
            fontStyle: style.fontStyle as any,
            textDecoration: style.textDecoration || 'none',
            color: style.fill || '#333333',
            caretColor: '#111111',
            textAlign: (style.textAlign as CanvasTextAlign) || 'left',
            letterSpacing: style.letterSpacing ? `${style.letterSpacing * z}px` : undefined,
            margin: 0,
            // autoSize: no soft wrap (hard `\n` only). Fixed width: wrap like SVG.
            whiteSpace: autoSize ? 'pre' : 'pre-wrap',
            overflowWrap: autoSize ? 'normal' : 'break-word',
            wordBreak: autoSize ? 'normal' : 'break-word',
            boxSizing: 'border-box',
            display: 'block',
          }}
        />
      </div>
    </RcbOverlayPortal>
  );
}

export default memo(TextInlineEditor);
