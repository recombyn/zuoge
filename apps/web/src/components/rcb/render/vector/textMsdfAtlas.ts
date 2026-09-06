/**
 * Idle text MSDF glyph atlas — Chlumsky msdfgen (WASM), not bitmap EDT.
 * Per-glyph cells from @playcanvas/msdfgen-wasm; dedicated packer (not media atlas).
 */
import { createMsdfgen } from '@playcanvas/msdfgen-wasm';
import msdfgenWasmUrl from '@playcanvas/msdfgen-wasm/msdfgen.wasm?url';
import type { SceneNodeInput } from '@/components/rcb/sceneNode';
import {
  parseNodeText,
  parseNodeTextStyle,
  textVerticalOriginY,
  measureTextEmBoxHeight,
  wrapPlainTextLines,
  toFabricFontFamily,
  type TextStyle,
} from '@/components/rcb/scene/document/sceneText';
import { TEXT_FRAME_PADDING } from '@/components/rcb/scene/document/sceneEffects';
import {
  getBaseFontFamily,
  getFontChildren,
  getFontCatalogSync,
  loadFontCatalog,
  resolveFontFileUrl,
} from '@/components/rcb/scene/document/fontCatalog';
import { woff2Decode } from 'woff-lib/woff2/decode';
import { woffDecode } from 'woff-lib/woff/decode';

/** Atlas edge (power of two). */
export const MSDF_ATLAS_SIZE = 2048;
/**
 * Cell size for msdfgen `-size`. PlayCanvas default 64; real MSDF stays sharp when
 * magnified (unlike bitmap EDT).
 */
export const MSDF_GLYPH_PX = 64;
/** msdfgen `-pxrange` (texels of distance). */
export const MSDF_PX_RANGE = 8;
/**
 * Em span of one autoframed cell when using emnormalize + size/2 px-per-em
 * (PlayCanvas binding: cell covers 2 em).
 */
export const MSDF_CELL_EM = MSDF_GLYPH_PX / 32;

/**
 * Same jsDelivr faces as `styles/fonts.css` — catalog API may be empty/slow while
 * the editor already paints via CSS @font-face. Idle MSDF must still resolve bytes.
 */
export const PUHUI_TI_CDN = {
  thin: 'https://cdn.jsdelivr.net/npm/c1-alibaba-puhui-ti@1.0.0/fonts/AlibabaPuHuiTi-3-35-Thin.woff2',
  regular:
    'https://cdn.jsdelivr.net/npm/c1-alibaba-puhui-ti@1.0.0/fonts/AlibabaPuHuiTi-3-55-Regular.woff2',
  bold: 'https://cdn.jsdelivr.net/npm/c1-alibaba-puhui-ti@1.0.0/fonts/AlibabaPuHuiTi-3-85-Bold.woff2',
} as const;

function numericStyleWeight(fontWeight: string | number | undefined): number {
  if (fontWeight === 'bold' || fontWeight === '700') return 700;
  if (fontWeight === 'normal' || fontWeight === '400') return 400;
  const n = Number(fontWeight);
  return Number.isFinite(n) ? n : 400;
}

/** Built-in CDN URL when the font catalog has no face for the app default family. */
export function resolveBuiltinFontUrl(
  fontFamily: string,
  fontWeight?: string | number
): string | null {
  const base = getBaseFontFamily(fontFamily);
  if (!/puhui|普惠|Alibaba PuHuiTi/i.test(base) && base !== 'Alibaba PuHuiTi') {
    return null;
  }
  const w = numericStyleWeight(fontWeight);
  if (w >= 600) return PUHUI_TI_CDN.bold;
  if (w > 0 && w <= 300) return PUHUI_TI_CDN.thin;
  return PUHUI_TI_CDN.regular;
}

export type MsdfGlyphMetrics = {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Layout in em (1 = fontSize). Plane origin → baseline / pen. */
  bearingX: number;
  bearingY: number;
  width: number;
  height: number;
  advance: number;
};

export type MsdfAtlasState = {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  size: number;
  nextSlot: number;
  slotsPerRow: number;
  glyphs: Map<string, MsdfGlyphMetrics>;
  revision: number;
  inflight: Set<string>;
};

export type MsdfGlyphQuad = {
  x: number;
  y: number;
  w: number;
  h: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
};

type MsdfgenFont = {
  generateGlyph: (
    codepoint: number,
    size: number,
    pxrange: number
  ) => null | {
    width: number;
    height: number;
    rgba: Uint8Array | Uint8ClampedArray | number[];
    advance: number;
    translateX: number;
    translateY: number;
    boundsL: number;
    boundsB: number;
    boundsR: number;
    boundsT: number;
    range: number;
  };
  ok: () => boolean;
  delete: () => void;
};

type MsdfgenApi = {
  loadFont: (bytes: Uint8Array | ArrayBuffer) => MsdfgenFont | null;
};

let sharedAtlas: MsdfAtlasState | null = null;
let msdfgenApi: MsdfgenApi | null = null;
let msdfgenInit: Promise<MsdfgenApi | null> | null = null;
const fontBytesByUrl = new Map<string, Promise<Uint8Array | null>>();
const fontHandleByUrl = new Map<string, MsdfgenFont | null>();

function makeCanvas(size: number): {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
} | null {
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) return { canvas, ctx };
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) return { canvas, ctx };
  }
  return null;
}

export function ensureSharedMsdfAtlas(): MsdfAtlasState | null {
  if (sharedAtlas) return sharedAtlas;
  const made = makeCanvas(MSDF_ATLAS_SIZE);
  if (!made) return null;
  made.ctx.clearRect(0, 0, MSDF_ATLAS_SIZE, MSDF_ATLAS_SIZE);
  made.ctx.fillStyle = 'rgb(128,128,128)';
  made.ctx.fillRect(0, 0, MSDF_ATLAS_SIZE, MSDF_ATLAS_SIZE);
  sharedAtlas = {
    canvas: made.canvas,
    ctx: made.ctx,
    size: MSDF_ATLAS_SIZE,
    nextSlot: 0,
    slotsPerRow: Math.floor(MSDF_ATLAS_SIZE / MSDF_GLYPH_PX),
    glyphs: new Map(),
    revision: 1,
    inflight: new Set(),
  };
  return sharedAtlas;
}

export function clearMsdfAtlasForTests() {
  sharedAtlas = null;
  for (const f of fontHandleByUrl.values()) {
    try {
      f?.delete();
    } catch {
      /* ignore */
    }
  }
  fontHandleByUrl.clear();
  fontBytesByUrl.clear();
}

async function ensureMsdfgen(): Promise<MsdfgenApi | null> {
  if (msdfgenApi) return msdfgenApi;
  if (!msdfgenInit) {
    msdfgenInit = (async () => {
      try {
        const api = await createMsdfgen({
          moduleOverrides: {
            locateFile: (path: string) =>
              path.endsWith('.wasm') ? msdfgenWasmUrl : path,
          },
        });
        msdfgenApi = api as MsdfgenApi;
        return msdfgenApi;
      } catch (err) {
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn('[msdf] createMsdfgen failed', err);
        }
        return null;
      }
    })();
  }
  return msdfgenInit;
}

function preferBinaryFontUrl(url: string | null, family: string, weight?: string): string | null {
  if (!url) return null;
  if (/\.(ttf|otf|ttc)(\?|#|$)/i.test(url)) return url;
  const catalog = getFontCatalogSync();
  const children = getFontChildren(family, catalog);
  const binary =
    children.find((c) => c.url && /\.(ttf|otf|ttc)(\?|#|$)/i.test(c.url)) ||
    children.find((c) => c.url && !/\.woff2?(\?|#|$)/i.test(c.url));
  if (binary?.url) {
    return resolveFontFileUrl(binary.family || family, weight ?? binary.weight, catalog) || url;
  }
  // WOFF/WOFF2 are OK — decode to SFNT before FreeType (see fontBytesToSfnt).
  return url;
}

function resolveStyleFontUrl(style: TextStyle): string | null {
  const family = toFabricFontFamily(style.fontFamily);
  const weight = style.fontWeight;
  const primary = resolveFontFileUrl(family, weight);
  const preferred = preferBinaryFontUrl(primary, family, weight);
  if (preferred) return preferred;
  // Catalog empty / missing PuHuiTi URL — still pack idle MSDF from CSS CDN faces.
  return resolveBuiltinFontUrl(family, weight);
}

async function loadFontBytes(url: string): Promise<Uint8Array | null> {
  let pending = fontBytesByUrl.get(url);
  if (!pending) {
    pending = (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`font fetch ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn('[msdf] font fetch failed', url, err);
        }
        return null;
      }
    })();
    fontBytesByUrl.set(url, pending);
  }
  return pending;
}

function sniffFontContainer(bytes: Uint8Array): 'woff2' | 'woff' | 'sfnt' | 'unknown' {
  if (bytes.length < 4) return 'unknown';
  // 'wOF2' / 'wOFF'
  if (bytes[0] === 0x77 && bytes[1] === 0x4f && bytes[2] === 0x46 && bytes[3] === 0x32) return 'woff2';
  if (bytes[0] === 0x77 && bytes[1] === 0x4f && bytes[2] === 0x46 && bytes[3] === 0x46) return 'woff';
  // OTTO / true / typ1 / 00 01 00 00
  if (bytes[0] === 0x4f && bytes[1] === 0x54 && bytes[2] === 0x54 && bytes[3] === 0x4f) return 'sfnt';
  if (bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return 'sfnt';
  if (bytes[0] === 0x74 && bytes[1] === 0x72 && bytes[2] === 0x75 && bytes[3] === 0x65) return 'sfnt';
  return 'unknown';
}

/** FreeType needs SFNT; catalog faces are often WOFF2 — decode in-browser. */
async function fontBytesToSfnt(url: string, bytes: Uint8Array): Promise<Uint8Array | null> {
  const sniffed = sniffFontContainer(bytes);
  const kind =
    sniffed !== 'unknown'
      ? sniffed
      : /\.woff2(\?|#|$)/i.test(url)
        ? 'woff2'
        : /\.woff(\?|#|$)/i.test(url)
          ? 'woff'
          : 'sfnt';
  try {
    if (kind === 'woff2') return new Uint8Array(await woff2Decode(bytes));
    if (kind === 'woff') return new Uint8Array(await woffDecode(bytes));
    return bytes;
  } catch (err) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn('[msdf] WOFF→SFNT decode failed', url, err);
    }
    return null;
  }
}

async function loadMsdfFont(url: string): Promise<MsdfgenFont | null> {
  if (fontHandleByUrl.has(url)) return fontHandleByUrl.get(url) ?? null;
  const api = await ensureMsdfgen();
  if (!api) {
    fontHandleByUrl.set(url, null);
    return null;
  }
  const raw = await loadFontBytes(url);
  // Failed fetch must not poison the cache forever (transient network).
  if (!raw) {
    fontBytesByUrl.delete(url);
    return null;
  }
  const bytes = await fontBytesToSfnt(url, raw);
  if (!bytes) {
    fontBytesByUrl.delete(url);
    return null;
  }
  try {
    const font = api.loadFont(bytes);
    fontHandleByUrl.set(url, font);
    return font;
  } catch (err) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn('[msdf] loadFont failed after SFNT decode', url, err);
    }
    fontBytesByUrl.delete(url);
    return null;
  }
}

function glyphKey(style: TextStyle, ch: string): string {
  return [
    toFabricFontFamily(style.fontFamily),
    style.fontWeight || '',
    style.fontStyle || '',
    ch,
  ].join('\u0001');
}

function allocateSlot(atlas: MsdfAtlasState): { slot: number; x: number; y: number } | null {
  const max = atlas.slotsPerRow * atlas.slotsPerRow;
  if (atlas.nextSlot >= max) {
    atlas.nextSlot = 0;
    atlas.glyphs.clear();
    atlas.ctx.fillStyle = 'rgb(128,128,128)';
    atlas.ctx.fillRect(0, 0, atlas.size, atlas.size);
    atlas.revision += 1;
  }
  const slot = atlas.nextSlot;
  atlas.nextSlot += 1;
  const col = slot % atlas.slotsPerRow;
  const row = Math.floor(slot / atlas.slotsPerRow);
  return { slot, x: col * MSDF_GLYPH_PX, y: row * MSDF_GLYPH_PX };
}

function scheduleIdleBump() {
  void import('@/components/rcb/render/sceneRenderer').then((m) => {
    m.bumpSceneCanvasIdlePaint();
  });
}

/**
 * Pack one codepoint via real msdfgen into the shared atlas.
 * Returns metrics when ready; null while async init / font / pack is in flight.
 */
export function ensureMsdfGlyph(style: TextStyle, ch: string): MsdfGlyphMetrics | null {
  const atlas = ensureSharedMsdfAtlas();
  if (!atlas) return null;
  const key = glyphKey(style, ch);
  const hit = atlas.glyphs.get(key);
  if (hit) return hit;
  if (atlas.inflight.has(key)) return null;
  atlas.inflight.add(key);

  void (async () => {
    try {
      await loadFontCatalog().catch(() => undefined);
      const url = resolveStyleFontUrl(style);
      if (!url) {
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn(
            '[msdf] no font URL for',
            toFabricFontFamily(style.fontFamily),
            style.fontWeight
          );
        }
        return;
      }
      const font = await loadMsdfFont(url);
      if (!font) return;
      const cp = ch.codePointAt(0);
      if (cp == null) return;

      if (ch === ' ' || ch === '\t') {
        const slot = allocateSlot(atlas);
        if (!slot) return;
        const metrics: MsdfGlyphMetrics = {
          u0: slot.x / atlas.size,
          v0: slot.y / atlas.size,
          u1: (slot.x + MSDF_GLYPH_PX) / atlas.size,
          v1: (slot.y + MSDF_GLYPH_PX) / atlas.size,
          bearingX: 0,
          bearingY: 0,
          width: 0.01,
          height: 0.01,
          advance: ch === '\t' ? 2 : 0.33,
        };
        atlas.glyphs.set(key, metrics);
        atlas.revision += 1;
        scheduleIdleBump();
        return;
      }

      const g = font.generateGlyph(cp, MSDF_GLYPH_PX, MSDF_PX_RANGE);
      if (!g) {
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn('[msdf] generateGlyph returned null', ch, url);
        }
        return;
      }
      const slot = allocateSlot(atlas);
      if (!slot) return;
      const img = atlas.ctx.createImageData(MSDF_GLYPH_PX, MSDF_GLYPH_PX);
      const src = g.rgba;
      if (src instanceof Uint8ClampedArray || src instanceof Uint8Array) {
        img.data.set(src.subarray(0, MSDF_GLYPH_PX * MSDF_GLYPH_PX * 4));
      } else {
        for (let i = 0; i < img.data.length; i += 1) img.data[i] = Number(src[i]) || 0;
      }
      // Force opaque alpha — msdfgen RGB is the field; A may be unused.
      for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
      atlas.ctx.putImageData(img, slot.x, slot.y);

      // Plane: cell covers MSDF_CELL_EM em; translate is autoframe origin (PlayCanvas).
      const cellEm = MSDF_CELL_EM;
      const tx = Number(g.translateX) || 0;
      const ty = Number(g.translateY) || 0;
      const metrics: MsdfGlyphMetrics = {
        u0: slot.x / atlas.size,
        v0: slot.y / atlas.size,
        u1: (slot.x + MSDF_GLYPH_PX) / atlas.size,
        v1: (slot.y + MSDF_GLYPH_PX) / atlas.size,
        bearingX: -tx,
        // y-down scene: top of cell relative to baseline.
        bearingY: -(cellEm - ty),
        width: cellEm,
        height: cellEm,
        advance: Math.max(0.05, Number(g.advance) || 0.5),
      };
      atlas.glyphs.set(key, metrics);
      atlas.revision += 1;
      scheduleIdleBump();
    } catch (err) {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn('[msdf] glyph pack failed', ch, err);
      }
    } finally {
      atlas.inflight.delete(key);
    }
  })();

  return null;
}

/**
 * Layout world-space MSDF quads for a text node (local → caller adds x/y + rotation).
 */
export function layoutMsdfTextQuads(
  node: SceneNodeInput,
  opts?: { width?: number; height?: number }
): { quads: MsdfGlyphQuad[]; pending: boolean; fill: string; opacity: number } | null {
  if (String(node.key || '') !== 'text') return null;
  const plain = parseNodeText(node.attrs || {});
  if (!String(plain || '').trim()) return null;
  const style = parseNodeTextStyle(node.attrs || {});
  const fontSize = Math.max(1, Number(style.fontSize) || 14);
  const lineHeight = Math.max(0.8, Number(style.lineHeight) || 1.4);
  const letterSpacing = Number(style.letterSpacing) || 0;
  const w = Math.max(1, Number(opts?.width ?? node.width) || 1);
  const h = Math.max(1, Number(opts?.height ?? node.height) || 1);
  const textFrame =
    node.attrs?.textFrame === true ||
    node.attrs?.textFrame === 'true' ||
    node.attrs?.textFrame === 1 ||
    node.attrs?.textFrame === '1';
  const framePad = textFrame ? TEXT_FRAME_PADDING : 0;
  const innerW = Math.max(1, w - framePad * 2);
  const lines = wrapPlainTextLines(plain, style, innerW);
  const emBox = measureTextEmBoxHeight(style, (plain || '永').slice(0, 1) || '永');
  const originY = textFrame
    ? 0
    : textVerticalOriginY(
        Math.max(1, h - framePad * 2),
        fontSize,
        lineHeight,
        Math.max(1, lines.length),
        emBox
      );
  const align = String(style.textAlign || 'left');
  const lineH = fontSize * lineHeight;
  const ascent = Math.max(0.5, Math.min(1.2, emBox || 0.85));
  const quads: MsdfGlyphQuad[] = [];
  let pending = false;

  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li] || ' ';
    const chars = Array.from(line.length ? line : ' ');
    let lineWEm = 0;
    const metricsList: (MsdfGlyphMetrics | null)[] = [];
    for (const ch of chars) {
      const m = ensureMsdfGlyph(style, ch);
      metricsList.push(m);
      if (!m) {
        pending = true;
        lineWEm += 0.5;
      } else {
        lineWEm += m.advance + letterSpacing / fontSize;
      }
    }
    if (chars.length) lineWEm -= letterSpacing / fontSize;
    let penX = framePad;
    if (align === 'center' || align === 'middle') {
      penX = framePad + (innerW - lineWEm * fontSize) / 2;
    } else if (align === 'right' || align === 'end') {
      penX = framePad + innerW - lineWEm * fontSize;
    }
    const lineTop = framePad + originY + li * lineH;
    const baseline = lineTop + ascent * fontSize;
    for (let ci = 0; ci < chars.length; ci += 1) {
      const m = metricsList[ci];
      if (!m) {
        penX += 0.5 * fontSize + letterSpacing;
        continue;
      }
      if (chars[ci] !== ' ' && chars[ci] !== '\t') {
        quads.push({
          x: penX + m.bearingX * fontSize,
          y: baseline + m.bearingY * fontSize,
          w: m.width * fontSize,
          h: m.height * fontSize,
          u0: m.u0,
          v0: m.v0,
          u1: m.u1,
          v1: m.v1,
        });
      }
      penX += m.advance * fontSize + letterSpacing;
    }
  }

  const fillOpacity = Math.max(0, Math.min(100, Number(style.fillOpacity) || 100)) / 100;
  return {
    quads,
    pending,
    fill: style.fill || '#333333',
    opacity: fillOpacity,
  };
}

/** True when idle WebGL can submit glyph quads (no async holes left). */
export function isMsdfTextPaintReady(
  node: SceneNodeInput,
  opts?: { width?: number; height?: number }
): boolean {
  const laid = layoutMsdfTextQuads(node, opts);
  return Boolean(laid && laid.quads.length > 0 && !laid.pending);
}

export function parseCssColorRgb(css: string): [number, number, number] {
  const s = String(css || '').trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return [
      parseInt(h.slice(0, 2), 16) / 255,
      parseInt(h.slice(2, 4), 16) / 255,
      parseInt(h.slice(4, 6), 16) / 255,
    ];
  }
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(s);
  if (m) {
    return [
      Math.min(1, Number(m[1]) / 255),
      Math.min(1, Number(m[2]) / 255),
      Math.min(1, Number(m[3]) / 255),
    ];
  }
  return [0.2, 0.2, 0.2];
}
