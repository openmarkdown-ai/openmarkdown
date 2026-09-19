/**
 * Graph renderers: WebGL2 (instanced circles and line quads, node data in a
 * float texture so one upload per frame moves every node and edge) and a
 * Canvas2D fallback. Labels are drawn by the view on a 2D overlay.
 */
import type { GraphColors, RGBA } from "./colors";
import { rgbaToCss } from "./colors";

/** Per-node highlight state. */
export const NodeState = {
  Normal: 0,
  Neighbor: 1,
  Hovered: 2,
  Dimmed: 3,
} as const;

export interface GraphFrame {
  /** `[x0, y0, x1, y1, …]` in world units. */
  positions: Float32Array;
  /** World radius per node. */
  radius: Float32Array;
  state: Uint8Array;
  /** Whether highlight states are in effect (hovering or fading out). */
  hovering: boolean;
  /** 0 → normal look, 1 → full highlight look. */
  fade: number;
  cx: number;
  cy: number;
  scale: number;
  /** CSS pixels. */
  width: number;
  height: number;
  dpr: number;
  /** Line width in CSS pixels. */
  lineWidth: number;
  /** Arrowhead opacity (0 = hidden). */
  arrows: number;
  colors: GraphColors;
  /** Alpha multiplier for dimmed nodes/links at full fade. */
  dimAlpha: number;
}

export interface GraphRenderer {
  readonly kind: "webgl2" | "canvas2d";
  readonly canvas: HTMLCanvasElement;
  resize(width: number, height: number, dpr: number): void;
  /** Topology: `links` is `[s0, t0, s1, t1, …]`. */
  setLinks(nodeCount: number, links: Uint32Array): void;
  /** RGBA (0–1) per node. */
  setNodeColors(colors: Float32Array): void;
  draw(frame: GraphFrame): void;
  destroy(): void;
}

export function createRenderer(canvas: HTMLCanvasElement, preferWebGL = true): GraphRenderer {
  if (preferWebGL) {
    try {
      const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: true, alpha: true, preserveDrawingBuffer: false });
      if (gl) return new WebGLGraphRenderer(canvas, gl);
    } catch (e) {
      console.warn("WebGL2 graph renderer unavailable; using Canvas2D", e);
    }
  }
  return new Canvas2DGraphRenderer(canvas);
}

// ---- WebGL2 -------------------------------------------------------------------------

const TEX_W = 1024;

const FETCH = /* glsl */ `
uniform sampler2D u_nodes;
vec4 fetchNode(int i) { return texelFetch(u_nodes, ivec2(i % ${TEX_W}, i / ${TEX_W}), 0); }
uniform vec2 u_center;
uniform float u_scale;
uniform vec2 u_viewport;
vec2 toScreen(vec2 p) { return (p - u_center) * u_scale + u_viewport * 0.5; }
vec4 toClip(vec2 s) { vec2 c = s / u_viewport * 2.0 - 1.0; return vec4(c.x, -c.y, 0.0, 1.0); }
`;

const NODE_VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_color;
${FETCH}
uniform float u_fade;
uniform float u_dimAlpha;
uniform bool u_hovering;
uniform vec4 u_hoverColor;
out vec2 v_local;
out float v_r;
out vec4 v_color;
void main() {
  vec4 n = fetchNode(gl_InstanceID);
  float r = max(n.z * u_scale, 1.25);
  float ext = r + 1.5;
  v_local = a_corner * ext;
  v_r = r;
  gl_Position = toClip(toScreen(n.xy) + v_local);
  vec4 c = a_color;
  int st = int(n.w + 0.5);
  if (u_hovering) {
    if (st == 2) c = mix(c, u_hoverColor, u_fade);
    else if (st == 3) c.a *= mix(1.0, u_dimAlpha, u_fade);
  }
  v_color = c;
}`;

const NODE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_local;
in float v_r;
in vec4 v_color;
out vec4 o;
void main() {
  float d = length(v_local);
  float w = max(fwidth(d), 0.0001);
  float a = clamp((v_r - d) / w + 0.5, 0.0, 1.0) * v_color.a;
  if (a <= 0.0) discard;
  o = vec4(v_color.rgb * a, a);
}`;

const LINK_VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec2 a_corner;
layout(location = 1) in uvec2 a_ends;
${FETCH}
uniform float u_width;
uniform float u_fade;
uniform float u_dimAlpha;
uniform bool u_hovering;
uniform vec4 u_lineColor;
uniform vec4 u_hiColor;
out float v_across;
out float v_half;
out vec4 v_color;
void main() {
  vec4 s = fetchNode(int(a_ends.x));
  vec4 t = fetchNode(int(a_ends.y));
  vec2 ps = toScreen(s.xy);
  vec2 pt = toScreen(t.xy);
  vec2 d = pt - ps;
  float len = length(d);
  vec2 dir = len > 0.0001 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  vec4 c = u_lineColor;
  float w = u_width;
  if (w < 1.0) { c.a *= w; w = 1.0; }
  float ext = w * 0.5 + 1.0;
  vec2 p = mix(ps, pt, a_corner.x) + nrm * a_corner.y * ext;
  gl_Position = toClip(p);
  if (u_hovering) {
    int ss = int(s.w + 0.5);
    int ts = int(t.w + 0.5);
    if (ss == 2 || ts == 2) c = mix(c, u_hiColor, u_fade);
    else c.a *= mix(1.0, u_dimAlpha, u_fade);
  }
  v_across = a_corner.y * ext;
  v_half = w * 0.5;
  v_color = c;
}`;

const LINK_FS = /* glsl */ `#version 300 es
precision highp float;
in float v_across;
in float v_half;
in vec4 v_color;
out vec4 o;
void main() {
  float a = clamp(v_half - abs(v_across) + 0.5, 0.0, 1.0) * v_color.a;
  if (a <= 0.0) discard;
  o = vec4(v_color.rgb * a, a);
}`;

const ARROW_VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec2 a_corner;
layout(location = 1) in uvec2 a_ends;
${FETCH}
uniform float u_size;
uniform float u_alpha;
uniform float u_fade;
uniform float u_dimAlpha;
uniform bool u_hovering;
uniform vec4 u_color;
uniform vec4 u_hiColor;
out vec4 v_color;
void main() {
  vec4 s = fetchNode(int(a_ends.x));
  vec4 t = fetchNode(int(a_ends.y));
  vec2 ps = toScreen(s.xy);
  vec2 pt = toScreen(t.xy);
  vec2 d = pt - ps;
  float len = length(d);
  vec2 dir = len > 0.0001 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float r = max(t.z * u_scale, 1.25);
  vec2 tip = pt - dir * r;
  vec2 p = tip - dir * a_corner.x * u_size + nrm * a_corner.y * u_size * 0.5;
  gl_Position = toClip(p);
  vec4 c = u_color;
  if (u_hovering) {
    int ss = int(s.w + 0.5);
    int ts = int(t.w + 0.5);
    if (ss == 2 || ts == 2) c = mix(c, u_hiColor, u_fade);
    else c.a *= mix(1.0, u_dimAlpha, u_fade);
  }
  c.a *= u_alpha;
  if (len < r * 2.0) c.a = 0.0;
  v_color = c;
}`;

const ARROW_FS = /* glsl */ `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 o;
void main() { o = vec4(v_color.rgb * v_color.a, v_color.a); }`;

type Uniforms = Record<string, WebGLUniformLocation | null>;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string, names: string[]): { prog: WebGLProgram; u: Uniforms } {
  const make = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`graph shader: ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, make(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, make(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`graph program: ${gl.getProgramInfoLog(prog)}`);
  const u: Uniforms = {};
  for (const n of names) u[n] = gl.getUniformLocation(prog, n);
  return { prog, u };
}

const COMMON_U = ["u_nodes", "u_center", "u_scale", "u_viewport", "u_fade", "u_dimAlpha", "u_hovering"];

class WebGLGraphRenderer implements GraphRenderer {
  readonly kind = "webgl2" as const;
  private node: { prog: WebGLProgram; u: Uniforms };
  private link: { prog: WebGLProgram; u: Uniforms };
  private arrow: { prog: WebGLProgram; u: Uniforms };
  private nodeVao: WebGLVertexArrayObject;
  private linkVao: WebGLVertexArrayObject;
  private arrowVao: WebGLVertexArrayObject;
  private colorBuf: WebGLBuffer;
  private endsBuf: WebGLBuffer;
  private tex: WebGLTexture;
  private texH = 0;
  private texData: Float32Array = new Float32Array(0);
  private nodeCount = 0;
  private linkCount = 0;
  private lost = false;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private gl: WebGL2RenderingContext,
  ) {
    this.node = compile(gl, NODE_VS, NODE_FS, [...COMMON_U, "u_hoverColor"]);
    this.link = compile(gl, LINK_VS, LINK_FS, [...COMMON_U, "u_width", "u_lineColor", "u_hiColor"]);
    this.arrow = compile(gl, ARROW_VS, ARROW_FS, [...COMMON_U, "u_size", "u_alpha", "u_color", "u_hiColor"]);

    const quad = (data: number[]) => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
      return b;
    };
    this.colorBuf = gl.createBuffer()!;
    this.endsBuf = gl.createBuffer()!;

    this.nodeVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.nodeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad([-1, -1, 1, -1, -1, 1, 1, 1]));
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);

    this.linkVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.linkVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad([0, -1, 1, -1, 0, 1, 1, 1]));
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.endsBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribIPointer(1, 2, gl.UNSIGNED_INT, 0, 0);
    gl.vertexAttribDivisor(1, 1);

    this.arrowVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.arrowVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad([0, 0, 1, 1, 1, -1]));
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.endsBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribIPointer(1, 2, gl.UNSIGNED_INT, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);

    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.lost = true;
    });
  }

  resize(width: number, height: number, dpr: number) {
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  setLinks(nodeCount: number, links: Uint32Array) {
    const gl = this.gl;
    this.nodeCount = nodeCount;
    this.linkCount = links.length >> 1;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.endsBuf);
    gl.bufferData(gl.ARRAY_BUFFER, links.length ? links : new Uint32Array(2), gl.STATIC_DRAW);
    const rows = Math.max(1, Math.ceil(nodeCount / TEX_W));
    if (rows !== this.texH) {
      this.texH = rows;
      this.texData = new Float32Array(TEX_W * rows * 4);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TEX_W, rows, 0, gl.RGBA, gl.FLOAT, this.texData);
    }
  }

  setNodeColors(colors: Float32Array) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuf);
    gl.bufferData(gl.ARRAY_BUFFER, colors.length ? colors : new Float32Array(4), gl.DYNAMIC_DRAW);
  }

  draw(f: GraphFrame) {
    const gl = this.gl;
    if (this.lost || gl.isContextLost()) return;
    const n = Math.min(this.nodeCount, f.radius.length, f.positions.length >> 1);
    const td = this.texData;
    const pos = f.positions;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      td[o] = pos[i * 2]!;
      td[o + 1] = pos[i * 2 + 1]!;
      td[o + 2] = f.radius[i]!;
      td[o + 3] = f.state[i]!;
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (n === 0) return;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEX_W, this.texH, gl.RGBA, gl.FLOAT, td);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const common = (p: { prog: WebGLProgram; u: Uniforms }) => {
      gl.useProgram(p.prog);
      gl.uniform1i(p.u.u_nodes!, 0);
      gl.uniform2f(p.u.u_center!, f.cx, f.cy);
      gl.uniform1f(p.u.u_scale!, f.scale);
      gl.uniform2f(p.u.u_viewport!, f.width, f.height);
      gl.uniform1f(p.u.u_fade!, f.fade);
      gl.uniform1f(p.u.u_dimAlpha!, f.dimAlpha);
      gl.uniform1i(p.u.u_hovering!, f.hovering ? 1 : 0);
    };
    const c4 = (loc: WebGLUniformLocation | null | undefined, c: RGBA) => gl.uniform4f(loc!, c[0], c[1], c[2], c[3]);

    if (this.linkCount > 0) {
      common(this.link);
      gl.uniform1f(this.link.u.u_width!, f.lineWidth);
      c4(this.link.u.u_lineColor, f.colors.line);
      c4(this.link.u.u_hiColor, f.colors.lineHighlight);
      gl.bindVertexArray(this.linkVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.linkCount);

      if (f.arrows > 0.001) {
        common(this.arrow);
        gl.uniform1f(this.arrow.u.u_size!, Math.max(4, 3 + f.lineWidth * 3));
        gl.uniform1f(this.arrow.u.u_alpha!, f.arrows);
        c4(this.arrow.u.u_color, f.colors.arrow);
        c4(this.arrow.u.u_hiColor, f.colors.lineHighlight);
        gl.bindVertexArray(this.arrowVao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, this.linkCount);
      }
    }

    common(this.node);
    c4(this.node.u.u_hoverColor, f.colors.fillHighlight);
    gl.bindVertexArray(this.nodeVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    gl.bindVertexArray(null);
  }

  destroy() {
    const ext = this.gl.getExtension("WEBGL_lose_context");
    ext?.loseContext();
  }
}

// ---- Canvas2D fallback ------------------------------------------------------------------

class Canvas2DGraphRenderer implements GraphRenderer {
  readonly kind = "canvas2d" as const;
  private ctx: CanvasRenderingContext2D;
  private links: Uint32Array = new Uint32Array(0);
  private colors: Float32Array = new Float32Array(0);
  private dpr = 1;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  resize(width: number, height: number, dpr: number) {
    this.dpr = dpr;
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  setLinks(_nodeCount: number, links: Uint32Array) {
    this.links = links;
  }

  setNodeColors(colors: Float32Array) {
    this.colors = colors;
  }

  draw(f: GraphFrame) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, f.width, f.height);
    const pos = f.positions;
    const n = Math.min(f.radius.length, pos.length >> 1);
    const hw = f.width / 2;
    const hh = f.height / 2;
    const sx = (i: number) => (pos[i * 2]! - f.cx) * f.scale + hw;
    const sy = (i: number) => (pos[i * 2 + 1]! - f.cy) * f.scale + hh;
    const dim = 1 + (f.dimAlpha - 1) * f.fade;

    // Links in three batches: normal, highlighted, dimmed.
    const links = this.links;
    const batches: [RGBA, number, (s: number, t: number) => boolean][] = f.hovering
      ? [
          [f.colors.line, dim, (s, t) => f.state[s] !== NodeState.Hovered && f.state[t] !== NodeState.Hovered],
          [mix(f.colors.line, f.colors.lineHighlight, f.fade), 1, (s, t) => f.state[s] === NodeState.Hovered || f.state[t] === NodeState.Hovered],
        ]
      : [[f.colors.line, 1, () => true]];
    let lw = f.lineWidth;
    let lineAlpha = 1;
    if (lw < 1) {
      lineAlpha = lw;
      lw = 1;
    }
    ctx.lineWidth = lw;
    for (const [color, alpha, pick] of batches) {
      ctx.strokeStyle = rgbaToCss(color, alpha * lineAlpha);
      ctx.beginPath();
      for (let k = 0; k < links.length; k += 2) {
        const s = links[k]!;
        const t = links[k + 1]!;
        if (s >= n || t >= n || !pick(s, t)) continue;
        ctx.moveTo(sx(s), sy(s));
        ctx.lineTo(sx(t), sy(t));
      }
      ctx.stroke();
      if (f.arrows > 0.001) {
        ctx.fillStyle = rgbaToCss(f.colors.arrow, alpha * f.arrows);
        const size = Math.max(4, 3 + f.lineWidth * 3);
        ctx.beginPath();
        for (let k = 0; k < links.length; k += 2) {
          const s = links[k]!;
          const t = links[k + 1]!;
          if (s >= n || t >= n || !pick(s, t)) continue;
          const x0 = sx(s), y0 = sy(s), x1 = sx(t), y1 = sy(t);
          const dx = x1 - x0, dy = y1 - y0;
          const len = Math.hypot(dx, dy);
          const r = Math.max(f.radius[t]! * f.scale, 1.25);
          if (len < r * 2) continue;
          const ux = dx / len, uy = dy / len;
          const tx = x1 - ux * r, ty = y1 - uy * r;
          ctx.moveTo(tx, ty);
          ctx.lineTo(tx - ux * size - uy * size * 0.5, ty - uy * size + ux * size * 0.5);
          ctx.lineTo(tx - ux * size + uy * size * 0.5, ty - uy * size - ux * size * 0.5);
          ctx.closePath();
        }
        ctx.fill();
      }
    }

    // Nodes, batched by colour.
    const byColor = new Map<string, number[]>();
    const cols = this.colors;
    for (let i = 0; i < n; i++) {
      const x = sx(i);
      const y = sy(i);
      const r = Math.max(f.radius[i]! * f.scale, 1.25);
      if (x + r < 0 || y + r < 0 || x - r > f.width || y - r > f.height) continue;
      let c: RGBA = [cols[i * 4] ?? 0.5, cols[i * 4 + 1] ?? 0.5, cols[i * 4 + 2] ?? 0.5, cols[i * 4 + 3] ?? 1];
      if (f.hovering) {
        if (f.state[i] === NodeState.Hovered) c = mix(c, f.colors.fillHighlight, f.fade);
        else if (f.state[i] === NodeState.Dimmed) c = [c[0], c[1], c[2], c[3] * dim];
      }
      const key = rgbaToCss(c);
      let list = byColor.get(key);
      if (!list) byColor.set(key, (list = []));
      list.push(x, y, r);
    }
    for (const [color, list] of byColor) {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (let k = 0; k < list.length; k += 3) {
        ctx.moveTo(list[k]! + list[k + 2]!, list[k + 1]!);
        ctx.arc(list[k]!, list[k + 1]!, list[k + 2]!, 0, Math.PI * 2);
      }
      ctx.fill();
    }
  }

  destroy() {}
}

function mix(a: RGBA, b: RGBA, t: number): RGBA {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
}
