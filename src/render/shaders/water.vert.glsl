precision highp float;

// Clipmap vertex shader (spec §1.8): snap to the camera, sum the cascade
// displacements sampled at worldXZ / size_i, drop cascades too fine for the
// ring's cell, average neighbours on seam vertices.

in vec3 position;
in float ring;
in vec2 seam;

uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform vec3 cameraPosition;

uniform vec2 uOrigin;      // snapped camera xz
uniform float uBaseCell;
uniform vec3 uSizes;       // cascade tile sides (unused slots = 1)
uniform sampler2D uDisp0;
uniform sampler2D uDisp1;
uniform sampler2D uDisp2;

// Wake field (h, ∂h/∂x, ∂h/∂z, foam) on a uWakeSize square whose min corner
// is at uWakeOrigin; zero (with a soft border) outside it. uWakeSize = 0
// disables it.
uniform sampler2D uWakeTex;
uniform vec2 uWakeOrigin;
uniform float uWakeSize;

// Island heightmap (metres in .r) for wave shoaling; uTerrainSize = 0 disables.
uniform sampler2D uTerrainTex;
uniform vec2 uTerrainOrigin;
uniform float uTerrainSize;

out vec3 vWorld;
out float vHeight;
out float vDist;
out float vViewZ;

//#include common

float wakeHeight(vec2 xz) {
  if (uWakeSize <= 0.0) return 0.0;
  vec2 uv = (xz - uWakeOrigin) / uWakeSize;
  vec2 e = min(uv, 1.0 - uv);
  float mask = smoothstep(0.0, 0.04, min(e.x, e.y));
  return texture(uWakeTex, uv).r * mask;
}

vec3 sampleDisp(vec2 xz, float cell) {
  vec3 d = vec3(0.0);
  float dist = length(xz - cameraPosition.xz);
  float w0 = fadeWeight(uSizes.x, dist) * (1.0 - smoothstep(uSizes.x / 8.0, uSizes.x / 2.0, cell));
  d += texture(uDisp0, xz / uSizes.x).xyz * w0;
#if CASCADES > 1
  float w1 = fadeWeight(uSizes.y, dist) * (1.0 - smoothstep(uSizes.y / 8.0, uSizes.y / 2.0, cell));
  d += texture(uDisp1, xz / uSizes.y).xyz * w1;
#endif
#if CASCADES > 2
  float w2 = fadeWeight(uSizes.z, dist) * (1.0 - smoothstep(uSizes.z / 8.0, uSizes.z / 2.0, cell));
  d += texture(uDisp2, xz / uSizes.z).xyz * w2;
#endif
  return d;
}

void main() {
  vec2 xz = uOrigin + position.xz;
  float cell = uBaseCell * exp2(ring);
  vec3 d;
  if (seam.x != 0.0 || seam.y != 0.0) {
    d = 0.5 * (sampleDisp(xz + seam, cell) + sampleDisp(xz - seam, cell));
  } else {
    d = sampleDisp(xz, cell);
  }
  d *= shoalFactor(terrainHeightAt(uTerrainTex, uTerrainOrigin, uTerrainSize, xz));
  d.y += wakeHeight(xz);
  vec3 world = vec3(xz.x + d.x, d.y, xz.y + d.z);
  vWorld = world;
  vHeight = d.y;
  vDist = distance(world, cameraPosition);
  vec4 view = viewMatrix * vec4(world, 1.0);
  vViewZ = -view.z;
  gl_Position = projectionMatrix * view;
}
