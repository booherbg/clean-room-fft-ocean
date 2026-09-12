// Time evolution — GPU port of core/oceanCpu.ts `evolve()` (spec §1.2).
//   h̃(k,t) = h0(k) e^{iωt} + conj(h0(−k)) e^{−iωt},  t already × animationSpeed
// Eight complex spectra packed into four RGBA outputs:
//   A = (h.re, h.im, Dx.re, Dx.im)     B = (Dz.re, Dz.im, sx.re, sx.im)
//   C = (sz.re, sz.im, dxdx.re, dxdx.im) D = (dzdz.re, dzdz.im, dxdz.re, dxdz.im)
precision highp float;
precision highp int;

uniform sampler2D uH0;
uniform int uN;
uniform float uL;
uniform float uT;
uniform float uGravity;

layout(location = 0) out vec4 outA;
layout(location = 1) out vec4 outB;
layout(location = 2) out vec4 outC;
layout(location = 3) out vec4 outD;

const float PI = 3.14159265358979323846;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float dk = (2.0 * PI) / uL;
  int half_ = uN / 2;
  float kx = dk * float(p.x - half_);
  float kz = dk * float(p.y - half_);
  float k = length(vec2(kx, kz));

  if (k == 0.0) {
    outA = vec4(0.0);
    outB = vec4(0.0);
    outC = vec4(0.0);
    outD = vec4(0.0);
    return;
  }

  float omega = sqrt(uGravity * k);
  float c = cos(omega * uT);
  float s = sin(omega * uT);
  vec4 h0 = texelFetch(uH0, p, 0);
  float pr = h0.x, pi = h0.y, mr = h0.z, mi = h0.w;
  // h0(k)·e^{iωt} + conj(h0(−k))·e^{−iωt}
  float hr = pr * c - pi * s + (mr * c - mi * s);
  float hi = pr * s + pi * c - (mr * s + mi * c);

  float nx = kx / k;
  float nz = kz / k;
  // Dx = −i·nx·h
  outA = vec4(hr, hi, hi * nx, -hr * nx);
  // Dz, sx = i·kx·h
  outB = vec4(hi * nz, -hr * nz, -hi * kx, hr * kx);
  // sz, dxdx = kx·nx·h
  outC = vec4(-hi * kz, hr * kz, hr * kx * nx, hi * kx * nx);
  // dzdz = kz·nz·h, dxdz = kx·nz·h
  outD = vec4(hr * kz * nz, hi * kz * nz, hr * kx * nz, hi * kx * nz);
}
