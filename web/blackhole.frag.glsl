precision highp float;

uniform vec2 uRes;
uniform float uTime;
uniform vec3 uCam, uRight, uUp, uFwd;
uniform float uTanHalf, uInside, uAbstract, uExposure, uFade, uHasSky;
uniform int uSteps;
uniform sampler2D uSky;
varying vec2 vUv;

const float PI = 3.14159265;

// ---------- procedural noise (all textures are generated, no flat colours) ----------
float hash13(vec3 p3) {
  p3 = fract(p3 * .1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(.1031, .1030, .0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3(1,0,0)), f.x),
        mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x),
        mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec3(11.7, 3.1, 5.3);
    a *= 0.5;
  }
  return s;
}

// Blackbody colour approximation (Kelvin -> sRGB), returned in linear light
vec3 blackbody(float K) {
  float t = clamp(K, 1000.0, 40000.0) / 100.0;
  float r, g, b;
  if (t <= 66.0) { r = 255.0; g = 99.4708 * log(t) - 161.1196; }
  else { r = 329.699 * pow(t - 60.0, -0.1332); g = 288.122 * pow(t - 60.0, -0.0755); }
  if (t >= 66.0) b = 255.0;
  else if (t <= 19.0) b = 0.0;
  else b = 138.518 * log(t - 10.0) - 305.045;
  vec3 c = clamp(vec3(r, g, b) / 255.0, 0.0, 1.0);
  return pow(c, vec3(2.2));
}

// ---------- sky: Milky Way, dust lanes, stars, distant spiral galaxy ----------
vec3 starLayer(vec3 d, float s, float density, float gain) {
  vec3 p = d * s;
  vec3 c = floor(p);
  vec3 f = fract(p);
  vec3 h = hash33(c);
  if (h.x > density) return vec3(0.0);
  vec3 pos = 0.25 + 0.5 * hash33(c + 17.0);
  float dist = length(f - pos);
  float rad = 0.06 + 0.10 * h.y * h.y;
  float mag = 0.25 + 5.0 * pow(h.z, 7.0);
  float I = smoothstep(rad, 0.0, dist) * mag * gain;
  vec3 col = blackbody(mix(3200.0, 14000.0, h.y * h.z + 0.15 * h.x));
  return col * I;
}

vec3 galaxy(vec3 d) {
  vec3 gd = normalize(vec3(-0.55, 0.22, -0.80));
  float facing = dot(d, gd);
  if (facing < 0.9) return vec3(0.0);
  vec3 t1 = normalize(cross(gd, vec3(0, 1, 0)));
  vec3 t2 = cross(gd, t1);
  vec2 q = vec2(dot(d, t1), dot(d, t2)) / 0.075;
  // tilt the disk
  float ca = cos(0.6), sa = sin(0.6);
  q = vec2(ca * q.x - sa * q.y, sa * q.x + ca * q.y);
  q.y *= 2.6;
  float r = length(q);
  float ang = atan(q.y, q.x);
  float arms = 0.5 + 0.5 * sin(2.0 * ang - 5.5 * log(r + 0.15));
  float n = fbm(vec3(q * 2.5, 1.7));
  float core = exp(-r * 4.5);
  float disk = exp(-r * 1.4) * (0.25 + 0.75 * arms) * (0.4 + 0.9 * n);
  vec3 warm = vec3(1.0, 0.82, 0.6), blue = vec3(0.55, 0.7, 1.0);
  return (core * warm * 1.6 + disk * mix(blue, warm, 0.35) * 0.55) * smoothstep(0.9, 0.97, facing);
}

vec3 sky(vec3 d) {
  vec3 col = vec3(0.0012, 0.0015, 0.0026);
  if (uHasSky > 0.5) {
    vec2 uv = vec2(atan(d.z, d.x) / (2.0 * PI) + 0.5, asin(clamp(d.y, -1.0, 1.0)) / PI + 0.5);
    return textureLod(uSky, uv, 0.0).rgb * 2.2 + col;
  }
  vec3 N = normalize(vec3(0.25, 0.85, 0.45));
  vec3 A = normalize(cross(N, vec3(0, 0, 1)));
  vec3 B = cross(N, A);
  float lat = dot(d, N);
  float lon = atan(dot(d, B), dot(d, A));
  float band = exp(-lat * lat / 0.010);
  float cloud = fbm(d * 5.0 + 3.0);
  float fine = fbm(d * 18.0);
  float dust = smoothstep(0.42, 0.68, fbm(d * 9.0 + 9.0 + vec3(0, lat * 6.0, 0)));
  float coreGlow = exp(-lon * lon / 0.9) * exp(-lat * lat / 0.03);
  vec3 mw = mix(vec3(0.55, 0.62, 0.85), vec3(1.0, 0.8, 0.58), clamp(cloud + coreGlow * 0.6, 0.0, 1.0));
  col += mw * band * (0.05 + 0.18 * cloud) * (0.5 + fine) * (1.0 - 0.8 * dust);
  col += mw * coreGlow * 0.10 * (1.0 - 0.7 * dust);
  // unresolved stellar grain
  float grain = pow(vnoise(d * 260.0), 9.0) * (band * 1.6 + 0.08);
  col += vec3(0.9, 0.92, 1.0) * grain * 0.9;
  col += starLayer(d, 55.0, 0.55, 1.0);
  col += starLayer(d, 110.0, 0.5, 0.8);
  col += galaxy(d);
  return col;
}

// ---------- accretion disk ----------
float dens(float a, float rr) {
  vec3 n = vec3(cos(a) * 2.6, sin(a) * 2.6, rr * 2.4);
  float f = fbm(n);
  float g = fbm(n * vec3(2.2, 2.2, 5.0) + 3.7);
  return clamp(0.65 * f + 0.55 * g, 0.0, 1.0);
}

vec4 diskSample(vec3 q, vec3 v) {
  float rr = length(q.xz);
  float ang = atan(q.z, q.x);
  float om = 0.22 * pow(rr / 3.0, -1.5);          // Keplerian shear
  const float Tc = 14.0;                          // flow-map cycle to stop infinite winding
  float t1 = mod(uTime, Tc), t2 = mod(uTime + Tc * 0.5, Tc);
  float w1 = 1.0 - abs(2.0 * t1 / Tc - 1.0);
  float dd = w1 * dens(ang - om * t1, rr) + (1.0 - w1) * dens(ang - om * t2, rr);
  float shape = smoothstep(0.22, 0.8, dd);
  float edgeIn = smoothstep(2.95, 3.7, rr);
  float edgeOut = 1.0 - smoothstep(8.0, 14.0, rr);

  float T0 = 11000.0 * pow(3.0 / rr, 0.75);
  vec3 beta = normalize(vec3(-q.z, 0.0, q.x)) * min(sqrt(0.5 / max(rr - 1.0, 0.2)), 0.62);
  float gam = inversesqrt(1.0 - dot(beta, beta));
  float dop = 1.0 / (gam * (1.0 - dot(beta, -normalize(v))));
  float grav = sqrt(max(1.0 - 1.0 / rr, 0.02));
  float sh = dop * grav;
  vec3 c = blackbody(T0 * sh);
  float I = pow(3.0 / rr, 2.3) * (0.22 + 1.7 * shape) * min(pow(sh, 3.0), 6.0);
  float alpha = clamp((0.12 + 0.88 * shape) * edgeIn * edgeOut, 0.0, 0.97);
  return vec4(c * I * edgeIn * edgeOut * 1.6, alpha);
}

vec3 acesTonemap(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec2 uv = (vUv * 2.0 - 1.0) * vec2(uRes.x / uRes.y, 1.0) * uTanHalf;
  vec3 v = normalize(uFwd + uv.x * uRight + uv.y * uUp);
  vec3 v0 = v;
  vec3 p = uCam;
  float camR = length(p);
  bool camInside = camR < 1.0;
  float hr = camInside ? 0.02 : 1.0;

  vec3 L = cross(p, v);
  float h2 = dot(L, L);

  vec3 col = vec3(0.0);
  float T = 1.0;
  bool escaped = false;
  bool fell = false;

  for (int i = 0; i < 800; i++) {
    if (i >= uSteps) break;
    float r = length(p);
    if (r < hr) { fell = true; break; }
    if (r > 40.0 && dot(p, v) > 0.0) { escaped = true; break; }
    float dt = clamp(0.08 * (r - 0.8), 0.02, 15.0);
    if (camInside) dt = clamp(0.08 * max(r, 0.3), 0.02, 15.0);
    vec3 a = -1.5 * h2 * p / pow(r, 5.0);
    v += a * dt;
    vec3 pn = p + v * dt;
    if (p.y * pn.y < 0.0) {
      float tt = p.y / (p.y - pn.y);
      vec3 q = mix(p, pn, tt);
      float rr = length(q.xz);
      if (rr > 3.0 && rr < 14.0) {
        vec4 e = diskSample(q, v);
        col += T * e.rgb * e.a;
        T *= (1.0 - e.a);
        if (T < 0.015) break;
      }
    }
    p = pn;
  }
  if (!fell && T >= 0.015 && !escaped) escaped = true;   // ran out of steps: treat as escaped

  vec3 dir = normalize(v);
  if (escaped && T >= 0.015) {
    vec3 s = sky(dir);
    // abstract spacetime grid overlay on the lensed sky
    if (uAbstract > 0.0) {
      vec2 g = vec2(atan(dir.z, dir.x), asin(clamp(dir.y, -1.0, 1.0))) * (14.0 / PI);
      vec2 gl = abs(fract(g - 0.5) - 0.5);
      float line = 1.0 - smoothstep(0.0, 0.05, min(gl.x, gl.y));
      s += vec3(0.1, 0.5, 0.9) * line * 0.6 * uAbstract;
      s *= mix(1.0, 0.35, uAbstract);
    }
    col += T * s;
  } else if (fell && uAbstract > 0.0) {
    vec3 ax = -normalize(uCam);
    vec3 t1 = normalize(cross(ax, vec3(0, 1, 0)));
    vec3 t2 = cross(ax, t1);
    float a0 = acos(clamp(dot(v0, ax), -1.0, 1.0));
    float phi = atan(dot(v0, t2), dot(v0, t1));
    float rings = pow(0.5 + 0.5 * sin(log(a0 + 0.03) * 16.0 - uTime * 1.4), 10.0);
    float spokes = pow(abs(sin(phi * 8.0)), 40.0);
    float funnel = exp(-a0 * 2.2);
    vec3 tcol = mix(vec3(0.02, 0.07, 0.28), vec3(0.75, 0.12, 0.45), funnel);
    col += T * tcol * (rings * 0.9 + spokes * 0.5 * funnel + 0.08) * uAbstract;
  }

  // Inside the horizon: the whole outside universe is squeezed into a shrinking, blue-shifted disc
  if (uInside > 0.0) {
    float cosA = dot(v0, normalize(uCam));
    float ang = acos(clamp(cosA, -1.0, 1.0));
    float thetaC = mix(PI, 0.42, uInside);
    float m = 1.0 - smoothstep(thetaC - 0.05, thetaC + 0.03, ang);
    float rim = exp(-pow((ang - thetaC) / 0.05, 2.0)) * uInside;
    col = col * m * (1.0 + 5.0 * uInside) + vec3(0.35, 0.55, 1.0) * rim * 1.4;
  }

  col *= uExposure;
  col = acesTonemap(col);
  col = pow(col, vec3(1.0 / 2.2));
  vec2 vc = vUv - 0.5;
  col *= 1.0 - 0.35 * dot(vc, vc) * 2.0;
  col += (hash13(vec3(gl_FragCoord.xy, uTime * 60.0)) - 0.5) / 255.0;
  gl_FragColor = vec4(col * uFade, 1.0);
}
