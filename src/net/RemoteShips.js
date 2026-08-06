import * as THREE from 'three';
import { buildHull } from '../ship/hull.js';

/* ============================================================================
   Other pilots, drawn.

   Two problems, and the second is the one that matters at these distances.

   **Cost.** `buildHull()` is two thousand lines of procedural geometry and it
   is the same hull for everybody, so it is built once and cloned. three's
   `clone()` shares geometry and materials outright, which is the pattern
   `Fleet.js` already uses for traffic: a dozen ships cost a dozen transforms.
   Building a hull per pilot would be correct and would also be the reason the
   room could not hold twenty of them.

   **Visibility.** The Pale Seeker is 0.1 world units long and a system is
   millions across, so a pilot on the far side of it is thousands of times
   below a pixel and the cloned hull renders nothing at all. Every remote
   therefore also carries a *beacon*: a camera-facing sprite whose world size is
   recomputed each frame from its own view depth so it lands at a constant few
   pixels. That is `Fleet.js`'s answer for traffic — a moving spark is what
   makes a system read as inhabited — and it is the right answer here for the
   same reason.

   The beacon is a built-in `SpriteMaterial` on purpose. Every hand-written
   `ShaderMaterial` in this game has to opt into the logarithmic depth buffer by
   hand or it z-fights; three's own materials already carry the chunks, so this
   is one fewer place to get that wrong.
   ========================================================================== */

const BEACON_PX = 5.0;          // fallback size, before a contact is classified

/* ------------------------------------------------------------ the gain

   The trap this project documents in Fleet.js and which I walked into anyway:
   "BEACON_HDR is the difference between a running light and a grey dot".

   These quads land in a scene-linear HDR target and go through AgX with
   everything else, and a pixel needs something like 120 units of radiance
   before AgX returns white. A `SpriteMaterial` colour is at most 1.0 per
   channel, so a beacon authored as a hex colour arrives at roughly one per
   cent of the value it needs and tonemaps to nothing. Against a starfield
   whose stars are authored in real HDR, it is invisible — which, with a hull
   that is a tenth of a unit long and therefore sub-pixel at any distance worth
   the name, meant a contact could be flown to and never seen at all.

   Colours are multiplied into HDR range below. A pilot sits above the clip
   point and blooms, because finding another pilot is the whole purpose of the
   thing; the two machine contacts sit under it. */
const HDR = 44;
const PILOT = { px: 8.0, hex: 0xfff0c8, gain: 2.1 };
const PATROL = { px: 5.0, hex: 0x9ec8ff, gain: 1.3 };
const HOSTILE = { px: 6.0, hex: 0xff7a4a, gain: 1.7 };
const _v = new THREE.Vector3();

let _template = null;
function hullTemplate() {
  if (!_template) {
    const built = buildHull();
    built.root.traverse((o) => { o.frustumCulled = false; });
    _template = built.root;
  }
  return _template;
}

let _sparkTex = null;
function sparkTexture() {
  if (_sparkTex) return _sparkTex;
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d').createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(210,230,255,0.85)');
  g.addColorStop(1.0, 'rgba(120,170,255,0)');
  const ctx = c.getContext('2d');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  _sparkTex = new THREE.CanvasTexture(c);
  _sparkTex.colorSpace = THREE.SRGBColorSpace;
  return _sparkTex;
}

export class RemoteShips {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.frustumCulled = false;
    scene.add(this.group);
    this.rigs = new Map();      // remote id -> { root, hull, beacon }
  }

  _rig(id) {
    let rig = this.rigs.get(id);
    if (!rig) {
      const root = new THREE.Group();
      root.frustumCulled = false;

      const hull = hullTemplate().clone(true);
      root.add(hull);

      const beacon = new THREE.Sprite(new THREE.SpriteMaterial({
        map: sparkTexture(),
        color: 0x9ec8ff,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        // The spark stands for a ship that is too small to draw, so it must not
        // be hidden by the ship it stands for.
        depthTest: false,
        transparent: true,
      }));
      beacon.frustumCulled = false;
      root.add(beacon);

      this.group.add(root);
      rig = { root, hull, beacon };
      this.rigs.set(id, rig);
    }
    return rig;
  }

  /**
   * Place every remote for this frame.
   *
   *   remotes  the client's live map, keyed by id
   *   origin   the floating-origin anchor — the local ship's absolute position
   *   camera   for the beacon's pixel-size solve
   *   heightPx the drawing buffer height, same units the solve is in
   */
  update(remotes, origin, camera, heightPx) {
    for (const [id, rig] of this.rigs) {
      if (!remotes.has(id)) { this._dispose(id, rig); }
    }

    // One pixel of vertical angle at unit distance. Multiplying by view depth
    // turns a pixel count into a world size, which is the whole trick.
    const perPixel = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) / Math.max(1, heightPx);

    for (const [id, r] of remotes) {
      const rig = this._rig(id);
      rig.root.visible = r.seen;
      if (!r.seen) continue;

      rig.root.position.copy(r.absPos).sub(origin);
      rig.root.quaternion.copy(r.quat);

      /* Colour and size say what it is before anything else can.
         A hull is a tenth of a unit long, so at any distance worth calling a
         distance it is well under a pixel and the beacon is the whole of what
         a pilot sees. Making every contact the same cold white meant another
         pilot and a hostile raider were the same dot. */
      const style = r.isNpc
        ? (r.hostile || r.npcKind === 'raider' ? HOSTILE : PATROL)
        : PILOT;
      if (rig.style !== style) {
        rig.style = style;
        // setHex decodes to linear; the multiply is what puts it in HDR range
        rig.beacon.material.color.setHex(style.hex).multiplyScalar(HDR * style.gain);
      }

      const depth = _v.copy(rig.root.position).sub(camera.position).length();
      rig.beacon.scale.setScalar(Math.max(1e-4, depth * perPixel * style.px));
      // Brighter under power, so a burning drive reads across a system.
      rig.beacon.material.opacity = r.foldMode ? 1.0 : 0.55 + 0.45 * (r.throttle || 0);
    }
  }

  _dispose(id, rig) {
    this.group.remove(rig.root);
    rig.beacon.material.dispose();
    this.rigs.delete(id);
  }

  dispose() {
    for (const [id, rig] of this.rigs) this._dispose(id, rig);
    this.scene.remove(this.group);
  }
}
