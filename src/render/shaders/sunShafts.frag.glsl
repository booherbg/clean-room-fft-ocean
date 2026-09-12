// Underwater sun shafts (spec §1.13): Mitchell 2007, "Volumetric light
// scattering as a post-process". Three stages selected by a define:
//
//   STAGE_MASK      half-res "sky-through-surface" mask from the rendered frame
//   STAGE_BLUR      radial blur of the mask toward the (refracted) sun
//   STAGE_COMPOSITE frame + shafts, to the canvas
//
// Everything is addressed by gl_FragCoord / uSize so DPR and resizes need no
// shader changes.
precision highp float;

//#include common

uniform vec2 uSize;
out vec4 fragColor;

#ifdef STAGE_MASK
uniform sampler2D uFrame;
uniform mat4 uInvProj;
uniform mat3 uInvViewRot;
uniform vec3 uSunDirW;     // refracted sun direction, world (unit)
uniform vec3 uCamPos;
uniform float uSurfaceY;   // mean surface height at the camera (world)
uniform float uCausticScale;
uniform float uTime;
uniform float uThreshold;  // luminance (display space) where the mask starts
uniform float uKnee;       // luminance where the mask is full

void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec3 c = texture(uFrame, uv).rgb;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // World view direction of this pixel.
  vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec3 dir = normalize(uInvViewRot * (p.xyz / p.w));
  // Only the underside above the eye can be "sky through the surface":
  // Snell's window is ~48.6° from the zenith (dir.y > 0.66 on a flat sea),
  // waves widen it. Kills the caustics floor and the water body.
  float elev = smoothstep(0.12, 0.55, dir.y);
  // Bright rim of the window + foam ceiling, from the frame.
  float bright = smoothstep(uThreshold, uKnee, lum);
  // The sun's own lobe through the window, modulated by what the surface
  // let through so the waves streak it rather than a flat disc.
  float toSun = max(dot(dir, uSunDirW), 0.0);
  float lobe = pow(toSun, 24.0) * (0.3 + lum);
  // Shafts live near the sun: the mask falls off with the angle to it, so
  // the far foam ceiling does not smear into a haze.
  float cone = pow(toSun, 6.0);
  // The beams are the surface's wave lenses: the same caustics web that
  // lands on the floor, sampled where this ray meets the surface, drifting
  // down-sun like the floor's — so the shafts are streaks, not a glow.
  float web = 0.0;
  if (dir.y > 1e-3) {
    float t = (uSurfaceY - uCamPos.y) / dir.y;
    vec3 hit = uCamPos + dir * t;
    vec2 wuv = (hit.xz + uSunDirW.xz * uTime * 0.6) / uCausticScale * 20.0;
    web = saturate1(caustics(wuv, uTime) * 1.5);
  }
  float beams = 0.1 + 0.9 * web;
  float m = elev * min(1.0, (bright * cone + lobe) * beams);
  fragColor = vec4(vec3(m), 1.0);
}
#endif

#ifdef STAGE_BLUR
uniform sampler2D uMask;
uniform vec2 uSunUv;       // sun on screen, uv (may be off-screen)
uniform float uDensity;
uniform float uDecay;
uniform float uWeight;
uniform float uMaxLen;     // longest march in uv units

const int SAMPLES = 48;

void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec2 delta = uv - uSunUv;
  float len = length(delta);
  delta *= min(1.0, uMaxLen / max(len, 1e-4)) * uDensity / float(SAMPLES);
  vec2 q = uv;
  float decay = 1.0;
  float illum = 0.0;
  for (int i = 0; i < SAMPLES; i++) {
    q -= delta;
    float inside = step(0.0, q.x) * step(q.x, 1.0) * step(0.0, q.y) * step(q.y, 1.0);
    float s = texture(uMask, q).r * inside;
    illum += s * decay * uWeight;
    decay *= uDecay;
  }
  fragColor = vec4(vec3(illum), 1.0);
}
#endif

#ifdef STAGE_COMPOSITE
uniform sampler2D uFrame;
uniform sampler2D uShafts;
uniform vec3 uTint;        // sun colour × strength (display space)

void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec3 c = texture(uFrame, uv).rgb;
  float s = texture(uShafts, uv).r;
  // Screen blend: brightens without saturating to white.
  vec3 add = uTint * s;
  fragColor = vec4(c + add * (1.0 - c), 1.0);
}
#endif
