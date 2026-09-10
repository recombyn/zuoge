import { nanoid } from 'nanoid';
import { buildMarkdownTextAttrs, measurePlainTextSize, type TextStyle } from './sceneText';
import {
  clampShapeSides,
  DEFAULT_SHAPE_SIDES,
  DEFAULT_STAR_INNER_RATIO,
  STROKE_GEOMETRY_HEIGHT,
} from './sceneShapes';
import type { CreatedSceneNode } from '@/components/rcb/sceneNode';

/** Pure node constructors + media measure helpers (no document writes). */

export function createTextNode({
  x = 40,
  y = 40,
  text = '',
  width,
  height,
  autoSize = true,
  fontSize,
  fontFamily,
}: {
  x?: number;
  y?: number;
  text?: string;
  width?: number;
  height?: number;
  /** true = hug content; false = fixed wrap width from L/R resize or drag-create. */
  autoSize?: boolean;
  /** Scene-px font size (T-tool passes zoom-fitted size so high zoom is not huge). */
  fontSize?: number;
  fontFamily?: string;
} = {}): CreatedSceneNode {
  const id = nanoid(10);
  const content = String(text ?? '');
  const style: Partial<TextStyle> = {};
  if (fontSize != null && Number.isFinite(fontSize) && fontSize > 0) {
    style.fontSize = Math.max(1, Number(fontSize));
  }
  if (fontFamily) style.fontFamily = String(fontFamily);
  const measured = measurePlainTextSize(content || 'M', style);
  // Empty autoSize = caret only (tiny width). Fixed-width keeps the dragged box.
  const w = width ?? (content ? measured.width : autoSize ? 2 : 160);
  const h = height ?? measured.height;
  const attrs: Record<string, unknown> = {
    ...buildMarkdownTextAttrs(content, style),
    autoSize: autoSize ? 'true' : 'false',
  };
  return {
    id,
    node: {
      id,
      key: 'text',
      x,
      y,
      z: 0,
      width: w,
      height: h,
      attrs,
      children: [],
    },
  };
}

/** shapeType: rect | line | arrow | circle | triangle | star | polygon | path | pen | pencil */
export function createShapeNode({
  x = 40,
  y = 40,
  width = 120,
  height = 120,
  shapeType = 'rect',
  fill = '#FFFFFF',
  stroke = '#333333',
  path = '',
  closed = false,
  borderWidth,
  angle = 0,
  brushStyle,
  pressureEnabled,
  pathPressure,
  sides,
  opacity = 1,
}: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  shapeType?: string;
  fill?: string;
  stroke?: string;
  path?: string;
  closed?: boolean;
  borderWidth?: number;
  angle?: number;
  /** Pencil brushStyle (vector-ink / vector-even / …). */
  brushStyle?: string;
  /** When false, ignore pathPressure for width modulation. */
  pressureEnabled?: boolean;
  /** Comma-separated 0–1 pressures aligned with path points (pencil). */
  pathPressure?: string;
  /** Polygon side count / star point count (default 5). */
  sides?: number;
  /** 0–1 node opacity (brush-time opacity for pencil). */
  opacity?: number;
} = {}): CreatedSceneNode {
  const op = Math.min(1, Math.max(0, Number(opacity)));
  const opacityVal = Number.isFinite(op) ? op : 1;
  const id = nanoid(10);
  const strokeW =
    borderWidth ??
    (shapeType === 'pen' || shapeType === 'pencil' || shapeType === 'line' || shapeType === 'arrow' ? 2 : 1);
  // Stroke panel default — center on the path (inside/outside are explicit user picks).
  const strokeAlignDefault = 'center';
  // Quantize to 0.5px so odd center strokes can sit outer edges on integer grid
  // (geom = visual ± sw/2). Full integers when sw is even / inside.
  // Pencil/pen keep exact placement: path points are relative to the padded origin;
  // half-pixel snapping the node would shift freehand ink off the stored centerline.
  const rawX = Number(x) || 0;
  const rawY = Number(y) || 0;
  // Keep true size — do not floor to 1wu (high zoom draws sub-1 shapes).
  const nW = Number(width);
  const nH = Number(height);
  const rawW = Number.isFinite(nW) && nW > 0 ? nW : 1;
  const rawH = Number.isFinite(nH) && nH > 0 ? nH : 1;
  const keepExactOrigin = shapeType === 'pencil' || shapeType === 'pen';
  const ix = keepExactOrigin ? rawX : Math.round(rawX * 2) / 2;
  const iy = keepExactOrigin ? rawY : Math.round(rawY * 2) / 2;
  const snappedW = keepExactOrigin ? rawW : Math.round(rawW * 2) / 2;
  const snappedH = keepExactOrigin ? rawH : Math.round(rawH * 2) / 2;
  const iw = snappedW > 0 ? snappedW : rawW;
  const ih = snappedH > 0 ? snappedH : rawH;
  if (shapeType === 'line' || shapeType === 'arrow') {
    return {
      id,
      node: {
        id,
        key: 'shape',
        x: ix,
        y: iy,
        z: 0,
        width: iw > 0 ? iw : rawW,
        // Open strokes are length + angle; visual thickness belongs to border-width.
        height: STROKE_GEOMETRY_HEIGHT,
        attrs: {
          shapeType,
          'border-color': stroke,
          'border-width': strokeW,
          strokeAlign: strokeAlignDefault,
          'stroke-enabled': 'true',
          'stroke-visible': 'true',
          // Must live on this early-return path — the general branch never runs
          // for line/arrow (panel showed Butt while paint stayed Round).
          strokeLinecap: 'butt',
          strokeLinejoin: 'miter',
          'fill-color': 'transparent',
          'fill-enabled': 'false',
          opacity: opacityVal,
          angle: Number(angle) || 0,
        },
        children: [],
      },
    };
  }

  return {
    id,
    node: {
      id,
      key: 'shape',
      x: ix,
      y: iy,
      z: 0,
      width: iw,
      height: ih,
      attrs: {
        shapeType,
        'fill-color': fill,
        'fill-type': 'solid',
        'border-color': stroke,
        'border-width': strokeW,
        strokeAlign: strokeAlignDefault,
        'stroke-enabled': 'true',
        'stroke-visible': 'true',
        'fill-enabled':
          shapeType === 'pencil'
            ? 'false'
            : shapeType === 'pen'
              ? closed && fill !== 'transparent' && fill !== 'none'
                ? 'true'
                : 'false'
              : fill === 'transparent'
                ? 'false'
                : 'true',
        'fill-visible':
          shapeType === 'pencil'
            ? 'false'
            : shapeType === 'pen'
              ? closed && fill !== 'transparent' && fill !== 'none'
                ? 'true'
                : 'false'
              : fill === 'transparent'
                ? 'false'
                : 'true',
        L: 'true',
        R: 'true',
        T: 'true',
        B: 'true',
        opacity: opacityVal,
        angle: Number(angle) || 0,
        radiusTL: 0,
        radiusTR: 0,
        radiusBR: 0,
        radiusBL: 0,
        radiusLinked: 'true',
        ...(shapeType === 'polygon' || shapeType === 'star'
          ? { sides: clampShapeSides(sides, DEFAULT_SHAPE_SIDES) }
          : {}),
        ...(shapeType === 'star' ? { starInnerRatio: DEFAULT_STAR_INNER_RATIO } : {}),
        ...(path ? { path } : {}),
        // Persist open/closed so stroke panel can show linecap for open pens.
        ...((shapeType === 'pen' || shapeType === 'path' || path) && {
          closed: closed ? 'true' : 'false',
        }),
        // Pen / line / arrow → butt+miter (stroke panel default). Pencil stays round.
        ...(shapeType === 'pencil' && {
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        ...((shapeType === 'pen' || shapeType === 'line' || shapeType === 'arrow') && {
          strokeLinecap: 'butt',
          strokeLinejoin: 'miter',
        }),
        ...(brushStyle ? { brushStyle } : {}),
        ...(shapeType === 'pencil' && pressureEnabled != null
          ? { pressureEnabled: pressureEnabled ? true : false }
          : {}),
        ...(shapeType === 'pencil' && pathPressure ? { pathPressure } : {}),
      },
      children: [],
    },
  };
}

/** Read natural pixel size of an image src (data URL / http). */
export function measureImageNaturalSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    if (!src) {
      reject(new Error('empty image src'));
      return;
    }
    const img = new Image();
    img.onload = () => {
      resolve({
        width: Math.max(1, img.naturalWidth || img.width || 1),
        height: Math.max(1, img.naturalHeight || img.height || 1),
      });
    };
    img.onerror = () => reject(new Error('image load failed'));
    img.src = src;
  });
}

/** Read video metadata (size + duration) from a blob/object/http URL. */
export function measureVideoNaturalSize(
  src: string
): Promise<{ width: number; height: number; duration: number }> {
  return new Promise((resolve, reject) => {
    if (!src) {
      reject(new Error('empty video src'));
      return;
    }
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    let settled = false;
    const cleanup = () => {
      video.removeAttribute('src');
      video.load();
    };
    const finish = (width: number, height: number, duration: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ width, height, duration });
    };
    video.onloadedmetadata = () => {
      const width = Math.max(1, video.videoWidth || 1);
      const height = Math.max(1, video.videoHeight || 1);
      const raw = Number(video.duration);
      if (Number.isFinite(raw) && raw > 0 && raw < 60 * 60 * 12) {
        finish(width, height, raw);
        return;
      }
      // Fragmented MP4s often report Infinity — seek-clamp once at upload so we can store it.
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        window.clearTimeout(timer);
        const probed = Number(video.currentTime);
        const duration =
          Number.isFinite(probed) && probed > 0 && probed < 60 * 60 * 12 ? probed : 0;
        try {
          video.currentTime = 0;
        } catch {
          /* ignore */
        }
        finish(width, height, duration);
      };
      const timer = window.setTimeout(() => {
        video.removeEventListener('seeked', onSeeked);
        const probed = Number(video.currentTime);
        const duration =
          Number.isFinite(probed) && probed > 0 && probed < 60 * 60 * 12 ? probed : 0;
        try {
          video.currentTime = 0;
        } catch {
          /* ignore */
        }
        finish(width, height, duration);
      }, 900);
      video.addEventListener('seeked', onSeeked);
      try {
        video.currentTime = 1e10;
      } catch {
        window.clearTimeout(timer);
        video.removeEventListener('seeked', onSeeked);
        finish(width, height, 0);
      }
    };
    video.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('video load failed'));
    };
    video.src = src;
  });
}

/** Capture a poster frame (JPEG blob URL) from a video src. Caller should revoke when done. */
export function captureVideoPosterFrame(
  src: string,
  atSeconds = 0.1
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!src) {
      reject(new Error('empty video src'));
      return;
    }
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    // data/blob are same-origin; forcing anonymous breaks some blob captures.
    if (!src.startsWith('blob:') && !src.startsWith('data:')) {
      video.crossOrigin = 'anonymous';
    }
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('video poster capture failed'));
    };
    const succeed = (url: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(url);
    };
    const timer = window.setTimeout(fail, 8000);
    const cleanup = () => {
      window.clearTimeout(timer);
      video.onerror = null;
      video.onloadeddata = null;
      video.onseeked = null;
      try {
        video.removeAttribute('src');
        video.load();
      } catch {
        /* ignore */
      }
    };
    const draw = () => {
      try {
        const w = Math.max(1, video.videoWidth || 1);
        const h = Math.max(1, video.videoHeight || 1);
        if (w <= 1 || h <= 1) {
          fail();
          return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          fail();
          return;
        }
        ctx.drawImage(video, 0, 0, w, h);
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              fail();
              return;
            }
            succeed(URL.createObjectURL(blob));
          },
          'image/jpeg',
          0.85
        );
      } catch {
        fail();
      }
    };
    video.onerror = fail;
    video.onloadeddata = () => {
      try {
        const seekTo = Math.min(
          Math.max(0, atSeconds),
          Math.max(0, (video.duration || 1) - 0.05)
        );
        if (seekTo <= 0.01 || Math.abs((Number(video.currentTime) || 0) - seekTo) <= 0.04) {
          draw();
          return;
        }
        const seekTimer = window.setTimeout(draw, 700);
        video.onseeked = () => {
          window.clearTimeout(seekTimer);
          draw();
        };
        video.currentTime = seekTo;
      } catch {
        fail();
      }
    };
    video.src = src;
  });
}

/** Shared prep for canvas video place (tool strip / paste): preview, poster, size, label. */
export async function prepareVideoUploadPreview(file: File): Promise<{
  preview: string;
  poster: string;
  width: number;
  height: number;
  duration: number;
  name: string;
}> {
  const { createFilePreviewUrl } = await import('@/utils/uploadImage');
  const preview = createFilePreviewUrl(file);
  const natural = await measureVideoNaturalSize(preview);
  let poster = '';
  try {
    poster = await captureVideoPosterFrame(preview);
  } catch {
    /* optional */
  }
  return {
    preview,
    poster,
    width: natural.width,
    height: natural.height,
    duration: natural.duration,
    name: file.name?.replace(/\.[^.]+$/, '') || 'Video',
  };
}

/** Fit natural size into a max box while keeping aspect ratio. */
export function fitImageSize(
  naturalWidth: number,
  naturalHeight: number,
  maxSide = 280
): { width: number; height: number } {
  const nw = Math.max(1, naturalWidth);
  const nh = Math.max(1, naturalHeight);
  const scale = Math.min(maxSide / nw, maxSide / nh, 1);
  return {
    width: Math.max(1, Math.round(nw * scale)),
    height: Math.max(1, Math.round(nh * scale)),
  };
}

export function createImageNode({
  x = 40,
  y = 40,
  width = 200,
  height = 200,
  src = '',
  name = 'Image',
  /** Catalog SVG icons — selection shows annotate tools, not photo AI tools. */
  assetKind,
}: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  src?: string;
  name?: string;
  assetKind?: 'icon' | 'image';
} = {}): CreatedSceneNode {
  const id = nanoid(10);
  const kind = assetKind || 'image';
  return {
    id,
    node: {
      id,
      key: 'image',
      x,
      y,
      z: 0,
      width,
      height,
      attrs: {
        src,
        name: name || (kind === 'icon' ? 'Icon' : 'Image'),
        assetKind: kind,
        mode: 'FIT',
        /** Default on — drag-resize keeps width:height (Shift temporarily unlocks). */
        lockAspect: 'true',
        radiusTL: 0,
        radiusTR: 0,
        radiusBR: 0,
        radiusBL: 0,
        radiusLinked: 'true',
      } as Record<string, unknown>,
      children: [],
    },
  };
}

/** Canvas image-generator plate (empty image + generator overlay until promote). */
export function createImageGeneratorNode({
  x = 40,
  y = 40,
  width = 360,
  height = 360,
  name = 'Image Generator',
}: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  name?: string;
} = {}): CreatedSceneNode {
  const id = nanoid(10);
  // Integer quantize — empty gen uses inset border so path === outer ink on the grid.
  // (Half-pixel was only needed for center strokes.)
  const iw = Math.max(1, Math.round(Number(width) || 360));
  const ih = Math.max(1, Math.round(Number(height) || 360));
  const ix = Math.round(Number(x) || 0);
  const iy = Math.round(Number(y) || 0);
  return {
    id,
    node: {
      id,
      key: 'image',
      x: ix,
      y: iy,
      z: 0,
      width: iw,
      height: ih,
      attrs: {
        src: '',
        name: name || 'Image Generator',
        assetKind: 'image',
        imageGenerator: true,
        // Durable gen settings — survive overlay remount / deselect.
        imageGenAspect: '1:1',
        imageGenResolution: '2K',
        imageGenCount: 1,
        mode: 'FIT',
        radiusTL: 0,
        radiusTR: 0,
        radiusBR: 0,
        radiusBL: 0,
        radiusLinked: 'true',
      } as Record<string, unknown>,
      children: [],
    },
  };
}

/** Parse durable multi-gen stack URLs from image node attrs. */
export function createVideoGeneratorNode({
  x = 40,
  y = 40,
  width = 640,
  height = 360,
  name = 'Video Generator',
}: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  name?: string;
} = {}): CreatedSceneNode {
  const id = nanoid(10);
  // Integer quantize — inset border means path === outer ink on the grid.
  const iw = Math.max(1, Math.round(Number(width) || 640));
  const ih = Math.max(1, Math.round(Number(height) || 360));
  const ix = Math.round(Number(x) || 0);
  const iy = Math.round(Number(y) || 0);
  return {
    id,
    node: {
      id,
      key: 'video',
      x: ix,
      y: iy,
      z: 0,
      width: iw,
      height: ih,
      attrs: {
        src: '',
        poster: '',
        name: name || 'Video Generator',
        assetKind: 'video',
        videoGenerator: true,
        videoGenAspect: '16:9',
        videoGenResolution: '720p',
        videoGenDuration: 5,
        mode: 'FIT',
        lockAspect: 'true',
        radiusTL: 0,
        radiusTR: 0,
        radiusBR: 0,
        radiusBL: 0,
        radiusLinked: 'true',
      } as Record<string, unknown>,
      children: [],
    },
  };
}

export function createVideoNode({
  x = 40,
  y = 40,
  width = 640,
  height = 360,
  src = '',
  poster = '',
  name = 'Video',
  duration,
}: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  src?: string;
  poster?: string;
  name?: string;
  /** Media length in seconds — set at upload so players need not seek-probe. */
  duration?: number;
} = {}): CreatedSceneNode {
  const id = nanoid(10);
  const d = Number(duration);
  // Integer quantize only — do NOT floor to 80×60. High-zoom viewport place
  // yields small scene sizes; independent floors destroy the natural aspect
  // and stretch the video (object-fit: fill / preserveAspectRatio none).
  const iw = Math.max(1, Math.round(Number(width) || 640));
  const ih = Math.max(1, Math.round(Number(height) || 360));
  const ix = Math.round(Number(x) || 0);
  const iy = Math.round(Number(y) || 0);
  return {
    id,
    node: {
      id,
      key: 'video',
      x: ix,
      y: iy,
      z: 0,
      width: iw,
      height: ih,
      attrs: {
        src,
        poster: poster || '',
        name: name || 'Video',
        assetKind: 'video',
        mode: 'FIT',
        lockAspect: 'true',
        ...(Number.isFinite(d) && d > 0 ? { duration: d } : {}),
        radiusTL: 0,
        radiusTR: 0,
        radiusBR: 0,
        radiusBL: 0,
        radiusLinked: 'true',
      } as Record<string, unknown>,
      children: [],
    },
  };
}

/** Turn a video-generator plate into a normal video node (same id / selection). */
export function createSvgNode({
  x = 40,
  y = 40,
  width = 48,
  height = 48,
  svg = '',
  name = 'SVG',
  fill,
}: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  svg?: string;
  name?: string;
  fill?: string;
} = {}): CreatedSceneNode {
  const id = nanoid(10);
  const ix = Math.round(Number(x) || 0);
  const iy = Math.round(Number(y) || 0);
  const iw = Math.max(1, Math.round(Number(width) || 1));
  const ih = Math.max(1, Math.round(Number(height) || 1));
  const markup = String(svg || '').trim();
  return {
    id,
    node: {
      id,
      key: 'svg',
      x: ix,
      y: iy,
      z: 0,
      width: iw,
      height: ih,
      attrs: {
        svg: markup,
        name: name || 'SVG',
        ...(fill ? { 'fill-color': String(fill) } : {}),
        opacity: 1,
        angle: 0,
      } as Record<string, unknown>,
      children: [],
    },
  };
}

/** Minimal looping pulse — FE smoke / tool-strip spawn until Agent emits JSON. */
export const SAMPLE_LOTTIE_ANIMATION: Record<string, unknown> = {
  v: '5.7.4',
  fr: 60,
  ip: 0,
  op: 120,
  w: 200,
  h: 200,
  nm: 'Sample',
  ddd: 0,
  assets: [],
  layers: [
    {
      ddd: 0,
      ind: 1,
      ty: 4,
      nm: 'Dot',
      sr: 1,
      ks: {
        o: { a: 0, k: 100 },
        r: { a: 0, k: 0 },
        p: { a: 0, k: [100, 100, 0] },
        a: { a: 0, k: [0, 0, 0] },
        s: {
          a: 1,
          k: [
            {
              i: { x: [0.667], y: [1] },
              o: { x: [0.333], y: [0] },
              t: 0,
              s: [55, 55, 100],
            },
            {
              i: { x: [0.667], y: [1] },
              o: { x: [0.333], y: [0] },
              t: 60,
              s: [100, 100, 100],
            },
            { t: 120, s: [55, 55, 100] },
          ],
        },
      },
      ao: 0,
      shapes: [
        {
          ty: 'el',
          p: { a: 0, k: [0, 0] },
          s: { a: 0, k: [88, 88] },
          nm: 'Ellipse',
          hd: false,
        },
        {
          ty: 'fl',
          c: { a: 0, k: [0.2, 0.45, 1, 1] },
          o: { a: 0, k: 100 },
          r: 1,
          bm: 0,
          nm: 'Fill',
          hd: false,
        },
        {
          ty: 'tr',
          p: { a: 0, k: [0, 0] },
          a: { a: 0, k: [0, 0] },
          s: { a: 0, k: [100, 100] },
          r: { a: 0, k: 0 },
          o: { a: 0, k: 100 },
          sk: { a: 0, k: 0 },
          sa: { a: 0, k: 0 },
          nm: 'Transform',
        },
      ],
      ip: 0,
      op: 120,
      st: 0,
      bm: 0,
    },
  ],
};

/**
 * Lift drawable items out of nested `gr` groups.
 * LLM / Bodymovin groups often paint blank in lottie-web (empty `<g>`).
 */
function flattenLottieShapes(shapes: unknown): Record<string, unknown>[] {
  if (!Array.isArray(shapes)) return [];
  const out: Record<string, unknown>[] = [];
  for (const sh of shapes) {
    if (!sh || typeof sh !== 'object' || Array.isArray(sh)) continue;
    const item = sh as Record<string, unknown>;
    const ty = String(item.ty || '');
    if (ty === 'gr') {
      out.push(...flattenLottieShapes(item.it));
      continue;
    }
    if (ty === 'tr') continue;
    out.push(item);
  }
  return out;
}

function flattenLottieGroups(anim: Record<string, unknown>): Record<string, unknown> {
  const layers = anim.layers;
  if (!Array.isArray(layers)) return anim;
  let changed = false;
  const nextLayers = layers.map((layer) => {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) return layer;
    const L = layer as Record<string, unknown>;
    if (Number(L.ty) !== 4) return layer;
    const shapes = L.shapes;
    const flat = flattenLottieShapes(shapes);
    if (flat === shapes || (Array.isArray(shapes) && flat.length === shapes.length && flat.every((s, i) => s === shapes[i]))) {
      return layer;
    }
    changed = true;
    return { ...L, shapes: flat };
  });
  if (!changed) return anim;
  return { ...anim, layers: nextLayers };
}

/** Parse Agent / attrs Lottie payload (object or JSON string). */
export function parseLottieAnimationData(raw: unknown): Record<string, unknown> | null {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;
    try {
      obj = JSON.parse(s);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (!Array.isArray(o.layers)) return null;
  return flattenLottieGroups(o);
}

export function serializeLottieAnimationData(data: unknown): string | null {
  const parsed = parseLottieAnimationData(data);
  if (!parsed) return null;
  try {
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}

/** Finished Lottie plate (not a generator composer). */
export function createAudioGeneratorNode({
  x = 40,
  y = 40,
  width = 360,
  height = 200,
  name = 'Audio Generator',
}: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  name?: string;
} = {}): CreatedSceneNode {
  const id = nanoid(10);
  const iw = Math.max(1, Math.round(Number(width) || 360));
  const ih = Math.max(1, Math.round(Number(height) || 200));
  const ix = Math.round(Number(x) || 0);
  const iy = Math.round(Number(y) || 0);
  return {
    id,
    node: {
      id,
      key: 'audio',
      x: ix,
      y: iy,
      z: 0,
      width: iw,
      height: ih,
      attrs: {
        src: '',
        name: name || 'Audio Generator',
        assetKind: 'audio',
        audioGenerator: true,
        mode: 'FIT',
        lockAspect: 'true',
        radiusTL: 16,
        radiusTR: 16,
        radiusBR: 16,
        radiusBL: 16,
        radiusLinked: 'true',
      } as Record<string, unknown>,
      children: [],
    },
  };
}

/** Theme surface fill — empty / `#FFFFFF` / `white` → `var(--surface)`. */
export function resolveThemeSurfaceFill(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return 'var(--surface)';
  if (s.toLowerCase() === 'white') return 'var(--surface)';
  if (/^#fff(fff)?$/i.test(s)) return 'var(--surface)';
  return s;
}

/** Audio / generator plate — default wash matches generator (`--gen-empty`, light #e9eaee). */
export function resolveGenPlateFill(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return 'var(--gen-empty)';
  const lower = s.toLowerCase();
  if (
    lower === 'var(--surface)' ||
    lower === 'var(--rail)' ||
    lower === 'white' ||
    /^#fff(fff)?$/i.test(s)
  ) {
    return 'var(--gen-empty)';
  }
  return resolveThemeSurfaceFill(raw);
}

/**
 * Clone an audio node to the right (trim / speed confirm).
 * Returns null when source is missing.
 */
export const AUDIO_ASPECT_RATIO = 1.8;
export const AUDIO_MIN_WIDTH = 252;
export const AUDIO_MIN_HEIGHT = 140;
/** Soft cap when sanitizing absurd metadata (not viewport placement). */
export const AUDIO_MAX_WIDTH = 1440;
export const AUDIO_MAX_HEIGHT = 800;
/** Viewport-fit baseline when asset has no pixel size (video + audio). */
export const MEDIA_PLACE_DEFAULT = { width: 1280, height: 720 } as const;

export type MediaPlaceKind = 'image' | 'video' | 'audio' | 'lottie';

/** Resolve natural pixel size before viewport fit — shared by drag / upload / store. */
export function resolveMediaPlaceNatural(
  kind: MediaPlaceKind,
  payload: { width?: number; height?: number },
  imageNatural?: { width: number; height: number }
): { width: number; height: number } {
  const ow = Math.max(0, Math.round(Number(payload.width) || 0));
  const oh = Math.max(0, Math.round(Number(payload.height) || 0));
  // Audio has no meaningful pixel dimensions (often video metadata) — HD baseline only.
  if (kind === 'audio') return { ...MEDIA_PLACE_DEFAULT };
  if (ow > 0 && oh > 0) return { width: ow, height: oh };
  if (kind === 'video') return { ...MEDIA_PLACE_DEFAULT };
  if (kind === 'lottie') return { width: 200, height: 200 };
  if (imageNatural) return imageNatural;
  return { width: 360, height: 360 };
}

/**
 * Same viewport fit as image/video; audio only adds aspect lock afterward.
 */
export function fitMediaIntoViewport(
  kind: MediaPlaceKind,
  natural: { width: number; height: number },
  sizeForViewport: (natural: { width: number; height: number }) => {
    width: number;
    height: number;
  }
): { width: number; height: number } {
  const sized = sizeForViewport(natural);
  return kind === 'audio' ? fitAudioAspect(sized.width, sized.height) : sized;
}

/** Lock width/height to audio plate aspect. */
export function fitAudioAspect(width: number, height: number): { width: number; height: number } {
  const w = Math.max(1, Math.round(Number(width) || 1));
  const h = Math.max(1, Math.round(Number(height) || 1));
  const normalizedHeight = Math.max(h, w / AUDIO_ASPECT_RATIO);
  return {
    width: Math.max(1, Math.round(normalizedHeight * AUDIO_ASPECT_RATIO)),
    height: Math.max(1, Math.round(normalizedHeight)),
  };
}

/** Clamp + aspect-lock for audio plates (create / sanitize metadata). */
export function normalizeAudioSize(width?: number, height?: number): {
  width: number;
  height: number;
} {
  let fitted = fitAudioAspect(
    Math.max(1, Math.round(Number(width) || 360)),
    Math.max(1, Math.round(Number(height) || 200))
  );
  if (fitted.width > AUDIO_MAX_WIDTH || fitted.height > AUDIO_MAX_HEIGHT) {
    const scale = Math.min(AUDIO_MAX_WIDTH / fitted.width, AUDIO_MAX_HEIGHT / fitted.height);
    fitted = fitAudioAspect(fitted.width * scale, fitted.height * scale);
  }
  if (fitted.width < AUDIO_MIN_WIDTH || fitted.height < AUDIO_MIN_HEIGHT) {
    fitted = fitAudioAspect(
      Math.max(fitted.width, AUDIO_MIN_WIDTH),
      Math.max(fitted.height, AUDIO_MIN_HEIGHT)
    );
  }
  return fitted;
}

export function createAudioNode({
  x = 40,
  y = 40,
  width = 360,
  height = 200,
  src = '',
  name = 'Audio',
  duration,
  uploadKey,
}: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  src?: string;
  name?: string;
  /** Media length in seconds — set at upload so players need not seek-probe. */
  duration?: number;
  uploadKey?: string;
} = {}): CreatedSceneNode {
  const id = nanoid(10);
  const d = Number(duration);
  const key = String(uploadKey || '').trim();
  const { width: iw, height: ih } = normalizeAudioSize(width, height);
  const ix = Math.round(Number(x) || 0);
  const iy = Math.round(Number(y) || 0);
  return {
    id,
    node: {
      id,
      key: 'audio',
      x: ix,
      y: iy,
      z: 0,
      width: iw,
      height: ih,
      attrs: {
        src,
        name: name || 'Audio',
        assetKind: 'audio',
        mode: 'FIT',
        lockAspect: 'true',
        audioSpeed: 1,
        'fill-color': 'var(--gen-empty)',
        ...(Number.isFinite(d) && d > 0 ? { duration: d } : {}),
        ...(key ? { uploadKey: key } : {}),
        radiusTL: 16,
        radiusTR: 16,
        radiusBR: 16,
        radiusBL: 16,
        radiusLinked: 'true',
      } as Record<string, unknown>,
      children: [],
    },
  };
}

/** Turn an audio-generator plate into a normal audio node (same id / selection). */
export function createLottieGeneratorNode({
  x = 40,
  y = 40,
  width = 200,
  height = 200,
  name = 'Lottie Generator',
}: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  name?: string;
} = {}): CreatedSceneNode {
  const id = nanoid(10);
  const iw = Math.max(1, Math.round(Number(width) || 200));
  const ih = Math.max(1, Math.round(Number(height) || 200));
  const ix = Math.round(Number(x) || 0);
  const iy = Math.round(Number(y) || 0);
  return {
    id,
    node: {
      id,
      key: 'lottie',
      x: ix,
      y: iy,
      z: 0,
      width: iw,
      height: ih,
      attrs: {
        animationData: '',
        name: name || 'Lottie Generator',
        assetKind: 'lottie',
        lottieGenerator: true,
        lottieGenAspect: '1:1',
        lottieGenDuration: 3,
        lottieGenModel: 'auto',
        mode: 'FIT',
        lockAspect: 'true',
        'fill-color': '#FFFFFF',
        radiusTL: 0,
        radiusTR: 0,
        radiusBR: 0,
        radiusBL: 0,
        radiusLinked: 'true',
        opacity: 1,
        angle: 0,
      } as Record<string, unknown>,
      children: [],
    },
  };
}

/**
 * Lottie animation plate — `attrs.animationData` is JSON string (Bodymovin).
 * HTML overlay plays via lottie-web; SVG is hit-target / export underlay.
 */
export function createLottieNode({
  x = 40,
  y = 40,
  width,
  height,
  animationData,
  name = 'Lottie',
}: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  animationData?: unknown;
  name?: string;
} = {}): CreatedSceneNode {
  const id = nanoid(10);
  const parsed =
    parseLottieAnimationData(animationData) ||
    (animationData == null ? SAMPLE_LOTTIE_ANIMATION : null);
  const json = serializeLottieAnimationData(parsed);
  if (!json) {
    throw new Error('createLottieNode: invalid animationData');
  }
  const natW = Math.max(1, Math.round(Number(parsed?.w) || 200));
  const natH = Math.max(1, Math.round(Number(parsed?.h) || 200));
  const iw = Math.max(1, Math.round(Number(width) || natW));
  const ih = Math.max(1, Math.round(Number(height) || natH));
  const ix = Math.round(Number(x) || 0);
  const iy = Math.round(Number(y) || 0);
  return {
    id,
    node: {
      id,
      key: 'lottie',
      x: ix,
      y: iy,
      z: 0,
      width: iw,
      height: ih,
      attrs: {
        animationData: json,
        name: name || 'Lottie',
        assetKind: 'lottie',
        mode: 'FIT',
        lockAspect: 'true',
        // Default surface plate so finished Lottie isn’t floating on the canvas.
        'fill-color': 'var(--surface)',
        radiusTL: 8,
        radiusTR: 8,
        radiusBR: 8,
        radiusBL: 8,
        radiusLinked: 'true',
        opacity: 1,
        angle: 0,
      } as Record<string, unknown>,
      children: [],
    },
  };
}

/** 1×1 transparent GIF — keeps image nodes selectable while src is blank. */
export const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
