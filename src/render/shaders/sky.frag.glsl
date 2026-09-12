precision highp float;

//#include common

in vec3 vDir;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uCloudCoverage;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
out vec4 fragColor;

// Marine haze sits in a shallow layer over the sea, not the whole atmosphere:
// the slab's height in metres. A ray leaving at elevation dir.y crosses
// FOG_SLAB / dir.y metres of it, so the horizon fogs long before the zenith.
const float FOG_SLAB = 80.0;

void main() {
  vec3 dir = normalize(vDir);
  vec3 c = skyRadiance(dir, uSunDir, uMoonDir, uCloudCoverage);
  // Aerial perspective: run the slab path through the same linear near/far
  // law as the water's distance fog, so sea and sky converge on the same
  // colour at the horizon. On a clear day (far ≈ 2 km) only the lowest few
  // degrees haze over; a fog preset (far ≈ 260 m) swallows the whole dome.
  // The fog has no light of its own: its *brightness* is the sky's at the
  // horizon in this direction (so it dims through dusk and under a deck by
  // itself, and the water's distance fog — which targets this very sample —
  // meets it exactly), its *hue* is the user's fog colour, and the colour's
  // own luminance is the bank's fully-lit brightness — a cap, so a dark
  // rain fog (authored below the sky's level) stays darker than its deck.
  float path = FOG_SLAB / max(dir.y, 1e-3);
  float fog = clamp((path - uFogNear) / max(uFogFar - uFogNear, 1.0), 0.0, 1.0);
  if (fog > 0.0) {
    vec3 hz = skyRadiance(normalize(vec3(dir.x, 0.02, dir.z + 1e-4)), uSunDir, uMoonDir, uCloudCoverage);
    const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
    float lumFog = dot(uFogColor, LUMA);
    // The bank is its authored colour, dimmed by the light actually there:
    // uFogColor * min(1, lum(hz)/lum(fog)) — so a sunset's afterglow makes
    // the bank brighter on the sun's side but never re-tints it.
    vec3 bank = uFogColor * min(1.0, dot(hz, LUMA) / max(lumFog, 1e-4));
    c = mix(c, bank, fog);
  }
#ifdef TONEMAP
  c = finish(c);
#endif
  fragColor = vec4(c, 1.0);
}
