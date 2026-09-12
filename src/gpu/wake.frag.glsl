// iWave wake field (Tessendorf 2004), one explicit step per frame, ping-pong.
// State (attachment 0): R = height h (m), G = velocity v (m/s), B = foam.
// Render view (attachment 1): (h, ∂h/∂x, ∂h/∂z, foam) — what the water
// material samples with world UVs.
//
//   v += (−g/cell · (h ⊗ G) − α v) dt;   h += v dt
//
// with G the (2P+1)² vertical-derivative kernel in uKernel (per-texel units).
// The field is anchored to the hull in cell steps: texel p of this frame is
// texel p + uShift of the previous one; out-of-range reads are zero (the
// wake that scrolls off the square is gone). The hull stamps a soft ellipse
// obstruction (surface pushed down under the hull, velocity killed) — moving
// it is what radiates the Kelvin pattern — and lays foam along its path.
precision highp float;
precision highp int;

#define P 6
#define W (2 * P + 1)

uniform sampler2D uPrev;
uniform int uN;
uniform float uCell;          // metres per texel
uniform float uDt;
uniform float uGravity;
uniform float uDamping;       // α, 1/s
uniform float uKernel[W * W];
uniform ivec2 uShift;
uniform vec2 uHull;           // hull centre, texels
uniform vec2 uHullFwd;        // unit forward, texel space
uniform vec2 uHullHalf;       // (length/2, beam/2) in texels
uniform float uSpeedFactor;   // |speed| / cruise, 0..1
uniform float uDraft;         // obstruction depth at full speed, m
uniform float uFoamDecay;     // seconds

layout(location = 0) out vec4 outState;
layout(location = 1) out vec4 outView;

vec3 fetchState(ivec2 q) {
  if (q.x < 0 || q.y < 0 || q.x >= uN || q.y >= uN) return vec3(0.0);
  return texelFetch(uPrev, q, 0).rgb;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 q = p + uShift;
  vec3 s = fetchState(q);
  float h = s.r;
  float v = s.g;
  float foam = s.b;

  // Vertical derivative by convolution with the shifted previous field.
  float dh = 0.0;
  for (int j = -P; j <= P; j++) {
    for (int i = -P; i <= P; i++) {
      dh += uKernel[(j + P) * W + (i + P)] * fetchState(q + ivec2(i, j)).r;
    }
  }
  // Finite-difference slopes of the previous field (one frame of lag).
  float sx = (fetchState(q + ivec2(1, 0)).r - fetchState(q - ivec2(1, 0)).r) / (2.0 * uCell);
  float sz = (fetchState(q + ivec2(0, 1)).r - fetchState(q - ivec2(0, 1)).r) / (2.0 * uCell);

  v += (-(uGravity / uCell) * dh - uDamping * v) * uDt;
  h += v * uDt;

  // Hull obstruction: soft ellipse in the hull's frame.
  vec2 d = (vec2(p) + 0.5) - uHull;
  vec2 right = vec2(uHullFwd.y, -uHullFwd.x);
  vec2 local = vec2(dot(d, uHullFwd), dot(d, right)) / uHullHalf;
  float rr = length(local);
  float obst = 1.0 - smoothstep(0.75, 1.15, rr);
  float depth = uDraft * (0.35 + 0.65 * uSpeedFactor);
  h = mix(h, -depth, obst);
  v *= 1.0 - obst;
  // The displaced water piles up around the hull: a ring of ~equal volume
  // (ring area ≈ 2.4× the ellipse) so the stamp is zero-mean and the field
  // does not accumulate a broad hollow that the wave operator cannot lift.
  float ring = smoothstep(1.05, 1.35, rr) - smoothstep(1.6, 2.0, rr);
  h = mix(h, 0.42 * depth, ring * 0.5);
  // And a slow relaxation of whatever mean is left (DC has no restoring force).
  h *= exp(-uDt / 8.0);

  // Foam: the hull's path (a little wider than the hull, strongest astern)
  // + churn where the wake's own slopes are steep (the V's crests).
  float astern = smoothstep(0.2, -0.6, local.x);
  float pathMask = (1.0 - smoothstep(0.8, 1.25, rr)) * (0.45 + 0.55 * astern) * uSpeedFactor;
  float churn = smoothstep(0.12, 0.45, length(vec2(sx, sz))) * uSpeedFactor;
  float decayed = uFoamDecay > 0.0 ? foam * exp(-uDt / uFoamDecay) : 0.0;
  foam = max(decayed, max(pathMask * 0.55, churn * 0.7));

  // Absorbing border so nothing reflects off the edge of the square.
  float edge = float(min(min(p.x, p.y), min(uN - 1 - p.x, uN - 1 - p.y)));
  float border = smoothstep(0.0, 24.0, edge);
  h *= mix(0.9, 1.0, border);
  v *= mix(0.9, 1.0, border);
  foam *= border;

  outState = vec4(h, v, foam, 1.0);
  outView = vec4(h, sx, sz, foam);
}
