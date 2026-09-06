/**
 * Shared WebGL2 painter for artboard FO ink (ADR 0027).
 * One GL context → draw plate-bound SoA/mesh → blit to each FO canvas (2D).
 * Keeps stackOrder / FO interleave; does not merge plate ink into world GL.
 */
import {
  getSharedSceneRenderBuffer,
  isSoaCanvasShapesEnabled,
  setSoaPaintDocument,
} from '@/components/rcb/render/sceneRenderBuffer';
import {
  ensureSharedSoaWebglAtlas,
  recreateSharedSoaWebglAtlas,
} from '@/components/rcb/render/webglInstanceAtlas';
import {
  collectSoaWebglInstances,
  compileSoaWebglShader,
  linkSoaWebglProgram,
  SOA_WEBGL_INK_FS,
  SOA_WEBGL_INK_VS,
  SOA_WEBGL_MESH_FS,
  SOA_WEBGL_MESH_VS,
  SOA_WEBGL_NO_CLIP,
  SOA_WEBGL_UNIT_QUAD,
  soaWebglInkShadersOk,
} from '@/components/rcb/render/webglSceneRenderer';
import {
  createMediaTexBatch,
  disposeAllMediaNodeTextures,
  drawMediaTexBatch,
  pruneMediaNodeTextures,
  SOA_WEBGL_TEX_MESH_FS,
  SOA_WEBGL_TEX_MESH_VS,
} from '@/components/rcb/render/mediaTextureMesh';
import {
  ensureSharedMsdfAtlas,
  MSDF_ATLAS_SIZE,
  MSDF_PX_RANGE,
} from '@/components/rcb/render/vector/textMsdfAtlas';
import type { SceneDocument } from '@/components/rcb/sceneNode';
import { releaseArtboardTileCache } from '@/components/rcb/frames/artboardInkTiles';

type ArtboardGlResources = {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  prog: WebGLProgram;
  meshProg: WebGLProgram | null;
  texProg: WebGLProgram | null;
  vao: WebGLVertexArrayObject;
  meshVao: WebGLVertexArrayObject | null;
  texVao: WebGLVertexArrayObject | null;
  cornerBuf: WebGLBuffer;
  rectBuf: WebGLBuffer;
  colorBuf: WebGLBuffer;
  kindBuf: WebGLBuffer;
  angleBuf: WebGLBuffer;
  uvBuf: WebGLBuffer;
  clipBuf: WebGLBuffer;
  meshPosBuf: WebGLBuffer | null;
  meshColBuf: WebGLBuffer | null;
  meshClipBuf: WebGLBuffer | null;
  meshEdgeBuf: WebGLBuffer | null;
  texPosBuf: WebGLBuffer | null;
  texUvBuf: WebGLBuffer | null;
  texColBuf: WebGLBuffer | null;
  texClipBuf: WebGLBuffer | null;
  atlasTex: WebGLTexture;
  msdfTex: WebGLTexture;
  instanceCap: number;
  atlasUploadedRevision: number;
  atlasBufferRevision: number;
  msdfUploadedRevision: number;
  scratchRect: Float32Array;
  scratchColor: Float32Array;
  scratchKind: Float32Array;
  scratchAngle: Float32Array;
  scratchUv: Float32Array;
  scratchClip: Float32Array;
};

let shared: ArtboardGlResources | null = null;
let sharedFailed = false;

function copyToScratch(src: ArrayLike<number>, prev: Float32Array): Float32Array {
  const n = src.length;
  const out = prev.length >= n ? prev : new Float32Array(Math.max(n, prev.length * 2 || 64));
  out.set(src, 0);
  return out;
}

function ensureInstanceCapacity(res: ArtboardGlResources, n: number) {
  if (n <= res.instanceCap) return;
  const gl = res.gl;
  res.instanceCap = Math.max(1024, n * 2);
  gl.bindBuffer(gl.ARRAY_BUFFER, res.rectBuf);
  gl.bufferData(gl.ARRAY_BUFFER, res.instanceCap * 4 * 4, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, res.colorBuf);
  gl.bufferData(gl.ARRAY_BUFFER, res.instanceCap * 4 * 4, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, res.kindBuf);
  gl.bufferData(gl.ARRAY_BUFFER, res.instanceCap * 4, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, res.angleBuf);
  gl.bufferData(gl.ARRAY_BUFFER, res.instanceCap * 4, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, res.uvBuf);
  gl.bufferData(gl.ARRAY_BUFFER, res.instanceCap * 4 * 4, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, res.clipBuf);
  gl.bufferData(gl.ARRAY_BUFFER, res.instanceCap * 4 * 4, gl.DYNAMIC_DRAW);
}

function createSharedArtboardGl(): ArtboardGlResources | null {
  if (typeof document === 'undefined') return null;
  if (!isSoaCanvasShapesEnabled() || !soaWebglInkShadersOk()) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  if (!gl) return null;

  const vs = compileSoaWebglShader(gl, gl.VERTEX_SHADER, SOA_WEBGL_INK_VS);
  const fs = compileSoaWebglShader(gl, gl.FRAGMENT_SHADER, SOA_WEBGL_INK_FS);
  const prog = vs && fs ? linkSoaWebglProgram(gl, vs, fs) : null;
  const meshVs = compileSoaWebglShader(gl, gl.VERTEX_SHADER, SOA_WEBGL_MESH_VS);
  const meshFs = compileSoaWebglShader(gl, gl.FRAGMENT_SHADER, SOA_WEBGL_MESH_FS);
  const meshProg = meshVs && meshFs ? linkSoaWebglProgram(gl, meshVs, meshFs) : null;
  const texVs = compileSoaWebglShader(gl, gl.VERTEX_SHADER, SOA_WEBGL_TEX_MESH_VS);
  const texFs = compileSoaWebglShader(gl, gl.FRAGMENT_SHADER, SOA_WEBGL_TEX_MESH_FS);
  const texProg = texVs && texFs ? linkSoaWebglProgram(gl, texVs, texFs) : null;
  if (!prog) return null;

  const vao = gl.createVertexArray();
  const meshVao = gl.createVertexArray();
  const texVao = gl.createVertexArray();
  const cornerBuf = gl.createBuffer();
  const rectBuf = gl.createBuffer();
  const colorBuf = gl.createBuffer();
  const kindBuf = gl.createBuffer();
  const angleBuf = gl.createBuffer();
  const uvBuf = gl.createBuffer();
  const clipBuf = gl.createBuffer();
  const meshPosBuf = gl.createBuffer();
  const meshColBuf = gl.createBuffer();
  const meshClipBuf = gl.createBuffer();
  const meshEdgeBuf = gl.createBuffer();
  const texPosBuf = gl.createBuffer();
  const texUvBuf = gl.createBuffer();
  const texColBuf = gl.createBuffer();
  const texClipBuf = gl.createBuffer();
  const atlasTex = gl.createTexture();
  const msdfTex = gl.createTexture();
  if (
    !vao ||
    !cornerBuf ||
    !rectBuf ||
    !colorBuf ||
    !kindBuf ||
    !angleBuf ||
    !uvBuf ||
    !clipBuf ||
    !atlasTex ||
    !msdfTex
  ) {
    return null;
  }

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
  gl.bufferData(gl.ARRAY_BUFFER, SOA_WEBGL_UNIT_QUAD, gl.STATIC_DRAW);
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

  if (meshProg && meshVao && meshPosBuf && meshColBuf && meshClipBuf && meshEdgeBuf) {
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
    gl.bindBuffer(gl.ARRAY_BUFFER, meshEdgeBuf);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  if (texProg && texVao && texPosBuf && texUvBuf && texColBuf && texClipBuf) {
    gl.bindVertexArray(texVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, texPosBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, texUvBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, texColBuf);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, texClipBuf);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  gl.bindTexture(gl.TEXTURE_2D, atlasTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([0, 0, 0, 0])
  );
  gl.bindTexture(gl.TEXTURE_2D, msdfTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([128, 128, 128, 255])
  );
  gl.bindTexture(gl.TEXTURE_2D, null);

  return {
    canvas,
    gl,
    prog,
    meshProg,
    texProg,
    vao,
    meshVao: meshProg ? meshVao : null,
    texVao: texProg ? texVao : null,
    cornerBuf,
    rectBuf,
    colorBuf,
    kindBuf,
    angleBuf,
    uvBuf,
    clipBuf,
    meshPosBuf: meshProg ? meshPosBuf : null,
    meshColBuf: meshProg ? meshColBuf : null,
    meshClipBuf: meshProg ? meshClipBuf : null,
    meshEdgeBuf: meshProg ? meshEdgeBuf : null,
    texPosBuf: texProg ? texPosBuf : null,
    texUvBuf: texProg ? texUvBuf : null,
    texColBuf: texProg ? texColBuf : null,
    texClipBuf: texProg ? texClipBuf : null,
    atlasTex,
    msdfTex,
    instanceCap: 0,
    atlasUploadedRevision: -1,
    atlasBufferRevision: -1,
    msdfUploadedRevision: -1,
    scratchRect: new Float32Array(0),
    scratchColor: new Float32Array(0),
    scratchKind: new Float32Array(0),
    scratchAngle: new Float32Array(0),
    scratchUv: new Float32Array(0),
    scratchClip: new Float32Array(0),
  };
}

function getSharedArtboardGl(): ArtboardGlResources | null {
  if (sharedFailed) return null;
  if (shared) return shared;
  shared = createSharedArtboardGl();
  if (!shared) sharedFailed = true;
  return shared;
}

/** True when plate idle can use shared SoA WebGL (same mesh path as world). */
export function artboardWebglInkAvailable(): boolean {
  return Boolean(getSharedArtboardGl());
}

export type PaintArtboardWebglInkArgs = {
  targetCanvas: HTMLCanvasElement;
  frameId: string;
  frame: { x: number; y: number; width: number; height: number };
  document: SceneDocument;
  /** Scene→backing scale (after MAX_EDGE clamp). */
  effectiveScale: number;
  dpr?: number;
  /**
   * Optional plate-local region (tile). When set, collect/pan cover only that
   * AABB so the target canvas maps 1:1 to the region at effectiveScale.
   */
  plateLocalView?: { left: number; top: number; width: number; height: number };
};

/**
 * Clear shared GL → collect onlyFrameId → draw with plate-local uniforms →
 * blit onto the FO display canvas (keeps 2D context on the FO element).
 */
export function paintArtboardWebglInk(args: PaintArtboardWebglInkArgs): boolean {
  const res = getSharedArtboardGl();
  if (!res) return false;

  const w = Math.max(1, Number(args.frame.width) || 1);
  const h = Math.max(1, Number(args.frame.height) || 1);
  const fx = Number(args.frame.x) || 0;
  const fy = Number(args.frame.y) || 0;
  const scale = Math.max(1e-6, Number(args.effectiveScale) || 1);
  const dpr = Math.max(1, Number(args.dpr) || 1);
  const local = args.plateLocalView;
  const regionLeft = local ? Math.max(0, local.left) : 0;
  const regionTop = local ? Math.max(0, local.top) : 0;
  const regionW = local ? Math.max(1e-6, local.width) : w;
  const regionH = local ? Math.max(1e-6, local.height) : h;
  const bw = Math.max(1, args.targetCanvas.width);
  const bh = Math.max(1, args.targetCanvas.height);

  const gl = res.gl;
  if (res.canvas.width !== bw || res.canvas.height !== bh) {
    res.canvas.width = bw;
    res.canvas.height = bh;
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, bw, bh);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  setSoaPaintDocument(args.document);
  const buf = getSharedSceneRenderBuffer();
  const atlas = ensureSharedSoaWebglAtlas();
  if (!atlas) return false;

  if (res.atlasBufferRevision !== buf.revision) {
    res.atlasBufferRevision = buf.revision;
    res.atlasUploadedRevision = -1;
  }

  const rects: number[] = [];
  const colors: number[] = [];
  const kinds: number[] = [];
  const angles: number[] = [];
  const uvs: number[] = [];
  const clips: number[] = [];
  const meshPos: number[] = [];
  const meshCol: number[] = [];
  const meshClipArr: number[] = [];
  const meshEdgeArr: number[] = [];
  const mediaTex = createMediaTexBatch();

  // World view for collect = plate origin + plate-local region.
  const viewLeft = fx + regionLeft;
  const viewTop = fy + regionTop;
  // Plate-local via pan: screen = world * scale + (-viewOrigin)*scale.
  // screen is in *backing* px (same as 2D setTransform(scale)); uStage must match
  // (bw,bh) — using plate CSS (w,h) mis-projects whenever scale ≠ 1 (zoom drift).
  collectSoaWebglInstances(
    buf,
    { left: viewLeft, top: viewTop, width: regionW, height: regionH },
    rects,
    colors,
    kinds,
    angles,
    uvs,
    {
      atlas,
      bufferRevision: buf.revision,
      clips,
      document: args.document,
      zoom: scale,
      dpr,
      onlyFrameId: args.frameId,
      meshPos,
      meshCol,
      meshClip: meshClipArr,
      meshEdge: meshEdgeArr,
      mediaTex,
    }
  );

  const count = kinds.length;
  const meshVertCount = Math.floor(meshPos.length / 2);
  const mediaVertCount = Math.floor(mediaTex.pos.length / 2);
  const panX = -viewLeft * scale;
  const panY = -viewTop * scale;
  const stageW = bw;
  const stageH = bh;

  if (count > 0) {
    ensureInstanceCapacity(res, count);
    res.scratchRect = copyToScratch(rects, res.scratchRect);
    res.scratchColor = copyToScratch(colors, res.scratchColor);
    res.scratchKind = copyToScratch(kinds, res.scratchKind);
    res.scratchAngle = copyToScratch(angles, res.scratchAngle);
    res.scratchUv = copyToScratch(uvs, res.scratchUv);
    gl.bindBuffer(gl.ARRAY_BUFFER, res.rectBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, res.scratchRect.subarray(0, rects.length));
    gl.bindBuffer(gl.ARRAY_BUFFER, res.colorBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, res.scratchColor.subarray(0, colors.length));
    gl.bindBuffer(gl.ARRAY_BUFFER, res.kindBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, res.scratchKind.subarray(0, kinds.length));
    gl.bindBuffer(gl.ARRAY_BUFFER, res.angleBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, res.scratchAngle.subarray(0, angles.length));
    gl.bindBuffer(gl.ARRAY_BUFFER, res.uvBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, res.scratchUv.subarray(0, uvs.length));
    const clipFill =
      clips.length === count * 4
        ? clips
        : Array.from({ length: count * 4 }, (_, i) => SOA_WEBGL_NO_CLIP[i % 4]);
    res.scratchClip = copyToScratch(clipFill, res.scratchClip);
    gl.bindBuffer(gl.ARRAY_BUFFER, res.clipBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, res.scratchClip.subarray(0, count * 4));

    if (atlas.revision !== res.atlasUploadedRevision) {
      gl.bindTexture(gl.TEXTURE_2D, res.atlasTex);
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
        res.atlasUploadedRevision = atlas.revision;
      } catch {
        recreateSharedSoaWebglAtlas();
        res.atlasUploadedRevision = -1;
      }
    }

    const msdf = ensureSharedMsdfAtlas();
    if (msdf && msdf.revision !== res.msdfUploadedRevision) {
      gl.bindTexture(gl.TEXTURE_2D, res.msdfTex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
      try {
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          msdf.canvas as TexImageSource
        );
        res.msdfUploadedRevision = msdf.revision;
      } catch {
        res.msdfUploadedRevision = -1;
      }
    }

    gl.useProgram(res.prog);
    gl.uniform2f(gl.getUniformLocation(res.prog, 'uPan'), panX, panY);
    gl.uniform1f(gl.getUniformLocation(res.prog, 'uZoom'), scale);
    gl.uniform2f(gl.getUniformLocation(res.prog, 'uStage'), stageW, stageH);
    gl.uniform1f(gl.getUniformLocation(res.prog, 'uMsdfSize'), MSDF_ATLAS_SIZE);
    gl.uniform1f(gl.getUniformLocation(res.prog, 'uMsdfPxRange'), MSDF_PX_RANGE);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, res.atlasTex);
    gl.uniform1i(gl.getUniformLocation(res.prog, 'uAtlas'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, res.msdfTex);
    gl.uniform1i(gl.getUniformLocation(res.prog, 'uMsdf'), 1);
    gl.bindVertexArray(res.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    gl.bindVertexArray(null);
  }

  if (
    meshVertCount >= 3 &&
    res.meshProg &&
    res.meshVao &&
    res.meshPosBuf &&
    res.meshColBuf &&
    res.meshClipBuf &&
    res.meshEdgeBuf
  ) {
    gl.useProgram(res.meshProg);
    gl.uniform2f(gl.getUniformLocation(res.meshProg, 'uPan'), panX, panY);
    gl.uniform1f(gl.getUniformLocation(res.meshProg, 'uZoom'), scale);
    gl.uniform2f(gl.getUniformLocation(res.meshProg, 'uStage'), stageW, stageH);
    gl.bindVertexArray(res.meshVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, res.meshPosBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(meshPos), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, res.meshColBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(meshCol), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, res.meshClipBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(meshClipArr), gl.DYNAMIC_DRAW);
    while (meshEdgeArr.length < meshVertCount) meshEdgeArr.push(0);
    gl.bindBuffer(gl.ARRAY_BUFFER, res.meshEdgeBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array(meshEdgeArr.slice(0, meshVertCount)),
      gl.DYNAMIC_DRAW
    );
    gl.drawArrays(gl.TRIANGLES, 0, meshVertCount);
    gl.bindVertexArray(null);
  }

  if (
    mediaVertCount >= 3 &&
    res.texProg &&
    res.texVao &&
    res.texPosBuf &&
    res.texUvBuf &&
    res.texColBuf &&
    res.texClipBuf
  ) {
    pruneMediaNodeTextures(
      gl,
      mediaTex.draws.map((d) => d.nodeId)
    );
    drawMediaTexBatch(
      gl,
      res.texProg,
      res.texVao,
      res.texPosBuf,
      res.texUvBuf,
      res.texColBuf,
      res.texClipBuf,
      mediaTex,
      { panX, panY, zoom: scale, stageW, stageH }
    );
  }

  const ctx = args.targetCanvas.getContext('2d');
  if (!ctx) return false;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, bw, bh);
  // Empty plate: clear only (SVG owns fill/edge).
  if (count > 0 || meshVertCount >= 3) {
    ctx.drawImage(res.canvas, 0, 0, bw, bh, 0, 0, bw, bh);
  }
  return true;
}

/**
 * Drop per-plate GPU scratch when a FO unregisters.
 * Shared GL stays alive (cheap while no plates; recreates on next paint).
 */
export function releaseArtboardWebglTarget(frameId: string): void {
  releaseArtboardTileCache(frameId);
}

/** Test-only: reset shared GL so probes can re-init. */
export function resetArtboardWebglInkForTests(): void {
  if (shared) {
    disposeAllMediaNodeTextures(shared.gl);
    shared.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
  shared = null;
  sharedFailed = false;
}
