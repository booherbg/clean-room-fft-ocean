// Initial spectrum h0(k) — GPU port of core/spectrum.ts `phi()` and
// core/oceanCpu.ts `initialSpectrum()`. Keep this line-for-line with the
// TypeScript: it is the oracle the e2e tests compare against.
//
// Texel (x, y) holds wavevector k = 2π·(x − N/2, y − N/2) / L.
// Output: h0(k) in .rg, h0(−k) in .ba. The Gaussian pair ξ per texel comes
// from the CPU (core/random, same stream as the oracle) via uGauss.
precision highp float;
precision highp int;

uniform sampler2D uGauss;
uniform int uN;
uniform float uL;
uniform float uKMin;
uniform float uKMax;
uniform float uKMinWidth;
uniform float uKMaxWidth;
// Energy scale α from core/spectrum.ts `alphaFor()`: the CPU normalises the
// JONSWAP shape to the Pierson–Moskowitz significant wave height (with the
// user amplitude folded in) and hands the constant over, so the GLSL stays
// a per-texel evaluation with no integration loop.
uniform float uAlpha;
uniform float uWindSpeed;
uniform float uWindDirection;
uniform float uGravity;
uniform float uGamma;
uniform float uPeakWavelength;
uniform float uSharpness;
uniform float uStandingWaveRatio;

layout(location = 0) out vec4 outH0;

const float PI = 3.14159265358979323846;
const float INV_SQRT2 = 0.70710678118654752440;
const float S_MIN = 1.0;
const float S_MAX = 200.0;
const int NORM_SAMPLES = 64;

float dispersion(float k, float g) { return sqrt(g * k); }
float dispersionDerivative(float k, float g) { return g / (2.0 * dispersion(k, g)); }

// S(ω) = α g² / ω⁵ · exp(−1.25 (ωp/ω)⁴) · γ^r
float jonswap(float omega, float omegaPeak, float gamma, float sharpness, float alpha, float g) {
  if (omega <= 0.0) return 0.0;
  float sigma = omega <= omegaPeak ? 0.07 : 0.09;
  float d = omega - omegaPeak;
  float r = exp(-(d * d) / (2.0 * sigma * sigma * omegaPeak * omegaPeak));
  float ratio = omegaPeak / omega;
  float pm = ((alpha * g * g) / pow(omega, 5.0)) * exp(-1.25 * pow(ratio, 4.0));
  return pm * pow(gamma, r * sharpness);
}

// Hasselmann (1980) sharpness exponent, clamped to [1, 200].
float hasselmannS(float omega, float omegaPeak, float windSpeed, float g) {
  float ratio = omega / omegaPeak;
  float s;
  if (omega < omegaPeak) {
    s = 6.97 * pow(ratio, 4.06);
  } else {
    float cp = g / omegaPeak;
    float mu = -2.33 - 1.45 * (windSpeed / cp - 1.17);
    s = 9.77 * pow(ratio, mu);
  }
  if (isinf(s) || isnan(s)) s = S_MAX;
  return min(S_MAX, max(S_MIN, s));
}

// pow(0, s) is only defined for s > 0 in GLSL; guard to be driver-safe.
float powSafe(float x, float s) { return x > 0.0 ? pow(x, s) : 0.0; }

// Unnormalised cos^{2s}((θ−θw)/2) with the mirrored lobe mixed in.
float spreadRaw(float theta, float s, float windDirection, float standingWaveRatio) {
  float half_ = (theta - windDirection) / 2.0;
  float c = cos(half_);
  float m = sin(half_);
  return powSafe(c * c, s) + standingWaveRatio * powSafe(m * m, s);
}

// D(θ, ω) normalised with a 64-sample trapezoid (same as the CPU).
float hasselmannSpread(float theta, float omega, float omegaPeak, float windSpeed, float windDirection,
                       float standingWaveRatio, float g) {
  float s = hasselmannS(omega, omegaPeak, windSpeed, g);
  float sum = 0.0;
  float step_ = (2.0 * PI) / float(NORM_SAMPLES);
  for (int i = 0; i < NORM_SAMPLES; i++) sum += spreadRaw(float(i) * step_, s, windDirection, standingWaveRatio);
  float integral = sum * step_;
  if (integral <= 0.0) return 0.0;
  return spreadRaw(theta, s, windDirection, standingWaveRatio) / integral;
}

// core/spectrum.ts `bandWeight()`: hard [kMin, kMax) mask, or a linear
// energy ramp of the given width centred on each edge (seam cross-fade).
float bandWeight(float k) {
  float w = 1.0;
  if (uKMinWidth > 0.0) w *= clamp((k - (uKMin - uKMinWidth * 0.5)) / uKMinWidth, 0.0, 1.0);
  else if (k < uKMin) return 0.0;
  if (uKMaxWidth > 0.0) w *= 1.0 - clamp((k - (uKMax - uKMaxWidth * 0.5)) / uKMaxWidth, 0.0, 1.0);
  else if (k >= uKMax) return 0.0;
  return w;
}

// Φ(k) = S(ω) · D(θ, ω) · (dω/dk) / |k| · (2π/L)² · bandWeight; 0 at k = 0 and outside the band.
float phi(float kx, float kz) {
  float k = length(vec2(kx, kz));
  if (k == 0.0) return 0.0;
  float band = bandWeight(k);
  if (band <= 0.0) return 0.0;

  float g = uGravity;
  float omega = dispersion(k, g);
  float theta = atan(kz, kx);
  float omegaPeak = dispersion((2.0 * PI) / uPeakWavelength, g);

  float s = jonswap(omega, omegaPeak, uGamma, uSharpness, uAlpha, g);
  float d = hasselmannSpread(theta, omega, omegaPeak, uWindSpeed, uWindDirection, uStandingWaveRatio, g);
  float dk = (2.0 * PI) / uL;
  return (band * s * d * dispersionDerivative(k, g) * dk * dk) / k;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float dk = (2.0 * PI) / uL;
  int half_ = uN / 2;

  vec2 k = dk * vec2(p.x - half_, p.y - half_);
  vec2 xi = texelFetch(uGauss, p, 0).rg;
  float a = sqrt(phi(k.x, k.y)) * INV_SQRT2;

  // Mirror texel ((N − x) % N, (N − y) % N) — its own k, exactly as the CPU.
  ivec2 m = ivec2((uN - p.x) % uN, (uN - p.y) % uN);
  vec2 km = dk * vec2(m.x - half_, m.y - half_);
  vec2 xim = texelFetch(uGauss, m, 0).rg;
  float am = sqrt(phi(km.x, km.y)) * INV_SQRT2;

  outH0 = vec4(xi * a, xim * am);
}
