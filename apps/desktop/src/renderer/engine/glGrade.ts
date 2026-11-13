/**
 * The grade pass: unsharp mask, then a colour LUT, on one picture layer.
 * Preview and export both go through gradeDrawable, so they produce the same
 * pixels. It runs on the GPU (WebGL 2); when that is unavailable the same maths
 * runs on the CPU (core.gradePixels) — slower, never different in kind.
 */
import { SHARPEN_GAIN, gradePixels, type GradeParams, type Lut } from '@cutaway/core';
import type { Drawable } from './compositor';

export type GradeBackend = 'gl' | 'cpu';

const MAX_SIDE = 4096;
const LUT1_MAX = 4096;

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  // row 0 of the uploaded picture is its top
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv;
out vec4 o;
uniform sampler2D uSrc;
uniform sampler3D uLut3;
uniform sampler2D uLut1;
uniform int uKind;
uniform float uSize;
uniform vec3 uMin;
uniform vec3 uMax;
uniform float uStrength;
uniform float uSharpen;
uniform vec2 uStep;
void main() {
  vec3 rgb = texture(uSrc, vUv).rgb;
  if (uSharpen > 0.0) {
    vec2 dx = vec2(uStep.x, 0.0);
    vec2 dy = vec2(0.0, uStep.y);
    vec3 b = rgb * 4.0;
    b += 2.0 * (texture(uSrc, vUv + dx).rgb + texture(uSrc, vUv - dx).rgb + texture(uSrc, vUv + dy).rgb + texture(uSrc, vUv - dy).rgb);
    b += texture(uSrc, vUv + dx + dy).rgb + texture(uSrc, vUv - dx - dy).rgb + texture(uSrc, vUv + dx - dy).rgb + texture(uSrc, vUv - dx + dy).rgb;
    rgb = clamp(rgb + (rgb - b / 16.0) * uSharpen, 0.0, 1.0);
  }
  if (uKind != 0) {
    vec3 t = clamp((rgb - uMin) / (uMax - uMin), 0.0, 1.0);
    vec3 q = (t * (uSize - 1.0) + 0.5) / uSize;
    vec3 g = uKind == 2 ? texture(uLut3, q).rgb : vec3(texture(uLut1, vec2(q.r, 0.5)).r, texture(uLut1, vec2(q.g, 0.5)).g, texture(uLut1, vec2(q.b, 0.5)).b);
    rgb = mix(rgb, clamp(g, 0.0, 1.0), uStrength);
  }
  o = vec4(rgb, 1.0);
}`;

interface GlPass {
  kind: 'gl';
  canvas: OffscreenCanvas;
  gl: WebGL2RenderingContext;
  u: Record<string, WebGLUniformLocation | null>;
  src: WebGLTexture;
  lut3: WebGLTexture;
  lut1: WebGLTexture;
  loaded: Lut | null;
  /** Entries on the LUT texture axis (1D tables longer than the GPU allows are resampled). */
  loadedSize: number;
  input: OffscreenCanvas;
  lost: boolean;
}

interface CpuPass {
  kind: 'cpu';
  canvas: OffscreenCanvas;
}

let forced: GradeBackend | null = null;
let glBroken = false;
const passes = new Map<string, GlPass | CpuPass>();

/** Tests (and nothing else) can pin the backend; null returns to automatic. */
export function setGradeBackend(b: GradeBackend | null): void {
  forced = b;
  passes.clear();
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader failed');
  return sh;
}

function texture(gl: WebGL2RenderingContext, target: number): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(target, t);
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (target === gl.TEXTURE_3D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  return t;
}

function createGl(): GlPass | null {
  if (glBroken || typeof OffscreenCanvas === 'undefined') return null;
  try {
    const canvas = new OffscreenCanvas(2, 2);
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true, premultipliedAlpha: false }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('no webgl2');
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link failed');
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u: GlPass['u'] = {};
    for (const n of ['uSrc', 'uLut3', 'uLut1', 'uKind', 'uSize', 'uMin', 'uMax', 'uStrength', 'uSharpen', 'uStep']) u[n] = gl.getUniformLocation(prog, n);
    gl.uniform1i(u.uSrc!, 0);
    gl.uniform1i(u.uLut3!, 1);
    gl.uniform1i(u.uLut1!, 2);
    gl.activeTexture(gl.TEXTURE1);
    const lut3 = texture(gl, gl.TEXTURE_3D);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, 1, 1, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array(4));
    gl.activeTexture(gl.TEXTURE2);
    const lut1 = texture(gl, gl.TEXTURE_2D);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 1, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array(4));
    gl.activeTexture(gl.TEXTURE0);
    const src = texture(gl, gl.TEXTURE_2D);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    const pass: GlPass = { kind: 'gl', canvas, gl, u, src, lut3, lut1, loaded: null, loadedSize: 0, input: new OffscreenCanvas(2, 2), lost: false };
    canvas.addEventListener('webglcontextlost', () => {
      pass.lost = true;
    });
    return pass;
  } catch (e) {
    // One clear line, then the CPU path for the rest of the session.
    console.warn('[grade] WebGL 2 is unavailable; colour grading will run on the CPU.', e instanceof Error ? e.message : e);
    glBroken = true;
    return null;
  }
}

function rgba(lut: Lut, count: number, pick: (i: number) => number): Float32Array {
  const out = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const s = pick(i) * 3;
    out[i * 4] = lut.data[s]!;
    out[i * 4 + 1] = lut.data[s + 1]!;
    out[i * 4 + 2] = lut.data[s + 2]!;
    out[i * 4 + 3] = 1;
  }
  return out;
}

function uploadLut(p: GlPass, lut: Lut): void {
  const gl = p.gl;
  if (lut.kind === '3d') {
    const n = lut.size;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, p.lut3);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, n, n, n, 0, gl.RGBA, gl.FLOAT, rgba(lut, n * n * n, (i) => i));
    p.loadedSize = n;
  } else {
    // long 1D tables are resampled to what a texture row can hold
    const n = Math.min(lut.size, LUT1_MAX);
    const row = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const pos = n === lut.size ? i : (i / (n - 1)) * (lut.size - 1);
      const a = Math.min(lut.size - 2, Math.floor(pos));
      const f = pos - a;
      for (let c = 0; c < 3; c++) row[i * 4 + c] = lut.data[a * 3 + c]! * (1 - f) + lut.data[(a + 1) * 3 + c]! * f;
      row[i * 4 + 3] = 1;
    }
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, p.lut1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, n, 1, 0, gl.RGBA, gl.FLOAT, row);
    p.loadedSize = n;
  }
  gl.activeTexture(gl.TEXTURE0);
  p.loaded = lut;
}

function passFor(key: string): GlPass | CpuPass {
  let p = passes.get(key);
  if (p?.kind === 'gl' && (p.lost || p.gl.isContextLost())) p = undefined;
  if (!p) {
    p = (forced === 'cpu' ? null : createGl()) ?? { kind: 'cpu', canvas: new OffscreenCanvas(2, 2) };
    passes.set(key, p);
  }
  return p;
}

/** Which backend a grade would run on right now. */
export function gradeBackend(): GradeBackend {
  const any = passes.values().next().value as GlPass | CpuPass | undefined;
  return (any ?? passFor('screen')).kind;
}

function size(src: Drawable): { w: number; h: number; k: number } {
  const k = Math.min(1, MAX_SIDE / Math.max(src.width, src.height));
  return { w: Math.max(2, Math.round(src.width * k)), h: Math.max(2, Math.round(src.height * k)), k };
}

function fit(c: OffscreenCanvas, w: number, h: number) {
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
}

/**
 * The same picture with the grade applied. `key` names the layer (one GPU
 * context each, so a graded screen and a graded camera can coexist in a frame).
 * `p.radius` is in source pixels.
 */
export function gradeDrawable(key: string, src: Drawable, p: GradeParams): Drawable {
  const { w, h, k } = size(src);
  const pass = passFor(key);
  let result: OffscreenCanvas;
  if (pass.kind === 'gl') {
    const gl = pass.gl;
    fit(pass.input, w, h);
    const ictx = pass.input.getContext('2d', { alpha: false })!;
    src.draw(ictx, 0, 0, src.width, src.height, 0, 0, w, h);
    fit(pass.canvas, w, h);
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, pass.src);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pass.input);
    const lut = p.lut && p.strength > 0.005 ? p.lut : null;
    if (lut && pass.loaded !== lut) uploadLut(pass, lut);
    gl.uniform1i(pass.u.uKind!, lut ? (lut.kind === '3d' ? 2 : 1) : 0);
    if (lut) {
      gl.uniform1f(pass.u.uSize!, pass.loadedSize);
      gl.uniform3fv(pass.u.uMin!, lut.domainMin);
      gl.uniform3fv(pass.u.uMax!, lut.domainMax);
      gl.uniform1f(pass.u.uStrength!, Math.min(1, Math.max(0, p.strength)));
    }
    const amount = p.sharpen > 0.005 ? p.sharpen * SHARPEN_GAIN : 0;
    gl.uniform1f(pass.u.uSharpen!, amount);
    const rad = Math.max(1, p.radius * k);
    gl.uniform2f(pass.u.uStep!, rad / w, rad / h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    result = pass.canvas;
  } else {
    fit(pass.canvas, w, h);
    const ctx = pass.canvas.getContext('2d', { alpha: false, willReadFrequently: true })!;
    src.draw(ctx, 0, 0, src.width, src.height, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    gradePixels(img.data, w, h, { ...p, radius: Math.max(1, p.radius * k) });
    ctx.putImageData(img, 0, 0);
    result = pass.canvas;
  }
  const kx = w / src.width;
  const ky = h / src.height;
  return { width: src.width, height: src.height, draw: (ctx, sx, sy, sw, sh, dx, dy, dw, dh) => ctx.drawImage(result, sx * kx, sy * ky, sw * kx, sh * ky, dx, dy, dw, dh) };
}

// Test hook, present only when the e2e harness launched the app.
if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('e2e')) {
  (window as unknown as { __cutawayGrade: unknown }).__cutawayGrade = { setGradeBackend, gradeBackend };
}
