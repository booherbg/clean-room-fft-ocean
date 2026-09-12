// Spray particle update (spec §1.14). One texel = one particle slot,
// ping-ponged between two MRT float targets:
//   A = (x, y, z, age)      B = (vx, vy, vz, life)   life < 0 → bow droplet
// A slot is free when life == 0 or age >= |life|. Live slots integrate
// (gravity, relaxation toward the wind, position) and die on age or on
// falling below the water. Free slots try to spawn: bow spray with
// probability uBowP, else a crest droplet at a random point in a disc
// around uCentre with probability (foam − threshold) · uCrestP. The rules
// mirror `app/spray/sprayField.ts`.
precision highp float;
precision highp int;

uniform sampler2D uPrevA;
uniform sampler2D uPrevB;
uniform sampler2D uDisp0;
uniform sampler2D uFoam0;
uniform sampler2D uDisp1;
uniform sampler2D uFoam1;
uniform sampler2D uJac0;
uniform sampler2D uJac1;
// Tile sides of cascades 0 and 1; uHasCascade1 = 0 on the one-cascade tier.
uniform vec2 uSizes;
uniform float uHasCascade1;

uniform float uDt;
uniform uint uFrame;
uniform float uGravity;
uniform float uDragRate;
uniform vec3 uWindVel;
uniform vec2 uWindDir;
uniform float uWindSpeed;
uniform float uWindCarry;

uniform float uFoamThreshold;
// The foam pass's J threshold: J below it is a crest folding over right now.
uniform float uJacThreshold;
// crestGain · density · dt
uniform float uCrestP;
uniform float uCrestLife;
uniform vec2 uCentre;
uniform float uRadius;

// Bow spray: per-slot probability this step, the two bow points, forward.
uniform float uBowP;
uniform vec3 uBowA;
uniform vec3 uBowB;
uniform vec2 uBowForward;
uniform float uBowSpeed;
uniform float uBowLife;

layout(location = 0) out vec4 outA;
layout(location = 1) out vec4 outB;

uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  return v;
}

vec3 rand3(uint salt) {
  uvec3 h = pcg3d(uvec3(uint(gl_FragCoord.x), uint(gl_FragCoord.y), uFrame * 7u + salt));
  return vec3(h) * (1.0 / 4294967295.0);
}

vec3 dispAt(vec2 xz) {
  vec3 d = texture(uDisp0, xz / uSizes.x).xyz;
  d += texture(uDisp1, xz / uSizes.y).xyz * uHasCascade1;
  return d;
}

// How hard the surface is folding at xz: sat(threshold − J), summed over
// the two cascades. Fresh breaking, as opposed to lingering foam.
float foldAt(vec2 xz) {
  float f = clamp(uJacThreshold - texture(uJac0, xz / uSizes.x).r, 0.0, 1.0);
  f += clamp(uJacThreshold - texture(uJac1, xz / uSizes.y).r, 0.0, 1.0) * uHasCascade1;
  return f;
}

float foamAt(vec2 xz) {
  float e = texture(uFoam0, xz / uSizes.x).r;
  e += texture(uFoam1, xz / uSizes.y).r * uHasCascade1;
  return e;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 A = texelFetch(uPrevA, p, 0);
  vec4 B = texelFetch(uPrevB, p, 0);
  float life = abs(B.w);

  if (life > 0.0 && A.w < life) {
    vec3 pos = A.xyz;
    vec3 vel = B.xyz;
    float k = min(1.0, uDragRate * uDt);
    vel.xz += (uWindVel.xz - vel.xz) * k;
    vel.y -= uGravity * uDt;
    pos += vel * uDt;
    float age = A.w + uDt;
    if (age >= life || pos.y < dispAt(pos.xz).y - 0.3) {
      outA = vec4(0.0);
      outB = vec4(0.0);
      return;
    }
    outA = vec4(pos, age);
    outB = vec4(vel, B.w);
    return;
  }

  vec3 r = rand3(0u);
  vec3 q = rand3(1u);

  if (uBowP > 0.0 && r.x < uBowP) {
    float side = r.y < 0.5 ? -1.0 : 1.0;
    vec3 at = side < 0.0 ? uBowA : uBowB;
    vec2 right = vec2(-uBowForward.y, uBowForward.x);
    float s = abs(uBowSpeed);
    float outv = (0.5 + 0.6 * q.x) * s * side;
    float fwd = (0.2 + 0.3 * q.z) * s;
    vec3 vel = vec3(
      right.x * outv + uBowForward.x * fwd,
      1.5 + 0.6 * s * (0.6 + 0.8 * q.y),
      right.y * outv + uBowForward.y * fwd);
    vec3 jit = (rand3(2u) - 0.5) * vec3(1.2, 0.6, 1.2);
    outA = vec4(at + vec3(0.0, 0.3, 0.0) + jit, 0.0);
    outB = vec4(vel, -uBowLife * (0.6 + 0.8 * r.z));
    return;
  }

  float ang = r.x * 6.2831853;
  // Linear in r (not sqrt): density falls as 1/r, so the near field, where
  // a droplet is more than a pixel, gets most of the budget.
  float rad = uRadius * r.y;
  vec2 xz = uCentre + vec2(cos(ang), sin(ang)) * rad;
  float e = foamAt(xz);
  // Lingering foam smokes a little; a crest that is folding right now
  // throws the sheet.
  float fold = foldAt(xz);
  float prob = clamp((e - uFoamThreshold) * uCrestP * (0.25 + 4.0 * fold), 0.0, 1.0);
  if (r.z < prob) {
    vec3 d = dispAt(xz);
    float carry = uWindSpeed * uWindCarry;
    float jitter = 0.35 * carry + 1.0;
    float lift = 0.6 + 1.2 * clamp(fold, 0.0, 1.0);
    vec3 vel = vec3(
      uWindDir.x * carry + (q.x - 0.5) * 2.0 * jitter,
      (1.5 + 0.18 * uWindSpeed + q.y * (1.0 + 0.12 * uWindSpeed)) * lift,
      uWindDir.y * carry + (q.z - 0.5) * 2.0 * jitter);
    vec3 w = rand3(3u);
    outA = vec4(xz.x + d.x, d.y + 0.2, xz.y + d.z, 0.0);
    outB = vec4(vel, uCrestLife * (0.6 + 0.8 * w.x));
    return;
  }

  outA = vec4(0.0);
  outB = vec4(0.0);
}
