precision highp float;
precision highp samplerCube;

//#include common

// Island terrain shading (spec §1.11): sand on the beach band (darkened
// where it is wet, within ~1.5 m of sea level, lapping with time), scrub
// above, rock on steep slopes; sun + sky-ambient lighting from the same
// cubemap the water reflects; the water's distance fog; and, when the
// camera is under the surface, the water's underwater fog and caustics.

in vec3 vWorld;
in vec3 vNormal;
in float vDist;

uniform vec3 cameraPosition;
uniform samplerCube uSky;
uniform vec3 uSunDir;
uniform float uSunIntensity;
uniform float uSunElevation;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uTime;
uniform float uUnderwater;
uniform vec3 uWaterColor;
uniform vec3 uAbsorption;
// 1 = write linear radiance (the water's scene pre-pass finishes it later).
uniform float uLinearOut;

out vec4 fragColor;

// Albedos are real-world (dry sand ≈ 0.4): the sun is 1.5 and ACES clips.
const vec3 SAND = vec3(0.44, 0.37, 0.26);
const vec3 SAND_WET = vec3(0.27, 0.22, 0.16);
const vec3 GRASS = vec3(0.16, 0.30, 0.10);
const vec3 SCRUB = vec3(0.34, 0.36, 0.15);
const vec3 ROCK = vec3(0.30, 0.20, 0.13);
const vec3 ROCK_LIGHT = vec3(0.52, 0.40, 0.28);

void main() {
  vec3 n = normalize(vNormal);
  vec3 p = vWorld;
  float y = p.y;
  float slope = 1.0 - n.y;

  // --- albedo -------------------------------------------------------------
  float nCoarse = valueNoise(p.xz * 0.05) * 0.6 + valueNoise(p.xz * 0.21 + 3.0) * 0.4;
  float nFine = valueNoise(p.xz * 1.7 + 11.0);

  // Beach band: sand below ~3 m (edge jittered so it is not a contour line).
  float sandW = 1.0 - smoothstep(2.8, 4.2, y + (nCoarse - 0.5) * 3.0 + (nFine - 0.5) * 0.8);
  // Dune grass: patches of scrub creeping onto the backshore.
  float dune = smoothstep(0.55, 0.7, valueNoise(p.xz * 0.11 + 5.0)) * smoothstep(1.5, 3.0, y);
  sandW *= 1.0 - dune;
  // Wet sand: within ~1.5 m of sea level, the line lapping with the swell.
  float tide = 1.5 + 0.5 * sin(uTime * 0.7 + p.x * 0.05 + p.z * 0.03) + (nCoarse - 0.5) * 0.4;
  float wet = 1.0 - smoothstep(tide - 0.5, tide + 0.3, y);
  vec3 sand = mix(SAND, SAND * 0.9, nFine * 0.5) * (0.9 + 0.2 * nCoarse);
  sand = mix(sand, SAND_WET, wet);

  vec3 veg = mix(GRASS, SCRUB, smoothstep(0.35, 0.75, nCoarse));
  veg *= 0.85 + 0.3 * nFine;
  vec3 albedo = mix(veg, sand, sandW);

  // Rock on steep slopes (and everywhere near the peak's crags).
  float rockW = smoothstep(0.10, 0.28, slope + (nCoarse - 0.5) * 0.12);
  rockW = max(rockW, smoothstep(28.0, 42.0, y + (nCoarse - 0.5) * 16.0));
  vec3 rock = mix(ROCK, ROCK_LIGHT, nFine * 0.6 + nCoarse * 0.3);
  albedo = mix(albedo, rock, rockW);

  // --- lighting -----------------------------------------------------------
  vec3 l = normalize(uSunDir);
  vec3 sunCol = sunTint(uSunElevation) * uSunIntensity;
  float nDotL = max(dot(n, l), 0.0);
  // Sky ambient: cubemap along the normal (blurred by the sky's smoothness),
  // faded towards the ground bounce for downward-facing surfaces.
  vec3 skyN = texture(uSky, normalize(vec3(n.x, max(n.y, 0.05), n.z))).rgb;
  vec3 skyUp = texture(uSky, vec3(0.0, 1.0, 0.0)).rgb;
  vec3 ambient = mix(skyN, skyUp, 0.5) * 0.9;
  // Real ground is lit by a whole hemisphere of scattered light, not just the
  // blue zenith: pull the ambient a third of the way to grey so shadowed
  // sand and rock keep their own colour.
  ambient = mix(ambient, vec3(dot(ambient, vec3(0.2126, 0.7152, 0.0722))), 0.35);
  // Light bounce off the sand keeps the shadow side from going dead.
  ambient += SAND * skyUp * 0.2 * saturate1(-n.y * 0.5 + 0.5);
  ambient += sunCol * 0.12;
  vec3 light = sunCol * nDotL + ambient;

  // Submerged terrain seen from under the water: caustics web on the bed.
  // The light is what the surface let through (the water body's light,
  // not the open sun), absorbed on the way down, focused into the web.
  if (uUnderwater > 0.5 && y < 0.0) {
    vec2 uv = (p.xz + l.xz * uTime * 0.6) * 0.45;
    float c = caustics(uv, uTime);
    vec3 down = underwaterExtinction(uAbsorption, -y);
    vec3 uwLight = underwaterLight(skyUp, sunCol, l.y);
    light = uwLight * (0.55 + 0.45 * nDotL) * down * (0.9 + min(c, 2.5) * 0.61 * 0.7);
  }

  vec3 colour = albedo * light;

  // --- fog ----------------------------------------------------------------
  vec3 v = normalize(cameraPosition - p);
  if (uUnderwater > 0.5) {
    vec3 uwLight = underwaterLight(skyUp, sunCol, l.y);
    vec3 fogCol = underwaterRadiance(-v, uWaterColor, uwLight, l, sunCol);
    vec3 ext = underwaterExtinction(uAbsorption, vDist);
    colour = mix(fogCol, colour, ext);
  } else {
    // Same fog as the water surface (water.frag.glsl step 9): the sky's
    // horizon sample already carries the fog colour.
    float fog = saturate1((vDist - uFogNear) / max(uFogFar - uFogNear, 1.0));
    vec3 fogCol = texture(uSky, normalize(vec3(-v.x, 0.02, -v.z))).rgb;
    colour = mix(colour, fogCol, fog);
  }

  fragColor = vec4(uLinearOut > 0.5 ? colour : finish(colour), 1.0);
}
