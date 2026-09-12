/**
 * The one shader include mechanism: `common.glsl` (tonemapping, sky,
 * underwater, terrain and cascade-fade helpers shared by every render
 * shader) is spliced in at a `//#include common` marker. Both stages of the
 * water material, the sky, terrain, underwater, sun-shaft and spray shaders
 * use it, so a helper is defined once and drifts nowhere.
 */
import common from "./common.glsl?raw";
import { skyDefines } from "../skyConstants";

const MARKER = "//#include common";
const spliced = skyDefines() + common;

/**
 * Splice the shared helpers — preceded by the sky constant `#define`s from
 * `skyConstants.ts` — into a shader at its `//#include common` marker
 * (throws if there is none).
 */
export function withCommon(src: string): string {
  if (!src.includes(MARKER)) throw new Error("withCommon: shader has no `//#include common` marker");
  return src.replace(MARKER, spliced);
}
