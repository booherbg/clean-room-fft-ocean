// Fullscreen quad: the PlaneGeometry(2,2) already spans clip space, so no
// matrices. Every pass addresses texels with ivec2(gl_FragCoord.xy).
precision highp float;

in vec3 position;

void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
