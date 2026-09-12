// Shared helpers, spliced into the water (both stages), sky, terrain,
// underwater, sun-shaft and spray shaders at `//#include common`. The
// SKY_* macros come from `skyConstants.ts` (one table for TS and GLSL).

float saturate1(float x) { return clamp(x, 0.0, 1.0); }

// ACES filmic fit (Narkowicz), linear in → linear-ish out in [0,1].
vec3 acesTonemap(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 linearToSrgb(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

vec3 finish(vec3 linear) { return linearToSrgb(acesTonemap(linear)); }

// Colour of the sun (linear) as a function of its elevation: white high up,
// deep orange at the horizon, gone below it.
// Just below the horizon the disc is gone but the afterglow still lights
// the sea from the sun's azimuth (the warm glint path of a sunset), so the
// tint fades out over −0.18..0 instead of cutting at the geometric set.
vec3 sunTint(float elevation) {
  float warm = 1.0 - smoothstep(0.0, SKY_SUN_WARM_EL, elevation);
  vec3 tint = mix(SKY_SUN_TINT_HIGH, SKY_SUN_TINT_LOW, warm * warm);
  return tint * smoothstep(SKY_SUN_FADE_EL, 0.0, elevation);
}

// Procedural sky (spec §1.7): Rayleigh-ish gradient by sun elevation, a Mie
// forward lobe for the disc and halo, a 2-octave value-noise cloud layer.
float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Night factor: 0 through dusk, 1 once the sun is well below the horizon
// (the same band as sky.ts `moonIntensityFromSun`, so the moon rises after the afterglow).
float nightFactor(float sunElevation) {
  return 1.0 - smoothstep(SKY_MOON_FULL_EL, SKY_MOON_RISE_EL, sunElevation);
}

// Moonlight colour (linear, cool) at full strength.
const vec3 MOON_TINT = SKY_MOON_TINT;

// `moon`: direction of the moon (see sky.ts `moonDirectionFromTime`).
vec3 skyRadiance(vec3 dir, vec3 sun, vec3 moon, float coverage) {
  float el = sun.y;
  float mu = dot(dir, sun);
  // Twilight is stretched (sunset presets sit at 18:30–19:00, el ≈ −0.15..−0.26).
  float day = smoothstep(SKY_DAY_EL_LO, SKY_DAY_EL_HI, el);
  float dusk = exp(-abs(el) * 4.0);

  // Rayleigh-ish gradient: deep blue overhead, paler at the horizon.
  vec3 zenithDay = SKY_ZENITH_DAY;
  vec3 horizonDay = SKY_HORIZON_DAY;
  // Night: a cool, legible blue (airglow + moonlight scatter), paler at the
  // horizon; nowhere near black so the water still has something to reflect.
  vec3 zenithNight = SKY_ZENITH_NIGHT;
  vec3 horizonNight = SKY_HORIZON_NIGHT;
  float h = pow(1.0 - saturate1(dir.y), 3.5);
  vec3 sky = mix(mix(zenithNight, zenithDay, day), mix(horizonNight, horizonDay, day), h);

  // Warm scattering around a low sun.
  float glow = pow(saturate1(mu * 0.5 + 0.5), 6.0) * pow(1.0 - saturate1(dir.y), 2.0) * dusk;
  sky += SKY_SUN_TINT_LOW * glow * 1.4 * smoothstep(-0.32, 0.0, el);

  // Twilight band (sun elevation −0.16..+0.10): a wide orange→pink wash
  // low in the sky on the sun's side, and the purple anti-twilight arch
  // (Belt of Venus) opposite. Both hug the horizon and fade upward.
  float twilight = smoothstep(-0.16, -0.04, el) * (1.0 - smoothstep(0.02, 0.10, el));
  vec2 sunH = normalize(sun.xz + vec2(1e-4, 0.0));
  vec2 dirH = normalize(dir.xz + vec2(1e-4, 0.0));
  float az = dot(sunH, dirH) * 0.5 + 0.5;
  float low = pow(1.0 - saturate1(dir.y), 4.0);
  float lowWide = pow(1.0 - saturate1(dir.y), 2.0);
  vec3 orange = vec3(1.0, 0.40, 0.10);
  vec3 pink = vec3(0.90, 0.38, 0.42);
  vec3 purple = vec3(0.30, 0.18, 0.42);
  // The band *replaces* the pale daytime horizon (which would otherwise
  // wash the added colour out to white through the tonemapper).
  sky *= 1.0 - 0.55 * lowWide * twilight;
  sky += orange * pow(az, 5.0) * low * 1.2 * twilight;
  sky += orange * pow(az, 12.0) * lowWide * 0.5 * twilight;
  sky += pink * pow(az, 2.0) * lowWide * 0.22 * twilight;
  sky += purple * pow(1.0 - az, 2.0) * lowWide * 0.3 * twilight;

  // Mie halo + disc.
  vec3 tint = sunTint(el);
  float halo = pow(saturate1(mu), 48.0) * 0.4 + pow(saturate1(mu), 8.0) * 0.06;
  float disc = smoothstep(0.9995, 0.9998, mu);
  sky += tint * (halo * 2.0 + disc * 40.0) * step(-0.02, el) * (dir.y > -0.02 ? 1.0 : 0.0);

  // Moon: disc, tight halo and a wide glow once the sun is down.
  float mm = dot(dir, moon);
  float night = nightFactor(el);
  float moonGlow = smoothstep(0.9996, 0.9998, mm) * 3.0 + pow(saturate1(mm), 256.0) * 0.25 + pow(saturate1(mm), 12.0) * 0.05;
  sky += MOON_TINT * moonGlow * night * step(0.0, moon.y);

  // Below the horizon: a dim mirror of the horizon so reflections never go black.
  sky = mix(sky * 0.3, sky, smoothstep(-0.05, 0.0, dir.y));

  // Clouds on a plane above the viewer, thinning toward the horizon.
  float above = saturate1(dir.y);
  if (dir.y > -0.03 && coverage > 0.001) {
    vec2 p = dir.xz / (dir.y + 0.15) * 3.0;
    float n = valueNoise(p * 1.0) * 0.65 + valueNoise(p * 2.7 + 17.3) * 0.35;
    // Toward the horizon the plane projection shrinks the noise below a
    // texel, so blend it to its mean instead of fading the layer out: an
    // overcast stays overcast down to the sea (no clear band at the
    // horizon) while a scattered sky still clears.
    n = mix(0.5, n, smoothstep(0.0, 0.15, above));
    float cov = smoothstep(1.0 - coverage, 1.0 - coverage + 0.35, n);
    // 100 % coverage must mean 100 % covered: the noise may thin a full
    // deck but never punch holes in it — the water's ambient samples the
    // zenith, and a hole there would let the blue gradient tint every
    // overcast sea.
    cov = max(cov, smoothstep(0.75, 1.0, coverage));
    cov *= smoothstep(-0.03, 0.02, dir.y);
    vec3 lit = mix(vec3(0.05, 0.058, 0.075), vec3(0.95, 0.93, 0.92), day);
    // Moonlit clouds: lit from the moon's side.
    lit += MOON_TINT * 0.06 * night * (0.5 + 0.5 * saturate1(mm));
    // A full overcast is a thick deck: about a quarter as bright as a sunlit
    // cumulus face (the reference's overcast presets sit at a linear
    // luminance of ~0.1, sRGB ≈ 96) and faintly *warm*, not cool — what
    // filters through is direct sun reddened by the air path, not blue sky
    // (the reference's decks all measure hue ≈ 30 at sat ≈ 0.07).
    lit *= mix(vec3(1.0), vec3(0.26, 0.247, 0.232), coverage * coverage);
    // Sunset under-lighting: scattered cloud catches the low sun's orange on
    // its underside; a full deck is too thick for the sun to reach and stays
    // a neutral grey (the reference's storm at dusk is sRGB ≈ 96,92,88).
    lit = mix(lit, lit * vec3(1.0, 0.6, 0.35), dusk * day * (1.0 - coverage * coverage));
    // Cumulus undersides are shaded blue by the open sky around them; under
    // a full deck there is no blue sky to fill the shadows, so the mottling
    // goes neutral.
    vec3 shade = lit * mix(vec3(0.42, 0.47, 0.58), vec3(0.47), coverage * coverage);
    float thick = smoothstep(0.3, 1.0, n);
    vec3 cloud = mix(lit, shade, thick) * (0.6 + 0.4 * saturate1(mu * 0.5 + 0.5));
    // Scattered cloud keeps a little sky showing through its edges; a full
    // deck is opaque.
    sky = mix(sky, cloud, cov * (0.9 + 0.1 * coverage * coverage));
  }
  return sky;
}

// ---------------------------------------------------------------------------
// Underwater (spec §1.10). Shared by the water surface's back-face branch and
// the underwater volume so the two meet seamlessly at the horizon.

// Per-metre extinction: the user's absorption colour (tiny numbers: it is
// tuned for a 30 m Beer–Lambert path) scaled up, plus a neutral scattering
// density so even clear water closes in after ~30 m.
vec3 underwaterExtinction(vec3 absorption, float dist) {
  return exp(-(absorption * 12.0 + 0.045) * dist);
}

// The light the water body scatters: overhead sky plus the sun (matches the
// surface's body-colour light so both sides agree).
vec3 underwaterLight(vec3 skyUp, vec3 sunCol, float sunY) {
  return skyUp * 1.1 + sunCol * 0.45 * (0.3 + 0.7 * saturate1(sunY));
}

// Radiance of the water volume in a direction: brighter looking up toward
// the lit surface, darkening into the deep, with a broad lobe toward the
// (refracted) sun — the bright side of the water.
vec3 underwaterRadiance(vec3 dir, vec3 waterColor, vec3 light, vec3 sunDir, vec3 sunCol) {
  float up = saturate1(dir.y * 0.5 + 0.5);
  vec3 col = waterColor * light * mix(0.15, 1.6, up * up);
  vec3 sunIn = normalize(vec3(sunDir.x, max(sunDir.y, 0.15) + 0.5, sunDir.z));
  col += waterColor * sunCol * pow(saturate1(dot(dir, sunIn)), 3.0) * 0.6;
  return col;
}

// Caustics: two sine-warped value-noise layers, each folded into a ridge
// (bright where the noise crosses its mean), multiplied so only the
// crossings of both webs light up. `uv` is in pattern units, `t` seconds.
float causticLayer(vec2 uv, float t) {
  vec2 w = uv + 0.35 * vec2(sin(uv.y * 3.1 + t * 0.9), sin(uv.x * 2.7 - t * 0.7));
  float n = valueNoise(w * 4.0);
  float ridge = 1.0 - abs(n - 0.5) * 2.0;
  return pow(saturate1(ridge), 5.0);
}

float caustics(vec2 uv, float t) {
  float a = causticLayer(uv, t);
  float b = causticLayer(uv * 1.7 + vec2(3.1, 7.3), -t * 1.3);
  return a * b * 8.0 + (a + b) * 0.2;
}

// ---------------------------------------------------------------------------
// Terrain (spec §1.11). Seabed height under world xz from the island's
// heightmap (metres in .r) covering a uTerrainSize square from
// uTerrainOrigin; very deep outside it or when unbound (size 0).
float terrainHeightAt(sampler2D tex, vec2 origin, float size, vec2 xz) {
  if (size <= 0.0) return -1000.0;
  vec2 uv = (xz - origin) / size;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return -1000.0;
  return texture(tex, uv).r;
}

// Waves shoal: the displacement (and so the slopes and foam) fade out as
// the still-water depth drops under ~6 m, flat by the waterline.
float shoalFactor(float seabed) {
  return smoothstep(0.3, 6.0, -seabed);
}

// ---------------------------------------------------------------------------
// Cascade distance fade (spec §1.8). A cascade of tile side `size` fades
// out between 5 and 16 tile sides from the camera: past ~16 sides its
// finest waves are under a pixel and its normals would sparkle (and its
// displacement is sub-pixel anyway). One curve for the vertex stage
// (displacement) and the fragment stage (normals, foam) so the geometry
// never carries a cascade whose shading is gone.
float fadeWeight(float size, float dist) {
  return 1.0 - smoothstep(size * 5.0, size * 16.0, dist);
}
