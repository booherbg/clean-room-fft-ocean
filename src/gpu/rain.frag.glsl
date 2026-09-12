// Rain-ripple stamp (spec §1.16): one expanding ring per live drop,
// accumulated additively into the rain field around the camera.
//
//   .rg  radial slope of the ring (a derivative-of-Gaussian profile along
//        the radius, pointed outward) — the water shader adds this straight
//        onto its normal's slopes, so overlapping rings sum like gradients;
//   .b   wetness: a soft disc that mattes the surface while the ripple lives;
//   .a   splash: a bright point at the impact for the first ~0.15 of life —
//        the water shader turns it into the white prick of the hit.
//
// The kinematics (radius, amplitude vs age) are `ringRadius` /
// `ringAmplitude` in core/rainField.ts, evaluated in the vertex stage.
precision highp float;
precision highp int;

uniform float uRingWidth;

in vec2 vLocal;
in float vRadius;
in float vAmp;
in float vAge01;

layout(location = 0) out vec4 outField;

void main() {
  float r = length(vLocal);
  float x = (r - vRadius) / uRingWidth;
  float g = exp(-x * x);
  // d/dr of a Gaussian bump: the water rises inside the ring front and
  // falls behind it. vAmp carries the age fade and the 1/√R spreading.
  float slope = vAmp * (-2.0 * x) * g;
  vec2 dir = r > 1e-4 ? vLocal / r : vec2(0.0);

  float extent = vRadius + 2.0 * uRingWidth;
  float wet = vAmp * 0.8 * exp(-(r * r) / (extent * extent) * 2.0);

  // The impact itself: a prick about a texel wide (the field is 12.5 cm a
  // texel) that is gone in a tenth of the ripple's life.
  float fresh = 1.0 - clamp(vAge01 / 0.10, 0.0, 1.0);
  float splash = fresh * fresh * exp(-(r * r) / 0.02);

  outField = vec4(dir * slope, wet, splash);
}
