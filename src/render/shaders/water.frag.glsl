precision highp float;
precision highp samplerCube;

//#include common

// Water fragment shader — the ten steps of spec §1.6, in order.

in vec3 vWorld;
in float vHeight;
in float vDist;
in float vViewZ;

uniform vec3 cameraPosition;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
// Scene pre-pass (`ScenePass`, spec §1.11 / §1.12): linear colour (alpha 0
// where nothing was drawn) and the depth buffer (1.0 where nothing was
// drawn) of the terrain and the ship, water hidden.
uniform sampler2D uSceneColor;
uniform sampler2D uSceneDepth;
// Screen-space reflection + scene-colour refraction on/off (spec §1.12).
uniform float uSsr;
uniform float uTime;
// Island heightmap (metres in .r) for wave shoaling; uTerrainSize = 0 disables.
uniform sampler2D uTerrainTex;
uniform vec2 uTerrainOrigin;
uniform float uTerrainSize;

uniform vec3 uSizes;
uniform float uChoppiness;
uniform sampler2D uDeriv0;
uniform sampler2D uDeriv1;
uniform sampler2D uDeriv2;
uniform sampler2D uFoam0;
uniform sampler2D uFoam1;
uniform sampler2D uFoam2;
// Boat wake (h, ∂h/∂x, ∂h/∂z, foam); see water.vert.glsl. uWakeSize = 0 disables.
uniform sampler2D uWakeTex;
uniform vec2 uWakeOrigin;
uniform float uWakeSize;
// Rain ripple field (∂h/∂x, ∂h/∂z, wetness, splash) on a camera-following
// square (gpu/rainPass, spec §1.16). uRainIntensity = 0 disables.
uniform sampler2D uRainField;
uniform vec2 uRainOrigin;
uniform float uRainSize;
uniform float uRainIntensity;

uniform samplerCube uSky;
uniform vec3 uSunDir;
uniform float uSunIntensity;
uniform float uSunElevation;
uniform vec3 uMoonDir;
uniform float uMoonIntensity;

uniform vec3 uWaterColor;
uniform vec3 uAbsorption;
uniform vec3 uTransmission;
uniform float uDepth;
uniform float uSssIntensity;
uniform float uSssPower;
uniform float uF0;
uniform float uIor;
uniform float uRefraction;
uniform float uFoamEnabled;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;

uniform float uCloudCoverage;
uniform float uUnderwater;

out vec4 fragColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
const vec3 FOAM_ALBEDO = vec3(0.9, 0.9, 0.9);
// Seabed (sand) albedo seen through shallow water, and the depth-dependent
// extinction that turns it turquoise: red dies first.
const vec3 SEABED_ALBEDO = vec3(0.72, 0.64, 0.46);
const vec3 SHALLOW_SIGMA = vec3(0.095, 0.050, 0.032);
const float NO_SCENE = 1e6;
// Rain-ring slope (the field carries the ring profile, not its height) in
// surface-slope units: a dimple you can see, an order below a wind wave.
const float RAIN_SLOPE = 0.9;

// Linear view depth (metres) of the scene at a screen uv, or NO_SCENE where
// nothing was drawn. The depth buffer is perspective: z = P32 / (ndc + P22).
float sceneDepthAt(vec2 uv) {
  float d = texture(uSceneDepth, clamp(uv, vec2(0.001), vec2(0.999))).r;
  if (d >= 1.0) return NO_SCENE;
  return projectionMatrix[3][2] / (d * 2.0 - 1.0 + projectionMatrix[2][2]);
}

// Vertical thickness of water below this pixel of the surface, metres, or
// NO_SCENE when nothing is behind it. `viewDir` points away from the eye.
// `uv` is the (already refraction-offset) screen position to look at; it is
// pulled back to the pixel's own position when the offset lands on
// something in front of the surface (the hull above the waterline).
float waterThickness(inout vec2 uv, vec2 ownUv, vec3 viewDir) {
  float sceneZ = sceneDepthAt(uv);
  if (sceneZ < vViewZ) {
    uv = ownUv;
    sceneZ = sceneDepthAt(uv);
  }
  if (sceneZ >= NO_SCENE) return NO_SCENE;
  // View-space z difference → distance along the ray → vertical component.
  float alongRay = max(sceneZ - vViewZ, 0.0) * (vDist / max(vViewZ, 1e-3));
  return alongRay * max(-viewDir.y, 0.08);
}

// Screen-space reflection (spec §1.12): march the reflected ray `rWorld`
// from the surface point in view space, stepping uniformly in screen space
// (depth interpolated in 1/z, so it is perspective-correct), 24 steps then
// 4 binary refinements once the ray has gone behind the scene. Returns the
// scene colour and a weight: hit confidence (how far behind the surface
// the ray ended, against a thickness of ~1.5 m growing with distance),
// faded at the screen border and for rays that turn toward the eye.
vec4 ssrTrace(vec3 rWorld) {
  vec3 p0 = (viewMatrix * vec4(vWorld, 1.0)).xyz;
  vec3 dir = normalize(mat3(viewMatrix) * rWorld);
  // Long enough to reach a mast from the chase camera, or the island from
  // the shallows; a ray heading for the eye stops short of the near plane.
  float len = clamp(vViewZ * 3.0, 80.0, 1500.0);
  if (dir.z > 0.0) len = min(len, (-p0.z - 1.0) / dir.z);
  if (len <= 0.0) return vec4(0.0);
  vec3 p1 = p0 + dir * len;
  vec4 c0 = projectionMatrix * vec4(p0, 1.0);
  vec4 c1 = projectionMatrix * vec4(p1, 1.0);
  vec2 s0 = c0.xy / c0.w * 0.5 + 0.5;
  vec2 s1 = c1.xy / c1.w * 0.5 + 0.5;
  float w0 = 1.0 / c0.w;
  float w1 = 1.0 / c1.w;

  const int STEPS = 24;
  float tPrev = 0.0;
  float tHit = -1.0;
  for (int i = 1; i <= STEPS; i++) {
    float t = float(i) / float(STEPS);
    vec2 uv = mix(s0, s1, t);
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) break;
    float rayZ = 1.0 / mix(w0, w1, t);
    if (sceneDepthAt(uv) < rayZ) { tHit = t; break; }
    tPrev = t;
  }
  if (tHit < 0.0) return vec4(0.0);
  float lo = tPrev, hi = tHit;
  for (int i = 0; i < 4; i++) {
    float mid = 0.5 * (lo + hi);
    float rayZ = 1.0 / mix(w0, w1, mid);
    if (sceneDepthAt(mix(s0, s1, mid)) < rayZ) hi = mid; else lo = mid;
  }
  vec2 uv = mix(s0, s1, hi);
  float rayZ = 1.0 / mix(w0, w1, hi);
  float sceneZ = sceneDepthAt(uv);
  float thick = max(1.5, sceneZ * 0.04);
  float conf = 1.0 - saturate1((rayZ - sceneZ) / thick);
  vec2 border = smoothstep(vec2(0.0), vec2(0.06), uv) * smoothstep(vec2(0.0), vec2(0.06), 1.0 - uv);
  float facing = 1.0 - smoothstep(0.0, 0.5, dir.z);
  vec4 sc = texture(uSceneColor, uv);
  return vec4(sc.rgb, conf * border.x * border.y * facing * sc.a);
}

// Hemisphere-average sky radiance for an upward-facing white surface: the
// zenith, four taps at ~24° and four near the horizon (the cubemap is 128²
// with no mips, so nine taps of a smooth sky are a fair average). The low
// taps are weighted up: under an overcast the deck is darkest overhead and
// brightest at the horizon, and that is the light whitecaps actually show.
vec3 foamSkyIrradiance() {
  vec3 s = texture(uSky, vec3(0.0, 1.0, 0.0)).rgb * 0.2;
  s += texture(uSky, vec3(0.9, 0.4, 0.0)).rgb * 0.1;
  s += texture(uSky, vec3(-0.9, 0.4, 0.0)).rgb * 0.1;
  s += texture(uSky, vec3(0.0, 0.4, 0.9)).rgb * 0.1;
  s += texture(uSky, vec3(0.0, 0.4, -0.9)).rgb * 0.1;
  s += texture(uSky, vec3(0.99, 0.12, 0.0)).rgb * 0.1;
  s += texture(uSky, vec3(-0.99, 0.12, 0.0)).rgb * 0.1;
  s += texture(uSky, vec3(0.0, 0.12, 0.99)).rgb * 0.1;
  s += texture(uSky, vec3(0.0, 0.12, -0.99)).rgb * 0.1;
  return s;
}

void main() {
  vec2 xz = vWorld.xz;
  float dist = vDist;

  // 1. Normal from summed derivatives (sx, sz, dxdx, dzdz). The horizontal
  //    displacement stretches the surface, so slopes are divided by (1+λ∂D).
  vec4 d = texture(uDeriv0, xz / uSizes.x) * fadeWeight(uSizes.x, dist);
  float foamE = 0.0;
  foamE += texture(uFoam0, xz / uSizes.x).r;
#if CASCADES > 1
  d += texture(uDeriv1, xz / uSizes.y) * fadeWeight(uSizes.y, dist);
  foamE += texture(uFoam1, xz / uSizes.y).r;
#endif
#if CASCADES > 2
  d += texture(uDeriv2, xz / uSizes.z) * fadeWeight(uSizes.z, dist);
  foamE += texture(uFoam2, xz / uSizes.z).r;
#endif
  if (uWakeSize > 0.0) {
    vec2 wuv = (xz - uWakeOrigin) / uWakeSize;
    vec2 we = min(wuv, 1.0 - wuv);
    vec4 wake = texture(uWakeTex, wuv) * smoothstep(0.0, 0.04, min(we.x, we.y));
    d.xy += wake.gb;
    foamE += wake.a;
  }
  // Shoaling (spec §1.11): the vertex shader flattened the waves here; the
  // slopes and the crest foam go with them.
  float shoal = shoalFactor(terrainHeightAt(uTerrainTex, uTerrainOrigin, uTerrainSize, xz));
  d *= shoal;
  foamE *= shoal;
  // 1b. Rain (spec §1.16): the ripple field rides on top of the wind waves
  //     (shoaling flattens the swell, not the drops). Its slopes perturb
  //     the normal; `.b` mattes the surface and `.a` is the impact prick.
  float rainWet = 0.0;
  float rainRing = 0.0;
  float rainSplash = 0.0;
  if (uRainIntensity > 0.0 && uRainSize > 0.0) {
    vec2 ruv = (xz - uRainOrigin) / uRainSize;
    vec2 re = min(ruv, 1.0 - ruv);
    // Zero outside the square, and gone before a ring is sub-texel on screen.
    float w = uRainIntensity * smoothstep(0.0, 0.05, min(re.x, re.y)) * (1.0 - smoothstep(40.0, 110.0, dist));
    if (w > 0.0) {
      vec4 rf = texture(uRainField, clamp(ruv, vec2(0.0), vec2(1.0)));
      d.xy += rf.xy * (RAIN_SLOPE * w);
      rainWet = saturate1(rf.z * 1.6) * w;
      rainRing = saturate1(length(rf.xy) * 1.5) * w;
      rainSplash = saturate1(rf.w) * w;
    }
  }
  float jxx = max(1.0 + uChoppiness * d.z, 0.2);
  float jzz = max(1.0 + uChoppiness * d.w, 0.2);
  vec3 n = normalize(vec3(-d.x / jxx, 1.0, -d.y / jzz));

  // 2. View, sun, half vectors.
  vec3 v = normalize(cameraPosition - vWorld);
  vec3 l = normalize(uSunDir);
  vec3 hv = normalize(v + l);
  float nDotV = max(dot(n, v), 0.0);
  float nDotL = max(dot(n, l), 0.0);
  // Direct sun through the cloud deck: a scattered sky barely dims it, a
  // full overcast leaves ~15 % (the same law the spray uses). Under a deck
  // the body colour then comes from the grey sky alone, and the glints go.
  float cloudShade = 1.0 - 0.85 * uCloudCoverage * uCloudCoverage;
  vec3 sunCol = sunTint(uSunElevation) * uSunIntensity * cloudShade;
  vec3 m = normalize(uMoonDir);
  vec3 moonCol = MOON_TINT * uMoonIntensity * 0.35;

  // 3. Fresnel (Schlick, dielectric).
  float fresnel = uF0 + (1.0 - uF0) * pow(1.0 - nDotV, 5.0);

  // 4. Reflection: procedural-sky cubemap along the reflected ray. Keep the
  //    ray above the horizon so back-facing normals don't sample the ground.
  vec3 r = reflect(-v, n);
  r.y = max(r.y, 0.03);
  vec3 reflection = texture(uSky, r).rgb;
  // 4b. Screen-space reflection of the ship and the island (spec §1.12):
  //     where the marched ray meets the scene, its colour replaces the sky.
  bool haveScene = textureSize(uSceneDepth, 0).x > 1;
  bool ssr = uSsr > 0.5 && haveScene && uUnderwater < 0.5;
  if (ssr && dist < 3000.0) {
    vec4 hit = ssrTrace(r);
    reflection = mix(reflection, hit.rgb, hit.a);
  }
  vec3 skyUp = texture(uSky, vec3(0.0, 1.0, 0.0)).rgb;
  vec3 skyAmbient = 0.6 * skyUp + 0.4 * texture(uSky, vec3(0.0, 0.2, -1.0)).rgb;

  // 5. Refraction / body colour: Beer–Lambert along the refracted ray down
  //    to the floor: the real seabed where the depth pass has one, else a
  //    virtual floor at uDepth (spec §1.11).
  vec3 nRef = normalize(mix(vec3(0.0, 1.0, 0.0), n, clamp(uRefraction * 10.0, 0.0, 1.0)));
  vec3 rd = refract(-v, nRef, 1.0 / uIor);
  vec2 ownUv = gl_FragCoord.xy / vec2(textureSize(uSceneDepth, 0));
  vec2 refrUv = ownUv + n.xz * (uRefraction * 8.0 / max(dist, 1.0));
  float thickness = haveScene ? waterThickness(refrUv, ownUv, -v) : NO_SCENE;
  float floorDepth = min(uDepth, thickness);
  float path = floorDepth / max(-rd.y, 0.15);
  vec3 atten = exp(-uAbsorption * path);
  vec3 light = skyAmbient * 1.1 + sunCol * 0.45 * (0.3 + 0.7 * saturate1(l.y)) + moonCol * 0.4;
  vec3 body = uWaterColor * atten * light;
  // Thin-water tint: where the floor is close (steep view down) the
  // transmission colour leaks through.
  body += uTransmission * (1.0 - atten) * light * 0.08;
  // 5b. What is seen through the shallows, blended by its two-way
  //     transmittance: the scene colour at the refracted position (the real
  //     seabed, the hull below the waterline; spec §1.12) or, with SSR off
  //     or nothing bound, a sand albedo lit by the light that got down and
  //     back. Beyond ~25 m of water it has vanished into the body colour.
  {
    vec3 T = exp(-(SHALLOW_SIGMA + uAbsorption * 40.0) * (floorDepth + path * 0.5));
    vec3 bedLight = sunCol * saturate1(l.y) * 0.9 + skyAmbient * 1.1;
    vec3 seabed = SEABED_ALBEDO * bedLight * uTransmission / max(dot(uTransmission, LUMA), 1e-3) * 0.55;
    seabed = mix(seabed, SEABED_ALBEDO * bedLight, 0.5);
    if (ssr) {
      vec4 sc = texture(uSceneColor, clamp(refrUv, vec2(0.001), vec2(0.999)));
      vec3 tint = mix(vec3(1.0), uTransmission / max(dot(uTransmission, LUMA), 1e-3), 0.3);
      seabed = mix(seabed, sc.rgb * tint, sc.a);
    }
    body = mix(body, seabed, T * (1.0 - smoothstep(18.0, 28.0, floorDepth)));
  }

  // 6. Sub-surface scattering: back-lit lobe on tall waves.
  float sss = uSssIntensity * pow(saturate1(dot(v, -l)), uSssPower) * max(vHeight, 0.0);
  sss *= 0.35 * (1.0 - nDotV);
  body += uTransmission * sss * (sunCol + skyAmbient * 0.3);

  // 7. Specular: Blinn–Phong sparkle (512) plus a broad halo (64). Far away
  //    the normals are filtered, so widen the lobe to keep the glitter path.
  float nDotH = max(dot(n, hv), 0.0);
  float far = smoothstep(80.0, 1200.0, dist);
  //    Strengths: the reference's sea at 15:00 shows a sparse glitter and
  //    no broad sun halo away from the glint path, so the sparkle is kept
  //    tight and the halo faint; both scale with the Fresnel term (the
  //    glint is a reflection).
  float sparkle = pow(nDotH, mix(512.0, 96.0, far)) * mix(0.24, 0.16, far);
  float halo = pow(nDotH, 32.0) * 0.09;
  vec3 specular = sunCol * (sparkle + halo) * (0.3 + 4.0 * fresnel);
  // Moon glitter path: a broader lobe than the sun's (the disc is dim, the
  // eye is dark-adapted) so it reads as a band across the sea.
  float mDotH = max(dot(n, normalize(v + m)), 0.0);
  float moonPath = pow(mDotH, mix(256.0, 64.0, far)) * 0.6 + pow(mDotH, 24.0) * 0.08;
  specular += moonCol * moonPath * (0.3 + 4.0 * fresnel) * step(0.0, m.y);
  // 7b. Rain roughness: a pocked surface has no mirror left, so the glint
  //     goes matte and the reflection loses contrast toward the sky's mean.
  //     The rings themselves are ringed by unresolved capillary ripples
  //     that scatter the sky back — under a storm deck, where the mirror
  //     has no contrast to lose, that stipple is the whole effect — and
  //     each fresh impact leaves a white prick.
  specular *= 1.0 - 0.8 * rainWet;
  reflection = mix(reflection, skyAmbient, 0.35 * rainWet);

  vec3 colour = mix(body, reflection, fresnel) + specular + skyAmbient * (rainRing * 0.15 + rainSplash * 0.3);

  // 8. Foam: energy field through a procedural tiling albedo, lit as a white
  //    Lambert surface: sun (unshadowed) + a *neutralised* hemisphere
  //    irradiance. The cubemap keeps ~10 % clear sky under a full overcast,
  //    so the sky term is grey-clamped as the cover thickens — whitecaps in
  //    a storm are white, never blue. A floor keeps them legible at dusk.
  float mask = 0.0;
  vec3 foamCol = vec3(0.0);
  if (uFoamEnabled > 0.5) {
    float noise = valueNoise(xz * 0.9) * 0.6 + valueNoise(xz * 3.1 + 5.0) * 0.4;
    mask = saturate1(foamE * 0.9) * smoothstep(0.3, 0.8, noise + foamE * 0.35);
    mask *= 1.0 - smoothstep(300.0, 2000.0, dist);
    vec3 skyIrr = foamSkyIrradiance();
    float skyLum = dot(skyIrr, LUMA);
    float grey = mix(0.35, 1.0, smoothstep(0.5, 1.0, uCloudCoverage));
    skyIrr = mix(skyIrr, vec3(skyLum), grey);
    // Foam is a multiply-scattering bubble raft: it returns more of the
    // hemisphere than a flat Lambert white, hence the 2.0.
    vec3 foamLight = sunCol * nDotL * 0.9 + skyIrr * 2.0 + moonCol * 0.5;
    foamLight = max(foamLight, vec3(0.25 * dot(skyUp, LUMA)));
    foamCol = FOAM_ALBEDO * foamLight;
    colour = mix(colour, foamCol, mask);
  }

  // 8c. Shoreline foam (spec §1.11): whitewater where the water is thinner
  //     than ~1 m, lapping with time, broken up by the foam albedo noise
  //     and thickening to a solid line at the water's edge.
  if (thickness < 6.0) {
    float lap = 0.75 + 0.25 * sin(uTime * 0.9 + xz.x * 0.06 + xz.y * 0.045 + valueNoise(xz * 0.03 + uTime * 0.05) * 4.0);
    float band = 1.0 - smoothstep(0.0, 1.0 * lap, thickness);
    float edge = 1.0 - smoothstep(0.0, 0.25, thickness);
    float sn = valueNoise(xz * 0.9 + vec2(uTime * 0.35, -uTime * 0.2)) * 0.6 + valueNoise(xz * 3.1 + uTime * 0.6) * 0.4;
    float shore = band * smoothstep(0.25, 0.7, sn + band * 0.35) * 0.85 + edge * 0.6;
    shore = saturate1(shore) * (1.0 - smoothstep(600.0, 2500.0, dist));
    vec3 skyIrr = foamSkyIrradiance();
    vec3 shoreLight = sunCol * nDotL * 0.9 + skyIrr * 2.0 + moonCol * 0.5;
    shoreLight = max(shoreLight, vec3(0.25 * dot(skyUp, LUMA)));
    vec3 shoreCol = FOAM_ALBEDO * shoreLight;
    colour = mix(colour, shoreCol, shore);
    foamCol = mix(foamCol, shoreCol, shore);
    mask = max(mask, shore);
  }

  // 8b. Underwater (spec §1.10): the camera is below the surface.
  if (uUnderwater > 0.5) {
    vec3 uwLight = underwaterLight(skyUp, sunCol, l.y);
    vec3 fogCol = underwaterRadiance(-v, uWaterColor, uwLight, l, sunCol);
    vec3 ext = underwaterExtinction(uAbsorption, dist);
    vec3 under;
    if (gl_FrontFacing) {
      // A trough below the eye seen from above: only the fog is right here.
      under = fogCol;
    } else {
      // Looking up at the underside. Water→air: total internal reflection
      // outside Snell's window (≈ 48.6° from the normal at 1/1.33), the sky
      // refracted inside it, foam as a bright ceiling.
      vec3 nb = -n;
      vec3 t = refract(-v, nb, uIor);
      vec3 rDown = reflect(-v, nb);
      vec3 mirror = underwaterRadiance(rDown, uWaterColor, uwLight, l, sunCol);
      // The mirror is faintly lit by the sun's glint refracted into the
      // water (a soft bright band under the sun).
      float glint = pow(max(dot(rDown, -l), 0.0), 8.0);
      mirror += sunCol * glint * 0.08;
      if (dot(t, t) < 0.5) {
        under = mirror;
      } else {
        float cosT = saturate1(dot(t, n));
        float fr = uF0 + (1.0 - uF0) * pow(1.0 - cosT, 5.0);
        vec3 skyT = texture(uSky, t).rgb;
        under = mix(skyT, mirror, fr);
      }
      under = mix(under, foamCol * 0.7, mask);
    }
    colour = mix(fogCol, under, ext);
    fragColor = vec4(finish(colour), 1.0);
    return;
  }

  // 9. Distance fog, linear between near/far, toward the sky at the horizon
  //    in the view direction. The sky bakes the same slab fog into that
  //    sample (hue from the user's colour, brightness from the sky itself —
  //    sky.frag.glsl), so the horizon sample *is* the fog colour and far
  //    water meets the skybox with no band, whatever the sky: overcast,
  //    sunset, night.
  float fog = saturate1((dist - uFogNear) / max(uFogFar - uFogNear, 1.0));
  vec3 fogCol = texture(uSky, normalize(vec3(-v.x, 0.02, -v.z))).rgb;
  colour = mix(colour, fogCol, fog);

  // 10. Tonemap + sRGB.
  fragColor = vec4(finish(colour), 1.0);
}
