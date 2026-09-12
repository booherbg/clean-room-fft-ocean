# Asset licenses

All files under `public/assets/` are third-party work redistributed under the
licenses below. Nothing here is required to be credited, but we do anyway.

| File | Source | Author | License |
| --- | --- | --- | --- |
| `models/galleon.glb` | [Pirate Ship](https://opengameart.org/content/pirate-ship-0) (`GalleonOGA.obj`), OpenGameArt | Daniel Quevedo | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `models/palm-tall.glb` | [Nature Kit 2.1](https://kenney.nl/assets/nature-kit) (`tree_palmDetailedTall.glb`) | Kenney (www.kenney.nl) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `models/palm-short.glb` | [Nature Kit 2.1](https://kenney.nl/assets/nature-kit) (`tree_palmDetailedShort.glb`) | Kenney (www.kenney.nl) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `models/palm-bend.glb` | [Nature Kit 2.1](https://kenney.nl/assets/nature-kit) (`tree_palmBend.glb`) | Kenney (www.kenney.nl) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |

## Modifications

- `galleon.glb` is derived from the untextured OBJ by
  `scripts/buildShipAsset.mjs`: the single mesh is split into connected
  components, classified as hull / spar / sail / iron, given box-projected
  UVs, scaled to 40 m on deck with the waterline at y = 0 and written as a
  glTF binary. The app dresses the parts with its own procedural wood,
  canvas and iron materials (`src/app/assets/shipMaterials.ts`); the file
  carries only flat placeholder colours.
- The Kenney palms are unmodified (`.glb` straight from the kit).

The procedural fallback ship (`src/app/ship/shipModel.ts`), the rocks and
the frond textures are original work under the repository's MIT license.
