import * as THREE from 'three';

const W = 1920, H = 1080;
const qs = new URLSearchParams(location.search);

// ---------------------------------------------------------------- data
const tl = await (await fetch('/data/timeline.json')).json();
let timing = null;
try { const r = await fetch('/build/timing.json'); if (r.ok) timing = await r.json(); } catch (e) { /* estimate */ }
const fragSrc = await (await fetch('/web/blackhole.frag.glsl')).text();

// ---------------------------------------------------------------- WebGL
const glCanvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);

let skyTex = null;
try {
  skyTex = await new THREE.TextureLoader().loadAsync('/assets/textures/sky.jpg');
  skyTex.colorSpace = THREE.SRGBColorSpace;
  skyTex.minFilter = THREE.LinearFilter;
  skyTex.generateMipmaps = false;
  console.log('Using photographic sky texture');
} catch (e) { console.log('No sky texture, using procedural sky'); }
const dummy = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
dummy.needsUpdate = true;

const uniforms = {
  uRes: { value: new THREE.Vector2(W, H) },
  uTime: { value: 0 },
  uCam: { value: new THREE.Vector3() },
  uRight: { value: new THREE.Vector3() },
  uUp: { value: new THREE.Vector3() },
  uFwd: { value: new THREE.Vector3() },
  uTanHalf: { value: 0.5 },
  uInside: { value: 0 },
  uAbstract: { value: 0 },
  uExposure: { value: Number(qs.get('exposure') || 1.3) },
  uFade: { value: 1 },
  uHasSky: { value: skyTex ? 1 : 0 },
  uSteps: { value: 420 },
  uSky: { value: skyTex || dummy },
};
const material = new THREE.ShaderMaterial({
  uniforms,
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: fragSrc,
  depthTest: false, depthWrite: false,
});
const scene = new THREE.Scene();
scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
renderer.debug.onShaderError = (gl, program, vs, fs) => {
  window.__error = 'Shader error: ' + (gl.getProgramInfoLog(program) || '') + ' ' + (gl.getShaderInfoLog(fs) || '');
  console.error(window.__error);
};

// ---------------------------------------------------------------- timeline helpers
const scenes = tl.scenes;
const rad = (d) => d * Math.PI / 180;
const clamp01 = (x) => Math.min(Math.max(x, 0), 1);
const smooth = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };
const sceneAt = (t) => scenes.find((s) => t >= s.start && t < s.end) || scenes[scenes.length - 1];

function camAt(t) {
  const s = sceneAt(t);
  const u0 = (t - s.start) / (s.end - s.start);
  const u = smooth(u0);
  const c = s.cam;
  const lin = (a) => a[0] + (a[1] - a[0]) * u;
  const log = (a) => Math.exp(Math.log(a[0]) + (Math.log(a[1]) - Math.log(a[0])) * u);
  return { s, u0: clamp01(u0), d: log(c.d), az: lin(c.az), el: lin(c.el), fov: lin(c.fov), lb: c.lb ? lin(c.lb) : 0 };
}
const rAt = (t) => camAt(t).d;   // distance in Schwarzschild radii

function applyCamera(t) {
  const c = camAt(t);
  const az = rad(c.az), el = rad(c.el);
  const pos = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).multiplyScalar(c.d);
  const f0 = pos.clone().normalize().negate();
  const worldUp = new THREE.Vector3(0, 1, 0);
  let right = new THREE.Vector3().crossVectors(f0, worldUp).normalize();
  const up0 = new THREE.Vector3().crossVectors(right, f0);
  const th = smooth(c.lb) * Math.PI;
  let fwd = f0.clone().multiplyScalar(Math.cos(th)).add(up0.clone().multiplyScalar(Math.sin(th)));
  // gentle hand-held sway
  fwd.add(right.clone().multiplyScalar(0.0022 * Math.sin(t * 0.9))).add(up0.clone().multiplyScalar(0.0016 * Math.cos(t * 0.7))).normalize();
  right = new THREE.Vector3().crossVectors(fwd, worldUp).normalize();
  if (right.lengthSq() < 0.5) right.set(1, 0, 0);
  const up = new THREE.Vector3().crossVectors(right, fwd).normalize();

  uniforms.uCam.value.copy(pos);
  uniforms.uFwd.value.copy(fwd);
  uniforms.uRight.value.copy(right);
  uniforms.uUp.value.copy(up);
  uniforms.uTanHalf.value = Math.tan(rad(c.fov) / 2);
  uniforms.uInside.value = clamp01((1.12 - c.d) / 0.45);
  const s = c.s;
  uniforms.uSteps.value = s.steps || 420;
  const ex = s.exposure || [1, 1];
  uniforms.uExposure.value = Number(qs.get('exposure') || 1.3) * (ex[0] + (ex[1] - ex[0]) * c.u0);
  uniforms.uAbstract.value = s.abstract ? s.abstract[0] + (s.abstract[1] - s.abstract[0]) * c.u0 : 0;
  let fade = clamp01(t / 1.0);
  if (t > tl.duration - 4) fade *= clamp01((tl.duration - t) / 4);
  uniforms.uFade.value = fade;
  uniforms.uTime.value = t;
  return c;
}

// ---------------------------------------------------------------- 2D overlay
const hud = document.getElementById('hud');
const ctx = hud.getContext('2d');
const SANS = (w, px) => `${w} ${px}px "Helvetica Neue", Helvetica, Arial, "Liberation Sans", "DejaVu Sans", sans-serif`;
const MONO = (px) => `${px}px "DejaVu Sans Mono", "Liberation Mono", Menlo, Consolas, monospace`;
const CYAN = '120,215,255';

const windowAlpha = (t, at, dur, fi = 0.6, fo = 0.8) => {
  if (t < at || t > at + dur) return 0;
  return Math.min(clamp01((t - at) / fi), clamp01((at + dur - t) / fo));
};

function shadowText(txt, x, y, align = 'left') {
  ctx.textAlign = align;
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 14;
  ctx.fillText(txt, x, y);
  ctx.shadowBlur = 0;
}

function drawCockpit(t, c, alpha) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  // window frame
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.roundRect(110, 70, W - 220, H - 140, 160);
  ctx.fillStyle = '#05070a';
  ctx.fill('evenodd');
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, 'rgba(120,140,160,0.55)');
  g.addColorStop(0.5, 'rgba(40,50,60,0.4)');
  g.addColorStop(1, 'rgba(120,140,160,0.55)');
  ctx.strokeStyle = g;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.roundRect(110, 70, W - 220, H - 140, 160);
  ctx.stroke();
  // frame panel lines
  ctx.strokeStyle = 'rgba(90,105,120,0.25)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(60, 38, W - 120, H - 76, 190);
  ctx.stroke();
  // glass reflection
  const gr = ctx.createLinearGradient(0, 70, W * 0.6, H);
  gr.addColorStop(0, 'rgba(255,255,255,0.05)');
  gr.addColorStop(0.35, 'rgba(255,255,255,0)');
  ctx.fillStyle = gr;
  ctx.beginPath();
  ctx.roundRect(110, 70, W - 220, H - 140, 160);
  ctx.fill();
  ctx.restore();

  // telemetry
  ctx.save();
  ctx.globalAlpha = alpha;
  const r = c.d;
  const crossed = r < 1.0;
  ctx.font = MONO(22);
  ctx.fillStyle = `rgba(${CYAN},0.85)`;
  shadowText(`RADIAL DISTANCE  r = ${r.toFixed(r < 10 ? 2 : 1)} rs`, 150, 118);
  shadowText(`T+ ${formatClock(t - scenes[1].start + 0)}`, 150, 148);
  ctx.textAlign = 'right';
  shadowText('TELEMETRY · ILLUSTRATIVE', W - 150, 118, 'right');
  const blink = Math.floor(t * 2) % 2 === 0;
  ctx.fillStyle = crossed ? 'rgba(255,120,80,0.95)' : `rgba(${CYAN},0.85)`;
  shadowText(crossed ? 'INSIDE EVENT HORIZON · NO SIGNAL CAN ESCAPE' : (blink ? '● LINK ACTIVE' : '○ LINK ACTIVE'), W - 150, 148, 'right');
  // reticle
  ctx.strokeStyle = `rgba(${CYAN},0.22)`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(W / 2, H / 2, 46, 0, Math.PI * 2);
  ctx.moveTo(W / 2 - 70, H / 2); ctx.lineTo(W / 2 - 30, H / 2);
  ctx.moveTo(W / 2 + 30, H / 2); ctx.lineTo(W / 2 + 70, H / 2);
  ctx.moveTo(W / 2, H / 2 - 70); ctx.lineTo(W / 2, H / 2 - 30);
  ctx.moveTo(W / 2, H / 2 + 30); ctx.lineTo(W / 2, H / 2 + 70);
  ctx.stroke();
  ctx.restore();
}

function formatClock(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

// ---- scene 6: two clocks
function drawClocks(t, s) {
  const tau = t - s.start;
  let obs = 0;
  for (let k = 0; k < tau; k += 0.1) {
    const r = rAt(s.start + k);
    obs += Math.sqrt(Math.max(0, 1 - 1 / r)) * Math.min(0.1, tau - k);
  }
  const rNow = rAt(t);
  const rate = Math.sqrt(Math.max(0, 1 - 1 / rNow));
  const a = windowAlpha(t, s.start + 4, s.end - s.start - 4.5, 1.0, 1.0);
  if (a <= 0) return;
  ctx.save();
  ctx.globalAlpha = a;
  const panel = (x, title, value, color, sub) => {
    ctx.fillStyle = 'rgba(4,10,16,0.72)';
    ctx.strokeStyle = `rgba(${color},0.6)`;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(x, 770, 480, 150, 14); ctx.fill(); ctx.stroke();
    ctx.fillStyle = `rgba(${color},0.95)`;
    ctx.font = MONO(18);
    ctx.textAlign = 'left';
    ctx.fillText(title, x + 24, 806);
    ctx.font = MONO(54);
    ctx.fillText(value, x + 24, 868);
    ctx.font = MONO(16);
    ctx.fillStyle = 'rgba(200,220,235,0.75)';
    ctx.fillText(sub, x + 24, 900);
  };
  panel(180, 'YOUR CLOCK (ON BOARD)', formatClock(tau), CYAN, 'ticks at the normal rate: 1.00 s / s');
  panel(1260, "DISTANT OBSERVER'S VIEW OF IT", formatClock(obs), '255,150,90', `appears to tick at ${(rate * 100).toFixed(0)}% rate`);
  // rate curve
  const gx = 700, gy = 760, gw = 520, gh = 170;
  ctx.fillStyle = 'rgba(4,10,16,0.72)';
  ctx.strokeStyle = 'rgba(160,190,210,0.4)';
  ctx.beginPath(); ctx.roundRect(gx, gy, gw, gh + 20, 12); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,150,90,0.9)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  for (let i = 0; i <= 100; i++) {
    const r = 6 - 5 * (i / 100) + 0.0001;
    const rt = Math.sqrt(Math.max(0, 1 - 1 / Math.max(r, 1)));
    const x = gx + 30 + (gw - 60) * (i / 100);
    const y = gy + 20 + (gh - 30) * (1 - rt);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  const p = clamp01((6 - rNow) / 5);
  const mx = gx + 30 + (gw - 60) * p, my = gy + 20 + (gh - 30) * (1 - rate);
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(mx, my, 6, 0, Math.PI * 2); ctx.fill();
  ctx.font = MONO(14);
  ctx.fillStyle = 'rgba(200,220,235,0.8)';
  ctx.textAlign = 'left';
  ctx.fillText('observed clock rate  vs  r  (6 rs → 1 rs)', gx + 20, gy + gh + 12);
  ctx.restore();
}

// ---- scene 9: tidal forces (linearised tidal stretch of a rocky body)
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const rnd = mulberry32(12345);
const pts = [];
while (pts.length < 2600) {
  const x = rnd() * 2 - 1, y = rnd() * 2 - 1, z = rnd() * 2 - 1;
  const rr = x * x + y * y + z * z;
  if (rr <= 1) pts.push({ x, y, z, rr: Math.sqrt(rr), tone: rnd(), n: rnd() });
}
const TID_T = 40, TID_DT = 0.02, TID_TARGET = 16;
function solveStretch(c) {
  const K = (tau) => c * Math.exp(0.15 * tau);
  let A = 1, V = 0;
  const out = [1];
  const f = (tau, a) => 2 * K(tau) * a;
  for (let i = 0; i < TID_T / TID_DT; i++) {
    const tau = i * TID_DT, h = TID_DT;
    const k1a = V, k1v = f(tau, A);
    const k2a = V + 0.5 * h * k1v, k2v = f(tau + 0.5 * h, A + 0.5 * h * k1a);
    const k3a = V + 0.5 * h * k2v, k3v = f(tau + 0.5 * h, A + 0.5 * h * k2a);
    const k4a = V + h * k3v, k4v = f(tau + h, A + h * k3a);
    A += h / 6 * (k1a + 2 * k2a + 2 * k3a + k4a);
    V += h / 6 * (k1v + 2 * k2v + 2 * k3v + k4v);
    if (!isFinite(A) || A > 1e6) A = 1e6;
    out.push(A);
  }
  return out;
}
let lo = 1e-6, hi = 5;
for (let i = 0; i < 40; i++) {
  const mid = Math.sqrt(lo * hi);
  const e = solveStretch(mid)[TID_T / TID_DT];
  if (e > TID_TARGET) hi = mid; else lo = mid;
}
const stretchTable = solveStretch(Math.sqrt(lo * hi));

function drawTidal(t, s) {
  const tau = Math.min(t - s.start, TID_T);
  const a = windowAlpha(t, s.start + 1.0, s.end - s.start - 1.5, 1.2, 1.2);
  if (a <= 0) return;
  const A = stretchTable[Math.min(stretchTable.length - 1, Math.round(tau / TID_DT))];
  const B = 1 / Math.sqrt(A);
  const R = 62, cx = W / 2, cy = H / 2 - 20;
  const spin = tau * 0.35;
  const cs = Math.cos(spin), sn = Math.sin(spin);
  const L = [0.7, 0.35, 0.62];
  const items = [];
  for (const p of pts) {
    const rx = p.x * cs - p.z * sn, rz = p.x * sn + p.z * cs;
    const n = [rx / (p.rr + 1e-6), p.y / (p.rr + 1e-6), rz / (p.rr + 1e-6)];
    items.push({ X: cx + rx * R * B, Y: cy + p.y * R * A, Z: rz, n, p });
  }
  items.sort((a1, b1) => a1.Z - b1.Z);
  ctx.save();
  ctx.globalAlpha = a;
  for (const it of items) {
    if (it.Y < -20 || it.Y > H + 20) continue;
    const p = it.p;
    const shade = clamp01((it.n[0] * L[0] + it.n[1] * L[1] + it.n[2] * L[2]) * 0.5 + 0.5);
    const k = (0.18 + 0.95 * shade) * (0.55 + 0.45 * p.rr);
    const grain = 0.75 + 0.5 * p.n;
    const r = Math.min(255, (120 + 70 * p.tone) * k * grain + 30 * shade);
    const g = Math.min(255, (100 + 55 * p.tone) * k * grain + 14 * shade);
    const b = Math.min(255, (88 + 45 * p.tone) * k * grain);
    ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
    const size = (2.0 + 0.9 * (it.Z + 1)) * (1 + 0.04 * Math.min(A, 12));
    ctx.beginPath();
    ctx.arc(it.X, it.Y, size, 0, Math.PI * 2);
    ctx.fill();
  }
  // gravity direction arrow
  ctx.strokeStyle = `rgba(${CYAN},0.55)`;
  ctx.fillStyle = `rgba(${CYAN},0.8)`;
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 8]);
  ctx.beginPath(); ctx.moveTo(W - 260, 300); ctx.lineTo(W - 260, 760); ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(W - 260, 790); ctx.lineTo(W - 274, 760); ctx.lineTo(W - 246, 760); ctx.closePath(); ctx.fill();
  ctx.font = MONO(18);
  ctx.textAlign = 'center';
  shadowText('DIRECTION OF GRAVITY', W - 260, 270, 'center');
  shadowText(`STRETCH × ${A.toFixed(1)}`, W - 260, 830, 'center');
  ctx.restore();
}

// ---- scene 11: distant observer
const pulses = [];
{ let tp = 0; const dur = 50; while (tp < dur) { pulses.push(tp); tp += 1.0 * Math.exp(2.2 * tp / dur); } }
function drawObserver(t, s) {
  const dur = s.end - s.start;
  const u = clamp01((t - s.start) / (dur - 6));
  const c = camAt(t);
  const pxPerUnit = (H / 2) / (Math.tan(rad(c.fov) / 2) * c.d);
  const apparent = 2.6 + 6.4 * Math.exp(-4.2 * u);
  const cx = W / 2 - apparent * pxPerUnit, cy = H / 2 - 36;
  const a = windowAlpha(t, s.start + 0.5, dur - 1.0, 1.0, 1.0);
  if (a <= 0) return;
  const bright = Math.exp(-3.2 * u);
  const col = (k) => {
    const rC = 255, gC = Math.round(235 - 165 * k), bC = Math.round(255 - 225 * k);
    return [rC, gC, bC];
  };
  const [cr, cg, cb] = col(clamp01(u * 1.15));
  ctx.save();
  ctx.globalAlpha = a;
  // signal pulses, ever more delayed
  for (const tp of pulses) {
    const age = (t - s.start) - tp * (dur - 6) / 50;
    if (age < 0 || age > 1.8) continue;
    const pu = clamp01(tp / 50);
    const pb = Math.exp(-3.2 * pu);
    ctx.strokeStyle = `rgba(${cr},${cg},${cb},${(1 - age / 1.8) * pb * 0.8})`;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, 14 + age * 70, 0, Math.PI * 2); ctx.stroke();
  }
  const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, 46);
  rg.addColorStop(0, `rgba(${cr},${cg},${cb},${0.95 * bright})`);
  rg.addColorStop(0.2, `rgba(${cr},${cg},${cb},${0.35 * bright})`);
  rg.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
  ctx.fillStyle = rg;
  ctx.beginPath(); ctx.arc(cx, cy, 46, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = `rgba(255,255,255,${0.6 * bright})`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - 24, cy); ctx.lineTo(cx + 24, cy);
  ctx.moveTo(cx, cy - 24); ctx.lineTo(cx, cy + 24);
  ctx.stroke();
  ctx.font = MONO(16);
  ctx.fillStyle = `rgba(210,225,240,${0.4 + 0.5 * bright})`;
  ctx.textAlign = 'center';
  shadowText('SPACECRAFT (AS SEEN FROM FAR AWAY)', cx, cy + 64, 'center');
  ctx.restore();
}

// ---- labels, titles, subtitles
function drawLabel(l, t, s) {
  const a = windowAlpha(t, s.start + l.at, l.dur, 0.7, 0.8);
  if (a <= 0) return;
  const x = l.x * W, y = l.y * H;
  const slide = (1 - smooth((t - (s.start + l.at)) / 0.7)) * 24;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.translate(-slide, 0);
  ctx.fillStyle = `rgba(${CYAN},0.95)`;
  const w = 4;
  ctx.fillRect(x, y - 44, w, 70);
  ctx.letterSpacing = '5px';
  ctx.font = SANS('700', 34);
  ctx.fillStyle = '#fff';
  shadowText(l.text, x + 22, y - 6);
  ctx.letterSpacing = '1px';
  ctx.font = SANS('400', 22);
  ctx.fillStyle = 'rgba(200,225,240,0.9)';
  shadowText(l.sub || '', x + 22, y + 24);
  ctx.restore();
}

function drawBigText(o, t, s) {
  const a = windowAlpha(t, s.start + o.at, o.dur, 1.0, 1.0);
  if (a <= 0) return;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = '#fff';
  ctx.letterSpacing = `${10 + (1 - a) * 6}px`;
  ctx.font = SANS('700', 62);
  shadowText(o.text, W / 2, 210, 'center');
  ctx.fillStyle = `rgba(${CYAN},0.9)`;
  ctx.fillRect(W / 2 - 90, 236, 180, 3);
  ctx.restore();
}

function activeChunks() {
  if (timing) return timing.scenes.flatMap((s) => s.chunks);
  // fallback estimate: 14 characters per second
  const out = [];
  for (const s of scenes) {
    const sentences = s.narration.match(/[^.?!]+[.?!]?/g) || [s.narration];
    let tt = s.start + 0.6;
    for (const sent of sentences) {
      const d = sent.length / 14;
      out.push({ t0: tt, t1: tt + d, text: sent.trim() });
      tt += d + 0.4;
    }
  }
  return out;
}
const chunks = activeChunks();

function wrap(text, maxW) {
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = w; } else cur = test;
  }
  if (cur) lines.push(cur);
  return lines;
}

function drawSubtitle(t) {
  const ch = chunks.find((c) => t >= c.t0 - 0.05 && t <= c.t1 + 0.25);
  if (!ch) return;
  const a = Math.min(clamp01((t - ch.t0 + 0.05) / 0.15), clamp01((ch.t1 + 0.25 - t) / 0.2));
  ctx.save();
  ctx.globalAlpha = a;
  ctx.letterSpacing = '0px';
  ctx.font = SANS('500', 40);
  const lines = wrap(ch.text.replace(/\s+/g, ' '), 1480);
  const lh = 54;
  const bh = lines.length * lh + 22;
  const by = H - 56 - bh;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  const bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 56;
  ctx.beginPath(); ctx.roundRect(W / 2 - bw / 2, by, bw, bh, 14); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  lines.forEach((l, i) => ctx.fillText(l, W / 2, by + 11 + lh * (i + 0.78)));
  ctx.restore();
}

function drawTitleCard(t) {
  const a = windowAlpha(t, 0.3, 4.9, 0.9, 1.1);
  if (a <= 0) return;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.letterSpacing = '12px';
  ctx.font = SANS('700', 74);
  shadowText('FALLING INTO A BLACK HOLE', W / 2, 250, 'center');
  ctx.letterSpacing = '4px';
  ctx.font = SANS('400', 34);
  ctx.fillStyle = `rgba(${CYAN},0.95)`;
  shadowText('WHAT WOULD YOU ACTUALLY SEE?', W / 2, 306, 'center');
  ctx.restore();
}

function drawEndCard(t) {
  const start = tl.duration - 14;
  const a = Math.min(clamp01((t - start) / 1.5), clamp01((tl.duration - t) / 1.2));
  if (a <= 0) return;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.letterSpacing = '8px';
  ctx.font = SANS('700', 50);
  shadowText(tl.endQuestion, W / 2, H / 2 - 20, 'center');
  ctx.fillStyle = `rgba(${CYAN},0.9)`;
  ctx.fillRect(W / 2 - 120, H / 2 + 6, 240, 3);
  ctx.letterSpacing = '0.5px';
  ctx.font = SANS('400', 22);
  ctx.fillStyle = 'rgba(215,228,240,0.9)';
  shadowText(tl.credits, W / 2, H - 120, 'center');
  ctx.fillStyle = 'rgba(180,196,212,0.8)';
  ctx.font = SANS('400', 20);
  shadowText(tl.disclaimer, W / 2, H - 86, 'center');
  ctx.restore();
}

function drawOpeningDisclaimer(t) {
  const a = windowAlpha(t, 0.5, 6, 1.0, 1.0);
  if (a <= 0) return;
  ctx.save();
  ctx.globalAlpha = a * 0.8;
  ctx.font = SANS('400', 20);
  ctx.letterSpacing = '0.5px';
  ctx.fillStyle = 'rgba(190,205,220,0.9)';
  shadowText(tl.disclaimer, W / 2, H - 28, 'center');
  ctx.restore();
}

function drawOverlay(t, c) {
  ctx.clearRect(0, 0, W, H);
  const s = c.s;
  if (s.cockpit) drawCockpit(t, c, s.id === 2 ? clamp01((t - s.start) / 2.0) : 1);
  if (s.view === 'clock') drawClocks(t, s);
  if (s.view === 'tidal') drawTidal(t, s);
  if (s.view === 'observer') drawObserver(t, s);
  if (s.text) drawBigText(s.text, t, s);
  (s.labels || []).forEach((l) => drawLabel(l, t, s));
  if (t < 6) { drawTitleCard(t); drawOpeningDisclaimer(t); }
  drawEndCard(t);
  drawSubtitle(t);
}

// ---------------------------------------------------------------- public API
window.renderAt = async (t) => {
  const c = applyCamera(t);
  renderer.render(scene, orthoCam);
  renderer.getContext().finish();
  drawOverlay(t, c);
  return true;
};

window.__ready = true;

if (qs.get('t') !== null) window.renderAt(Number(qs.get('t')));
if (qs.get('play')) {
  const t0 = performance.now();
  const loop = () => { window.renderAt(((performance.now() - t0) / 1000) * Number(qs.get('play'))); requestAnimationFrame(loop); };
  loop();
}
