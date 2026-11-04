import { useEffect, useRef } from "react";

type Stats = {
  fps: number;
  frameMs: number;
  renderScale: number;
  mode: "webgl2" | "canvas";
  energy: number;
  pointers: number;
  frames: number;
  running: boolean;
  reducedMotion: boolean;
  particles: number;
  particleLimit: number;
  glitch: number;
  name: number;
  detune: number;
  nameBounds: { x: number; y: number; width: number; height: number };
};
declare global {
  interface Window {
    __vlnaStats?: Stats;
  }
}
type Finger = {
  x: number;
  y: number;
  tx: number;
  ty: number;
  vx: number;
  vy: number;
  dx: number;
  dy: number;
  speed: number;
  force: number;
  down: boolean;
  at: number;
};
type Ripple = { x: number; y: number; age: number; force: number };
type Emission = {
  x: number;
  y: number;
  dx: number;
  dy: number;
  force: number;
  count: number;
  mode: number;
};
type Scene = {
  time: number;
  clock: number;
  dt: number;
  energy: number;
  fingers: Float32Array;
  wakes: Float32Array;
  ripples: Float32Array;
  emissions: Emission[];
  blast: Float32Array;
  detune: number;
  name: number;
  glitch: number;
  glitchSeed: number;
  reduced: boolean;
  scale: number;
  mobile: boolean;
  targets: Float32Array;
  maskVersion: number;
  dotSize: number;
};
type Renderer = {
  mode: Stats["mode"];
  draw: (scene: Scene) => { particles: number; limit: number };
  dispose: () => void;
};
const STRANDS = 36,
  STEPS = 144,
  SOURCES = 8;
const BASE = 6144,
  SPARKS = 8192,
  TOTAL = BASE + SPARKS,
  LIFE = 2.4;
const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

// Shared by the string shader and the GPU particle integrator.
const field = `
uniform vec2 u_size;
uniform float u_time, u_energy, u_detune, u_name;
uniform vec4 u_fingers[8], u_wakes[8], u_ripples[8];
float wave(float x, float s) {
  float t=u_time, e=pow(max(0.,sin(clamp(x,0.,1.)*3.141593)),1.3);
  float y=.5+e*(sin(x*7.-t*.38)*.15+sin(x*10.-t*.48+s*2.2)*.18
    +s*cos(x*5.+t*.27)*.13+sin(x*19.+s*4.+t*.7)*(.018+u_energy*.012)
    +sin(x*(24.+s*9.)+t*1.5+s*13.)*u_detune*.09);
  for(int i=0;i<8;i++) {
    vec4 f=u_fingers[i], w=u_wakes[i];
    if(f.z>.001) {
      float dx=(x-f.x)*u_size.x/u_size.y;
      float magnetic=exp(-dx*dx*4.5)*f.z;
      float behind=dx*w.x;
      float wake=exp(-dx*dx*5.)*(1.-smoothstep(-.7,.3,behind))*w.z;
      y+=(f.y-y)*magnetic*.45+sin(dx*9.+s*2.-t)*magnetic*.07;
      y+=sin(dx*15.-t*1.2+s*3.)*wake*.09+w.y*wake*.04;
    }
    vec4 r=u_ripples[i];
    if(r.w>.001) {
      float distance=length(vec2((x-r.x)*u_size.x/u_size.y,(y-r.y)*.65));
      float front=distance-r.z*.72;
      y+=sin(front*15.)*exp(-front*front*9.-r.z*.8)*r.w*.19;
    }
  }
  return y;
}`;
const vertex = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_point;
${field}
uniform float u_width;
out float v_edge,v_light,v_strand,v_fade;
void main(){
  float x=a_point.x,s=a_point.y,y=wave(x,s);
  gl_Position=vec4(x*2.-1.,1.-y*2.+a_point.z*u_width/u_size.y,0.,1.);
  v_edge=a_point.z;v_strand=s;
  v_light=.48+.52*pow(.5+.5*cos(x*10.-u_time*.48+s*2.2),3.);
  v_fade=smoothstep(0.,.13,x)*(1.-smoothstep(.84,1.,x))*(1.-u_name*.85);
}`;
const fragment = `#version 300 es
precision mediump float;
in float v_edge,v_light,v_strand,v_fade;
uniform float u_glow;
out vec4 color;
void main(){
  vec3 ink=mix(vec3(.32,.68,.46),vec3(.835,.973,.475),.5+.5*v_strand);
  color=vec4(ink,exp(-v_edge*v_edge*4.)*v_light*v_fade*u_glow);
}`;
const updateVertex = `#version 300 es
precision highp float;
layout(location=0) in vec4 a_state;
layout(location=1) in float a_life;
layout(location=2) in vec2 a_target;
${field}
uniform float u_dt,u_base,u_reduced,u_reset;
uniform vec4 u_births[8],u_kicks[8],u_blast;
out vec4 nextState;
out float nextLife;
float hash(float x){return fract(sin(x*127.1+311.7)*43758.5453);}
void main(){
  float id=float(gl_VertexID),h=hash(id+1.),j=hash(id+19.);
  vec2 p=a_state.xy,v=a_state.zw;
  float life=a_life;bool dust=id<${BASE}.;
  if(u_reset>.5){p=vec2(h,wave(h,j*2.-1.));v=vec2(0.);life=dust?1.:0.;}
  if(dust) life=id<u_base?1.:0.; else life=max(0.,life-u_dt);
  for(int i=0;i<8;i++){
    vec4 b=u_births[i],k=u_kicks[i];
    if(!dust && id>=b.x && id<b.y){
      float angle=h*6.283185;
      p=b.zw;
      if(k.w>.5 && j>.48) p=vec2(h,wave(h,hash(id+91.)*2.-1.));
      v=vec2(cos(angle)*u_size.y/u_size.x,sin(angle))*(.12+j*.36)*k.z+k.xy*.12;
      life=${LIFE};
    }
  }
  if(life>0.){
    vec2 flow=vec2(.035+sin(p.y*9.+u_time*.4)*.035,
      (wave(p.x,j*2.-1.)-p.y)*.5+cos(p.x*13.+u_time*.5)*.025);
    v+=flow*u_dt*(1.-u_reduced*.85);
    for(int i=0;i<8;i++){
      vec4 f=u_fingers[i];
      if(f.z>.001){
        vec2 d=f.xy-p;d.x*=u_size.x/u_size.y;
        float radius=length(d),mag=exp(-radius*radius*5.);
        vec2 swirl=vec2(-d.y,d.x)*2.5+d*2.1;
        swirl.x*=u_size.y/u_size.x;
        v+=swirl*u_dt*f.z*mag*(f.w>.5?6.:.8)*(1.-u_reduced);
      }
    }
    if(u_blast.w>.5){
      vec2 d=p-u_blast.xy;d.x*=u_size.x/u_size.y;
      float radius=max(.02,length(d));
      vec2 kick=d/radius*exp(-radius*radius*1.5)*u_blast.z;
      kick.x*=u_size.y/u_size.x;
      v+=kick*.7*(1.-u_reduced);
    }
    // At rest the persistent dust becomes the word; breaking it releases the stored velocity.
    if(dust){v+=(a_target-p)*u_name*u_dt*30.;v*=exp(-u_dt*(1.7+u_name*11.));}
    else v*=exp(-u_dt*1.1);
    p+=v*u_dt;
    if(dust){
      p=mix(p,a_target,u_name*u_dt*7.);
      if(u_name<.01 && (p.x<-.1||p.x>1.1||p.y<-.3||p.y>1.3)) p=vec2(h,wave(h,j*2.-1.));
    }
  }
  nextState=vec4(p,v);nextLife=life;
}`;
const emptyFragment = `#version 300 es
precision mediump float;out vec4 color;void main(){color=vec4(0.);}`;
const pointVertex = `#version 300 es
precision highp float;
layout(location=0) in vec4 a_state;
layout(location=1) in float a_life;
uniform float u_pixel,u_name,u_dot;
out float v_alpha,v_seed;
void main(){
  float id=float(gl_VertexID);bool dust=id<${BASE}.;
  v_seed=fract(sin(id*127.1+311.7)*43758.5453);
  v_alpha=a_life>0.?(dust?mix(.28,.95,u_name):min(1.,a_life/.6)):0.;
  gl_Position=vec4(a_state.x*2.-1.,1.-a_state.y*2.,0.,1.);
  if(v_alpha==0.)gl_Position=vec4(3.,3.,0.,1.);
  gl_PointSize=u_pixel*(dust?mix(1.3,u_dot,u_name):(2.+v_seed*2.));
}`;
const pointFragment = `#version 300 es
precision mediump float;
in float v_alpha,v_seed;out vec4 color;
void main(){
  float r=length(gl_PointCoord-.5);
  float a=(1.-smoothstep(.08,.5,r))*v_alpha;
  color=vec4(mix(vec3(.38,.78,.59),vec3(.835,.973,.475),.5+v_seed*.5),a);
}`;
const screenVertex = `#version 300 es
precision highp float;out vec2 v_uv;
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));v_uv=p;gl_Position=vec4(p*2.-1.,0.,1.);}`;
const screenFragment = `#version 300 es
precision highp float;
in vec2 v_uv;uniform sampler2D u_ink;uniform float u_glitch,u_seed;out vec4 color;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7))+u_seed)*43758.5453);}
void main(){
  vec2 uv=v_uv;
  float row=hash(vec2(floor(uv.y*52.),1.));
  float block=hash(floor(uv*vec2(20.,13.)));
  uv.x+=(row>.72?(row-.72)*.13:0.)*u_glitch;
  if(block>.88) uv+=vec2((block-.88)*.22,.012)*u_glitch;
  float split=(.004+row*.005)*u_glitch;
  vec4 c=texture(u_ink,uv),r=texture(u_ink,uv+vec2(split,0.)),b=texture(u_ink,uv-vec2(split,0.));
  color=vec4(r.r,c.g,b.b,max(c.a,max(r.a,b.a)));
  // Spatial grain stays fixed for this burst; no full-frame luminance flashes.
  color.rgb+=(hash(floor(v_uv*vec2(900.,600.)))-.5)*.025*u_glitch*color.a;
}`;

function webgl(canvas: HTMLCanvasElement): Renderer | null {
  const gl = canvas.getContext("webgl2", {
    antialias: false,
    depth: false,
    powerPreference: "low-power",
  });
  if (!gl) return null;
  const shaders: WebGLShader[] = [],
    programs: WebGLProgram[] = [],
    buffers: WebGLBuffer[] = [],
    vaos: WebGLVertexArrayObject[] = [];
  const texture = gl.createTexture()!,
    framebuffer = gl.createFramebuffer()!,
    feedback = gl.createTransformFeedback()!;
  const dispose = () => {
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    buffers.forEach((b) => gl.deleteBuffer(b));
    vaos.forEach((v) => gl.deleteVertexArray(v));
    programs.forEach((p) => gl.deleteProgram(p));
    shaders.forEach((s) => gl.deleteShader(s));
    gl.deleteTransformFeedback(feedback);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  };
  try {
    const compile = (kind: number, source: string) => {
      const shader = gl.createShader(kind)!;
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(shader) || "Vlna: shader");
      return shader;
    };
    const program = (vs: string, fs: string, varyings?: string[]) => {
      const p = gl.createProgram()!;
      programs.push(p);
      gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
      if (varyings)
        gl.transformFeedbackVaryings(p, varyings, gl.INTERLEAVED_ATTRIBS);
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(p) || "Vlna: program");
      return p;
    };
    const strings = program(vertex, fragment),
      update = program(updateVertex, emptyFragment, ["nextState", "nextLife"]);
    const dots = program(pointVertex, pointFragment),
      screen = program(screenVertex, screenFragment);
    const uniforms = (p: WebGLProgram, keys: string[]) =>
      Object.fromEntries(
        keys.map((k) => [k, gl.getUniformLocation(p, `u_${k}`)]),
      );
    const commonKeys = [
      "size",
      "time",
      "energy",
      "detune",
      "name",
      "fingers[0]",
      "wakes[0]",
      "ripples[0]",
    ];
    const su = uniforms(strings, [...commonKeys, "width", "glow"]);
    const pu = uniforms(update, [
      ...commonKeys,
      "dt",
      "base",
      "reduced",
      "reset",
      "births[0]",
      "kicks[0]",
      "blast",
    ]);
    const du = uniforms(dots, ["pixel", "name", "dot"]),
      gu = uniforms(screen, ["ink", "glitch", "seed"]);
    const buffer = (
      target: number,
      data: Float32Array | Uint16Array,
      usage: number = gl.STATIC_DRAW,
    ) => {
      const b = gl.createBuffer()!;
      buffers.push(b);
      gl.bindBuffer(target, b);
      gl.bufferData(target, data, usage);
      return b;
    };
    const vao = () => {
      const v = gl.createVertexArray()!;
      vaos.push(v);
      gl.bindVertexArray(v);
      return v;
    };
    const stringVAO = vao(),
      points: number[] = [],
      indices: number[] = [];
    for (let s = 0; s < STRANDS; s++)
      for (let i = 0; i <= STEPS; i++) {
        for (const side of [-1, 1])
          points.push(i / STEPS, (s / (STRANDS - 1)) * 2 - 1, side);
        if (i < STEPS) {
          const n = (s * (STEPS + 1) + i) * 2;
          indices.push(n, n + 1, n + 2, n + 1, n + 3, n + 2);
        }
      }
    buffer(gl.ARRAY_BUFFER, new Float32Array(points));
    buffer(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices));
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const states = [
      buffer(gl.ARRAY_BUFFER, new Float32Array(TOTAL * 5), gl.DYNAMIC_COPY),
      buffer(gl.ARRAY_BUFFER, new Float32Array(TOTAL * 5), gl.DYNAMIC_COPY),
    ];
    const targets = buffer(
      gl.ARRAY_BUFFER,
      new Float32Array(TOTAL * 2),
      gl.DYNAMIC_DRAW,
    );
    const stateVAOs = states.map((b) => {
      const v = vao();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 20, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 20, 16);
      gl.bindBuffer(gl.ARRAY_BUFFER, targets);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
      return v;
    });
    const screenVAO = vao();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    let texWidth = 0,
      texHeight = 0,
      current = 0,
      reset = true,
      maskVersion = -1,
      cursor = 0,
      previousCapacity = 0;
    const expiry = new Float64Array(SPARKS),
      births = new Float32Array(SOURCES * 4),
      kicks = new Float32Array(SOURCES * 4);
    const common = (u: ReturnType<typeof uniforms>, s: Scene) => {
      gl.uniform2f(u.size, canvas.width, canvas.height);
      gl.uniform1f(u.time, s.time);
      gl.uniform1f(u.energy, s.energy);
      gl.uniform1f(u.detune, s.detune);
      gl.uniform1f(u.name, s.name);
      gl.uniform4fv(u["fingers[0]"], s.fingers);
      gl.uniform4fv(u["wakes[0]"], s.wakes);
      gl.uniform4fv(u["ripples[0]"], s.ripples);
    };
    return {
      mode: "webgl2",
      dispose,
      draw(s) {
        const base = Math.round((s.mobile ? BASE / 2 : BASE) * s.scale),
          capacity = Math.round((s.mobile ? SPARKS / 2 : SPARKS) * s.scale);
        if (capacity !== previousCapacity) {
          cursor %= capacity;
          expiry.fill(0, Math.min(capacity, previousCapacity));
          previousCapacity = capacity;
        }
        births.fill(0);
        kicks.fill(0);
        s.emissions.slice(0, SOURCES).forEach((e, i) => {
          const count = Math.min(capacity, Math.round(e.count * s.scale));
          if (cursor + count > capacity) cursor = 0;
          births.set([BASE + cursor, BASE + cursor + count, e.x, e.y], i * 4);
          kicks.set([e.dx, e.dy, e.force, e.mode], i * 4);
          expiry.fill(s.clock + LIFE, cursor, cursor + count);
          cursor = (cursor + count) % capacity;
        });
        let alive = 0;
        for (let i = 0; i < capacity; i++) if (expiry[i] > s.clock) alive++;
        if (maskVersion !== s.maskVersion) {
          gl.bindBuffer(gl.ARRAY_BUFFER, targets);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, s.targets);
          maskVersion = s.maskVersion;
        }
        gl.useProgram(update);
        common(pu, s);
        gl.uniform1f(pu.dt, s.dt);
        gl.uniform1f(pu.base, base);
        gl.uniform1f(pu.reduced, s.reduced ? 1 : 0);
        gl.uniform1f(pu.reset, reset ? 1 : 0);
        gl.uniform4fv(pu["births[0]"], births);
        gl.uniform4fv(pu["kicks[0]"], kicks);
        gl.uniform4fv(pu.blast, s.blast);
        gl.bindVertexArray(stateVAOs[current]);
        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, feedback);
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, states[1 - current]);
        gl.enable(gl.RASTERIZER_DISCARD);
        gl.beginTransformFeedback(gl.POINTS);
        // Age the whole pool so quality recovery cannot resurrect expired sparks.
        gl.drawArrays(gl.POINTS, 0, TOTAL);
        gl.endTransformFeedback();
        gl.disable(gl.RASTERIZER_DISCARD);
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
        current = 1 - current;
        reset = false;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        if (texWidth !== canvas.width || texHeight !== canvas.height) {
          texWidth = canvas.width;
          texHeight = canvas.height;
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA8,
            texWidth,
            texHeight,
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            null,
          );
          gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
          gl.framebufferTexture2D(
            gl.FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D,
            texture,
            0,
          );
          if (
            gl.checkFramebufferStatus(gl.FRAMEBUFFER) !==
            gl.FRAMEBUFFER_COMPLETE
          )
            throw new Error("Vlna: framebuffer");
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(
          gl.SRC_ALPHA,
          gl.ONE_MINUS_SRC_ALPHA,
          gl.ONE,
          gl.ONE_MINUS_SRC_ALPHA,
        );
        gl.useProgram(strings);
        common(su, s);
        gl.bindVertexArray(stringVAO);
        const pixel = canvas.width / Math.max(1, canvas.clientWidth);
        for (const [width, opacity] of [
          [9, 0.07],
          [2.1, 0.82],
        ]) {
          gl.uniform1f(su.width, width * pixel);
          gl.uniform1f(su.glow, opacity);
          gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0);
        }
        gl.useProgram(dots);
        gl.bindVertexArray(stateVAOs[current]);
        gl.uniform1f(du.pixel, pixel);
        gl.uniform1f(du.name, s.name);
        gl.uniform1f(du.dot, s.dotSize);
        gl.blendFuncSeparate(
          gl.SRC_ALPHA,
          gl.ONE,
          gl.ONE,
          gl.ONE_MINUS_SRC_ALPHA,
        );
        gl.drawArrays(gl.POINTS, 0, base);
        gl.drawArrays(gl.POINTS, BASE, capacity);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.disable(gl.BLEND);
        gl.useProgram(screen);
        gl.bindVertexArray(screenVAO);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1i(gu.ink, 0);
        gl.uniform1f(gu.glitch, s.glitch);
        gl.uniform1f(gu.seed, s.glitchSeed);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        return { particles: base + alive, limit: base + capacity };
      },
    };
  } catch {
    dispose();
    return null;
  }
}

function wave2d(x: number, s: number, scene: Scene, aspect: number) {
  const t = scene.time,
    envelope = Math.max(0, Math.sin(x * Math.PI)) ** 1.3;
  let y =
    0.5 +
    envelope *
      (Math.sin(x * 7 - t * 0.38) * 0.15 +
        Math.sin(x * 10 - t * 0.48 + s * 2.2) * 0.18 +
        s * Math.cos(x * 5 + t * 0.27) * 0.13 +
        Math.sin(x * 19 + s * 4 + t * 0.7) * (0.018 + scene.energy * 0.012) +
        Math.sin(x * (24 + s * 9) + t * 1.5 + s * 13) * scene.detune * 0.09);
  for (let i = 0; i < SOURCES * 4; i += 4) {
    const f = scene.fingers,
      w = scene.wakes,
      r = scene.ripples,
      dx = (x - f[i]) * aspect;
    if (f[i + 2] > 0.001) {
      const magnetic = Math.exp(-dx * dx * 4.5) * f[i + 2],
        wake = Math.exp(-dx * dx * 5) * clamp((0.3 - dx * w[i]) / 1) * w[i + 2];
      y +=
        (f[i + 1] - y) * magnetic * 0.45 +
        Math.sin(dx * 9 + s * 2 - t) * magnetic * 0.07;
      y +=
        Math.sin(dx * 15 - t * 1.2 + s * 3) * wake * 0.09 +
        w[i + 1] * wake * 0.04;
    }
    if (r[i + 3] > 0.001) {
      const distance = Math.hypot((x - r[i]) * aspect, (y - r[i + 1]) * 0.65),
        front = distance - r[i + 2] * 0.72;
      y +=
        Math.sin(front * 15) *
        Math.exp(-front * front * 9 - r[i + 2] * 0.8) *
        r[i + 3] *
        0.19;
    }
  }
  return y;
}
function canvas2d(canvas: HTMLCanvasElement): Renderer {
  const ctx = canvas.getContext("2d")!,
    ink = document.createElement("canvas"),
    c = ink.getContext("2d")!;
  const baseMax = 640,
    sparkMax = 320,
    data = new Float32Array((baseMax + sparkMax) * 5);
  let cursor = 0,
    initial = true;
  return {
    mode: "canvas",
    dispose() {
      canvas.width = canvas.height = ink.width = ink.height = 1;
      data.fill(0);
    },
    draw(s) {
      const w = canvas.width,
        h = canvas.height,
        pixel = w / Math.max(1, canvas.clientWidth),
        aspect = w / h;
      if (ink.width !== w || ink.height !== h) {
        ink.width = w;
        ink.height = h;
      }
      c.clearRect(0, 0, w, h);
      for (let line = 0; line < STRANDS; line++) {
        const strand = (line / (STRANDS - 1)) * 2 - 1;
        c.beginPath();
        for (let i = 0; i <= STEPS; i++) {
          const x = i / STEPS,
            y = wave2d(x, strand, s, aspect);
          if (i === 0) c.moveTo(x * w, y * h);
          else c.lineTo(x * w, y * h);
        }
        const fade = c.createLinearGradient(0, 0, w, 0);
        fade.addColorStop(0, "#d5f87900");
        fade.addColorStop(0.14, line % 4 ? "#d5f87999" : "#63ad8290");
        fade.addColorStop(0.8, "#d5f87988");
        fade.addColorStop(1, "#d5f87900");
        c.globalAlpha = 1 - s.name * 0.85;
        c.strokeStyle = fade;
        c.lineWidth = pixel * 0.85;
        c.stroke();
      }
      const base = Math.round(baseMax * s.scale),
        capacity = Math.round(sparkMax * s.scale);
      for (const e of s.emissions)
        for (let n = 0; n < Math.min(capacity, e.count / 12); n++) {
          const i = (baseMax + (cursor++ % capacity)) * 5,
            seed = hash(i + s.clock),
            angle = seed * Math.PI * 2;
          data[i] = e.mode > 0.5 && seed > 0.48 ? hash(i) : e.x;
          data[i + 1] =
            e.mode > 0.5 && seed > 0.48
              ? wave2d(data[i], seed * 2 - 1, s, aspect)
              : e.y;
          data[i + 2] =
            (Math.cos(angle) * (0.12 + seed * 0.36) * e.force) / aspect +
            e.dx * 0.12;
          data[i + 3] =
            Math.sin(angle) * (0.12 + seed * 0.36) * e.force + e.dy * 0.12;
          data[i + 4] = LIFE;
        }
      let alive = 0;
      for (let id = 0; id < baseMax + sparkMax; id++) {
        const i = id * 5,
          dust = id < baseMax,
          seed = hash(id + 1),
          j = hash(id + 19);
        if (initial) {
          data[i] = seed;
          data[i + 1] = wave2d(seed, j * 2 - 1, s, aspect);
        }
        if (id >= baseMax + capacity) {
          data[i + 4] = Math.max(0, data[i + 4] - s.dt);
          continue;
        }
        if (dust) data[i + 4] = id < base ? 1 : 0;
        else data[i + 4] = Math.max(0, data[i + 4] - s.dt);
        if (data[i + 4] <= 0) continue;
        alive++;
        let x = data[i],
          y = data[i + 1],
          vx = data[i + 2],
          vy = data[i + 3];
        vx +=
          (0.035 + Math.sin(y * 9 + s.time * 0.4) * 0.035) *
          s.dt *
          (s.reduced ? 0.15 : 1);
        vy +=
          ((wave2d(x, j * 2 - 1, s, aspect) - y) * 0.5 +
            Math.cos(x * 13 + s.time * 0.5) * 0.025) *
          s.dt *
          (s.reduced ? 0.15 : 1);
        for (let k = 0; k < SOURCES * 4; k += 4)
          if (!s.reduced && s.fingers[k + 2] > 0.001) {
            const dx = (s.fingers[k] - x) * aspect,
              dy = s.fingers[k + 1] - y;
            const force =
              Math.exp(-(dx * dx + dy * dy) * 5) *
              s.fingers[k + 2] *
              (s.fingers[k + 3] ? 6 : 0.8) *
              s.dt;
            vx += ((-dy * 2.5 + dx * 2.1) * force) / aspect;
            vy += (dx * 2.5 + dy * 2.1) * force;
          }
        if (s.blast[3] && !s.reduced) {
          const dx = (x - s.blast[0]) * aspect,
            dy = y - s.blast[1],
            radius = Math.max(0.02, Math.hypot(dx, dy));
          const force =
            (Math.exp(-radius * radius * 1.5) * s.blast[2] * 0.7) / radius;
          vx += (dx * force) / aspect;
          vy += dy * force;
        }
        const target = id * Math.floor(BASE / baseMax) * 2;
        if (dust) {
          vx += (s.targets[target] - x) * s.name * s.dt * 30;
          vy += (s.targets[target + 1] - y) * s.name * s.dt * 30;
        }
        const drag = Math.exp(-s.dt * (dust ? 1.7 + s.name * 11 : 1.1));
        vx *= drag;
        vy *= drag;
        x += vx * s.dt;
        y += vy * s.dt;
        if (dust) {
          x += (s.targets[target] - x) * s.name * s.dt * 7;
          y += (s.targets[target + 1] - y) * s.name * s.dt * 7;
          if (s.name < 0.01 && (x < -0.1 || x > 1.1 || y < -0.3 || y > 1.3)) {
            x = seed;
            y = wave2d(seed, j * 2 - 1, s, aspect);
          }
        }
        data.set([x, y, vx, vy], i);
        c.globalAlpha = dust
          ? 0.28 + s.name * 0.67
          : Math.min(1, data[i + 4] / 0.6);
        c.fillStyle = id % 4 ? "#d5f879" : "#69c697";
        const size = pixel * (dust ? 1.3 + s.name * 1.7 : 2 + seed * 2);
        c.beginPath();
        c.arc(x * w, y * h, size * 0.5, 0, Math.PI * 2);
        c.fill();
      }
      initial = false;
      c.globalAlpha = 1;
      ctx.clearRect(0, 0, w, h);
      if (s.glitch > 0) {
        for (let row = 0; row < 24; row++) {
          const y = Math.floor((row * h) / 24),
            height = Math.ceil(h / 24),
            shift = (hash(row + s.glitchSeed) - 0.5) * w * 0.035 * s.glitch;
          ctx.drawImage(ink, 0, y, w, height, shift, y, w, height);
        }
      } else ctx.drawImage(ink, 0, 0);
      return { particles: alive, limit: base + capacity };
    },
  };
}

export function Vlna() {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current!;
    let canvas = document.createElement("canvas");
    host.append(canvas);
    let renderer = webgl(canvas);
    if (!renderer) {
      const fallback = document.createElement("canvas");
      canvas.replaceWith(fallback);
      canvas = fallback;
      renderer = canvas2d(canvas);
    }
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const stats: Stats = {
      fps: 0,
      frameMs: 0,
      renderScale: 1,
      mode: renderer.mode,
      energy: 0,
      pointers: 0,
      frames: 0,
      running: false,
      reducedMotion: motion.matches,
      particles: 0,
      particleLimit: 0,
      glitch: 0,
      name: 0,
      detune: 0,
      nameBounds: { x: 0, y: 0, width: 1, height: 1 },
    };
    window.__vlnaStats = stats;
    const fingers = new Map<number, Finger>(),
      ripples: Ripple[] = [];
    const scene: Scene = {
      time: 0,
      clock: 0,
      dt: 0.0167,
      energy: 0,
      fingers: new Float32Array(SOURCES * 4),
      wakes: new Float32Array(SOURCES * 4),
      ripples: new Float32Array(SOURCES * 4),
      emissions: [],
      blast: new Float32Array(4),
      detune: 0,
      name: 0,
      glitch: 0,
      glitchSeed: 1,
      reduced: motion.matches,
      scale: 1,
      mobile: false,
      targets: new Float32Array(TOTAL * 2),
      maskVersion: 0,
      dotSize: 2,
    };
    let width = 1,
      height = 1,
      raf = 0,
      last = 0,
      visible = true,
      disposed = false;
    let average = 16.67,
      sampleTime = 0,
      sampleFrames = 0,
      slowFrames = 0,
      fastFrames = 0;
    let interactionAt = performance.now(),
      glitchAt = -10000,
      glitchPower = 0,
      randomAt = interactionAt + 5000,
      detuneUntil = 0,
      emittedAt = 0;
    let tapAt = -1000,
      tapX = 0,
      tapY = 0;
    const mask = document.createElement("canvas");
    mask.width = 720;
    mask.height = 200;
    const nameMask = () => {
      const ctx = mask.getContext("2d", { willReadFrequently: true })!;
      ctx.clearRect(0, 0, 720, 200);
      ctx.fillStyle = "white";
      ctx.font = '800 160px "Manrope", sans-serif';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("mluvka", 360, 100);
      const image = ctx.getImageData(0, 0, 720, 200).data,
        candidates: number[] = [];
      for (let y = 0; y < 200; y += 2)
        for (let x = 0; x < 720; x += 2)
          if (image[(y * 720 + x) * 4 + 3] > 100)
            candidates.push(x / 720, y / 200);
      const mobile = width < 900,
        columns = !mobile || matchMedia("(orientation: landscape)").matches,
        preferredSize = columns ? (mobile ? 0.5 : 0.55) : 0.96;
      const card =
        host.parentElement?.querySelector<HTMLElement>(".login-card");
      const available =
        columns && card
          ? (card.getBoundingClientRect().left -
              host.getBoundingClientRect().left) /
              width -
            0.035
          : 1;
      const size = Math.min(preferredSize, Math.max(0.2, available));
      const box = {
        x: columns ? 0.015 : 0.02,
        y: 0.49 - (((size * width) / height) * (200 / 720)) / 2,
        width: size,
        height: ((size * width) / height) * (200 / 720),
      };
      stats.nameBounds = box;
      for (let id = 0; id < TOTAL; id++) {
        const index = Math.floor((hash(id + 57) * candidates.length) / 2) * 2;
        scene.targets[id * 2] = box.x + (candidates[index] ?? 0.5) * box.width;
        scene.targets[id * 2 + 1] =
          box.y + (candidates[index + 1] ?? 0.5) * box.height;
      }
      scene.maskVersion++;
      scene.dotSize = clamp(
        (mobile && columns ? width * 0.5 : width) / (mobile ? 190 : 530),
        1.6,
        2.8,
      );
    };
    const resize = () => {
      const rect = host.getBoundingClientRect(),
        changed = width !== rect.width || height !== rect.height;
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      scene.mobile = width < 900;
      const pixel = Math.min(devicePixelRatio || 1, 2) * stats.renderScale;
      canvas.width = Math.max(1, Math.round(width * pixel));
      canvas.height = Math.max(1, Math.round(height * pixel));
      if (changed) nameMask();
    };
    void document.fonts.ready.then(() => {
      if (!disposed) nameMask();
    });
    const glitch = (power: number, now: number) => {
      if (motion.matches || now - glitchAt < 460) return;
      glitchAt = now;
      glitchPower = clamp(power);
      scene.glitchSeed = Math.floor(Math.random() * 10000);
    };
    const emit = (
      x: number,
      y: number,
      force: number,
      count: number,
      mode = 0,
      dx = 0,
      dy = 0,
    ) => {
      if (!motion.matches && scene.emissions.length < SOURCES)
        scene.emissions.push({ x, y, force, count, mode, dx, dy });
    };
    const impulse = (x: number, y: number, force: number) => {
      if (motion.matches) return;
      ripples.push({ x, y, age: 0, force: Math.min(2, force) });
      if (ripples.length > SOURCES) ripples.shift();
      scene.energy = Math.min(2, scene.energy + force * 0.65);
      emit(x, y, force, 900, 1);
    };
    const interact = (now: number, x: number, y: number) => {
      if (scene.name > 0.6 && !motion.matches) {
        scene.blast.set([x, y, 0.7, 1]);
        emit(x, y, 1.2, 1400, 1);
        glitch(0.8, now);
      }
      interactionAt = now;
      randomAt = Math.max(randomAt, now + 4000);
    };
    const pointer = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect(),
        x = (event.clientX - rect.left) / width,
        y = (event.clientY - rect.top) / height;
      const old = fingers.get(event.pointerId),
        now = performance.now(),
        inside = x >= 0 && x <= 1 && y >= 0 && y <= 1;
      if (!inside && !old?.down) {
        fingers.delete(event.pointerId);
        return;
      }
      if (
        event.pointerType !== "mouse" &&
        event.target !== canvas &&
        !old?.down
      )
        return;
      if (event.type === "pointerdown" && event.target !== canvas) return;
      if (!old && fingers.size >= SOURCES) return;
      const elapsed = old ? Math.max(8, now - old.at) : 16;
      const dx = old ? clamp(((x - old.tx) * 1000) / elapsed, -3, 3) : 0,
        dy = old ? clamp(((y - old.ty) * 1000) / elapsed, -3, 3) : 0;
      const speed = old
        ? Math.hypot((x - old.tx) * width, (y - old.ty) * height) / elapsed
        : 0;
      const down = event.type === "pointerdown" || !!old?.down;
      interact(now, x, y);
      if (event.type === "pointerdown") {
        canvas.setPointerCapture(event.pointerId);
        impulse(x, y, 1.5);
        glitch(0.9, now);
        if (
          event.isPrimary &&
          now - tapAt < 340 &&
          Math.hypot((x - tapX) * width, (y - tapY) * height) < 40 &&
          !motion.matches
        ) {
          detuneUntil = now + 3800;
          impulse(x, y, 2);
        }
        if (event.isPrimary) {
          tapAt = now;
          tapX = x;
          tapY = y;
        }
      }
      if (!motion.matches)
        scene.energy = Math.min(2, scene.energy + speed * 0.04);
      if (speed > 1.6) {
        glitch(clamp(speed / 4, 0.5, 1), now);
        if (!ripples.length || ripples[ripples.length - 1].age > 0.18)
          impulse(x, y, Math.min(1.6, speed * 0.3));
      }
      if (speed > 0.2)
        emit(
          x,
          y,
          0.6 + Math.min(1, speed * 0.2),
          80 + Math.min(240, speed * 40),
          0,
          dx,
          dy,
        );
      fingers.set(event.pointerId, {
        x: old?.x ?? x,
        y: old?.y ?? y,
        tx: x,
        ty: y,
        vx: old?.vx ?? 0,
        vy: old?.vy ?? 0,
        dx,
        dy,
        speed: motion.matches ? 0 : Math.min(2, speed * 0.4),
        force: motion.matches
          ? 0.1
          : Math.min(1.7, 0.32 + speed * 0.15 + (down ? 0.65 : 0)),
        down,
        at: now,
      });
    };
    const release = (event: PointerEvent) => {
      const f = fingers.get(event.pointerId);
      if (f?.down && event.type === "pointerup") {
        impulse(f.tx, f.ty, 1.2);
        scene.blast.set([f.tx, f.ty, 1.35, motion.matches ? 0 : 1]);
        emit(f.tx, f.ty, 2, 1600, 0, f.dx, f.dy);
        interactionAt = performance.now();
      }
      fingers.delete(event.pointerId);
      if (canvas.hasPointerCapture(event.pointerId))
        canvas.releasePointerCapture(event.pointerId);
    };
    const clear = () => {
      fingers.clear();
      ripples.length = 0;
      scene.emissions.length = 0;
      scene.blast.fill(0);
      scene.energy = scene.glitch = stats.energy = stats.glitch = 0;
      stats.pointers = 0;
      glitchPower = 0;
      interactionAt = performance.now();
    };
    const frame = (now: number) => {
      raf = 0;
      if (disposed || document.hidden || !visible) return;
      const elapsed = last ? now - last : 16.67,
        dt = Math.min(0.04, elapsed / 1000);
      last = now;
      average += (elapsed - average) * 0.06;
      scene.dt = dt;
      scene.clock += dt;
      scene.reduced = motion.matches;
      scene.scale = stats.renderScale;
      scene.time += dt * (motion.matches ? 0.12 : 1);
      scene.energy *= Math.exp(-dt * 1.1);
      const holding = [...fingers.values()].some((f) => f.down);
      const idle = holding ? 0 : (now - interactionAt) / 1000,
        targetName = clamp((idle - 2.6) / 0.6);
      scene.name +=
        (targetName - scene.name) *
        (1 -
          Math.exp(
            -dt * (targetName > scene.name ? 8 : motion.matches ? 3 : 17),
          ));
      scene.detune = motion.matches ? 0 : clamp((detuneUntil - now) / 1600);
      if (now >= randomAt) {
        glitch(0.17, now);
        randomAt = now + 4500 + Math.random() * 4000;
      }
      const glitchAge = now - glitchAt;
      scene.glitch =
        motion.matches || glitchAge < 0 || glitchAge >= 220
          ? 0
          : Math.sin((glitchAge / 220) * Math.PI) * glitchPower;
      scene.fingers.fill(0);
      scene.wakes.fill(0);
      scene.ripples.fill(0);
      let index = 0;
      for (const [id, f] of fingers) {
        f.vx += ((f.tx - f.x) * 90 - f.vx * 13) * dt;
        f.vy += ((f.ty - f.y) * 90 - f.vy * 13) * dt;
        f.x += f.vx * dt;
        f.y += f.vy * dt;
        if (!f.down) f.force *= Math.exp(-dt * 1.5);
        f.speed *= Math.exp(-dt * 2.6);
        if (f.force < 0.008) {
          fingers.delete(id);
          continue;
        }
        scene.fingers.set([f.x, f.y, f.force, f.down ? 1 : 0], index * 4);
        scene.wakes.set([f.dx, f.dy, f.speed, 0], index++ * 4);
        if (f.down && now - emittedAt > 55)
          emit(f.x, f.y, 0.7, 180, 0, f.dx, f.dy);
      }
      if (holding && now - emittedAt > 55) emittedAt = now;
      for (let i = ripples.length - 1; i >= 0; i--) {
        ripples[i].age += dt;
        if (ripples[i].age > 6) ripples.splice(i, 1);
      }
      ripples.forEach((r, i) =>
        scene.ripples.set([r.x, r.y, r.age, r.force], i * 4),
      );
      const rendered = renderer!.draw(scene);
      scene.emissions.length = 0;
      scene.blast.fill(0);
      stats.particles = rendered.particles;
      stats.particleLimit = rendered.limit;
      stats.name = +scene.name.toFixed(4);
      stats.glitch = +scene.glitch.toFixed(4);
      stats.detune = +scene.detune.toFixed(4);
      stats.frames++;
      sampleFrames++;
      sampleTime += elapsed;
      stats.energy = +scene.energy.toFixed(4);
      stats.pointers = fingers.size;
      if (sampleTime >= 500) {
        stats.fps = Math.round((sampleFrames * 1000) / sampleTime);
        stats.frameMs = +average.toFixed(2);
        sampleTime = sampleFrames = 0;
      }
      slowFrames = average > 20 ? slowFrames + 1 : 0;
      fastFrames = average < 17.5 ? fastFrames + 1 : 0;
      if (slowFrames > 30 && stats.renderScale > 0.45) {
        stats.renderScale = Math.max(
          0.45,
          +(stats.renderScale - 0.15).toFixed(2),
        );
        slowFrames = fastFrames = 0;
        resize();
      } else if (fastFrames > 300 && stats.renderScale < 1) {
        stats.renderScale = Math.min(1, +(stats.renderScale + 0.05).toFixed(2));
        fastFrames = 0;
        resize();
      }
      raf = requestAnimationFrame(frame);
    };
    const sync = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      stats.running = !disposed && !document.hidden && visible;
      last = 0;
      sampleTime = sampleFrames = 0;
      if (stats.running) raf = requestAnimationFrame(frame);
      else {
        stats.fps = 0;
        clear();
      }
    };
    const reduced = () => {
      stats.reducedMotion = motion.matches;
      clear();
    };
    const lost = (event: Event) => {
      event.preventDefault();
      if (disposed) return;
      canvas.removeEventListener("webglcontextlost", lost);
      renderer!.dispose();
      const replacement = document.createElement("canvas");
      canvas.replaceWith(replacement);
      canvas = replacement;
      renderer = canvas2d(canvas);
      stats.mode = "canvas";
      clear();
      resize();
    };
    canvas.addEventListener("webglcontextlost", lost);
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      sync();
    });
    intersection.observe(host);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("pointermove", pointer, { passive: true });
    window.addEventListener("pointerdown", pointer, { passive: true });
    window.addEventListener("pointerup", release, { passive: true });
    window.addEventListener("pointercancel", release, { passive: true });
    host.addEventListener("lostpointercapture", release);
    window.addEventListener("blur", clear);
    motion.addEventListener("change", reduced);
    resize();
    sync();
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      stats.running = false;
      stats.fps =
        stats.pointers =
        stats.particles =
        stats.particleLimit =
        stats.name =
        stats.detune =
          0;
      observer.disconnect();
      intersection.disconnect();
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("pointermove", pointer);
      window.removeEventListener("pointerdown", pointer);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      host.removeEventListener("lostpointercapture", release);
      window.removeEventListener("blur", clear);
      motion.removeEventListener("change", reduced);
      canvas.removeEventListener("webglcontextlost", lost);
      clear();
      renderer!.dispose();
      canvas.remove();
      mask.width = mask.height = 1;
    };
  }, []);
  return <div ref={hostRef} className="vlna" aria-hidden="true" />;
}
