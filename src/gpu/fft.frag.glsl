// One radix-2 butterfly stage over four RGBA textures at once (eight complex
// channels), GPU twin of core/butterfly.ts `applyButterflyStage()`.
//
// uButterfly texel (index, stage) = [srcA, srcB, twiddleRe, twiddleIm]; the
// lower-leg minus sign is already folded into the stored twiddle, so
//   out[index] = in[srcA] + twiddle · in[srcB]
// for every index. Horizontal stages transform rows, vertical stages columns.
// INVERSE conjugates the twiddle (unnormalised inverse transform).
precision highp float;
precision highp int;

uniform sampler2D uIn0;
uniform sampler2D uIn1;
uniform sampler2D uIn2;
uniform sampler2D uIn3;
uniform sampler2D uButterfly;
uniform int uStage;
uniform bool uVertical;

layout(location = 0) out vec4 out0;
layout(location = 1) out vec4 out1;
layout(location = 2) out vec4 out2;
layout(location = 3) out vec4 out3;

vec2 cmul(vec2 a, vec2 b) {
  return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

vec4 butterfly(sampler2D s, ivec2 pa, ivec2 pb, vec2 tw) {
  vec4 a = texelFetch(s, pa, 0);
  vec4 b = texelFetch(s, pb, 0);
  return a + vec4(cmul(b.xy, tw), cmul(b.zw, tw));
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int index = uVertical ? p.y : p.x;
  vec4 bf = texelFetch(uButterfly, ivec2(index, uStage), 0);
  int srcA = int(bf.x + 0.5);
  int srcB = int(bf.y + 0.5);
#ifdef INVERSE
  vec2 tw = vec2(bf.z, -bf.w);
#else
  vec2 tw = vec2(bf.z, bf.w);
#endif
  ivec2 pa = uVertical ? ivec2(p.x, srcA) : ivec2(srcA, p.y);
  ivec2 pb = uVertical ? ivec2(p.x, srcB) : ivec2(srcB, p.y);

  out0 = butterfly(uIn0, pa, pb, tw);
  out1 = butterfly(uIn1, pa, pb, tw);
  out2 = butterfly(uIn2, pa, pb, tw);
  out3 = butterfly(uIn3, pa, pb, tw);
}
