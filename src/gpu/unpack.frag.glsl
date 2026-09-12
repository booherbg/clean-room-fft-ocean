// Unpack — GPU twin of core/oceanCpu.ts `channelToField()` + `simulate()`.
// The FFT stages produce the *unnormalised* inverse sum Σ_k F(k) e^{+i k·x},
// which is exactly the CPU's N²·IFFT — so no scale here. The k-grid is centred
// at N/2, so the spatial field is that sum times (−1)^{x+y}. Real parts only.
//
// Outputs:
//   displacement = (λ·Dx, h, λ·Dz, dxdz)         (dxdz raw, kept for callers)
//   derivatives  = (∂h/∂x, ∂h/∂z, ∂Dx/∂x, ∂Dz/∂z) (raw, unscaled by λ)
//   jacobian     = (J, 0, 0, 0),  J = (1+λ dxdx)(1+λ dzdz) − (λ dxdz)²
precision highp float;
precision highp int;

uniform sampler2D uIn0;
uniform sampler2D uIn1;
uniform sampler2D uIn2;
uniform sampler2D uIn3;
uniform int uN;
uniform float uLambda;

layout(location = 0) out vec4 outDisplacement;
layout(location = 1) out vec4 outDerivatives;
layout(location = 2) out vec4 outJacobian;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float sign_ = ((p.x + p.y) & 1) == 1 ? -1.0 : 1.0;
  vec4 A = texelFetch(uIn0, p, 0) * sign_;
  vec4 B = texelFetch(uIn1, p, 0) * sign_;
  vec4 C = texelFetch(uIn2, p, 0) * sign_;
  vec4 D = texelFetch(uIn3, p, 0) * sign_;

  float h = A.x, dx = A.z;
  float dz = B.x, sx = B.z;
  float sz = C.x, dxdx = C.z;
  float dzdz = D.x, dxdz = D.z;

  float jxx = 1.0 + uLambda * dxdx;
  float jzz = 1.0 + uLambda * dzdz;
  float jxz = uLambda * dxdz;

  outDisplacement = vec4(uLambda * dx, h, uLambda * dz, dxdz);
  outDerivatives = vec4(sx, sz, dxdx, dzdz);
  outJacobian = vec4(jxx * jzz - jxz * jxz, 0.0, 0.0, 0.0);
}
