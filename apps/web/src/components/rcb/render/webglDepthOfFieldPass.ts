/**
 * WebGL2 depth-of-field pass — color + depth FBO, CoC-weighted separable blur, composite.
 * Used by {@link createWebglSceneRenderer} when GPU DOF is active (replaces CPU tile bake).
 */
import {
  clampDownsample,
  getGpuDepthOfFieldParams,
  type GpuDepthOfFieldParams,
} from '@/components/rcb/render/gpuDepthOfField';

const SCENE_VS = `#version 300 es
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
layout(location = 6) in float aDepth;
layout(location = 7) in vec4 aClip;
out vec2 vUv;
out vec2 vAtlasUv;
out vec4 vColor;
out float vKind;
out float vDepth;
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
  vDepth = aDepth;
  vWorld = pos;
  vClip = aClip;
}`;

const SCENE_FS = `#version 300 es
precision mediump float;
uniform sampler2D uAtlas;
uniform sampler2D uMsdf;
uniform float uZoom;
uniform float uMsdfSize;
uniform float uMsdfPxRange;
in vec2 vUv;
in vec2 vAtlasUv;
in vec4 vColor;
in float vKind;
in float vDepth;
in vec2 vWorld;
in vec4 vClip;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outDepth;
float median3(float r, float g, float b) {
  return max(min(r, g), min(max(r, g), b));
}
void main() {
  if (vWorld.x < vClip.x || vWorld.y < vClip.y || vWorld.x > vClip.z || vWorld.y > vClip.w) {
    discard;
  }
  if (vKind > 3.5 && vKind < 4.5) {
    vec3 msdf = texture(uMsdf, vAtlasUv).rgb;
    float sd = median3(msdf.r, msdf.g, msdf.b);
    vec2 unitRange = vec2(uMsdfPxRange) / max(uMsdfSize, 1.0);
    vec2 screenTexSize = 1.0 / max(fwidth(vAtlasUv), vec2(1e-6));
    float screenPxRange = max(0.5 * dot(unitRange, screenTexSize), 1.0);
    float screenPxDistance = screenPxRange * (sd - 0.5);
    float alpha = clamp(screenPxDistance + 0.5, 0.0, 1.0);
    if (alpha < 0.004) discard;
    float a = vColor.a * alpha;
    outColor = vec4(vColor.rgb * a, a);
    outDepth = vec4(vDepth, 0.0, 0.0, 1.0);
    return;
  }
  if (vKind > 2.5 && vKind < 3.5) {
    vec4 tex = texture(uAtlas, vAtlasUv);
    if (tex.a < 0.01) discard;
    outColor = vec4(tex.rgb * tex.a, tex.a);
    outDepth = vec4(vDepth, 0.0, 0.0, 1.0);
    return;
  }
  if (vKind > 0.5 && vKind < 1.5) {
    if (dot(vUv, vUv) > 1.0) discard;
  }
  outColor = vec4(vColor.rgb * vColor.a, vColor.a);
  outDepth = vec4(vDepth, 0.0, 0.0, 1.0);
}`;

const BLUR_FS = `#version 300 es
precision highp float;
uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform vec2 uTexel;
uniform vec2 uDir;
uniform float uFocal;
uniform float uMaxCoC;
uniform float uAperture;
in vec2 vUv;
out vec4 outColor;

void main() {
  float depth = texture(uDepth, vUv).r;
  float coc = min(uMaxCoC, abs(depth - uFocal) * uAperture * uMaxCoC);
  if (coc < 0.75) {
    outColor = texture(uColor, vUv);
    return;
  }
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  const int TAPS = 12;
  for (int i = -TAPS; i <= TAPS; i++) {
    float fi = float(i) / float(TAPS);
    float w = exp(-2.5 * fi * fi);
    vec2 off = uDir * uTexel * coc * fi;
    acc += texture(uColor, vUv + off) * w;
    wsum += w;
  }
  outColor = acc / max(wsum, 1e-4);
}`;

const FULLSCREEN_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

function compileShader(gl: WebGL2RenderingContext, type: number, src: string) {
  const sh = gl.createShader(type);
  if (!sh) return null;
  // Match webglSceneRenderer: strip CR so #version stays valid on Windows CRLF sources.
  gl.shaderSource(sh, src.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.error(
        '[webgl-dof] shader compile failed',
        type === gl.VERTEX_SHADER ? 'VS' : 'FS',
        gl.getShaderInfoLog(sh)
      );
    }
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function linkProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

function createTexture(
  gl: WebGL2RenderingContext,
  tw: number,
  th: number,
  internal: number,
  format: number,
  type: number
) {
  const tex = gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, tw, th, 0, format, type, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

export type WebglDepthOfFieldPass = {
  readonly sceneProgram: WebGLProgram;
  bindSceneFbo(): void;
  unbindSceneFbo(): void;
  compositeToScreen(params?: GpuDepthOfFieldParams): void;
  resize(deviceW: number, deviceH: number): void;
  dispose(): void;
};

export function createWebglDepthOfFieldPass(gl: WebGL2RenderingContext): WebglDepthOfFieldPass | null {
  const sceneProgram = linkProgram(gl, SCENE_VS, SCENE_FS);
  const blurProgram = linkProgram(gl, FULLSCREEN_VS, BLUR_FS);
  if (!sceneProgram || !blurProgram) return null;

  const quadBuf = gl.createBuffer();
  if (!quadBuf) return null;
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  let colorTex: WebGLTexture | null = null;
  let depthTex: WebGLTexture | null = null;
  let pingTex: WebGLTexture | null = null;
  let sceneFbo: WebGLFramebuffer | null = null;
  let pingFbo: WebGLFramebuffer | null = null;
  let w = 0;
  let h = 0;

  function dropTargets() {
    if (colorTex) gl.deleteTexture(colorTex);
    if (depthTex) gl.deleteTexture(depthTex);
    if (pingTex) gl.deleteTexture(pingTex);
    if (sceneFbo) gl.deleteFramebuffer(sceneFbo);
    if (pingFbo) gl.deleteFramebuffer(pingFbo);
    colorTex = null;
    depthTex = null;
    pingTex = null;
    sceneFbo = null;
    pingFbo = null;
  }

  function ensureTargets(deviceW: number, deviceH: number) {
    const ds = clampDownsample(getGpuDepthOfFieldParams().downsample);
    const tw = Math.max(1, Math.floor(deviceW / ds));
    const th = Math.max(1, Math.floor(deviceH / ds));
    if (tw === w && th === h && sceneFbo) return;
    dropTargets();
    w = tw;
    h = th;
    colorTex = createTexture(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    depthTex = createTexture(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    pingTex = createTexture(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    if (!colorTex || !depthTex || !pingTex) {
      dropTargets();
      return;
    }
    sceneFbo = gl.createFramebuffer();
    pingFbo = gl.createFramebuffer();
    if (!sceneFbo || !pingFbo) {
      dropTargets();
      return;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, depthTex, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, pingFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pingTex, 0);
    gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      dropTargets();
    }
  }

  function drawFullscreen(prog: WebGLProgram) {
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disableVertexAttribArray(loc);
  }

  function runBlurPass(
    srcColor: WebGLTexture,
    srcDepth: WebGLTexture,
    dirX: number,
    dirY: number,
    targetFbo: WebGLFramebuffer | null
  ) {
    const p = getGpuDepthOfFieldParams();
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(blurProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcColor);
    gl.uniform1i(gl.getUniformLocation(blurProgram, 'uColor'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, srcDepth);
    gl.uniform1i(gl.getUniformLocation(blurProgram, 'uDepth'), 1);
    gl.uniform2f(gl.getUniformLocation(blurProgram, 'uTexel'), 1 / w, 1 / h);
    gl.uniform2f(gl.getUniformLocation(blurProgram, 'uDir'), dirX, dirY);
    gl.uniform1f(gl.getUniformLocation(blurProgram, 'uFocal'), p.focalDepth);
    gl.uniform1f(
      gl.getUniformLocation(blurProgram, 'uMaxCoC'),
      p.maxCoCPx / clampDownsample(p.downsample)
    );
    gl.uniform1f(gl.getUniformLocation(blurProgram, 'uAperture'), p.aperture);
    drawFullscreen(blurProgram);
  }

  return {
    sceneProgram,
    resize(deviceW: number, deviceH: number) {
      ensureTargets(deviceW, deviceH);
    },
    bindSceneFbo() {
      if (!sceneFbo) return;
      gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFbo);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    },
    unbindSceneFbo() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    },
    compositeToScreen(params?: GpuDepthOfFieldParams) {
      if (!colorTex || !depthTex || !pingTex || !pingFbo) return;
      const p = params ?? getGpuDepthOfFieldParams();
      runBlurPass(colorTex, depthTex, 1, 0, pingFbo);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      runBlurPass(pingTex, depthTex, 0, 1, null);
      gl.viewport(0, 0, w * clampDownsample(p.downsample), h * clampDownsample(p.downsample));
    },
    dispose() {
      dropTargets();
      gl.deleteBuffer(quadBuf);
      gl.deleteProgram(sceneProgram);
      gl.deleteProgram(blurProgram);
    },
  };
}

/** Scene program: depth (6) + clip LTRB (7). */
export function bindWebglDofSceneAttributes(
  gl: WebGL2RenderingContext,
  cornerBuf: WebGLBuffer,
  rectBuf: WebGLBuffer,
  colorBuf: WebGLBuffer,
  kindBuf: WebGLBuffer,
  angleBuf: WebGLBuffer,
  uvBuf: WebGLBuffer,
  depthBuf: WebGLBuffer,
  clipBuf: WebGLBuffer
) {
  const inst = 1;
  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, rectBuf);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(1, inst);

  gl.bindBuffer(gl.ARRAY_BUFFER, colorBuf);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(2, inst);

  gl.bindBuffer(gl.ARRAY_BUFFER, kindBuf);
  gl.enableVertexAttribArray(3);
  gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(3, inst);

  gl.bindBuffer(gl.ARRAY_BUFFER, angleBuf);
  gl.enableVertexAttribArray(4);
  gl.vertexAttribPointer(4, 1, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(4, inst);

  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
  gl.enableVertexAttribArray(5);
  gl.vertexAttribPointer(5, 4, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(5, inst);

  gl.bindBuffer(gl.ARRAY_BUFFER, depthBuf);
  gl.enableVertexAttribArray(6);
  gl.vertexAttribPointer(6, 1, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(6, inst);

  gl.bindBuffer(gl.ARRAY_BUFFER, clipBuf);
  gl.enableVertexAttribArray(7);
  gl.vertexAttribPointer(7, 4, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(7, inst);
}

export function createWebglDepthInstanceBuffer(gl: WebGL2RenderingContext) {
  return gl.createBuffer();
}
