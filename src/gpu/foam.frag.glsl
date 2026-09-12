// Persistent foam energy field (spec §1.5, heavy-sea rework §1.16).
// Ping-pong; the CPU reference of every formula is core/foamModel.ts:
//
//   fold     = max(threshold − J, 0)          (unclamped: an overturned
//                                              crest injects ∝ the overturn)
//   source   = crest·fold + windward·sat(dot(n̂slope, wind))·fold
//   source  *= 1 − breakup·noise              (breakup 0 in the oracle rig)
//   prev'    = prev advected down the face and along the wind (bilinear,
//              periodic — exact texel fetch when the offset is zero)
//   e        = max(prev'·exp(−dt / (decay·troughScale(J))), source)
//
// Texel (x, y) is the same world texel as the cascade's jacobian.
precision highp float;
precision highp int;

uniform sampler2D uPrev;
uniform sampler2D uJacobian;
uniform sampler2D uDerivatives;
uniform int uN;
uniform float uDt;
uniform float uDecayTime;
uniform float uThreshold;
uniform float uCrestStrength;
uniform float uWindwardStrength;
uniform vec2 uWindDir;
// Metres per texel (advection is in world units, the field in texels).
uniform float uCell;
// Downslope slide, m/s per unit slope; wind drift, m/s (≈ 3 % of the wind).
uniform float uSlide;
uniform float uWindDrift;
// Decay-time multiplier in stretched water (troughs), saturating at J = 2.
uniform float uTroughBoost;
// Injection breakup weight ∈ [0,1] (0 = the closed-form oracle model) and a
// slow phase so the lace pattern crawls instead of strobing.
uniform float uBreakup;
uniform float uPhase;

layout(location = 0) out vec4 outFoam;

float saturate_(float x) { return clamp(x, 0.0, 1.0); }

float hash21_(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float valueNoise_(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21_(i);
  float b = hash21_(i + vec2(1.0, 0.0));
  float c = hash21_(i + vec2(0.0, 1.0));
  float d = hash21_(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Bilinear read of the previous field at continuous texel coords, wrapping
// (the cascade tile is periodic). At integer coords this degenerates to the
// exact texel fetch, so a zero offset reproduces the old pass bit-for-bit.
float prevAt(vec2 pos) {
  vec2 base = floor(pos);
  vec2 f = pos - base;
  ivec2 i0 = ivec2(base);
  int N = uN;
  ivec2 w0 = ivec2(((i0.x % N) + N) % N, ((i0.y % N) + N) % N);
  ivec2 w1 = ivec2((w0.x + 1) % N, (w0.y + 1) % N);
  float a = texelFetch(uPrev, ivec2(w0.x, w0.y), 0).r;
  float b = texelFetch(uPrev, ivec2(w1.x, w0.y), 0).r;
  float c = texelFetch(uPrev, ivec2(w0.x, w1.y), 0).r;
  float d = texelFetch(uPrev, ivec2(w1.x, w1.y), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float J = texelFetch(uJacobian, p, 0).r;
  vec2 slope = texelFetch(uDerivatives, p, 0).xy;

  // The foam now here was, dt ago, up the slope (it slid down the face) and
  // upwind (it drifted with the sea surface). Capped at 3 texels a step —
  // the resample is a warp, so this is cosmetic, not a CFL condition.
  vec2 offset = (slope * uSlide - uWindDir * uWindDrift) * (uDt / max(uCell, 1e-6));
  float olen = length(offset);
  if (olen > 3.0) offset *= 3.0 / olen;
  float prev = prevAt(vec2(p) + offset);

  // Whitewater parked in stretched water (the trough behind the break)
  // outlives the crest's own memory: decay time × (1 + boost·sat(J − 1)).
  float troughScale = 1.0 + uTroughBoost * saturate_(J - 1.0);
  float decayed = uDecayTime > 0.0 ? prev * exp(-uDt / (uDecayTime * troughScale)) : 0.0;

  float fold = max(uThreshold - J, 0.0);
  float windward = 0.0;
  float len = length(slope);
  if (len > 1e-6) windward = saturate_(dot(slope / len, uWindDir));

  float source = uCrestStrength * fold + uWindwardStrength * windward * fold;
  // Breakup: two octaves of static tile-space lace with a slow crawl, so a
  // saturated sheet keeps texture instead of blowing out to a flat blob.
  if (uBreakup > 0.0) {
    vec2 q = vec2(p);
    float n = valueNoise_(q * 0.11 + uPhase) * 0.6 + valueNoise_(q * 0.37 - uPhase * 1.7) * 0.4;
    source *= 1.0 - uBreakup * n;
  }

  outFoam = vec4(max(decayed, source), 0.0, 0.0, 1.0);
}
