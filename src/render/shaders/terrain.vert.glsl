precision highp float;

// Island terrain (spec §1.11): a static heightfield mesh; heights and
// normals come from the geometry, the fragment shader does the shading.

in vec3 position;
in vec3 normal;

uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 modelMatrix;
uniform vec3 cameraPosition;

out vec3 vWorld;
out vec3 vNormal;
out float vDist;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  // World space: the fragment shader lights against the world sun/sky and
  // masks rock by world slope. (three's `normalMatrix` is view-space.)
  // The terrain is only translated, so mat3(modelMatrix) is exact.
  vNormal = normalize(mat3(modelMatrix) * normal);
  vDist = distance(world.xyz, cameraPosition);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
