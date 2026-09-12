/**
 * A procedural three-masted galleon, ~40 m on deck (spec §1.9, §1.15). The
 * hull is lofted from the lines in `hullShape.ts` with plank UVs in metres
 * (the procedural wood texture from `assets/shipMaterials.ts` tiles at 4 m),
 * split into tarred planking below the waterline and oiled planking above,
 * with three raised wales (strakes), a gilt band, gunports with cannon
 * muzzles, a stern gallery with glazed windows, a main deck, forecastle, a
 * two-step stern castle, bowsprit, three masts with tops and yards, four
 * bellied canvas sails with reef bands, shrouds with ratlines and stays.
 *
 * It is the fallback for the glTF galleon (`assets/shipLoader.ts`) and the
 * `?ship=procedural` model.
 *
 * Coordinates: x starboard, y up, z aft (the ship sails toward −z); the
 * waterline is y = 0 and the loft is centred on z = 0. Every mesh is tagged
 * `userData.castsWaterDepth = true` for the water depth pass and casts /
 * receives the sun's shadow.
 */
import * as THREE from "three";
import { sharedShipMaterials, type ShipMaterials } from "../assets/shipMaterials";
import { BULWARK, deckHeight, halfBeamFraction, keelDepthFraction, sectionProfile } from "./hullShape";

export interface ShipModelOptions {
  length?: number;
  beam?: number;
  draft?: number;
  materials?: ShipMaterials;
}

const STATIONS = 22;
const RINGS = 14;
/** Wood texture tile, metres (matches `woodPlanes({ metres: 4 })`). */
const TILE = 4;
const SAIL_TILE = 10;

export class ShipModel extends THREE.Group {
  readonly length: number;
  readonly beam: number;
  readonly draft: number;
  readonly mats: ShipMaterials;
  private readonly geometries: THREE.BufferGeometry[] = [];

  constructor(opts: ShipModelOptions = {}) {
    super();
    this.name = "Ship";
    this.length = opts.length ?? 40;
    this.beam = opts.beam ?? 10;
    this.draft = opts.draft ?? 3;
    this.mats = opts.materials ?? sharedShipMaterials();
    this.buildHull();
    this.buildDecks();
    this.buildRig();
    this.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        o.userData.castsWaterDepth = true;
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
  }

  /** Local z of station `t` (0 stern → 1 bow). */
  private stationZ(t: number): number {
    return this.length / 2 - t * this.length;
  }

  private keep<T extends THREE.BufferGeometry>(g: T): T {
    this.geometries.push(g);
    return g;
  }

  private mesh(geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], name: string): THREE.Mesh {
    const m = new THREE.Mesh(this.keep(geo), mat);
    m.name = name;
    this.add(m);
    return m;
  }

  // ---------------------------------------------------------------- hull

  /** Hull surface point at station t and section fraction u (0 keel → 1 rail), `side` ±1. */
  private hullPoint(t: number, u: number, side: number, out: THREE.Vector3): THREE.Vector3 {
    const hb = (this.beam / 2) * halfBeamFraction(t);
    const keelY = -this.draft * keelDepthFraction(t);
    const railY = deckHeight(t) + BULWARK;
    return out.set(side * hb * sectionProfile(u), keelY + (railY - keelY) * u, this.stationZ(t));
  }

  private buildHull(): void {
    const positions: number[] = [];
    const uvs: number[] = [];
    const above: number[] = [];
    const below: number[] = [];
    const ringPoints = 2 * RINGS + 1;
    const p = new THREE.Vector3();
    const q = new THREE.Vector3();

    for (let s = 0; s <= STATIONS; s++) {
      const t = s / STATIONS;
      let arc = 0;
      for (let r = 0; r < ringPoints; r++) {
        // r: 0 = port rail → RINGS = keel → 2·RINGS = starboard rail.
        const side = r < RINGS ? -1 : 1;
        const u = Math.abs(r - RINGS) / RINGS;
        this.hullPoint(t, u, side, p);
        if (r > 0) arc += p.distanceTo(q);
        q.copy(p);
        positions.push(p.x, p.y, p.z);
        // Planks run fore-aft: u along z, v up the girth (both in metres).
        uvs.push(p.z / TILE, arc / TILE);
      }
    }
    for (let s = 0; s < STATIONS; s++) {
      for (let r = 0; r < ringPoints - 1; r++) {
        const a = s * ringPoints + r;
        const b = a + 1;
        const c = a + ringPoints;
        const d = c + 1;
        const yMid = (positions[a * 3 + 1]! + positions[b * 3 + 1]! + positions[c * 3 + 1]! + positions[d * 3 + 1]!) / 4;
        // Outward-facing winding (viewed from outside the hull).
        (yMid < 0.2 ? below : above).push(a, c, b, b, c, d);
      }
    }
    // Transom: fan across the stern ring.
    const sternCentre = positions.length / 3;
    const sternY = (deckHeight(0) + BULWARK - this.draft * keelDepthFraction(0)) / 2;
    positions.push(0, sternY, this.stationZ(0));
    uvs.push(0, sternY / TILE);
    for (let r = 0; r < ringPoints - 1; r++) above.push(sternCentre, r + 1, r);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex([...below, ...above]);
    geo.addGroup(0, below.length, 0);
    geo.addGroup(below.length, above.length, 1);
    geo.computeVertexNormals();
    this.mesh(geo, [this.mats.hullBelow, this.mats.hull], "hull");

    // Wales: raised strakes along the hull at the waterline, the gun deck
    // and just under the rail; a gilt band above the upper wale.
    this.strake(0.5, 0.14, 0.45, this.mats.wale, "wale-lower");
    this.strake(0.7, 0.14, 0.4, this.mats.wale, "wale-upper");
    this.strake(0.86, 0.1, 0.32, this.mats.wale, "wale-rail");
    this.strake(0.79, 0.04, 0.16, this.mats.gilt, "gilt-band");

    // Keel, stem and rudder.
    const keel = this.mesh(new THREE.BoxGeometry(0.5, 0.6, this.length * 0.78), this.mats.wale, "keel");
    keel.position.set(0, -this.draft - 0.1, this.length * 0.03);
    const stem = this.mesh(new THREE.BoxGeometry(0.5, deckHeight(1) + BULWARK + this.draft * 0.7, 1.2), this.mats.wale, "stem");
    stem.position.set(0, (deckHeight(1) + BULWARK - this.draft * 0.7) / 2, this.stationZ(1) + 0.2);
    stem.rotation.x = 0.28;
    const rudder = this.mesh(new THREE.BoxGeometry(0.35, this.draft * 0.85 + 1.5, 1.4), this.mats.wale, "rudder");
    rudder.position.set(0, -this.draft * 0.85 * 0.5 + 0.5, this.stationZ(0) + 0.6);
  }

  /** A strake: a ribbon `h` m tall standing `thick` m proud of the hull along section fraction `u`. */
  private strake(u: number, thick: number, h: number, mat: THREE.Material, name: string): void {
    const positions: number[] = [];
    const uvs: number[] = [];
    const index: number[] = [];
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    const o = new THREE.Vector3();
    const t0 = 0.02;
    const t1 = 0.985;
    const n1 = STATIONS + 1;
    for (const side of [-1, 1]) {
      const base = positions.length / 3;
      for (let s = 0; s < n1; s++) {
        const t = t0 + ((t1 - t0) * s) / (n1 - 1);
        this.hullPoint(t, u, side, p);
        // Outward normal in the section plane.
        this.hullPoint(t, Math.min(1, u + 0.02), side, tmp);
        n.set(tmp.y - p.y, -(tmp.x - p.x), 0).normalize();
        if (n.x * side < 0) n.negate();
        o.copy(p).addScaledVector(n, thick);
        positions.push(p.x, p.y - h / 2, p.z, o.x, o.y - h / 2, o.z, o.x, o.y + h / 2, o.z, p.x, p.y + h / 2, p.z);
        for (let k = 0; k < 4; k++) uvs.push(p.z / TILE, k / 40);
      }
      for (let s = 0; s < n1 - 1; s++) {
        const a = base + s * 4;
        const b = a + 4;
        for (let k = 0; k < 3; k++) {
          if (side > 0) index.push(a + k, b + k, a + k + 1, a + k + 1, b + k, b + k + 1);
          else index.push(a + k, a + k + 1, b + k, a + k + 1, b + k + 1, b + k);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(index);
    geo.computeVertexNormals();
    this.mesh(geo, mat, name);
  }

  // --------------------------------------------------------------- decks

  /** A planked deck surface between the gunwales from station t0 to t1 at `lift` m above the sheer. */
  private deckStrip(t0: number, t1: number, lift: number, inset = 0.35, name = "deck"): THREE.Mesh {
    const B2 = this.beam / 2;
    const n = Math.max(2, Math.round((t1 - t0) * STATIONS) + 1);
    const positions: number[] = [];
    const uvs: number[] = [];
    const index: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = t0 + ((t1 - t0) * i) / (n - 1);
      const hb = Math.max(0.05, B2 * halfBeamFraction(t) * sectionProfile(1) - inset);
      const y = deckHeight(t) + lift;
      const z = this.stationZ(t);
      positions.push(-hb, y, z, 0, y + 0.12, z, hb, y, z);
      // Deck planks run fore-aft: rows along z.
      uvs.push(z / TILE, -hb / TILE, z / TILE, 0, z / TILE, hb / TILE);
    }
    for (let i = 0; i < n - 1; i++) {
      const a = i * 3;
      const b = a + 3;
      // Upward-facing (bow at −z, port at −x).
      index.push(a, a + 1, b, b, a + 1, b + 1, a + 1, a + 2, b + 1, b + 1, a + 2, b + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(index);
    geo.computeVertexNormals();
    return this.mesh(geo, this.mats.deck, name);
  }

  /** Walls of a castle from station t0 to t1, `h` m above the sheer, following the hull's taper. */
  private castleBlock(t0: number, t1: number, h: number, mat: THREE.Material): THREE.Mesh {
    const B2 = this.beam / 2;
    const n = Math.max(2, Math.round((t1 - t0) * STATIONS) + 1);
    const positions: number[] = [];
    const uvs: number[] = [];
    const index: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = t0 + ((t1 - t0) * i) / (n - 1);
      const hb = Math.max(0.05, B2 * halfBeamFraction(t) * sectionProfile(1) - 0.3);
      const y0 = deckHeight(t) - 0.4;
      const y1 = deckHeight(t) + h;
      const z = this.stationZ(t);
      positions.push(-hb, y0, z, -hb, y1, z, hb, y1, z, hb, y0, z);
      uvs.push(z / TILE, y0 / TILE, z / TILE, y1 / TILE, z / TILE, y1 / TILE + 0.5, z / TILE, y0 / TILE + 0.5);
    }
    for (let i = 0; i < n - 1; i++) {
      const a = i * 4;
      const b = a + 4;
      for (let k = 0; k < 3; k++) index.push(a + k, b + k, a + k + 1, a + k + 1, b + k, b + k + 1);
    }
    // End walls.
    index.push(0, 1, 2, 0, 2, 3);
    const e = (n - 1) * 4;
    index.push(e, e + 2, e + 1, e, e + 3, e + 2);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(index);
    geo.computeVertexNormals();
    return this.mesh(geo, mat, "castle");
  }

  /** A thin rail along the castle's deck edge. */
  private cornice(t0: number, t1: number, h: number, mat: THREE.Material): THREE.Mesh {
    const B2 = this.beam / 2;
    const n = Math.max(2, Math.round((t1 - t0) * STATIONS) + 1);
    const positions: number[] = [];
    const index: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = t0 + ((t1 - t0) * i) / (n - 1);
      const hb = Math.max(0.05, B2 * halfBeamFraction(t) * sectionProfile(1) - 0.2);
      const y = deckHeight(t) + h;
      const z = this.stationZ(t);
      for (const side of [-1, 1]) positions.push(side * hb, y, z, side * hb, y + 0.9, z, side * (hb - 0.25), y + 0.9, z);
    }
    for (let i = 0; i < n - 1; i++) {
      const a = i * 6;
      const b = a + 6;
      for (const o of [0, 3]) {
        index.push(a + o, b + o, a + o + 1, a + o + 1, b + o, b + o + 1, a + o + 1, b + o + 1, a + o + 2, a + o + 2, b + o + 1, b + o + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    return this.mesh(geo, mat, "cornice");
  }

  private buildDecks(): void {
    // Main deck, a touch below the rail so the bulwark shows.
    this.deckStrip(0.02, 0.98, -0.05);

    // Stern castle: quarterdeck and poop, each a lofted cabin block that
    // follows the hull's taper and sheer, with a planked deck on top and a
    // gilt cornice along its edge.
    const steps: [number, number, number][] = [
      // t0, t1, height above the sheer
      [0.0, 0.36, 2.3],
      [0.0, 0.18, 4.3],
    ];
    for (const [t0, t1, h] of steps) {
      this.castleBlock(t0, t1, h, this.mats.hull);
      this.deckStrip(t0 + 0.01, t1, h, 0.32, "castle-deck");
      this.cornice(t0, t1, h + 0.05, this.mats.gilt);
    }
    // Gunports: a row of dark squares along each side at the wale, with a
    // cannon muzzle showing in each.
    for (let i = 0; i < 7; i++) {
      const t = 0.2 + i * 0.09;
      const hb = (this.beam / 2) * halfBeamFraction(t) * sectionProfile(0.72);
      const y = deckHeight(t) - 1.0;
      for (const side of [-1, 1]) {
        const g = this.mesh(new THREE.BoxGeometry(0.12, 0.9, 1.0), this.mats.wale, "gunport");
        g.position.set(side * (hb + 0.02), y, this.stationZ(t));
        const muzzle = this.mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.8, 8), this.mats.iron, "cannon");
        muzzle.rotation.z = Math.PI / 2;
        muzzle.position.set(side * (hb + 0.25), y, this.stationZ(t));
      }
    }

    // Stern gallery: a row of glazed panes in gilt frames on the transom.
    const sternZ = this.stationZ(0.02) + 0.05;
    const transomHb = (this.beam / 2) * halfBeamFraction(0.02) * sectionProfile(1) - 0.9;
    for (let i = 0; i < 5; i++) {
      const x = -transomHb + (i / 4) * 2 * transomHb;
      const w = this.mesh(new THREE.BoxGeometry(0.9, 1.1, 0.1), this.mats.glass, "window");
      w.position.set(x, deckHeight(0.02) + 1.3, sternZ);
      const f = this.mesh(new THREE.BoxGeometry(1.1, 1.3, 0.08), this.mats.gilt, "window-frame");
      f.position.set(x, deckHeight(0.02) + 1.3, sternZ - 0.02);
    }
    // Stern lantern.
    const lantern = this.mesh(
      new THREE.SphereGeometry(0.4, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xffd27a, emissive: 0xffb347, emissiveIntensity: 1.2, roughness: 0.4 }),
      "lantern",
    );
    lantern.position.set(0, deckHeight(0.02) + 4.3 + 1.6, this.stationZ(0.0) - 0.4);

    // Forecastle.
    this.castleBlock(0.76, 0.97, 1.6, this.mats.hull);
    this.deckStrip(0.76, 0.96, 1.6, 0.32, "forecastle-deck");
    this.cornice(0.76, 0.96, 1.65, this.mats.gilt);
  }

  // ----------------------------------------------------------------- rig

  private spar(radiusTop: number, radiusBottom: number, len: number): THREE.Mesh {
    return this.mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, len, 10), this.mats.spar, "spar");
  }

  /**
   * A square sail hung from a yard: `w` × `h`, bellied forward (−z) by
   * `belly` m. Returns the mesh and the (local) points of two reef bands
   * across its face for the rope pass.
   */
  private sail(w: number, h: number, belly: number): { mesh: THREE.Mesh; reefs: THREE.Vector3[][] } {
    const cols = 14;
    const rows = 10;
    const geo = new THREE.PlaneGeometry(w, h, cols, rows);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const u = THREE.MathUtils.clamp(pos.getX(i) / w + 0.5, 0, 1);
      const v = THREE.MathUtils.clamp(pos.getY(i) / h + 0.5, 0, 1); // 1 at the yard (top), 0 at the foot
      const across = Math.sin(u * Math.PI);
      const down = Math.pow(Math.sin((1 - v) * Math.PI * 0.5), 0.8);
      pos.setZ(i, -belly * across * (0.35 + 0.65 * down));
      // The foot falls a little at the clews' inside: a soft catenary.
      pos.setY(i, pos.getY(i) - 0.25 * h * (1 - v) * (1 - across) * 0.3);
      // Canvas panels in metres.
      uv.setXY(i, (u * w) / SAIL_TILE, (v * h) / SAIL_TILE);
    }
    geo.computeVertexNormals();
    const mesh = this.mesh(geo, this.mats.sail, "sail");
    // Reef bands: rows 2 and 3 from the yard (PlaneGeometry rows run top → bottom).
    const reefs: THREE.Vector3[][] = [];
    for (const row of [2, 3]) {
      const pts: THREE.Vector3[] = [];
      for (let c = 0; c <= cols; c++) {
        const i = row * (cols + 1) + c;
        pts.push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i) - 0.06));
      }
      reefs.push(pts);
    }
    return { mesh, reefs };
  }

  private buildRig(): void {
    const rope: number[] = [];
    const B2 = this.beam / 2;
    const addRope = (a: THREE.Vector3, b: THREE.Vector3): void => {
      rope.push(a.x, a.y, a.z, b.x, b.y, b.z);
    };

    // Masts: [station t, height above the deck, yards (course, topsail) widths as a fraction of the height].
    const masts: { t: number; height: number; yards: number[] }[] = [
      { t: 0.74, height: 26, yards: [0.56, 0.42] },
      { t: 0.47, height: 32, yards: [0.58, 0.44] },
      { t: 0.2, height: 22, yards: [0.42] },
    ];
    const tops: THREE.Vector3[] = [];
    masts.forEach((m, mi) => {
      const z = this.stationZ(m.t);
      const deckY = deckHeight(m.t) + (mi === 2 ? 2.3 : mi === 0 ? 1.6 : 0) - 0.3;
      const mast = this.spar(0.16, 0.38, m.height + 1);
      mast.position.set(0, deckY + (m.height + 1) / 2 - 1, z);
      const topY = deckY + m.height;
      tops.push(new THREE.Vector3(0, topY, z));

      // Fighting top platform at 58 %.
      const platY = deckY + m.height * 0.58;
      const plat = this.mesh(new THREE.CylinderGeometry(1.1, 0.9, 0.3, 12), this.mats.spar, "top");
      plat.position.set(0, platY, z);

      // Yards and sails: course at 36 %, topsail at 70 %.
      const yardFrac = [0.36, 0.7];
      m.yards.forEach((wf, yi) => {
        const w = wf * m.height;
        const yardY = deckY + m.height * yardFrac[yi]!;
        const yard = this.spar(0.12, 0.12, w);
        yard.rotation.z = Math.PI / 2;
        yard.position.set(0, yardY, z - 0.5);
        // Sail hangs from the yard; the mizzen carries none (a bare yard reads as a galleon's lateen spar).
        if (mi < 2) {
          const h = yi === 0 ? m.height * 0.24 : m.height * 0.2;
          const { mesh: s, reefs } = this.sail(w * 0.96, h, w * 0.14);
          s.position.set(0, yardY - h / 2, z - 0.7);
          for (const band of reefs) {
            for (let k = 0; k + 1 < band.length; k++) addRope(band[k]!.clone().add(s.position), band[k + 1]!.clone().add(s.position));
            // Reef points: short lines hanging from the band.
            for (let k = 1; k < band.length; k += 2) {
              const a = band[k]!.clone().add(s.position);
              addRope(a, a.clone().setY(a.y - 0.6));
            }
          }
          // Sheets: clews down to the deck edge (course) or the yard below (topsail).
          for (const side of [-1, 1]) {
            const clew = new THREE.Vector3((side * w * 0.96) / 2, yardY - h, z - 0.7);
            const to =
              yi === 0
                ? new THREE.Vector3(side * (B2 * halfBeamFraction(m.t) - 0.5), deckY + 1.2, z + 3)
                : new THREE.Vector3((side * m.yards[0]! * m.height) / 2, deckY + m.height * yardFrac[0]!, z - 0.5);
            addRope(clew, to);
          }
        }
        // Lifts: yardarm to the mast above.
        for (const side of [-1, 1]) addRope(new THREE.Vector3((side * w) / 2, yardY, z - 0.5), new THREE.Vector3(0, yardY + m.height * 0.2, z));
      });

      // Shrouds: three per side from the platform down to the channels, with ratlines.
      for (const side of [-1, 1]) {
        const feet: THREE.Vector3[] = [];
        const head = new THREE.Vector3(side * 0.3, platY - 0.2, z);
        for (let k = -1; k <= 1; k++) {
          const foot = new THREE.Vector3(side * (B2 * halfBeamFraction(m.t + k * 0.03) * 0.96), deckHeight(m.t) + BULWARK, z + k * 1.6);
          addRope(head, foot);
          feet.push(foot);
        }
        const span = head.y - feet[1]!.y;
        for (let y = 1.2; y < span - 1.5; y += 1.1) {
          const f = y / span;
          addRope(feet[0]!.clone().lerp(head, f), feet[2]!.clone().lerp(head, f));
        }
      }
      // Flag at the main truck.
      if (mi === 1) {
        const flag = this.mesh(new THREE.PlaneGeometry(4.5, 1.6, 6, 1), this.mats.flag, "flag");
        flag.position.set(0, topY + 0.4, z + 2.3);
        flag.rotation.y = Math.PI / 2;
      }
    });

    // Bowsprit.
    const bowZ = this.stationZ(1);
    const spritLen = 13;
    const sprit = this.spar(0.12, 0.3, spritLen);
    const spritAngle = 0.32;
    sprit.rotation.x = -Math.PI / 2 + spritAngle;
    const spritBase = new THREE.Vector3(0, deckHeight(0.98) + 1.6, bowZ + 2.5);
    const spritDir = new THREE.Vector3(0, Math.sin(spritAngle), -Math.cos(spritAngle));
    sprit.position.copy(spritBase).addScaledVector(spritDir, spritLen / 2);
    const spritTip = spritBase.clone().addScaledVector(spritDir, spritLen * 0.95);

    // Stays: fore top → bowsprit; each mast head to the one ahead; backstays to the stern.
    addRope(tops[0]!, spritTip);
    addRope(tops[0]!.clone().setY(tops[0]!.y * 0.6), spritTip.clone().addScaledVector(spritDir, -4));
    addRope(tops[1]!, tops[0]!.clone().setY(tops[0]!.y * 0.62));
    addRope(tops[2]!, tops[1]!.clone().setY(tops[1]!.y * 0.6));
    addRope(tops[1]!, new THREE.Vector3(0, deckHeight(0.05) + 4.3, this.stationZ(0.06)));

    const ropeGeo = this.keep(new THREE.BufferGeometry());
    ropeGeo.setAttribute("position", new THREE.Float32BufferAttribute(rope, 3));
    const lines = new THREE.LineSegments(ropeGeo, this.mats.ropeLine);
    lines.name = "rigging";
    this.add(lines);
  }

  /** Geometry only: the materials are shared (`ShipMaterials`). */
  override dispose(): void {
    for (const g of this.geometries) g.dispose();
  }
}
