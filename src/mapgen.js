// procedural terrain generator for framed map art, running fully on the GPU:
// the fragment shader evaluates the whole per-pixel pipeline, and river tracing
// runs in prep passes (one parallel trace pass per priority level).
import { getFont, measure, drawText } from "./mcfont.js"

function hash(x, y) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296
}
const smooth = t => t * t * (3 - 2 * t)
function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1)
  const u = smooth(fx), v = smooth(fy)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

const FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp isampler2D;
out vec4 fragColor;

uniform vec2 uCanvas;
uniform vec2 uCenter;
uniform float uScale;

const float uSeaN = 0.49, uRelief = 90.0, uHillMul = 1.0;
const float uDesertT = 0.72, uSnowyT = 0.25, uMountT = 0.6;
const float uGrassMul = 2.0, uGrassCap = 0.2;
uniform float uRiverW;
uniform float uLakeMul;
uniform float uValleyMul;
const float uRockHi = 0.84, uRockLo = 0.13;
const float uTreeMul = 0.6, uCactusMul = 1.0, uClusterChance = 0.4;
const float uIslDepth = 12.0, uIslRegT = 0.75, uIslRegS = 200.0;
const float uIslRough = 0.4, uIslRegRough = 1.5;
const float uHillScale = 110.0, uHillCon = 0.2, uDepthMul = 1.0;

uniform sampler2D uSegs;
uniform sampler2D uSegMeta;
uniform isampler2D uBucketIdx;
uniform isampler2D uIndexArr;
uniform ivec2 uBucket0;
uniform ivec2 uBucketDim;
uniform vec4 uLakes[64];
uniform int uLakeCount;
uniform int uNine; // always 9; a uniform bound keeps 3x3 scans from unrolling

const float SEA = 63.0;

float hashf(int x, int y) {
  uint h = uint(x) * 668265261u ^ uint(y) * 2654435761u;
  h = (h ^ (h >> 15u)) * 2246822507u;
  h = h ^ (h >> 13u);
  return float(h) * 2.3283064365386963e-10;
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  int xi = int(i.x), yi = int(i.y);
  float a = hashf(xi, yi), b = hashf(xi + 1, yi), c = hashf(xi, yi + 1), d = hashf(xi + 1, yi + 1);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y;
}
float fbm3(vec2 p, float f0) {
  float s = 0.0, amp = 0.5, f = f0, tot = 0.0;
  for (int i = 0; i < 3; i++) {
    s += vnoise(vec2(p.x * f + float(i) * 41.3, p.y * f + float(i) * 17.9)) * amp;
    tot += amp; amp *= 0.5; f *= 2.0;
  }
  return s / tot;
}
float fbm1(vec2 p) {
  return vnoise(p / 96.0) * 0.55
    + vnoise(vec2(p.x / 37.0 + 100.7, p.y / 37.0 + 31.1)) * 0.3
    + vnoise(vec2(p.x / 13.0 + 517.3, p.y / 13.0 + 209.4)) * 0.15;
}
float roughF(vec2 p) {
  return fbm1(p) + (vnoise(vec2(p.x / 5.0 + 61.3, p.y / 5.0 + 12.7)) - 0.5) * 0.05;
}
float hillinessF(vec2 p) {
  float raw = fbm3(p + vec2(900.0, 400.0), 1.0 / uHillScale);
  float t = clamp(0.5 + (raw - 0.5) * 2.5 * uHillCon, 0.0, 1.0);
  return (0.5 + t * 1.5) * uHillMul;
}
float mountainF(vec2 p) {
  vec2 c = p + (vec2(vnoise(vec2(p.x / 90.0 + 411.0, p.y / 90.0 + 622.0)),
                     vnoise(vec2(p.x / 90.0 + 260.0, p.y / 90.0 + 133.0))) - 0.5) * 70.0;
  c += (vec2(vnoise(vec2(p.x / 18.0 + 355.0, p.y / 18.0 + 208.0)),
             vnoise(vec2(p.x / 18.0 + 66.0, p.y / 18.0 + 471.0))) - 0.5) * 48.0;
  c += (vec2(vnoise(vec2(p.x / 7.0 + 240.0, p.y / 7.0 + 187.0)),
             vnoise(vec2(p.x / 7.0 + 88.0, p.y / 7.0 + 630.0))) - 0.5) * 18.0;
  float mm = fbm3(c + vec2(9100.0, 3600.0), 1.0 / 300.0);
  return clamp((mm - uMountT) / 0.07, 0.0, 1.0);
}
float biomeF(vec2 p) {
  vec2 a = p + (vec2(vnoise(vec2(p.x / 90.0 + 800.0, p.y / 90.0 + 60.0)),
                     vnoise(vec2(p.x / 90.0 + 55.0, p.y / 90.0 + 910.0))) - 0.5) * 70.0;
  a += (vec2(vnoise(vec2(p.x / 18.0 + 21.0, p.y / 18.0 + 77.0)),
             vnoise(vec2(p.x / 18.0 + 93.0, p.y / 18.0 + 40.0))) - 0.5) * 48.0;
  a += (vec2(vnoise(vec2(p.x / 7.0 + 149.0, p.y / 7.0 + 302.0)),
             vnoise(vec2(p.x / 7.0 + 511.0, p.y / 7.0 + 76.0))) - 0.5) * 18.0;
  return fbm3(a + vec2(5200.0, 8800.0), 1.0 / 260.0);
}
void fields(vec2 p, out float b, out float m, out float hill) {
  b = biomeF(p);
  float D = clamp((b - (uDesertT - 0.08)) / 0.06, 0.0, 1.0);
  float S = clamp(((uSnowyT + 0.08) - b) / 0.06, 0.0, 1.0);
  float sup = (1.0 - D) * (1.0 - S);
  m = sup > 0.0 ? mountainF(p) * sup : 0.0;
  float hb = hillinessF(p);
  hill = mix(hb, min(0.7, hb), D);
  if (m > 0.0) hill = hill * (1.0 - m) + (1.3 + fbm3(p + vec2(3100.0, 5100.0), 1.0 / 130.0) * 1.6) * m;
}

// every loop bound must stay a runtime value: ANGLE fully unrolls constant
// bounds, and with ground() inlined that stalls the GPU process compiling
float nsW, nsOff;
bool nearestSeg(vec2 q, out float dist) {
  ivec2 b = ivec2(int(floor(q.x / 32.0)) - uBucket0.x, int(floor(q.y / 32.0)) - uBucket0.y);
  dist = 1e9;
  if (b.x < 0 || b.y < 0 || b.x >= uBucketDim.x || b.y >= uBucketDim.y) return false;
  ivec2 oc = texelFetch(uBucketIdx, b, 0).xy;
  float bd2 = 55.0 * 55.0;
  int best = -1;
  int cnt = min(oc.y, 192);
  for (int i = 0; i < cnt; i++) {
    int si = texelFetch(uIndexArr, ivec2((oc.x + i) & 2047, (oc.x + i) >> 11), 0).x;
    vec4 s = texelFetch(uSegs, ivec2(si & 1023, si >> 10), 0);
    vec2 e = s.zw - s.xy;
    float len2 = dot(e, e);
    float t = len2 > 0.0 ? clamp(dot(q - s.xy, e) / len2, 0.0, 1.0) : 0.0;
    vec2 dd = q - (s.xy + e * t);
    float d2 = dot(dd, dd);
    if (d2 < bd2) { bd2 = d2; best = si; }
  }
  if (best < 0) return false;
  vec2 meta = texelFetch(uSegMeta, ivec2(best & 1023, best >> 10), 0).xy;
  nsW = meta.x * uRiverW;
  nsOff = meta.y;
  dist = sqrt(bd2);
  return true;
}
float nlR;
bool nearestLake(vec2 q, out float dist) {
  float bd = 55.0;
  bool found = false;
  for (int i = 0; i < uLakeCount; i++) {
    vec4 l = uLakes[i];
    float R = l.z * uLakeMul;
    if (length(q - l.xy) - R * 1.4 - 7.0 > bd) continue;
    float warp = (vnoise(vec2(q.x / 18.0 + l.w * 11.0 + 63.0, q.y / 18.0 + l.w * 5.0 + 29.0)) - 0.5) * R * 0.7
      + (vnoise(vec2(q.x / 7.0 + l.w * 3.0 + 340.0, q.y / 7.0 + l.w * 9.0 + 51.0)) - 0.5) * 6.0
      + (vnoise(vec2(q.x / 3.0 + 720.0, q.y / 3.0 + 233.0)) - 0.5) * 3.0;
    float d = length(q - l.xy) + warp - R;
    if (d < bd) { bd = d; nlR = R; found = true; }
  }
  dist = bd;
  return found;
}
float islandH(vec2 p, float floorH) {
  float excess = (SEA - floorH) - uIslDepth;
  excess += ((vnoise(vec2(p.x / 9.0 + 481.0, p.y / 9.0 + 852.0)) - 0.5) * 7.0
    + (vnoise(vec2(p.x / 3.5 + 77.0, p.y / 3.5 + 615.0)) - 0.5) * 3.0) * uIslRough;
  if (excess <= 0.0) return -1e9;
  float L = vnoise(vec2(p.x / uIslRegS + 233.0, p.y / uIslRegS + 977.0));
  L += ((vnoise(vec2(p.x / 40.0 + 559.0, p.y / 40.0 + 128.0)) - 0.5) * 0.12
    + (vnoise(vec2(p.x / 12.0 + 91.0, p.y / 12.0 + 704.0)) - 0.5) * 0.06) * uIslRegRough;
  float fade = clamp((L - uIslRegT) / 0.08, 0.0, 1.0);
  if (fade <= 0.0) return -1e9;
  return SEA - 8.0 + min(excess * 1.5, 19.0) * fade;
}
float islandHAt(vec2 p) {
  float n1 = roughF(p);
  float raw = SEA + (n1 - uSeaN) * uRelief;
  if (raw >= SEA) return -1e9;
  raw = SEA + (raw - SEA) * uDepthMul;
  return islandH(p, raw);
}

int rockAt(vec2 p) {
  float v = vnoise(vec2(p.x / 10.0 + 911.0, p.y / 10.0 + 141.0))
    + (vnoise(vec2(p.x / 6.0 + 27.0, p.y / 6.0 + 83.0)) - 0.5) * 0.3
    + (vnoise(vec2(p.x / 2.5 + 415.0, p.y / 2.5 + 246.0)) - 0.5) * 0.22;
  return v > uRockHi ? 6 : v < uRockLo ? 7 : 2;
}

// colour ids: 0 grass 1 sand 2 stone 3 snow 4 water 5 ice 6 dirt 7 quartz
// 8 purple 9 plant 10 red
void ground(vec2 pf, out bool water, out float h, out float depth, out int colId, out int biome, out float mtOut) {
  float b, mt, hill;
  fields(pf, b, mt, hill);
  mtOut = mt;
  biome = b > uDesertT ? 1 : b < uSnowyT ? 2 : mt > 0.5 ? 3 : 0;
  float n = roughF(pf);
  float raw = SEA + (n - uSeaN) * uRelief;
  if (raw > SEA) raw = SEA + (raw - SEA) * hill;
  else raw = SEA + (raw - SEA) * uDepthMul;

  vec2 q = pf + (vec2(vnoise(vec2(pf.x / 9.0 + 771.0, pf.y / 9.0 + 333.0)),
                      vnoise(vec2(pf.x / 9.0 + 141.0, pf.y / 9.0 + 909.0))) - 0.5) * 5.0;
  float d; bool hasSeg = nearestSeg(q, d);
  float ld = 1e9; bool hasLake = uLakeCount > 0 && nearestLake(q, ld);

  float infl = 0.0;
  if (hasSeg) { float t = min(1.0, d / 55.0); infl = 1.0 - t * t * (3.0 - 2.0 * t); }
  if (hasLake) { float t = min(1.0, max(0.0, ld) / 40.0); infl = max(infl, 1.0 - t * t * (3.0 - 2.0 * t)); }
  if (infl > 0.0 && raw > SEA) raw = SEA + (raw - SEA) * (1.0 - infl * 0.9);

  float outv = raw;
  float fringe = 1e9;
  if (hasSeg) {
    float swell = vnoise(vec2(pf.x / 55.0 + nsOff, pf.y / 55.0 + nsOff / 2.0));
    float valley = max(2.0 / 0.75, nsW * (0.5 + swell * swell * 1.4)) * uValleyMul;
    float w = valley + max(0.0, raw - SEA) * 0.5;
    if (d < w) { float t = d / w; float s = t * t * (3.0 - 2.0 * t); outv = min(outv, SEA + (raw - SEA) * s); }
    float chan = max(2.0, valley * 0.75);
    float maxd = 2.0 + (nsW - 2.6) / 2.4 * 2.0;
    if (d < chan) { float u = d / chan; outv = min(outv, SEA - maxd * (1.0 - u * u) * (0.5 + swell * swell)); }
    fringe = d - chan;
  }
  if (hasLake) {
    float w = 7.0 + max(0.0, raw - SEA) * 0.5;
    if (ld < w && ld >= 0.0) { float t = ld / w; float s = t * t * (3.0 - 2.0 * t); outv = min(outv, SEA + (raw - SEA) * s); }
    if (ld < 0.0) { float t = min(1.0, -ld / (nlR * 0.8)); outv = min(outv, SEA - 1.0 - 3.5 * t * t * (3.0 - 2.0 * t)); }
    fringe = min(fringe, ld);
  }

  if (raw < SEA) {
    float mi = islandH(pf, raw);
    if (mi > outv) {
      float hi = floor(mi);
      if (hi >= SEA) { water = false; h = hi; depth = 0.0; biome = 4; colId = 8; return; }
      outv = mi;
    }
  }

  h = floor(outv);
  if (h < SEA) {
    if (biome == 2) {
      float gx = (roughF(pf + vec2(1.0, 0.0)) - roughF(pf - vec2(1.0, 0.0))) / 2.0;
      float gy = (roughF(pf + vec2(0.0, 1.0)) - roughF(pf - vec2(0.0, 1.0))) / 2.0;
      float coastD = abs(n - uSeaN) / (length(vec2(gx, gy)) + 1e-6);
      float rim = 3.0 + vnoise(vec2(pf.x / 14.0 + 611.0, pf.y / 14.0 + 227.0)) * 5.0;
      if (n >= uSeaN || coastD < rim) { water = false; h = SEA; depth = 0.0; colId = 5; return; }
    }
    water = true; depth = SEA - h; colId = 4; return;
  }
  water = false; depth = 0.0;
  float a = h - SEA;
  if (biome == 2) { colId = 3; if (h == SEA) h = SEA + 1.0; return; }
  float width = max(2.0, 2.6 + (vnoise(vec2(pf.x / 7.0 + 88.0, pf.y / 7.0 + 41.0)) - 0.5) * 2.4);
  float gx = (roughF(pf + vec2(1.0, 0.0)) - roughF(pf - vec2(1.0, 0.0))) / 2.0;
  float gy = (roughF(pf + vec2(0.0, 1.0)) - roughF(pf - vec2(0.0, 1.0))) / 2.0;
  float coast = abs(n - uSeaN) / (length(vec2(gx, gy)) + 1e-6);
  float nearWater = min(coast, fringe);
  if (biome == 1) {
    colId = 1;
    if (h == SEA && nearWater > 3.0) h = SEA + 1.0;
    return;
  }
  if (biome == 3) {
    colId = coast < width ? 1 : a < 5.0 ? 0 : a < 42.0 ? rockAt(pf) : 3;
    if (h == SEA && (colId != 1 || nearWater > 3.0)) h = SEA + 1.0;
    return;
  }
  bool onBank = fringe < width;
  float roll = onBank
    ? vnoise(vec2(pf.x / 55.0 + 311.0, pf.y / 55.0 + 707.0)) + (vnoise(vec2(pf.x / 5.0 + 3.0, pf.y / 5.0 + 9.0)) - 0.5) * 0.12
    : 0.5;
  colId = (coast < width || roll > 0.62) ? 1
    : roll < 0.38 ? 2
    : a < 26.0 ? 0 : a < 33.0 ? rockAt(pf) : 3;
  if (h == SEA && ((colId != 1 && colId != 2) || nearWater > 3.0)) h = SEA + 1.0;
}

bool cornerKept(ivec2 tp, ivec2 d, int layer) {
  return hashf(tp.x * 8 + (d.x > 0 ? 1 : 0) + (d.y > 0 ? 2 : 0), tp.y * 8 + layer) < 0.5;
}
float oakTop(ivec2 tp, float top, ivec2 wp) {
  ivec2 d = wp - tp;
  int ax = abs(d.x), ay = abs(d.y);
  int m = max(ax, ay);
  if (m > 2) return -1.0;
  if (m <= 1) {
    if (ax == 1 && ay == 1) return cornerKept(tp, d, 1) ? top - 1.0 : top - 2.0;
    return top;
  }
  if (ax == 2 && ay == 2) {
    if (cornerKept(tp, d, 2)) return top - 2.0;
    if (cornerKept(tp, d, 3)) return top - 3.0;
    return -1.0;
  }
  return top - 2.0;
}
float spruceTop(ivec2 tp, float top, ivec2 wp) {
  ivec2 d = wp - tp;
  int ax = abs(d.x), ay = abs(d.y);
  int m = max(ax, ay);
  if (m > 2) return -1.0;
  if (m == 0) return top;
  if (m == 1) {
    if (ax == 1 && ay == 1) return cornerKept(tp, d, 1) ? top - 2.0 : top - 3.0;
    return top - 2.0;
  }
  if (ax == 2 && ay == 2) return cornerKept(tp, d, 2) ? top - 4.0 : -1.0;
  return top - 4.0;
}

// candidates append to the shared worklist so ground() is inlined exactly once;
// 3x3 scans run under a uniform bound (uNine) because constant bounds unroll
ivec2 posArr[20];
float metaSeed[20];
int metaType[20];  // -1 terrain sample, 0 oak/cactus, 1 spruce
int metaOwner[20];
int posN;
void gatherFor(ivec2 wp, int owner, int pxBiome) {
  ivec2 cc = ivec2(int(floor(float(wp.x) / 4.0)), int(floor(float(wp.y) / 4.0)));
  for (int jj = 0; jj < uNine; jj++) {
    ivec2 c = cc + ivec2(jj % 3 - 1, jj / 3 - 1);
    vec2 jit = vec2(hashf(c.x * 2 + 1, c.y * 2 + 7), hashf(c.x * 2 + 13, c.y * 2 + 3));
    ivec2 tp = ivec2(floor((vec2(c) + jit) * 4.0));
    ivec2 d = wp - tp;
    if (abs(d.x) > 2 || abs(d.y) > 2) continue;
    if (pxBiome == 1 && (d.x != 0 || d.y != 0)) continue;
    float roll = hashf(c.x + 101, c.y + 211);
    float dens;
    if (pxBiome == 1) {
      dens = (0.06 + vnoise(vec2(float(tp.x) / 30.0 + 640.0, float(tp.y) / 30.0 + 320.0)) * 0.12) * uCactusMul;
    } else {
      float ex = fbm3(vec2(tp) + vec2(4400.0, 2100.0), 1.0 / 85.0);
      float t = clamp((ex - 0.5) / 0.16, 0.0, 1.0);
      dens = t * (0.3 + vnoise(vec2(float(tp.x) / 26.0 + 71.0, float(tp.y) / 26.0 + 19.0)) * 0.85) * uTreeMul;
    }
    if (roll > dens) continue;
    if (posN < 20) {
      posArr[posN] = tp;
      metaSeed[posN] = hashf(c.x + 55, c.y + 77);
      metaType[posN] = 0;
      metaOwner[posN] = owner;
      posN++;
    }
  }
  ivec2 kc = ivec2(int(floor(float(wp.x) / 20.0)), int(floor(float(wp.y) / 20.0)));
  for (int jj = 0; jj < uNine; jj++) {
    ivec2 c = kc + ivec2(jj % 3 - 1, jj / 3 - 1);
    if (hashf(c.x + 771, c.y + 445) >= uClusterChance) continue;
    vec2 ctrF = (vec2(c) + vec2(hashf(c.x * 3 + 1, c.y * 3 + 7), hashf(c.x * 3 + 13, c.y * 3 + 5))) * 20.0;
    ivec2 c0 = ivec2(floor(ctrF));
    if (abs(wp.x - c0.x) > 9 || abs(wp.y - c0.y) > 9) continue;
    float b = biomeF(vec2(c0));
    if (b > uDesertT || b < uSnowyT || mountainF(vec2(c0)) <= 0.5) continue;
    int count = 2 + int(hashf(c.x + 909, c.y + 121) * 5.0);
    for (int t = 0; t < count; t++) {
      float ang = hashf(c.x * 7 + t, c.y * 5 + 3) * 6.283185307179586;
      float rad = hashf(c.x * 11 + t, c.y * 9 + 8) * 6.0;
      ivec2 tp = ivec2(floor(vec2(c0) + vec2(cos(ang), sin(ang)) * rad));
      ivec2 d = wp - tp;
      if (abs(d.x) > 2 || abs(d.y) > 2) continue;
      if (posN < 20) {
        posArr[posN] = tp;
        metaSeed[posN] = hashf(tp.x + 17, tp.y + 29);
        metaType[posN] = 1;
        metaOwner[posN] = owner;
        posN++;
      }
    }
  }
}
float capsAt(ivec2 wp, out int kind) {
  kind = 0;
  float best = -1.0;
  vec2 p = vec2(wp);
  if (islandHAt(p) < SEA - 6.0) return best;
  ivec2 cc = ivec2(int(floor(p.x / 8.0)), int(floor(p.y / 8.0)));
  for (int jj = 0; jj < uNine; jj++) {
    ivec2 c = cc + ivec2(jj % 3 - 1, jj / 3 - 1);
    if (hashf(c.x + 1201, c.y + 344) >= 0.55) continue;
    vec2 mp = floor((vec2(c) + vec2(hashf(c.x * 5 + 21, c.y * 5 + 8), hashf(c.x * 5 + 3, c.y * 5 + 14))) * 8.0);
    int ax = int(abs(p.x - mp.x)), ay = int(abs(p.y - mp.y));
    int ch = max(ax, ay);
    if (ch > 3) continue;
    float base = islandHAt(mp);
    if (base < SEA + 1.0) continue;
    bool red = hashf(int(mp.x) * 3 + 7, int(mp.y) * 3 + 11) < 0.5;
    float top = floor(base) + (red ? 6.0 : 5.0) + floor(hashf(int(mp.x) + 3, int(mp.y) + 8) * 2.0);
    if (red) {
      if (ch <= 1 && top > best) { best = top; kind = 2; }
      else if (ch == 2 && !(ax == 2 && ay == 2) && top - 1.0 > best) { best = top - 1.0; kind = 2; }
    } else if (ch <= 3 && !(ax == 3 && ay == 3) && top > best) {
      best = top; kind = 3;
    }
  }
  return best;
}

bool hasGrass(ivec2 wp) {
  vec2 p = vec2(wp);
  float ge = fbm3(p + vec2(7700.0, 3300.0), 1.0 / 70.0);
  float t = clamp((ge - 0.52) / 0.2, 0.0, 1.0);
  float dens = (0.05 + t * (0.06 + vnoise(vec2(p.x / 22.0 + 401.0, p.y / 22.0 + 55.0)) * 0.24)) * uGrassMul;
  dens = uGrassCap * tanh(dens / max(uGrassCap, 0.001));
  return hashf(wp.x + 5501, wp.y + 9077) < dens;
}

float rH[20]; float rD[20]; int rC[20]; int rB[20]; bool rW[20];

vec3 palette(int id) {
  return id == 0 ? vec3(127.0, 178.0, 56.0)
    : id == 1 ? vec3(247.0, 233.0, 163.0)
    : id == 2 ? vec3(112.0, 112.0, 112.0)
    : id == 3 ? vec3(255.0, 255.0, 255.0)
    : id == 4 ? vec3(64.0, 64.0, 255.0)
    : id == 5 ? vec3(160.0, 160.0, 255.0)
    : id == 6 ? vec3(151.0, 109.0, 77.0)
    : id == 7 ? vec3(255.0, 252.0, 245.0)
    : id == 8 ? vec3(127.0, 63.0, 178.0)
    : id == 9 ? vec3(0.0, 124.0, 0.0)
    : vec3(153.0, 51.0, 51.0);
}

void main() {
  vec2 sp = vec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y);
  vec2 world = uCenter + (sp - uCanvas * 0.5) / uScale;
  ivec2 wp = ivec2(floor(world));
  ivec2 np = wp + ivec2(0, -1);

  // the worklist appends to itself mid-loop; ground() has exactly one call site
  posArr[0] = wp; metaType[0] = -1; metaOwner[0] = 0;
  posArr[1] = np; metaType[1] = -1; metaOwner[1] = 1;
  posN = 2;
  for (int i = 0; i < posN; i++) {
    bool gw; float gh, gd; int gc, gb; float gm;
    ground(vec2(posArr[i]), gw, gh, gd, gc, gb, gm);
    rW[i] = gw; rH[i] = gh; rD[i] = gd; rC[i] = gc; rB[i] = gb;
    if (i == 0 && (!gw || gd <= 2.5)) gatherFor(wp, 0, gb);
    if (i == 1 && (!gw || gd <= 2.5)) gatherFor(np, 1, gb);
  }

  float topP = -1.0, topN = -1.0;
  int kindP = 0, kindN = 0;
  int ck;
  float cap = capsAt(wp, ck);
  if (cap > topP) { topP = cap; kindP = ck; }
  cap = capsAt(np, ck);
  if (cap > topN) { topN = cap; kindN = ck; }
  for (int i = 2; i < posN; i++) {
    if (rW[i]) continue;
    float gh = rH[i]; int gc = rC[i]; int gb = rB[i];
    float a = gh - SEA;
    ivec2 owner = metaOwner[i] == 0 ? wp : np;
    float lt = -1.0;
    if (metaType[i] == 1) {
      if (!(gb == 4 || gc == 1 || gc == 3 || a < 2.0 || a > 34.0))
        lt = spruceTop(posArr[i], gh + 6.0 + floor(metaSeed[i] * 3.0), owner);
    } else if (gb == 1) {
      if (gc == 1 && a >= 1.0) lt = gh + 1.0 + floor(metaSeed[i] * 3.0);
    } else if ((gc == 0 || gc == 3) && a >= 2.0 && a <= 24.0) {
      lt = oakTop(posArr[i], gh + 4.0 + floor(metaSeed[i] * 3.0), owner);
    }
    if (metaOwner[i] == 0) { if (lt > topP) { topP = lt; kindP = 1; } }
    else if (lt > topN) { topN = lt; kindN = 1; }
  }

  bool water; float h; float depth = 0.0; int colId;
  float surfP = rW[0] ? SEA : rH[0];
  if (kindP > 0 && topP > surfP) {
    water = false; h = topP;
    colId = kindP == 2 ? 10 : kindP == 3 ? 6 : (rB[0] == 2 ? 3 : 9);
  } else if (rW[0]) {
    water = true; h = rH[0]; depth = rD[0]; colId = rC[0];
  } else {
    water = false;
    if (rC[0] == 0 && hasGrass(wp)) { h = rH[0] + 1.0; colId = 9; }
    else { h = rH[0]; colId = rC[0]; }
  }
  bool nWater; float nH;
  float surfN = rW[1] ? SEA : rH[1];
  if (kindN > 0 && topN > surfN) { nWater = false; nH = topN; }
  else if (rW[1]) { nWater = true; nH = 0.0; }
  else if (rC[1] == 0 && hasGrass(np)) { nWater = false; nH = rH[1] + 1.0; }
  else { nWater = false; nH = rH[1]; }

  int br;
  if (water) {
    float diff = depth * 0.1 + float((wp.x + wp.y) & 1) * 0.2;
    br = diff < 0.5 ? 2 : diff > 0.9 ? 0 : 1;
  } else if (nWater) {
    br = 1;
  } else {
    float diff = (h - nH) * 0.8 + (float((wp.x + wp.y) & 1) - 0.5) * 0.4;
    br = diff > 0.6 ? 2 : diff < -0.6 ? 0 : 1;
  }
  float mm = br == 2 ? 255.0 : br == 1 ? 220.0 : 180.0;
  fragColor = vec4(palette(colId) * mm / (255.0 * 255.0), 1.0);
}`

const VERT = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const PREP_COMMON = `#version 300 es
precision highp float;
precision highp int;
precision highp isampler2D;
const float uSeaN = 0.49;
float hashf(int x, int y) {
  uint h = uint(x) * 668265261u ^ uint(y) * 2654435761u;
  h = (h ^ (h >> 15u)) * 2246822507u;
  h = h ^ (h >> 13u);
  return float(h) * 2.3283064365386963e-10;
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  int xi = int(i.x), yi = int(i.y);
  float a = hashf(xi, yi), b = hashf(xi + 1, yi), c = hashf(xi, yi + 1), d = hashf(xi + 1, yi + 1);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y;
}
float fbm1(vec2 p) {
  return vnoise(p / 96.0) * 0.55
    + vnoise(vec2(p.x / 37.0 + 100.7, p.y / 37.0 + 31.1)) * 0.3
    + vnoise(vec2(p.x / 13.0 + 517.3, p.y / 13.0 + 209.4)) * 0.15;
}
vec2 gradF(vec2 p) {
  return vec2((fbm1(p + vec2(1.5, 0.0)) - fbm1(p - vec2(1.5, 0.0))) / 3.0,
              (fbm1(p + vec2(0.0, 1.5)) - fbm1(p - vec2(0.0, 1.5))) / 3.0);
}
`

// one fragment per source cell: a jittered dart projected onto the coastline
const CAND_FRAG = PREP_COMMON + `
out vec4 o;
uniform vec2 uCell0;
uniform float uSCell;
void main() {
  ivec2 cc = ivec2(uCell0) + ivec2(gl_FragCoord.xy);
  vec2 pp = (vec2(cc) + vec2(hashf(cc.x * 7 + 1, cc.y * 7 + 4), hashf(cc.x * 7 + 2, cc.y * 7 + 5))) * uSCell;
  o = vec4(0.0);
  if (abs(fbm1(pp) - uSeaN) > 0.1) return;
  vec2 x = pp;
  bool okc = false;
  for (int i = 0; i < 24; i++) {
    float v = fbm1(x) - uSeaN;
    if (abs(v) < 0.002) { okc = true; break; }
    vec2 g = gradF(x);
    float gn = length(g) + 1e-9;
    x -= g / gn * clamp(v / gn, -40.0, 40.0);
  }
  if (!okc || distance(x, pp) > uSCell * 1.4) return;
  o = vec4(x, hashf(cc.x * 29 + 11, cc.y * 31 + 17), 1.0);
}`

// one fragment per (river, path column): each re-walks its river up to its own
// column, so a whole priority level traces in a single parallel pass
const TRACE_FRAG = PREP_COMMON + `
uniform sampler2D uSrcList;
uniform sampler2D uSegs;
uniform isampler2D uBucketIdx;
uniform isampler2D uIndexArr;
uniform ivec2 uBucket0;
uniform ivec2 uBucketDim;
uniform vec4 uLakes[64];
uniform int uLakeCount;
uniform int uBudget;
uniform int uAttempts; // always 3; runtime bound keeps the walk from unrolling
uniform float uRLimit;
uniform float uMeander;
out vec4 o;

vec2 nsPt, nsTan;
bool nearestSegT(vec2 q, float r, out float dist) {
  float bd2 = r * r;
  bool found = false;
  int g0x = int(floor((q.x - r) / 32.0)) - uBucket0.x, g1x = int(floor((q.x + r) / 32.0)) - uBucket0.x;
  int g0y = int(floor((q.y - r) / 32.0)) - uBucket0.y, g1y = int(floor((q.y + r) / 32.0)) - uBucket0.y;
  for (int gy = g0y; gy <= g1y; gy++) for (int gx = g0x; gx <= g1x; gx++) {
    if (gx < 0 || gy < 0 || gx >= uBucketDim.x || gy >= uBucketDim.y) continue;
    ivec2 oc = texelFetch(uBucketIdx, ivec2(gx, gy), 0).xy;
    for (int i = 0; i < oc.y; i++) {
      int si = texelFetch(uIndexArr, ivec2((oc.x + i) & 2047, (oc.x + i) >> 11), 0).x;
      vec4 sg = texelFetch(uSegs, ivec2(si & 1023, si >> 10), 0);
      vec2 e = sg.zw - sg.xy;
      float len2 = dot(e, e);
      float t = len2 > 0.0 ? clamp(dot(q - sg.xy, e) / len2, 0.0, 1.0) : 0.0;
      vec2 cp = sg.xy + e * t;
      vec2 dd = q - cp;
      float d2 = dot(dd, dd);
      if (d2 < bd2) { bd2 = d2; nsPt = cp; nsTan = e; found = true; }
    }
  }
  dist = sqrt(bd2);
  return found;
}
bool lakeHit(vec2 q) {
  for (int i = 0; i < uLakeCount; i++) {
    if (distance(q, uLakes[i].xy) < uLakes[i].z) return true;
  }
  return false;
}
bool oceanish(vec2 q) {
  int wet = 0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7853981633974483;
    if (fbm1(q + vec2(cos(a), sin(a)) * 30.0) < uSeaN - 0.005) wet++;
  }
  for (int i = 0; i < 4; i++) {
    float a = float(i) * 1.5707963267948966 + 0.4;
    if (fbm1(q + vec2(cos(a), sin(a)) * 60.0) < uSeaN - 0.005) wet++;
  }
  return wet >= 7;
}

void main() {
  int row = int(gl_FragCoord.y);
  int col = int(gl_FragCoord.x);
  o = vec4(0.0);
  vec4 t0 = texelFetch(uSrcList, ivec2((row * 2) & 1023, (row * 2) >> 10), 0);
  if (t0.w < 0.5) return;
  float pri = t0.z;
  int aBase = int(t0.w + 0.5) - 1;
  for (int attempt = aBase; attempt < uAttempts; attempt++) {
    float seed = pri * 977.0 + float(attempt) * 101.0;
    vec2 g0 = gradF(t0.xy);
    vec2 h = g0 / (length(g0) + 1e-9);
    vec2 pos = t0.xy;
    bool ended = false, joined = false, segJoin = false, dropRiver = false;
    int nearSteps = 0, wetSteps = 0;
    int redHits = 0, redTot = 0;
    int len = 0;
    vec2 emitPos = vec2(0.0);
    float emitStatus = 0.0;
    vec2 joinPos = vec2(0.0);
    if (col == 0) { emitPos = pos; emitStatus = 1.0; }
    for (int step = 0; step < uBudget; step++) {
      float run = float(step) * 3.0;
      float m = ((vnoise(vec2(pos.x / 105.0 + seed * 13.7, pos.y / 105.0 + seed * 5.1)) - 0.5) * 0.7
        + (vnoise(vec2(pos.x / 34.0 + seed * 7.3 + 51.0, pos.y / 34.0 + seed * 3.9 + 12.0)) - 0.5) * 1.2
        + (vnoise(vec2(pos.x / 12.0 + seed * 2.1 + 260.0, pos.y / 12.0 + seed * 9.4 + 83.0)) - 0.5) * 0.7) * uMeander;
      vec2 d = h + vec2(-h.y, h.x) * m;
      vec2 g = gradF(pos);
      float gn = length(g) + 1e-9;
      if (run < 140.0) d += g / gn * 0.5;
      else if (float(step) > float(uBudget) * 0.55) {
        float w = min(1.0, (float(step) / float(uBudget) - 0.55) * 3.0) * 0.7;
        d -= g / gn * w;
      }
      float nd = 1e9;
      bool near = run > 140.0 && nearestSegT(pos, 20.0, nd);
      if (near) {
        vec2 t = nsTan / (length(nsTan) + 1e-9);
        if (dot(t, h) < 0.0) t = -t;
        vec2 a2 = nsPt + t * 9.0 - pos;
        d += a2 / (length(a2) + 1e-9) * (1.0 - nd / 20.0) * 1.4;
      }
      d /= (length(d) + 1e-9);
      float crossv = h.x * d.y - h.y * d.x;
      float dotv = clamp(dot(h, d), -1.0, 1.0);
      float turn = clamp(atan(crossv, dotv), -0.28, 0.28);
      float cs = cos(turn), sn = sin(turn);
      h = vec2(h.x * cs - h.y * sn, h.x * sn + h.y * cs);
      pos += h * 3.0;
      len = step + 1;
      if (col == len) { emitPos = pos; emitStatus = 1.0; }
      if ((step & 3) == 0) {
        redTot++;
        float rd;
        if (nearestSegT(pos, 16.0, rd)) redHits++;
      }
      nearSteps = near ? nearSteps + 1 : 0;
      if (near && (nd < 7.0 || nearSteps > 8)) {
        float rd2;
        nearestSegT(pos, 20.0, rd2);
        joinPos = nsPt;
        ended = true; joined = true; segJoin = true;
        break;
      }
      if (run > 140.0 && lakeHit(pos)) { ended = true; joined = true; break; }
      float f = fbm1(pos);
      if (run > 140.0 && f < uSeaN - 0.004 && oceanish(pos)) { ended = true; break; }
      wetSteps = f < uSeaN ? wetSteps + 1 : 0;
      if (run <= 140.0 && wetSteps > 8) { dropRiver = true; break; }
      if (distance(pos, t0.xy) > uRLimit) break;
    }
    if (!dropRiver && float(len) * 3.0 < 110.0) dropRiver = true;
    if (!dropRiver && redTot > 0 && float(redHits) / float(redTot) > 0.3) dropRiver = true;
    if (dropRiver) continue;
    int endCol = segJoin ? len + 1 : len;
    float endSt = joined ? 2.0 : (ended ? 4.0 : 5.0);
    if (col == endCol) o = vec4(segJoin ? joinPos : emitPos, float(attempt), endSt);
    else if (col < endCol && emitStatus > 0.0) o = vec4(emitPos, 0.0, 1.0);
    return;
  }
}`

function createRenderer(canvas) {
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false })
  if (!gl) throw new Error("webgl2 unavailable")
  const compile = (type, src) => {
    const sh = gl.createShader(type)
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh))
    return sh
  }
  const prog = gl.createProgram()
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT))
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog))
  gl.useProgram(prog)
  const U = name => gl.getUniformLocation(prog, name)

  const mkTex = unit => {
    const t = gl.createTexture()
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  mkTex(0); mkTex(1); mkTex(2); mkTex(3)
  gl.uniform1i(U("uSegs"), 0); gl.uniform1i(U("uSegMeta"), 1)
  gl.uniform1i(U("uBucketIdx"), 2); gl.uniform1i(U("uIndexArr"), 3)
  gl.uniform1i(U("uNine"), 9)
  gl.uniform1f(U("uRiverW"), 1); gl.uniform1f(U("uLakeMul"), 1); gl.uniform1f(U("uValleyMul"), 1)

  const pad = (arr, Ctor, stride, width) => {
    const rows = Math.max(1, Math.ceil((arr.length / stride) / width))
    const out = new Ctor(width * rows * stride)
    out.set(arr)
    return { out, rows }
  }

  // ---- GPU river prep --------------------------------------------------------
  if (!gl.getExtension("EXT_color_buffer_float")) throw new Error("EXT_color_buffer_float unavailable")
  const linkProg = frag => {
    const p = gl.createProgram()
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT))
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, frag))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p))
    return p
  }
  const candProg = linkProg(CAND_FRAG)
  const traceProg = linkProg(TRACE_FRAG)
  const UP = (p, n) => gl.getUniformLocation(p, n)
  const fbo = gl.createFramebuffer()
  const prepTex = () => {
    const t = gl.createTexture()
    gl.activeTexture(gl.TEXTURE15)
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }
  const texTarget = prepTex(), texSrcList = prepTex(), texTSegs = prepTex(), texTBucket = prepTex(), texTIndex = prepTex()
  const bindAt = (unit, t) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t) }
  gl.useProgram(traceProg)
  gl.uniform1i(UP(traceProg, "uSrcList"), 8)
  gl.uniform1i(UP(traceProg, "uSegs"), 9)
  gl.uniform1i(UP(traceProg, "uBucketIdx"), 10)
  gl.uniform1i(UP(traceProg, "uIndexArr"), 11)
  gl.uniform1i(UP(traceProg, "uAttempts"), 3)
  gl.useProgram(prog)

  const runPass = (w, h) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.activeTexture(gl.TEXTURE15)
    gl.bindTexture(gl.TEXTURE_2D, texTarget)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texTarget, 0)
    gl.viewport(0, 0, w, h)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    const out = new Float32Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, out)
    return out
  }

  const SEA_N = 0.49
  const fbm1 = (x, y) => noise(x / 96, y / 96) * 0.55
    + noise(x / 37 + 100.7, y / 37 + 31.1) * 0.3
    + noise(x / 13 + 517.3, y / 13 + 209.4) * 0.15
  const NK = (x, y) => (x + 33554432) * 67108864 + (y + 33554432)
  function prepareRivers(rect, rp) {
    const t0 = performance.now()

    // flood-fill gates: connectivity is what matters, so a fragmented
    // archipelago sea still counts as ocean
    const wet16 = new Map()
    const wetCell = (cx, cy) => {
      const k = NK(cx, cy)
      let v = wet16.get(k)
      if (v === undefined) wet16.set(k, v = fbm1(cx * 16 + 8, cy * 16 + 8) < SEA_N)
      return v
    }
    const bigWaterMemo = new Map(), bigLandMemo = new Map()
    const bigBody = (x, y, wantWet, minCells, memo) => {
      const sx = Math.floor(x / 16), sy = Math.floor(y / 16)
      const memoKey = NK(sx, sy)
      const memod = memo.get(memoKey)
      if (memod !== undefined) return memod
      const seen = new Set([memoKey])
      const queue = [[sx, sy]]
      let big = false
      while (queue.length && !big) {
        const [cx, cy] = queue.pop()
        for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + ox, ny = cy + oy
          const k = NK(nx, ny)
          if (seen.has(k)) continue
          if (wetCell(nx, ny) !== wantWet) continue
          seen.add(k)
          queue.push([nx, ny])
          if (seen.size >= minCells) { big = true; break }
        }
      }
      if (wetCell(sx, sy) === wantWet) {
        for (const k of seen) memo.set(k, big)
      } else memo.set(memoKey, big)
      return big
    }
    const gated = (x, y) => {
      const gx = (fbm1(x + 1.5, y) - fbm1(x - 1.5, y)) / 3
      const gy = (fbm1(x, y + 1.5) - fbm1(x, y - 1.5)) / 3
      const gn = Math.hypot(gx, gy) + 1e-9
      return bigBody(x - gx / gn * 10, y - gy / gn * 10, true, 10, bigWaterMemo) &&
        bigBody(x + gx / gn * 10, y + gy / gn * 10, false, 38, bigLandMemo)
    }
    const scell = rp && rp.scell ? rp.scell : 50
    const meander = rp && rp.meander !== undefined ? rp.meander : 1
    const lenMul = rp && rp.lenMul !== undefined ? rp.lenMul : 1
    const budget = Math.min(1000, Math.round(240 * lenMul))
    const rlimit = 400 * lenMul
    const margin = rlimit * 2 + 200

    const c0x = Math.floor((rect.x0 - margin) / scell), c1x = Math.floor((rect.x1 + margin) / scell)
    const c0y = Math.floor((rect.y0 - margin) / scell), c1y = Math.floor((rect.y1 + margin) / scell)
    const cw = c1x - c0x + 1, ch = c1y - c0y + 1
    gl.useProgram(candProg)
    gl.uniform2f(UP(candProg, "uCell0"), c0x, c0y)
    gl.uniform1f(UP(candProg, "uSCell"), scell)
    const cand = runPass(cw, ch)

    const candAt = (cx, cy) => {
      if (cx < c0x || cy < c0y || cx > c1x || cy > c1y) return null
      const i = ((cy - c0y) * cw + (cx - c0x)) * 4
      if (cand[i + 3] < 0.5) return null
      return { x: cand[i], y: cand[i + 1], pri: cand[i + 2] }
    }
    const lvlOf = pri => Math.min(5, Math.floor(pri * 6))
    const sources = []
    for (let cy = c0y; cy <= c1y; cy++) for (let cx = c0x; cx <= c1x; cx++) {
      const v = candAt(cx, cy)
      if (!v) continue
      const lvl = lvlOf(v.pri)
      let ok = true
      outer: for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) {
        if (!i && !j) continue
        const o = candAt(cx + i, cy + j)
        if (!o || o.pri <= v.pri) continue
        const d = Math.hypot(o.x - v.x, o.y - v.y)
        if (d < 34 || (lvlOf(o.pri) === lvl && d < scell * 2)) { ok = false; break outer }
      }
      if (!ok || !gated(v.x, v.y)) continue
      sources.push({ x: v.x, y: v.y, pri: v.pri, lvl, cx, cy })
    }

    const segs = [], lakes = []
    const grid = new Map()
    const gridAdd = idx => {
      const s = segs[idx]
      const x0 = Math.min(s.ax, s.bx) - 2, x1 = Math.max(s.ax, s.bx) + 2
      const y0 = Math.min(s.ay, s.by) - 2, y1 = Math.max(s.ay, s.by) + 2
      for (let gx = Math.floor(x0 / 32); gx <= Math.floor(x1 / 32); gx++) {
        for (let gy = Math.floor(y0 / 32); gy <= Math.floor(y1 / 32); gy++) {
          const k = NK(gx, gy)
          let arr = grid.get(k)
          if (!arr) grid.set(k, arr = [])
          arr.push(idx)
        }
      }
    }

    const tb0x = Math.floor((rect.x0 - margin - rlimit - 64) / 32), tb1x = Math.floor((rect.x1 + margin + rlimit + 64) / 32)
    const tb0y = Math.floor((rect.y0 - margin - rlimit - 64) / 32), tb1y = Math.floor((rect.y1 + margin + rlimit + 64) / 32)
    const tbw = tb1x - tb0x + 1, tbh = tb1y - tb0y + 1
    const uploadCommitted = () => {
      const segData = new Float32Array(Math.max(1, segs.length) * 4)
      segs.forEach((s, i) => { segData[i * 4] = s.ax; segData[i * 4 + 1] = s.ay; segData[i * 4 + 2] = s.bx; segData[i * 4 + 3] = s.by })
      const segT = pad(segData, Float32Array, 4, 1024)
      bindAt(9, texTSegs)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1024, segT.rows, 0, gl.RGBA, gl.FLOAT, segT.out)
      const bucketIdx = new Int32Array(tbw * tbh * 2)
      const index = []
      for (let by = 0; by < tbh; by++) for (let bx = 0; bx < tbw; bx++) {
        const arr = grid.get(NK(tb0x + bx, tb0y + by))
        const i = (by * tbw + bx) * 2
        bucketIdx[i] = index.length
        bucketIdx[i + 1] = arr ? arr.length : 0
        if (arr) for (const si of arr) index.push(si)
      }
      bindAt(10, texTBucket)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32I, tbw, tbh, 0, gl.RG_INTEGER, gl.INT, bucketIdx)
      const idxT = pad(index.length ? Int32Array.from(index) : new Int32Array(1), Int32Array, 1, 2048)
      bindAt(11, texTIndex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32I, 2048, idxT.rows, 0, gl.RED_INTEGER, gl.INT, idxT.out)
    }
    const rcx = (rect.x0 + rect.x1) / 2, rcy = (rect.y0 + rect.y1) / 2
    const byDist = (a, b) => Math.hypot(a.x - rcx, a.y - rcy) - Math.hypot(b.x - rcx, b.y - rcy)
    const uploadLakes = () => {
      let la = lakes.length > 64 ? lakes.slice().sort(byDist).slice(0, 64) : lakes
      const buf = new Float32Array(64 * 4)
      la.forEach((l, i) => { buf[i * 4] = l.x; buf[i * 4 + 1] = l.y; buf[i * 4 + 2] = l.R; buf[i * 4 + 3] = l.id })
      gl.uniform4fv(UP(traceProg, "uLakes"), buf)
      gl.uniform1i(UP(traceProg, "uLakeCount"), la.length)
    }

    // self-avoid: a point within 7 blocks of one more than 12 steps older kills the attempt
    const selfCrosses = pts => {
      for (let i = 12; i < pts.length; i++) {
        const x = pts[i][0], y = pts[i][1]
        for (let j = 0; j < i - 12; j += 2) {
          const ex = pts[j][0] - x, ey = pts[j][1] - y
          if (ex * ex + ey * ey < 49) return true
        }
      }
      return false
    }

    let riverCount = 0
    for (let lvl = 5; lvl >= 0; lvl--) {
      let pending = sources.filter(s => s.lvl === lvl)
      if (!pending.length) continue
      gl.useProgram(traceProg)
      gl.uniform2i(UP(traceProg, "uBucket0"), tb0x, tb0y)
      gl.uniform2i(UP(traceProg, "uBucketDim"), tbw, tbh)
      gl.uniform1i(UP(traceProg, "uBudget"), budget)
      gl.uniform1f(UP(traceProg, "uRLimit"), rlimit)
      gl.uniform1f(UP(traceProg, "uMeander"), meander)
      // frozen per level: retries must not see this level's earlier commits
      uploadCommitted()
      uploadLakes()
      for (let round = 0; round < 3 && pending.length; round++) {
      const list = pending
      pending = []
      const rows = Math.min(4096, list.length)
      const src = new Float32Array(1024 * Math.max(1, Math.ceil(rows * 2 / 1024)) * 4)
      for (let i = 0; i < rows; i++) {
        src[i * 8] = list[i].x; src[i * 8 + 1] = list[i].y; src[i * 8 + 2] = list[i].pri; src[i * 8 + 3] = 1 + (list[i].aBase || 0)
      }
      bindAt(8, texSrcList)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1024, src.length / 4096, 0, gl.RGBA, gl.FLOAT, src)
      const path = runPass(1024, rows)

      for (let r0 = 0; r0 < rows; r0++) {
        const s = list[r0]
        const pts = []
        let endSt = 0, endAtt = 0
        for (let c = 0; c < 1024; c++) {
          const i = (r0 * 1024 + c) * 4
          const st = path[i + 3]
          if (st < 0.5) break
          pts.push([path[i], path[i + 1]])
          if (st > 1.5) { endSt = st; endAtt = Math.round(path[i + 2]); break }
        }
        if (endSt < 1.5 || pts.length < 2) continue
        if (selfCrosses(pts)) {
          if (endAtt + 1 < 3) pending.push({ ...s, aBase: endAtt + 1 })
          continue
        }
        riverCount++
        const joined = endSt === 2, isLake = endSt === 5
        const base = 2.6 + hash(s.cx + 31, s.cy + 77) * 2.4
        const off = 60 + Math.floor(hash(s.cx + 7, s.cy + 13) * 97) * 37
        const TAIL = 18
        const SWELL = joined || isLake ? 0.55 : 0.8
        for (let i = 1; i < pts.length; i++) {
          let w = base * (0.8 + 0.4 * i / pts.length)
          const k = i - (pts.length - 1 - TAIL)
          if (k > 0) { const t = k / TAIL; w *= 1 + SWELL * t * t * (3 - 2 * t) }
          if (i < TAIL) { const t = 1 - i / TAIL; w *= 1 + 0.8 * t * t * (3 - 2 * t) }
          segs.push({ ax: pts[i - 1][0], ay: pts[i - 1][1], bx: pts[i][0], by: pts[i][1], w, off })
          gridAdd(segs.length - 1)
        }
        if (isLake) {
          const [lx, ly] = pts[pts.length - 1]
          lakes.push({ x: lx, y: ly, R: 13 + hash(s.cx + 803, s.cy + 411) * 13, id: 1 + Math.floor(hash(s.cx + 17, s.cy + 23) * 89) })
        }
      }
      }
    }

    const M = 96
    const b0x = Math.floor((rect.x0 - M) / 32), b1x = Math.floor((rect.x1 + M) / 32)
    const b0y = Math.floor((rect.y0 - M) / 32), b1y = Math.floor((rect.y1 + M) / 32)
    const bw = b1x - b0x + 1, bh = b1y - b0y + 1
    const lists = new Array(bw * bh)
    const segSet = new Set()
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      const dedup = new Set()
      const list = []
      for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
        const arr = grid.get(NK(b0x + bx + i, b0y + by + j))
        if (!arr) continue
        for (const si of arr) if (!dedup.has(si)) { dedup.add(si); list.push(si); segSet.add(si) }
      }
      lists[by * bw + bx] = list
    }
    const segIds = Array.from(segSet)
    const segRemap = new Map(segIds.map((si, i) => [si, i]))
    const segData = new Float32Array(Math.max(1, segIds.length) * 4)
    const segMeta = new Float32Array(Math.max(1, segIds.length) * 2)
    segIds.forEach((si, i) => {
      const s = segs[si]
      segData[i * 4] = s.ax; segData[i * 4 + 1] = s.ay; segData[i * 4 + 2] = s.bx; segData[i * 4 + 3] = s.by
      segMeta[i * 2] = s.w; segMeta[i * 2 + 1] = s.off
    })
    let total = 0
    for (const l of lists) total += l.length
    const bucketIdx = new Int32Array(bw * bh * 2)
    const indexArr = new Int32Array(Math.max(1, total))
    let cursor = 0
    lists.forEach((l, i) => {
      bucketIdx[i * 2] = cursor
      bucketIdx[i * 2 + 1] = l.length
      for (const si of l) indexArr[cursor++] = segRemap.get(si)
    })
    let lakeArr = lakes.filter(l => l.x > rect.x0 - M - 52 && l.x < rect.x1 + M + 52 && l.y > rect.y0 - M - 52 && l.y < rect.y1 + M + 52)
    if (lakeArr.length > 64) lakeArr = lakeArr.sort(byDist).slice(0, 64)
    const lakeData = new Float32Array(lakeArr.length * 4)
    lakeArr.forEach((l, i) => { lakeData[i * 4] = l.x; lakeData[i * 4 + 1] = l.y; lakeData[i * 4 + 2] = l.R; lakeData[i * 4 + 3] = l.id })

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.useProgram(prog)
    api.setData({ segData, segMeta, bucketIdx, indexArr, b0x, b0y, bw, bh, lakeData })
    return { ms: Math.round(performance.now() - t0), rivers: riverCount, segs: segs.length }
  }

  const api = {
    gl,

    prepareRivers,
    setRiverParams(p) {
      gl.useProgram(prog)
      if (p.riverW !== undefined) gl.uniform1f(U("uRiverW"), p.riverW)
      if (p.lakeMul !== undefined) gl.uniform1f(U("uLakeMul"), p.lakeMul)
      if (p.valleyMul !== undefined) gl.uniform1f(U("uValleyMul"), p.valleyMul)
    },

    setData(d) {
      const segT = pad(d.segData, Float32Array, 4, 1024)
      gl.activeTexture(gl.TEXTURE0)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1024, segT.rows, 0, gl.RGBA, gl.FLOAT, segT.out)
      const metaT = pad(d.segMeta, Float32Array, 2, 1024)
      gl.activeTexture(gl.TEXTURE1)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, 1024, metaT.rows, 0, gl.RG, gl.FLOAT, metaT.out)
      gl.activeTexture(gl.TEXTURE2)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32I, d.bw, d.bh, 0, gl.RG_INTEGER, gl.INT, d.bucketIdx)
      const idxT = pad(d.indexArr, Int32Array, 1, 2048)
      gl.activeTexture(gl.TEXTURE3)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32I, 2048, idxT.rows, 0, gl.RED_INTEGER, gl.INT, idxT.out)
      gl.uniform2i(U("uBucket0"), d.b0x, d.b0y)
      gl.uniform2i(U("uBucketDim"), d.bw, d.bh)
      const nLakes = Math.min(64, d.lakeData.length / 4)
      const lakes = new Float32Array(64 * 4)
      lakes.set(d.lakeData.subarray(0, nLakes * 4))
      gl.uniform4fv(U("uLakes"), lakes)
      gl.uniform1i(U("uLakeCount"), nLakes)
    },
    setView(cx, cy, scale) {
      gl.uniform2f(U("uCenter"), cx, cy)
      gl.uniform1f(U("uScale"), scale)
    },
    resize(w, h) {
      canvas.width = w; canvas.height = h
      gl.viewport(0, 0, w, h)
      gl.uniform2f(U("uCanvas"), w, h)
    },
    draw() {
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
  }
  return api
}

let R = null, glCanvas = null, lastRect = null
let offX = 0, offY = 0

const PREP_PAD = 512

export function randomiseFakeMapWorld() {
  offX = (Math.floor(Math.random() * 4096) - 2048) * 128
  offY = (Math.floor(Math.random() * 4096) - 2048) * 128
}

function ensureRenderer() {
  if (!R) {
    glCanvas = document.createElement("canvas")
    glCanvas.width = glCanvas.height = 128
    R = createRenderer(glCanvas)
    R.resize(128, 128)
  }
}

export function prepareFakeMapArea(x0, y0, x1, y1) {
  ensureRenderer()
  lastRect = { x0: x0 + offX - PREP_PAD, y0: y0 + offY - PREP_PAD, x1: x1 + offX + PREP_PAD, y1: y1 + offY + PREP_PAD }
  R.prepareRivers(lastRect)
}

export function drawRealMap(canvas, sample, colors, palette) {
  const img = new ImageData(128, 128)
  for (let i = 0; i < 16384; i++) {
    const c = colors[i] & 0xff
    const base = palette.base[c >> 2]
    if (!base) continue
    const m = palette.shade[c & 3]
    const o = i * 4
    img.data[o] = base[0] * m / 255 | 0
    img.data[o + 1] = base[1] * m / 255 | 0
    img.data[o + 2] = base[2] * m / 255 | 0
    img.data[o + 3] = 255
  }
  const tmp = document.createElement("canvas")
  tmp.width = tmp.height = 128
  tmp.getContext("2d").putImageData(img, 0, 0)
  const [u0, v0] = sample(0, 0)
  const [u1, v1] = sample(127, 127)
  const ctx = canvas.getContext("2d")
  ctx.save()
  ctx.setTransform(u1 < u0 ? -1 : 1, 0, 0, v1 < v0 ? -1 : 1, u1 < u0 ? 128 : 0, v1 < v0 ? 128 : 0)
  ctx.drawImage(tmp, 0, 0)
  ctx.restore()
}

export async function drawFakeMap(canvas, sample, id) {
  ensureRenderer()
  const [u0, v0] = sample(0, 0)
  const [u1, v1] = sample(127, 127)
  const x0 = Math.min(u0, u1) + offX, y0 = Math.min(v0, v1) + offY
  const inside = lastRect && x0 >= lastRect.x0 && y0 >= lastRect.y0 &&
    x0 + 128 <= lastRect.x1 && y0 + 128 <= lastRect.y1
  if (!inside) {
    lastRect = { x0: x0 - PREP_PAD, y0: y0 - PREP_PAD, x1: x0 + 128 + PREP_PAD, y1: y0 + 128 + PREP_PAD }
    R.prepareRivers(lastRect)
  }
  R.setView(x0 + 63.5, y0 + 63.5, 1)
  R.draw()
  const ctx = canvas.getContext("2d")
  ctx.save()
  ctx.setTransform(u1 < u0 ? -1 : 1, 0, 0, v1 < v0 ? -1 : 1, u1 < u0 ? 128 : 0, v1 < v0 ? 128 : 0)
  ctx.drawImage(glCanvas, 0, 0)
  ctx.restore()
  if (id == null) return
  const font = await getFont()
  const text = String(id)
  const s = 3
  const x = Math.round((128 - measure(font, text) * s) / 2)
  const y = Math.round((128 - font.ch * s) / 2)
  drawText(ctx, font, text, x + s, y + s, { scale: s, color: "#3f3f3f" })
  drawText(ctx, font, text, x, y, { scale: s, color: "#ffffff" })
}
