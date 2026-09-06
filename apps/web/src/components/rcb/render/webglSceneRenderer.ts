/**
 * WebGL2 backend for SoA vector meshes + media atlas stamps (ADR 0027).
 * Shape fill/stroke are GPU triangles (never atlas bake).
 */
import { rcbCameraCssZoom, rcbCameraScreenOffset, rcbViewportSceneBounds } from '@/components/rcb/core/math';
import { getNodeTransformPreview } from '@/components/rcb/core/transformPreview';
import {
  getSharedSceneRenderBuffer,
  isSoaCanvasShapesEnabled,
  resolveSoaPaintBox,
  getSoaPaintDocument,
  setSoaPaintDocument,
  sampleLineOrArrowWorldPolyline,
  SOA_FLAG_CANVAS_IDLE,
  SOA_FLAG_DIRTY,
  SOA_FLAG_VISIBLE,
  SOA_KIND_ELLIPSE,
  SOA_KIND_IMAGE,
  SOA_KIND_LINE,
  SOA_KIND_PATH,
  SOA_KIND_POLY,
  SOA_KIND_RECT,
  SOA_KIND_TEXT,
  soaStrokeWidth,
  type SceneRenderBuffer,
} from '@/components/rcb/render/sceneRenderBuffer';
import { nodeOwnerFrameId } from '@/components/rcb/frames/frameNodeBinding';
import { selectionPaintRaises, frameClipRevealsOverflow } from '@/components/rcb/selection/selectionPaintRaise';
import { findClippingFrameForNode } from '@/components/rcb/frames/frameContentClip';
import {
  buildNodeStackZMap,
  maxDocumentStackZ,
} from '@/components/rcb/scene/document/sceneDocument';
import type { SceneDocument, SceneNodeInput } from '@/components/rcb/sceneNode';
import {
  ensureSharedSoaWebglAtlas,
  recreateSharedSoaWebglAtlas,
  pruneSoaAtlasForBuffer,
  pushAtlasRegionInstance,
  releaseSoaAtlasPrefix,
  stampImageToAtlas,
  atlasZoomBucket,
  type SoaWebglAtlas,
} from '@/components/rcb/render/webglInstanceAtlas';
import {
  bakeAudioInkForAtlas,
  bakeMediaInkForAtlas,
  bumpSceneCanvasIdlePaint,
  isFillImageWebglUnsafe,
  hitTestWithSpatialIndex,
  mediaPaintSrc,
  type CanvasSceneRendererDeps,
  type SceneRenderRequest,
  type SceneRenderer,
} from '@/components/rcb/render/sceneRenderer';
import { getOrBuildShapeMesh } from '@/components/rcb/render/vector/meshCache';
import { appendMeshLocal } from '@/components/rcb/render/vector/appendMesh';
import {
  ensureTextOutlineMesh,
  getTextOutlineMesh,
} from '@/components/rcb/render/vector/textOutlineMesh';
import {
  buildNormalizedDepthLookup,
  shouldRunGpuDepthOfField,
} from '@/components/rcb/render/gpuDepthOfField';
import {
  bindWebglDofSceneAttributes,
  createWebglDepthOfFieldPass,
  type WebglDepthOfFieldPass,
} from '@/components/rcb/render/webglDepthOfFieldPass';
import {
  adaptivePathStrokeMaxSegs,
  floorContentStrokeSceneWidth,
} from '@/components/rcb/render/strokeScreenFloor';
import { parseLayerOpacity } from '@/components/rcb/selection/chrome/BlendModeControl';

/** Scene-space LTRB when the slot has no clipContent owner (or reveal-overflow). */
export const SOA_WEBGL_NO_CLIP: [number, number, number, number] = [-1e8, -1e8, 1e8, 1e8];

/** Instance ink vertex shader (world + artboard FO). */
export const SOA_WEBGL_INK_VS = `#version 300 es
precision mediump float;
uniform vec2 uPan;
uniform float uZoom;
uniform vec2 uStage;
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aRect;
layout(location = 2) in vec4 aColor;
layout(location = 3) in float aKind;
layout(location = 4) in float aAngle;
layout(location = 5) in vec4 aUv;
layout(location = 6) in vec4 aClip;
out vec2 vUv;
out vec2 vAtlasUv;
out vec4 vColor;
out float vKind;
out vec2 vWorld;
out vec4 vClip;
void main() {
  vec2 local;
  if (aKind > 1.5 && aKind < 2.5) {
    local = vec2(aCorner.x * aRect.z, (aCorner.y - 0.5) * aRect.w);
  } else {
    local = aCorner * aRect.zw;
  }
  float c = cos(aAngle);
  float s = sin(aAngle);
  vec2 pos = aRect.xy + vec2(c * local.x - s * local.y, s * local.x + c * local.y);
  vec2 screen = pos * uZoom + uPan;
  vec2 clip = vec2(
    (screen.x / uStage.x) * 2.0 - 1.0,
    1.0 - (screen.y / uStage.y) * 2.0
  );
  gl_Position = vec4(clip, 0.0, 1.0);
  vUv = aCorner * 2.0 - 1.0;
  vAtlasUv = mix(aUv.xy, aUv.zw, aCorner);
  vColor = aColor;
  vKind = aKind;
  vWorld = pos;
  vClip = aClip;
}`;

/** Instance ink fragment shader (world + artboard FO). */
export const SOA_WEBGL_INK_FS = `#version 300 es
precision mediump float;
uniform sampler2D uAtlas;
uniform float uZoom;
in vec2 vUv;
in vec2 vAtlasUv;
in vec4 vColor;
in float vKind;
in vec2 vWorld;
in vec4 vClip;
out vec4 outColor;
void main() {
  if (vWorld.x < vClip.x || vWorld.y < vClip.y || vWorld.x > vClip.z || vWorld.y > vClip.w) {
    discard;
  }
  // Atlas stamp (closed fills / paths / bake tiles).
  if (vKind > 2.5 && vKind < 3.5) {
    vec4 tex = texture(uAtlas, vAtlasUv);
    if (tex.a < 0.01) discard;
    // Straight→premultiplied (canvas context uses premultipliedAlpha:true).
    outColor = vec4(tex.rgb * tex.a, tex.a);
    return;
  }
  // Open stroke segment (line/arrow/pen): soft long-edge AA.
  // Canvas2D atlas (pencil) already AA-bakes; hard quads look staircased on diagonals.
  if (vKind > 1.5 && vKind < 2.5) {
    float d = abs(vUv.y);
    float aa = max(fwidth(d), 1e-4);
    float cover = 1.0 - smoothstep(1.0 - aa, 1.0, d);
    if (cover < 0.01) discard;
    float a = vColor.a * cover;
    outColor = vec4(vColor.rgb * a, a);
    return;
  }
  if (vKind > 0.5 && vKind < 1.5) {
    if (dot(vUv, vUv) > 1.0) discard;
  }
  // Premultiply solid/ellipse ink so layer opacity composites correctly.
  outColor = vec4(vColor.rgb * vColor.a, vColor.a);
}`;

/** World-space triangle mesh program (vector fill/stroke). */
export const SOA_WEBGL_MESH_VS = `#version 300 es
precision mediump float;
uniform vec2 uPan;
uniform float uZoom;
uniform vec2 uStage;
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec4 aColor;
layout(location = 2) in vec4 aClip;
out vec4 vColor;
out vec2 vWorld;
out vec4 vClip;
void main() {
  vec2 screen = aPos * uZoom + uPan;
  vec2 clip = vec2(
    (screen.x / uStage.x) * 2.0 - 1.0,
    1.0 - (screen.y / uStage.y) * 2.0
  );
  gl_Position = vec4(clip, 0.0, 1.0);
  vColor = aColor;
  vWorld = aPos;
  vClip = aClip;
}`;

export const SOA_WEBGL_MESH_FS = `#version 300 es
precision mediump float;
in vec4 vColor;
in vec2 vWorld;
in vec4 vClip;
out vec4 outColor;
void main() {
  if (vWorld.x < vClip.x || vWorld.y < vClip.y || vWorld.x > vClip.z || vWorld.y > vClip.w) {
    discard;
  }
  // Premultiply — matches premultipliedAlpha:true + ONE / ONE_MINUS_SRC_ALPHA.
  outColor = vec4(vColor.rgb * vColor.a, vColor.a);
}`;

const VS = SOA_WEBGL_INK_VS;
const FS = SOA_WEBGL_INK_FS;
const MESH_VS = SOA_WEBGL_MESH_VS;
const MESH_FS = SOA_WEBGL_MESH_FS;

export const SOA_WEBGL_UNIT_QUAD = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);
const UNIT_QUAD = SOA_WEBGL_UNIT_QUAD;
/** Default line thickness in scene units (used when SoA stroke width is unset). */
export const SOA_WEBGL_LINE_THICKNESS = 2;
/** Cap segments emitted per path so one dense stroke cannot explode the instance batch. */
export const SOA_WEBGL_PATH_MAX_SEGS = 96;

/** ANGLE / some Windows drivers reject \\r in #version lines and non-ASCII in source. */
function normalizeGlslSource(src: string): string {
  return src.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Compile a GLSL shader (shared by world ink + artboard FO ink). */
export function compileSoaWebglShader(
  gl: WebGL2RenderingContext,
  type: number,
  src: string
): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, normalizeGlslSource(src));
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.error(
        '[webgl] shader compile failed',
        type === gl.VERTEX_SHADER ? 'VS' : 'FS',
        gl.getShaderInfoLog(sh)
      );
    }
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

/** Link VS+FS into a program (shared by world ink + artboard FO ink). */
export function linkSoaWebglProgram(
  gl: WebGL2RenderingContext,
  vs: WebGLShader,
  fs: WebGLShader
): WebGLProgram | null {
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.error('[webgl] program link failed', gl.getProgramInfoLog(prog));
    }
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  return compileSoaWebglShader(gl, type, src);
}

function link(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader) {
  return linkSoaWebglProgram(gl, vs, fs);
}

let inkShaderProbeOk: boolean | null = null;

/**
 * Compile the product ink program on a throwaway canvas.
 * Must run BEFORE `getContext('webgl2')` on the stage ink canvas — a failed
 * compile still binds WebGL2 to that element and blocks Canvas2D fallback
 * (deselected shapes then vanish; only selection chrome remains).
 */
export function soaWebglInkShadersOk(): boolean {
  if (inkShaderProbeOk != null) return inkShaderProbeOk;
  if (typeof document === 'undefined') {
    inkShaderProbeOk = false;
    return false;
  }
  try {
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    const gl = probe.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
    });
    if (!gl) {
      inkShaderProbeOk = false;
      return false;
    }
    const vs = compile(gl, gl.VERTEX_SHADER, VS);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FS);
    const prog = vs && fs ? link(gl, vs, fs) : null;
    inkShaderProbeOk = Boolean(prog);
    if (prog) gl.deleteProgram(prog);
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return inkShaderProbeOk;
  } catch (err) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.error('[webgl] ink shader probe failed', err);
    }
    inkShaderProbeOk = false;
    return false;
  }
}

/** Test-only: clear probe cache after shader source changes. */
export function resetSoaWebglInkShaderProbeForTests() {
  inkShaderProbeOk = null;
}

function argbToRgba(argb: number): [number, number, number, number] {
  const a = ((argb >>> 24) & 0xff) / 255;
  const r = ((argb >>> 16) & 0xff) / 255;
  const g = ((argb >>> 8) & 0xff) / 255;
  const b = (argb & 0xff) / 255;
  return [r, g, b, a];
}

/** Stroke ink for line/path segments (open pens store stroke in strokeColors, fill in colors=0). */
function soaWebglStrokeRgba(buf: SceneRenderBuffer, index: number): [number, number, number, number] {
  const stroke = buf.strokeColors[index] >>> 0;
  if (stroke) return argbToRgba(stroke);
  const fill = buf.colors[index] >>> 0;
  if (fill) return argbToRgba(fill);
  return argbToRgba(0xff333333);
}

function pushInstanceClip(
  clips: number[] | undefined,
  clip: readonly [number, number, number, number]
) {
  if (!clips) return;
  clips.push(clip[0], clip[1], clip[2], clip[3]);
}

/** Owning clipContent plate in scene space, or {@link SOA_WEBGL_NO_CLIP}. */
export function resolveSoaWebglSlotClip(
  buf: SceneRenderBuffer,
  index: number,
  doc: SceneDocument | null | undefined
): [number, number, number, number] {
  if (!doc) return SOA_WEBGL_NO_CLIP;
  const id = buf.ids[index];
  if (!id || frameClipRevealsOverflow(id)) return SOA_WEBGL_NO_CLIP;
  const node = doc.deltaSetLike?.[id] as Record<string, unknown> | undefined;
  if (!node) return SOA_WEBGL_NO_CLIP;
  const frame = findClippingFrameForNode(doc, { ...node, id });
  if (!frame) return SOA_WEBGL_NO_CLIP;
  const ox = Number(doc.x) || 0;
  const oy = Number(doc.y) || 0;
  const left = Number(frame.x) - ox;
  const top = Number(frame.y) - oy;
  const right = left + Math.max(1, Number(frame.width) || 1);
  const bottom = top + Math.max(1, Number(frame.height) || 1);
  return [left, top, right, bottom];
}

function pushLineInstance(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgba: [number, number, number, number],
  thickness: number,
  rects: number[],
  colors: number[],
  kinds: number[],
  angles: number[],
  uvs: number[],
  depths: number[] | undefined,
  depth: number,
  clips: number[] | undefined,
  clip: readonly [number, number, number, number]
) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 0.01;
  const thr = thickness > 0 ? thickness : SOA_WEBGL_LINE_THICKNESS;
  rects.push(x0, y0, len, thr);
  colors.push(rgba[0], rgba[1], rgba[2], rgba[3]);
  kinds.push(2);
  angles.push(Math.atan2(dy, dx));
  uvs.push(0, 0, 1, 1);
  if (depths) depths.push(depth);
  pushInstanceClip(clips, clip);
}

/**
 * Fill the outer wedge where two butt-capped stroke quads meet.
 * Without this, arrow V tips show a flat notch instead of a sharp point.
 */
function pushLineMiterJoin(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  rgba: [number, number, number, number],
  thickness: number,
  rects: number[],
  colors: number[],
  kinds: number[],
  angles: number[],
  uvs: number[],
  depths: number[] | undefined,
  depth: number,
  clips: number[] | undefined,
  clip: readonly [number, number, number, number]
) {
  const dx0 = bx - ax;
  const dy0 = by - ay;
  const dx1 = cx - bx;
  const dy1 = cy - by;
  const len0 = Math.hypot(dx0, dy0) || 1e-6;
  const len1 = Math.hypot(dx1, dy1) || 1e-6;
  const ux0 = dx0 / len0;
  const uy0 = dy0 / len0;
  const ux1 = dx1 / len1;
  const uy1 = dy1 / len1;
  const cross = ux0 * uy1 - uy0 * ux1;
  if (Math.abs(cross) < 1e-5) return;
  const thr = thickness > 0 ? thickness : SOA_WEBGL_LINE_THICKNESS;
  const half = thr / 2;
  // Outer side of the turn (opposite the left-normal).
  const outer = cross > 0 ? -1 : 1;
  const n0x = -uy0 * outer;
  const n0y = ux0 * outer;
  const n1x = -uy1 * outer;
  const n1y = ux1 * outer;
  const sx = n0x + n1x;
  const sy = n0y + n1y;
  const sl = Math.hypot(sx, sy);
  if (sl < 1e-6) return;
  // miterLen = half / cos(φ/2) = 2*half / |n0+n1|; cap like SVG miterLimit≈4.
  const miterLen = Math.min(thr * 4, (2 * half) / sl);
  const mx = bx + (sx / sl) * miterLen;
  const my = by + (sy / sl) * miterLen;
  const o0x = bx + n0x * half;
  const o0y = by + n0y * half;
  const o1x = bx + n1x * half;
  const o1y = by + n1y * half;
  const chord = Math.hypot(o0x - o1x, o0y - o1y);
  pushLineInstance(
    bx,
    by,
    mx,
    my,
    rgba,
    Math.max(thr, chord),
    rects,
    colors,
    kinds,
    angles,
    uvs,
    depths,
    depth,
    clips,
    clip
  );
}

/**
 * Emit crisp stroke quads along a densified polyline.
 * When `closeContours` is set, each finite run closes back to its first point
 * (boolean / evenodd holes use NaN breaks between contours).
 */
export function emitPathStrokeSegments(opts: {
  xy: Float32Array;
  start: number;
  len: number;
  ox?: number;
  oy?: number;
  rgba: [number, number, number, number];
  thickness: number;
  closeContours?: boolean;
  rects: number[];
  colors: number[];
  kinds: number[];
  angles: number[];
  uvs: number[];
  depths?: number[];
  depth: number;
  clips?: number[];
  paintClips: Array<readonly [number, number, number, number]>;
  maxSegs?: number;
}): number {
  const {
    xy,
    start,
    len,
    rgba,
    thickness,
    closeContours = false,
    rects,
    colors,
    kinds,
    angles,
    uvs,
    depths,
    depth,
    clips,
    paintClips,
  } = opts;
  const ox = opts.ox || 0;
  const oy = opts.oy || 0;
  const maxSegs = opts.maxSegs ?? SOA_WEBGL_PATH_MAX_SEGS;
  const base = start * 2;
  let contourFirst = -1;
  let lastFinite = -1;
  let emitted = 0;
  const emitSeg = (a: number, b: number) => {
    if (emitted >= maxSegs) return;
    for (const activeClip of paintClips) {
      pushLineInstance(
        xy[a] + ox,
        xy[a + 1] + oy,
        xy[b] + ox,
        xy[b + 1] + oy,
        rgba,
        thickness,
        rects,
        colors,
        kinds,
        angles,
        uvs,
        depths,
        depth,
        clips,
        activeClip,
      );
    }
    emitted += 1;
  };
  const endContour = () => {
    if (
      closeContours &&
      contourFirst >= 0 &&
      lastFinite >= 0 &&
      contourFirst !== lastFinite
    ) {
      emitSeg(lastFinite, contourFirst);
    }
    contourFirst = -1;
    lastFinite = -1;
  };
  for (let p = 0; p < len; p += 1) {
    const fo = base + p * 2;
    const px = xy[fo];
    const py = xy[fo + 1];
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      endContour();
      continue;
    }
    if (lastFinite < 0) {
      contourFirst = fo;
      lastFinite = fo;
      continue;
    }
    emitSeg(lastFinite, fo);
    lastFinite = fo;
  }
  endContour();
  return emitted;
}

function clearSoaDirtyFlag(buf: SceneRenderBuffer, index: number, flags: number, force: boolean) {
  if (!force) return;
  buf.flags[index] = (flags & ~SOA_FLAG_DIRTY) >>> 0;
}

export type CollectSoaWebglOpts = {
  atlas?: SoaWebglAtlas | null;
  bufferRevision?: number;
  /** Parallel depth [0,1] per instance when GPU DOF is active. */
  depths?: number[];
  depthForId?: (id: string) => number;
  /** Parallel scene-space LTRB clip per instance (clipContent artboards). */
  clips?: number[];
  /** Document for clip resolve; defaults to {@link getSoaPaintDocument}. */
  document?: SceneDocument | null;
  /** Camera zoom. */
  zoom?: number;
  /** Device pixel ratio (media stamps). */
  dpr?: number;
  /**
   * World idle ink: skip nodes with attrs.frameId (ArtboardLayer paints them).
   * Default false for tests / bake helpers that collect everything.
   * Ignored when {@link onlyFrameId} is set.
   */
  skipFrameBound?: boolean;
  /**
   * Artboard FO ink: only slots owned by this frame (and not selection-reveal).
   * World path leaves this unset and uses skipFrameBound instead.
   */
  onlyFrameId?: string;
  /** World-space vector fill/stroke triangle XY (flat). */
  meshPos?: number[];
  /** Per-vertex RGBA for meshPos. */
  meshCol?: number[];
  /** Per-vertex LTRB clip for meshPos. */
  meshClip?: number[];
};

/**
 * Pack visible SoA instances intersecting the view.
 * kinds: 0=rect, 1=ellipse, 2=open stroke segment, 3=atlas stamp.
 */
export function collectSoaWebglInstances(
  buf: SceneRenderBuffer,
  view: { left?: number; top?: number; x?: number; y?: number; width: number; height: number },
  rects: number[],
  colors: number[],
  kinds: number[],
  angles: number[] = [],
  uvs: number[] = [],
  opts?: CollectSoaWebglOpts
) {
  const atlas = opts?.atlas ?? null;
  const depthOut = opts?.depths;
  const depthForId = opts?.depthForId;
  const clips = opts?.clips;
  const paintDoc = opts?.document ?? getSoaPaintDocument();
  const zoom = Math.max(0.05, Number(opts?.zoom) || 1);
  const dpr = Math.max(1, Number(opts?.dpr) || 1);
  const onlyFrameId = String(opts?.onlyFrameId || '').trim();
  const skipFrameBound = !onlyFrameId && opts?.skipFrameBound === true;
  const meshPos = opts?.meshPos;
  const meshCol = opts?.meshCol;
  const meshClip = opts?.meshClip;
  const vl = view.left ?? view.x ?? 0;
  const vt = view.top ?? view.y ?? 0;
  const vr = vl + view.width;
  const vb = vt + view.height;

  // Buffer order ≠ stackOrder. Collect candidates then paint back→front so
  // selection max+1 and permanent z match Canvas2D idle / SVG data-z.
  const paintIndices: number[] = [];
  for (let i = 0; i < buf.count; i += 1) {
    const flags = buf.flags[i];
    if (!(flags & SOA_FLAG_VISIBLE) || !(flags & SOA_FLAG_CANVAS_IDLE)) continue;
    const idEarly = buf.ids[i];
    if (idEarly && getNodeTransformPreview(idEarly)?.hidden) continue;
    if (onlyFrameId && paintDoc && idEarly) {
      const node = paintDoc.deltaSetLike?.[idEarly];
      // Plate FO stays clipped; selection reveal → raised SVG host (max+1).
      // World ink is only a lag fallback while CANVAS_IDLE has not cleared yet.
      if (nodeOwnerFrameId(node) !== onlyFrameId || frameClipRevealsOverflow(idEarly)) continue;
    } else if (skipFrameBound && paintDoc && idEarly) {
      const node = paintDoc.deltaSetLike?.[idEarly];
      // Selection reveal: overflow may still be on SoA until host flags flip.
      if (nodeOwnerFrameId(node) && !frameClipRevealsOverflow(idEarly)) continue;
    }
    const kind = buf.kinds[i];
    if (
      kind !== SOA_KIND_RECT &&
      kind !== SOA_KIND_ELLIPSE &&
      kind !== SOA_KIND_LINE &&
      kind !== SOA_KIND_PATH &&
      kind !== SOA_KIND_POLY &&
      kind !== SOA_KIND_IMAGE &&
      kind !== SOA_KIND_TEXT
    ) {
      continue;
    }
    const { x, y, w, h } = resolveSoaPaintBox(buf, i);
    if (x + w < vl || y + h < vt || x > vr || y > vb) continue;
    paintIndices.push(i);
  }
  if (paintDoc && paintIndices.length > 1) {
    const zMap = buildNodeStackZMap(
      paintDoc,
      paintIndices.map((i) => buf.ids[i] || '')
    );
    const raisedZ = maxDocumentStackZ(paintDoc) + 1;
    paintIndices.sort((a, b) => {
      const idA = buf.ids[a] || '';
      const idB = buf.ids[b] || '';
      const za = selectionPaintRaises(idA) ? raisedZ : zMap.get(idA) || 0;
      const zb = selectionPaintRaises(idB) ? raisedZ : zMap.get(idB) || 0;
      return za - zb || (zMap.get(idA) || 0) - (zMap.get(idB) || 0) || a - b;
    });
  }

  for (const i of paintIndices) {
    const flags = buf.flags[i];
    const kind = buf.kinds[i];
    const { x, y, w, h, dx: odx, dy: ody } = resolveSoaPaintBox(buf, i);
    const rgba = argbToRgba(buf.colors[i]);
    const strokeRgba = soaWebglStrokeRgba(buf, i);
    const lineW = floorContentStrokeSceneWidth(soaStrokeWidth(buf, i), zoom);
    const pathMaxSegs = adaptivePathStrokeMaxSegs(zoom, SOA_WEBGL_PATH_MAX_SEGS);
    const forceStamp = (flags & SOA_FLAG_DIRTY) !== 0;
    const nodeId = buf.ids[i] || '';
    const id = nodeId;
    const slotDepth = depthForId ? depthForId(nodeId) : 0.5;
    const slotClip = resolveSoaWebglSlotClip(buf, i, paintDoc);
    const paintClips: Array<[number, number, number, number]> = [
      [slotClip[0], slotClip[1], slotClip[2], slotClip[3]],
    ];

    if (kind === SOA_KIND_IMAGE) {
      const node = paintDoc?.deltaSetLike?.[id];
      if (!node || !atlas) {
        clearSoaDirtyFlag(buf, i, flags, forceStamp);
        continue;
      }
      const isAudio = String(node.key || '') === 'audio';
      // Empty vs filled must not share atlas keys — otherwise a prior photo
      // stamp is cache-hit and the empty plate shows the old image colors.
      const mediaSrc = isAudio ? '' : mediaPaintSrc(node, id);
      const zBucket = atlasZoomBucket(zoom);
      // Always include zoomBucket so bucket changes force a new stamp (restamp).
      const atlasKey = isAudio
        ? `aud:${id}:z${zBucket}`
        : mediaSrc
          ? `img:${id}:z${zBucket}`
          : `img:${id}:empty:z${zBucket}`;
      const baked = isAudio
        ? bakeAudioInkForAtlas(node, w, h, zoom)
        : bakeMediaInkForAtlas(node, w, h, id, zoom);
      if (!baked) {
        const src = mediaSrc;
        // Pending decode → bump. CORS/tainted → stop retrying; host will paint.
        // Empty src should bake a plate — if bake still failed, clear dirty
        // (do not eternal-bump; that burned CPU and never drew).
        if (isAudio || !src || (src && isFillImageWebglUnsafe(src))) {
          clearSoaDirtyFlag(buf, i, flags, forceStamp);
        } else {
          bumpSceneCanvasIdlePaint();
        }
        continue;
      }
      const region = stampImageToAtlas(
        atlas,
        atlasKey,
        baked as CanvasImageSource,
        { left: x, top: y, width: w, height: h },
        { force: forceStamp }
      );
      if (region) {
        for (const activeClip of paintClips) {
          // Stamp world is already live x/y — never re-add odx/ody (ghost fill).
          pushAtlasRegionInstance(atlas, region, rects, colors, kinds, angles, uvs, 0, 0, 0);
          if (depthOut) depthOut.push(slotDepth);
          pushInstanceClip(clips, activeClip);
        }
        if (forceStamp) buf.flags[i] = (flags & ~SOA_FLAG_DIRTY) >>> 0;
      }
      continue;
    }

    if (kind === SOA_KIND_TEXT) {
      const node = paintDoc?.deltaSetLike?.[id];
      if (!node) {
        clearSoaDirtyFlag(buf, i, flags, forceStamp);
        continue;
      }
      const preview = id ? getNodeTransformPreview(id) : undefined;
      const liveAngle = Number.isFinite(preview?.angle)
        ? Number(preview!.angle)
        : Number(node.attrs?.angle) || 0;
      const paintNode =
        Number.isFinite(preview?.angle) &&
        Math.abs(liveAngle - (Number(node.attrs?.angle) || 0)) > 1e-4
          ? { ...node, attrs: { ...(node.attrs || {}), angle: liveAngle } }
          : node;
      ensureTextOutlineMesh(id, paintNode, {
        width: w,
        height: h,
        zoom,
        dpr: Math.max(1, Number(opts?.dpr) || 1),
      });
      const textMesh = getTextOutlineMesh(id, paintNode, {
        width: w,
        height: h,
        zoom,
        dpr: Math.max(1, Number(opts?.dpr) || 1),
      });
      if (textMesh?.fill && meshPos && meshCol && meshClip) {
        const opacity = parseLayerOpacity(paintNode.attrs?.opacity, 1);
        const fillRgba: [number, number, number, number] = [
          rgba[0],
          rgba[1],
          rgba[2],
          rgba[3] * opacity,
        ];
        if (fillRgba[3] > 0.01) {
          const rotOpts = {
            angleDeg: liveAngle,
            pivotW: w,
            pivotH: h,
          };
          for (const activeClip of paintClips) {
            appendMeshLocal(
              textMesh.fill.positions,
              x,
              y,
              fillRgba,
              activeClip,
              meshPos,
              meshCol,
              meshClip,
              rotOpts
            );
          }
        }
        if (forceStamp) buf.flags[i] = (flags & ~SOA_FLAG_DIRTY) >>> 0;
      }
      // No text atlas — wait for outline mesh (ensure already kicked).
      continue;
    }

    // All shape ink (closed fills + open strokes): GPU triangle meshes when
    // mesh buffers + document node exist. Without a node / mesh buffers,
    // RECT/ELLIPSE use kind 0/1 instances; LINE/PATH/POLY fall through to
    // kind 2 segment emitters — never swallow open strokes for missing docs.
    if (
      kind === SOA_KIND_RECT ||
      kind === SOA_KIND_ELLIPSE ||
      kind === SOA_KIND_PATH ||
      kind === SOA_KIND_POLY ||
      kind === SOA_KIND_LINE
    ) {
      const node = paintDoc?.deltaSetLike?.[id];
      if (node && meshPos && meshCol && meshClip) {
        const preview = id ? getNodeTransformPreview(id) : undefined;
        const liveAngle = Number.isFinite(preview?.angle)
          ? Number(preview!.angle)
          : Number(node.attrs?.angle) || 0;
        const paintNode =
          Number.isFinite(preview?.angle) &&
          Math.abs(liveAngle - (Number(node.attrs?.angle) || 0)) > 1e-4
            ? { ...node, attrs: { ...(node.attrs || {}), angle: liveAngle } }
            : node;
        const mesh = getOrBuildShapeMesh(id, paintNode, {
          width: w,
          height: h,
          zoom,
          dpr: Math.max(1, Number(opts?.dpr) || 1),
        });
        if (mesh) {
          const opacity = parseLayerOpacity(paintNode.attrs?.opacity, 1);
          const isPencil =
            String(paintNode.attrs?.shapeType || '').toLowerCase() === 'pencil';
          const fillRgba: [number, number, number, number] = [
            rgba[0],
            rgba[1],
            rgba[2],
            rgba[3] * opacity,
          ];
          const strokeBase = soaWebglStrokeRgba(buf, i);
          const strokeOut: [number, number, number, number] = [
            strokeBase[0],
            strokeBase[1],
            strokeBase[2],
            strokeBase[3] * opacity,
          ];
          const rotOpts = {
            angleDeg: liveAngle,
            pivotW: w,
            pivotH: h,
          };
          let wrote = 0;
          for (const activeClip of paintClips) {
            // Pencil silhouette is a fill mesh; ink color lives in strokeColors
            // (fill attrs are typically transparent for freehand).
            const fillCol =
              isPencil && mesh.fill && fillRgba[3] < 0.01 ? strokeOut : fillRgba;
            if (mesh.fill && fillCol[3] > 0.01) {
              wrote += appendMeshLocal(
                mesh.fill.positions,
                x,
                y,
                fillCol,
                activeClip,
                meshPos,
                meshCol,
                meshClip,
                rotOpts
              );
            }
            // Pencil uses silhouette fill only — skip uniform centerline ribbon.
            if (
              mesh.stroke &&
              lineW > 0 &&
              strokeOut[3] > 0.01 &&
              !(isPencil && mesh.fill)
            ) {
              wrote += appendMeshLocal(
                mesh.stroke.positions,
                x,
                y,
                strokeOut,
                activeClip,
                meshPos,
                meshCol,
                meshClip,
                rotOpts
              );
            }
          }
          if (wrote > 0) {
            if (forceStamp) buf.flags[i] = (flags & ~SOA_FLAG_DIRTY) >>> 0;
            continue;
          }
          // Mesh empty (e.g. transparent) — fall through to instance/segment fallback.
        }
      }
      // Fallback without mesh buffers: sharp rect/ellipse instances only.
      if (kind === SOA_KIND_RECT || kind === SOA_KIND_ELLIPSE) {
        const liveAngle = id ? getNodeTransformPreview(id)?.angle : undefined;
        let rotRad = 0;
        if (Number.isFinite(liveAngle) && Math.abs(Number(liveAngle)) > 0.5) {
          rotRad = (Number(liveAngle) * Math.PI) / 180;
        }
        const node = paintDoc?.deltaSetLike?.[id];
        const opacity = parseLayerOpacity(node?.attrs?.opacity, 1);
        const a = rgba[3] * opacity;
        for (const activeClip of paintClips) {
          rects.push(x, y, w, h);
          colors.push(rgba[0], rgba[1], rgba[2], a);
          kinds.push(kind === SOA_KIND_ELLIPSE ? 1 : 0);
          angles.push(rotRad);
          uvs.push(0, 0, 1, 1);
          if (depthOut) depthOut.push(slotDepth);
          pushInstanceClip(clips, activeClip);
        }
        clearSoaDirtyFlag(buf, i, flags, forceStamp);
        continue;
      }
      // PATH / LINE / POLY without mesh arrays: open stroke segments only (no atlas).
      if (kind === SOA_KIND_PATH || kind === SOA_KIND_LINE || kind === SOA_KIND_POLY) {
        // fall through to segment emitters below
      } else {
        clearSoaDirtyFlag(buf, i, flags, forceStamp);
        continue;
      }
    }

    if (kind === SOA_KIND_PATH) {
      const start = buf.pathStart[i];
      const len = buf.pathLen[i];
      if (start < 0 || len < 2) continue;
      const closed = buf.pathClosed[i] !== 0 || buf.colors[i] !== 0;
      const strokeW = Math.max(0, lineW);
      // Vector dual-backend: shape ink is mesh / Path2D — never atlas-stamped.
      // Closed fills without mesh cannot use stroke-only segments (border ghost).
      if (closed && buf.colors[i] !== 0) {
        if (forceStamp) buf.flags[i] = (flags & ~SOA_FLAG_DIRTY) >>> 0;
        continue;
      }
      emitPathStrokeSegments({
        xy: buf.pathXY,
        start,
        len,
        ox: odx,
        oy: ody,
        rgba: strokeRgba,
        thickness: strokeW > 0 ? strokeW : SOA_WEBGL_LINE_THICKNESS,
        closeContours: closed,
        rects,
        colors,
        kinds,
        angles,
        uvs,
        depths: depthOut,
        depth: slotDepth,
        clips,
        paintClips,
        maxSegs: pathMaxSegs,
      });
      if (forceStamp) buf.flags[i] = (flags & ~SOA_FLAG_DIRTY) >>> 0;
      continue;
    }

    if (kind === SOA_KIND_LINE) {
      // Fallback when mesh buffers unavailable (tests).
      const node = paintDoc?.deltaSetLike?.[id];
      const preview = id ? getNodeTransformPreview(id) : undefined;
      const liveAngle = Number.isFinite(preview?.angle)
        ? Number(preview!.angle)
        : Number(node?.attrs?.angle) || 0;
      const livePts =
        node &&
        sampleLineOrArrowWorldPolyline(node, x, y, w, h, liveAngle);
      if (livePts && livePts.length >= 2) {
        let emitted = 0;
        let prevA: { x: number; y: number } | null = null;
        for (let p = 1; p < livePts.length; p += 1) {
          if (emitted >= pathMaxSegs) break;
          const a = livePts[p - 1];
          const b = livePts[p];
          if (
            !a ||
            !b ||
            ![a.x, a.y, b.x, b.y].every(Number.isFinite)
          ) {
            prevA = null;
            continue;
          }
          for (const activeClip of paintClips) {
            pushLineInstance(
              a.x,
              a.y,
              b.x,
              b.y,
              strokeRgba,
              lineW,
              rects,
              colors,
              kinds,
              angles,
              uvs,
              depthOut,
              slotDepth,
              clips,
              activeClip,
            );
            if (prevA) {
              pushLineMiterJoin(
                prevA.x,
                prevA.y,
                a.x,
                a.y,
                b.x,
                b.y,
                strokeRgba,
                lineW,
                rects,
                colors,
                kinds,
                angles,
                uvs,
                depthOut,
                slotDepth,
                clips,
                activeClip,
              );
            }
          }
          emitted += 1;
          prevA = a;
        }
        if (forceStamp) buf.flags[i] = (flags & ~SOA_FLAG_DIRTY) >>> 0;
        continue;
      }
      const start = buf.pathStart[i];
      const len = buf.pathLen[i];
      if (start >= 0 && len >= 2) {
        const base = start * 2;
        let lastFinite = -1;
        let prevFinite = -1;
        let emitted = 0;
        const emitSeg = (a: number, b: number) => {
          if (emitted >= pathMaxSegs) return;
          for (const activeClip of paintClips) {
            pushLineInstance(
              buf.pathXY[a] + odx,
              buf.pathXY[a + 1] + ody,
              buf.pathXY[b] + odx,
              buf.pathXY[b + 1] + ody,
              strokeRgba,
              lineW,
              rects,
              colors,
              kinds,
              angles,
              uvs,
              depthOut,
              slotDepth,
              clips,
              activeClip,
            );
            if (prevFinite >= 0) {
              pushLineMiterJoin(
                buf.pathXY[prevFinite] + odx,
                buf.pathXY[prevFinite + 1] + ody,
                buf.pathXY[a] + odx,
                buf.pathXY[a + 1] + ody,
                buf.pathXY[b] + odx,
                buf.pathXY[b + 1] + ody,
                strokeRgba,
                lineW,
                rects,
                colors,
                kinds,
                angles,
                uvs,
                depthOut,
                slotDepth,
                clips,
                activeClip,
              );
            }
          }
          emitted += 1;
        };
        for (let p = 0; p < len; p += 1) {
          const fo = base + p * 2;
          const px = buf.pathXY[fo];
          const py = buf.pathXY[fo + 1];
          if (!Number.isFinite(px) || !Number.isFinite(py)) {
            lastFinite = -1;
            prevFinite = -1;
            continue;
          }
          if (lastFinite < 0) {
            lastFinite = fo;
            continue;
          }
          emitSeg(lastFinite, fo);
          prevFinite = lastFinite;
          lastFinite = fo;
        }
        if (forceStamp) buf.flags[i] = (flags & ~SOA_FLAG_DIRTY) >>> 0;
        continue;
      }
      const x1 = x + w;
      const y1 = y + h;
      for (const activeClip of paintClips) {
        pushLineInstance(
          x,
          y,
          x1,
          y1,
          strokeRgba,
          lineW,
          rects,
          colors,
          kinds,
          angles,
          uvs,
          depthOut,
          slotDepth,
          clips,
          activeClip,
        );
      }
      if (forceStamp) buf.flags[i] = (flags & ~SOA_FLAG_DIRTY) >>> 0;
      continue;
    }

    clearSoaDirtyFlag(buf, i, flags, forceStamp);
  }
}

/** WebGL ink for SoA vector meshes + media atlas stamps. */
export function createWebglSceneRenderer(
  deps: CanvasSceneRendererDeps
): SceneRenderer | null {
  const canvas = deps.canvas;
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    // Mesh stroke/fill edges need MSAA — antialias:false made 400% zoom look staircased.
    antialias: true,
  });
  if (!gl) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.error('[webgl] getContext(webgl2) returned null');
    }
    return null;
  }
  if (!isSoaCanvasShapesEnabled()) return null;

  const vs = compile(gl, gl.VERTEX_SHADER, VS);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FS);
  const prog = vs && fs ? link(gl, vs, fs) : null;
  const meshVs = compile(gl, gl.VERTEX_SHADER, MESH_VS);
  const meshFs = compile(gl, gl.FRAGMENT_SHADER, MESH_FS);
  const meshProg = meshVs && meshFs ? link(gl, meshVs, meshFs) : null;
  if (!prog || !vs || !fs) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.error('[webgl] ink program unavailable (compile/link failed)');
    }
    return null;
  }

  const vao = gl.createVertexArray();
  const meshVao = gl.createVertexArray();
  const meshPosBuf = gl.createBuffer();
  const meshColBuf = gl.createBuffer();
  const meshClipBuf = gl.createBuffer();
  const cornerBuf = gl.createBuffer();
  const rectBuf = gl.createBuffer();
  const colorBuf = gl.createBuffer();
  const kindBuf = gl.createBuffer();
  const angleBuf = gl.createBuffer();
  const uvBuf = gl.createBuffer();
  const clipBuf = gl.createBuffer();
  const depthBuf = gl.createBuffer();
  const atlasTex = gl.createTexture();
  let disposed = false;
  let instanceCap = 0;
  let atlasUploadedRevision = -1;
  let atlasBufferRevision = -1;
  let dofPass: WebglDepthOfFieldPass | null = null;
  let dofVao: WebGLVertexArrayObject | null = null;
  /** Scratch typed views — avoid per-frame `new Float32Array(arr)` GC. */
  let scratchRect = new Float32Array(0);
  let scratchColor = new Float32Array(0);
  let scratchKind = new Float32Array(0);
  let scratchAngle = new Float32Array(0);
  let scratchUv = new Float32Array(0);
  let scratchClip = new Float32Array(0);
  let scratchDepth = new Float32Array(0);

  function copyToScratch(src: ArrayLike<number>, prev: Float32Array): Float32Array {
    const n = src.length;
    const out = prev.length >= n ? prev : new Float32Array(Math.max(n, prev.length * 2 || 64));
    out.set(src, 0);
    return out;
  }

  function ensureDofPass(): WebglDepthOfFieldPass | null {
    if (dofPass) return dofPass;
    dofPass = createWebglDepthOfFieldPass(gl);
    if (!dofPass) return null;
    dofVao = gl.createVertexArray();
    gl.bindVertexArray(dofVao);
    bindWebglDofSceneAttributes(
      gl,
      cornerBuf,
      rectBuf,
      colorBuf,
      kindBuf,
      angleBuf,
      uvBuf,
      depthBuf,
      clipBuf,
    );
    gl.bindVertexArray(null);
    return dofPass;
  }

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
  gl.bufferData(gl.ARRAY_BUFFER, UNIT_QUAD, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, rectBuf);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(1, 1);

  gl.bindBuffer(gl.ARRAY_BUFFER, colorBuf);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(2, 1);

  gl.bindBuffer(gl.ARRAY_BUFFER, kindBuf);
  gl.enableVertexAttribArray(3);
  gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(3, 1);

  gl.bindBuffer(gl.ARRAY_BUFFER, angleBuf);
  gl.enableVertexAttribArray(4);
  gl.vertexAttribPointer(4, 1, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(4, 1);

  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
  gl.enableVertexAttribArray(5);
  gl.vertexAttribPointer(5, 4, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(5, 1);

  gl.bindBuffer(gl.ARRAY_BUFFER, clipBuf);
  gl.enableVertexAttribArray(6);
  gl.vertexAttribPointer(6, 4, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(6, 1);
  gl.bindVertexArray(null);

  if (meshProg && meshVao && meshPosBuf && meshColBuf && meshClipBuf) {
    gl.bindVertexArray(meshVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, meshPosBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, meshColBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, meshClipBuf);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  gl.bindTexture(gl.TEXTURE_2D, atlasTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
  gl.bindTexture(gl.TEXTURE_2D, null);

  function ensureInstanceCapacity(n: number) {
    if (n <= instanceCap) return;
    instanceCap = Math.max(1024, n * 2);
    gl.bindBuffer(gl.ARRAY_BUFFER, rectBuf);
    gl.bufferData(gl.ARRAY_BUFFER, instanceCap * 4 * 4, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuf);
    gl.bufferData(gl.ARRAY_BUFFER, instanceCap * 4 * 4, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, kindBuf);
    gl.bufferData(gl.ARRAY_BUFFER, instanceCap * 4, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, angleBuf);
    gl.bufferData(gl.ARRAY_BUFFER, instanceCap * 4, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, instanceCap * 4 * 4, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, clipBuf);
    gl.bufferData(gl.ARRAY_BUFFER, instanceCap * 4 * 4, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, depthBuf);
    gl.bufferData(gl.ARRAY_BUFFER, instanceCap * 4, gl.DYNAMIC_DRAW);
  }

  return {
    backend: 'webgl',
    render(req: SceneRenderRequest) {
      if (disposed) return;
      const dpr = req.dpr && req.dpr > 0 ? req.dpr : 1;
      const sw = Math.max(1, req.stage.width);
      const sh = Math.max(1, req.stage.height);
      const bw = Math.max(1, Math.round(sw * dpr));
      const bh = Math.max(1, Math.round(sh * dpr));
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      canvas.style.width = `${sw}px`;
      canvas.style.height = `${sh}px`;

      const useDof = shouldRunGpuDepthOfField();
      const dof = useDof ? ensureDofPass() : null;
      if (dof) dof.resize(bw, bh);

      if (dof) {
        dof.bindSceneFbo();
      } else {
        gl.viewport(0, 0, bw, bh);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.enable(gl.BLEND);
      // Premultiplied fragment output (see SOA_WEBGL_*_FS).
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      const z = rcbCameraCssZoom(req.camera);
      const pan = rcbCameraScreenOffset(req.camera, dpr);
      const view = rcbViewportSceneBounds(req.camera, { width: sw, height: sh }, dpr);
      const buf = getSharedSceneRenderBuffer();
      setSoaPaintDocument(req.document);
      const atlas = ensureSharedSoaWebglAtlas();
      if (!atlas) {
        throw new Error('SoA WebGL atlas unavailable — atlas is required for product ink');
      }
      if (atlasBufferRevision !== buf.revision) {
        // Drop orphans; dirty path/round stamps restamp in-place via force.
        pruneSoaAtlasForBuffer(atlas, buf);
        releaseSoaAtlasPrefix(atlas, 'bake:');
        atlasBufferRevision = buf.revision;
        atlasUploadedRevision = -1;
      }
      const rects: number[] = [];
      const colors: number[] = [];
      const kinds: number[] = [];
      const angles: number[] = [];
      const uvs: number[] = [];
      const clips: number[] = [];
      const depths: number[] = [];

      let depthLookup: ReturnType<typeof buildNormalizedDepthLookup> | null = null;
      if (useDof) {
        const ids: string[] = [];
        for (let i = 0; i < buf.count; i += 1) {
          const id = buf.ids[i];
          if (id) ids.push(id);
        }
        depthLookup = buildNormalizedDepthLookup(req.document, ids);
      }

      const meshPos: number[] = [];
      const meshCol: number[] = [];
      const meshClipArr: number[] = [];
      // Vector dual-backend: skip shape bake tiles; draw live instances + meshes.
      collectSoaWebglInstances(buf, view, rects, colors, kinds, angles, uvs, {
        atlas,
        bufferRevision: buf.revision,
        depths: useDof ? depths : undefined,
        depthForId: depthLookup ? (id) => depthLookup!.depthForId(id) : undefined,
        clips,
        document: req.document,
        zoom: z,
        dpr,
        skipFrameBound: true,
        meshPos,
        meshCol,
        meshClip: meshClipArr,
      });
      const count = kinds.length;
      const meshVertCount = Math.floor(meshPos.length / 2);
      if (!count && meshVertCount < 3) {
        if (dof) {
          dof.unbindSceneFbo();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, bw, bh);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
        }
        return;
      }

      if (count > 0) {
      ensureInstanceCapacity(count);
      scratchRect = copyToScratch(rects, scratchRect);
      scratchColor = copyToScratch(colors, scratchColor);
      scratchKind = copyToScratch(kinds, scratchKind);
      scratchAngle = copyToScratch(angles, scratchAngle);
      scratchUv = copyToScratch(uvs, scratchUv);
      gl.bindBuffer(gl.ARRAY_BUFFER, rectBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, scratchRect.subarray(0, rects.length));
      gl.bindBuffer(gl.ARRAY_BUFFER, colorBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, scratchColor.subarray(0, colors.length));
      gl.bindBuffer(gl.ARRAY_BUFFER, kindBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, scratchKind.subarray(0, kinds.length));
      gl.bindBuffer(gl.ARRAY_BUFFER, angleBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, scratchAngle.subarray(0, angles.length));
      gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, scratchUv.subarray(0, uvs.length));
      const clipFill =
        clips.length === count * 4
          ? clips
          : Array.from({ length: count * 4 }, (_, i) => SOA_WEBGL_NO_CLIP[i % 4]);
      scratchClip = copyToScratch(clipFill, scratchClip);
      gl.bindBuffer(gl.ARRAY_BUFFER, clipBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, scratchClip.subarray(0, count * 4));
      if (useDof) {
        const depthFill =
          depths.length === count
            ? depths
            : Array.from({ length: count }, () => 0.5);
        scratchDepth = copyToScratch(depthFill, scratchDepth);
        gl.bindBuffer(gl.ARRAY_BUFFER, depthBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, scratchDepth.subarray(0, count));
      }

      if (atlas.revision !== atlasUploadedRevision) {
        gl.bindTexture(gl.TEXTURE_2D, atlasTex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
        try {
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            atlas.canvas as TexImageSource
          );
          atlasUploadedRevision = atlas.revision;
        } catch {
          // Tainted atlas (cross-origin draw without CORS). Replace surface so
          // later stamps can recover; this frame draws with the last good tex.
          recreateSharedSoaWebglAtlas();
          atlasUploadedRevision = -1;
        }
      }

      const drawProg = dof ? dof.sceneProgram : prog;
      gl.useProgram(drawProg);
      gl.uniform2f(gl.getUniformLocation(drawProg, 'uPan'), pan.x, pan.y);
      gl.uniform1f(gl.getUniformLocation(drawProg, 'uZoom'), z);
      gl.uniform2f(gl.getUniformLocation(drawProg, 'uStage'), sw, sh);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, atlasTex);
      gl.uniform1i(gl.getUniformLocation(drawProg, 'uAtlas'), 0);
      gl.bindVertexArray(useDof && dofVao ? dofVao : vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
      gl.bindVertexArray(null);
      }

      if (meshVertCount >= 3 && meshProg) {
        gl.useProgram(meshProg);
        gl.uniform2f(gl.getUniformLocation(meshProg, 'uPan'), pan.x, pan.y);
        gl.uniform1f(gl.getUniformLocation(meshProg, 'uZoom'), z);
        gl.uniform2f(gl.getUniformLocation(meshProg, 'uStage'), sw, sh);
        gl.bindVertexArray(meshVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, meshPosBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(meshPos), gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, meshColBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(meshCol), gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, meshClipBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(meshClipArr), gl.DYNAMIC_DRAW);
        gl.drawArrays(gl.TRIANGLES, 0, meshVertCount);
        gl.bindVertexArray(null);
      }

      if (dof) {
        dof.unbindSceneFbo();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, bw, bh);
        dof.compositeToScreen();
      }
    },
    hitTest(point, screen) {
      return hitTestWithSpatialIndex(deps, point, screen);
    },
    dispose() {
      disposed = true;
      dofPass?.dispose();
      dofPass = null;
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (meshProg) gl.deleteProgram(meshProg);
      if (meshVs) gl.deleteShader(meshVs);
      if (meshFs) gl.deleteShader(meshFs);
      gl.deleteBuffer(cornerBuf);
      gl.deleteBuffer(rectBuf);
      gl.deleteBuffer(colorBuf);
      gl.deleteBuffer(kindBuf);
      gl.deleteBuffer(angleBuf);
      gl.deleteBuffer(uvBuf);
      gl.deleteBuffer(clipBuf);
      gl.deleteBuffer(depthBuf);
      if (meshPosBuf) gl.deleteBuffer(meshPosBuf);
      if (meshColBuf) gl.deleteBuffer(meshColBuf);
      if (meshClipBuf) gl.deleteBuffer(meshClipBuf);
      gl.deleteTexture(atlasTex);
      gl.deleteVertexArray(vao);
      if (meshVao) gl.deleteVertexArray(meshVao);
      if (dofVao) gl.deleteVertexArray(dofVao);
    },
  };
}
