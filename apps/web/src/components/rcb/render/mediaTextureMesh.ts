/**
 * Per-node WebGL textures for idle media (image / video poster / audio plate).
 * Replaces shared atlas stamps: bake once → textured quad mesh (no zoomBucket restamp).
 */
import type { SceneNodeInput } from '@/components/rcb/sceneNode';
import { atlasZoomBucket } from '@/components/rcb/render/webglInstanceAtlas';
import { mediaPaintSrc } from '@/components/rcb/render/sceneRenderer';
import { radiiFromAttrs } from '@/components/rcb/scene/document/sceneRadii';
import type { AppendMeshLocalOpts } from '@/components/rcb/render/vector/appendMesh';

function cropFingerprint(node: SceneNodeInput): string {
  const fx = Number(node?.attrs?.cropX);
  const fy = Number(node?.attrs?.cropY);
  const fw = Number(node?.attrs?.cropW);
  const fh = Number(node?.attrs?.cropH);
  if (
    Number.isFinite(fx) &&
    Number.isFinite(fy) &&
    Number.isFinite(fw) &&
    Number.isFinite(fh) &&
    fw > 0 &&
    fh > 0 &&
    (fx !== 0 || fy !== 0 || fw !== 1 || fh !== 1)
  ) {
    return `c${fx.toFixed(4)},${fy.toFixed(4)},${fw.toFixed(4)},${fh.toFixed(4)}`;
  }
  return 'cfull';
}

/** Textured media quad vertex shader (world + artboard FO). */
export const SOA_WEBGL_TEX_MESH_VS = `#version 300 es
precision mediump float;
uniform vec2 uPan;
uniform float uZoom;
uniform vec2 uStage;
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aUv;
layout(location = 2) in vec4 aColor;
layout(location = 3) in vec4 aClip;
out vec2 vUv;
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
  vUv = aUv;
  vColor = aColor;
  vWorld = aPos;
  vClip = aClip;
}`;

/** Sample per-node texture; premultiply for ONE / ONE_MINUS_SRC_ALPHA. */
export const SOA_WEBGL_TEX_MESH_FS = `#version 300 es
precision mediump float;
uniform sampler2D uTex;
in vec2 vUv;
in vec4 vColor;
in vec2 vWorld;
in vec4 vClip;
out vec4 outColor;
void main() {
  if (vWorld.x < vClip.x || vWorld.y < vClip.y || vWorld.x > vClip.z || vWorld.y > vClip.w) {
    discard;
  }
  vec4 tex = texture(uTex, vUv);
  if (tex.a < 0.01) discard;
  float a = tex.a * vColor.a;
  // Bake uploads with UNPACK_PREMULTIPLY; straight→premul if not.
  outColor = vec4(tex.rgb * vColor.a, a);
}`;

export type MediaTexDraw = {
  nodeId: string;
  fingerprint: string;
  source: TexImageSource;
  force?: boolean;
  vertStart: number;
  vertCount: number;
};

export type MediaTexBatch = {
  pos: number[];
  uv: number[];
  col: number[];
  clip: number[];
  draws: MediaTexDraw[];
};

export function createMediaTexBatch(): MediaTexBatch {
  return { pos: [], uv: [], col: [], clip: [], draws: [] };
}

type TexEntry = {
  fingerprint: string;
  tex: WebGLTexture;
};

const caches = new WeakMap<WebGL2RenderingContext, Map<string, TexEntry>>();
const lruByGl = new WeakMap<WebGL2RenderingContext, string[]>();
const MEDIA_TEX_MAX = 256;

function cacheFor(gl: WebGL2RenderingContext): Map<string, TexEntry> {
  let m = caches.get(gl);
  if (!m) {
    m = new Map();
    caches.set(gl, m);
  }
  return m;
}

function lruFor(gl: WebGL2RenderingContext): string[] {
  let l = lruByGl.get(gl);
  if (!l) {
    l = [];
    lruByGl.set(gl, l);
  }
  return l;
}

function touch(gl: WebGL2RenderingContext, nodeId: string) {
  const lru = lruFor(gl);
  const i = lru.indexOf(nodeId);
  if (i >= 0) lru.splice(i, 1);
  lru.push(nodeId);
}

function evictOne(gl: WebGL2RenderingContext): boolean {
  const lru = lruFor(gl);
  const map = cacheFor(gl);
  const drop = lru.shift();
  if (!drop) return false;
  const e = map.get(drop);
  if (e) {
    gl.deleteTexture(e.tex);
    map.delete(drop);
  }
  return true;
}

/** Content key for texture upload — filled bitmaps ignore zoom; empty/audio include bucket. */
export function mediaTextureFingerprint(
  node: SceneNodeInput,
  nodeId: string,
  width: number,
  height: number,
  zoom = 1
): string {
  const id = String(nodeId || node.id || '').trim() || 'unknown';
  const key = String(node.key || '');
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (key === 'audio') {
    return `aud:${id}:z${atlasZoomBucket(zoom)}:w${w}:h${h}`;
  }
  const src = mediaPaintSrc(node, id);
  if (!src) {
    return `img:${id}:empty:z${atlasZoomBucket(zoom)}:w${w}:h${h}`;
  }
  const cropPart = cropFingerprint(node);
  const r = radiiFromAttrs(node.attrs);
  const radPart = `r${Number(r.tl) || 0},${Number(r.tr) || 0},${Number(r.br) || 0},${Number(r.bl) || 0}`;
  // Cap src length so fingerprints stay small.
  const srcPart = src.length > 120 ? `${src.slice(0, 100)}#${src.length}` : src;
  return `img:${id}:${srcPart}:${cropPart}:${radPart}:w${w}:h${h}`;
}

/**
 * Append a local-space textured unit quad (two tris) into media batch buffers.
 * UV: (0,0)=top-left of bake, (1,1)=bottom-right — matches atlas stamp convention.
 */
export function appendTexturedMediaQuad(
  width: number,
  height: number,
  ox: number,
  oy: number,
  rgba: readonly [number, number, number, number],
  clip: readonly [number, number, number, number] | null | undefined,
  batch: MediaTexBatch,
  opts?: AppendMeshLocalOpts
): number {
  const w = Math.max(1e-6, Number(width) || 0);
  const h = Math.max(1e-6, Number(height) || 0);
  const c0 = clip?.[0] ?? -1e8;
  const c1 = clip?.[1] ?? -1e8;
  const c2 = clip?.[2] ?? 1e8;
  const c3 = clip?.[3] ?? 1e8;
  const angleDeg = Number(opts?.angleDeg) || 0;
  const hasRot = Math.abs(angleDeg) > 0.5;
  const pw = Math.max(0, Number(opts?.pivotW) || w);
  const ph = Math.max(0, Number(opts?.pivotH) || h);
  const px = Number.isFinite(opts?.pivotX) ? Number(opts!.pivotX) : pw * 0.5;
  const py = Number.isFinite(opts?.pivotY) ? Number(opts!.pivotY) : ph * 0.5;
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const corners: Array<[number, number, number, number]> = [
    [0, 0, 0, 0],
    [w, 0, 1, 0],
    [w, h, 1, 1],
    [0, 0, 0, 0],
    [w, h, 1, 1],
    [0, h, 0, 1],
  ];

  let n = 0;
  for (const [lx0, ly0, u, v] of corners) {
    let lx = lx0;
    let ly = ly0;
    if (hasRot) {
      const dx = lx - px;
      const dy = ly - py;
      lx = px + cos * dx - sin * dy;
      ly = py + sin * dx + cos * dy;
    }
    batch.pos.push(lx + ox, ly + oy);
    batch.uv.push(u, v);
    batch.col.push(rgba[0], rgba[1], rgba[2], rgba[3]);
    batch.clip.push(c0, c1, c2, c3);
    n += 1;
  }
  return n;
}

export function getOrUploadMediaNodeTexture(
  gl: WebGL2RenderingContext,
  nodeId: string,
  fingerprint: string,
  source: TexImageSource,
  opts?: { force?: boolean }
): WebGLTexture | null {
  const id = String(nodeId || '').trim();
  if (!id || !source) return null;
  const map = cacheFor(gl);
  const hit = map.get(id);
  if (hit && hit.fingerprint === fingerprint && !opts?.force) {
    touch(gl, id);
    return hit.tex;
  }

  let tex = hit?.tex ?? null;
  if (!tex) {
    while (map.size >= MEDIA_TEX_MAX && evictOne(gl)) {
      /* evict */
    }
    tex = gl.createTexture();
    if (!tex) return null;
  }

  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  } catch {
    if (!hit) gl.deleteTexture(tex);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return null;
  }
  gl.bindTexture(gl.TEXTURE_2D, null);

  map.set(id, { fingerprint, tex });
  touch(gl, id);
  return tex;
}

export function pruneMediaNodeTextures(
  gl: WebGL2RenderingContext,
  keepIds: Iterable<string>
): number {
  const keep = new Set([...keepIds].map((x) => String(x || '').trim()).filter(Boolean));
  const map = cacheFor(gl);
  const lru = lruFor(gl);
  let n = 0;
  for (const id of [...map.keys()]) {
    if (keep.has(id)) continue;
    const e = map.get(id);
    if (e) gl.deleteTexture(e.tex);
    map.delete(id);
    const i = lru.indexOf(id);
    if (i >= 0) lru.splice(i, 1);
    n += 1;
  }
  return n;
}

export function disposeAllMediaNodeTextures(gl: WebGL2RenderingContext): void {
  const map = cacheFor(gl);
  for (const e of map.values()) gl.deleteTexture(e.tex);
  map.clear();
  lruByGl.set(gl, []);
}

export function drawMediaTexBatch(
  gl: WebGL2RenderingContext,
  prog: WebGLProgram,
  vao: WebGLVertexArrayObject,
  posBuf: WebGLBuffer,
  uvBuf: WebGLBuffer,
  colBuf: WebGLBuffer,
  clipBuf: WebGLBuffer,
  batch: MediaTexBatch,
  uniforms: { panX: number; panY: number; zoom: number; stageW: number; stageH: number }
): void {
  if (!batch.draws.length || batch.pos.length < 6) return;
  gl.useProgram(prog);
  gl.uniform2f(gl.getUniformLocation(prog, 'uPan'), uniforms.panX, uniforms.panY);
  gl.uniform1f(gl.getUniformLocation(prog, 'uZoom'), uniforms.zoom);
  gl.uniform2f(gl.getUniformLocation(prog, 'uStage'), uniforms.stageW, uniforms.stageH);
  gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(batch.pos), gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(batch.uv), gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(batch.col), gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, clipBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(batch.clip), gl.DYNAMIC_DRAW);

  gl.activeTexture(gl.TEXTURE0);
  for (const d of batch.draws) {
    const tex = getOrUploadMediaNodeTexture(gl, d.nodeId, d.fingerprint, d.source, {
      force: d.force,
    });
    if (!tex) continue;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.drawArrays(gl.TRIANGLES, d.vertStart, d.vertCount);
  }
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.bindVertexArray(null);
}
