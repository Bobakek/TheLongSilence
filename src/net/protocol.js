/* ============================================================================
   The wire, defined once and imported by both ends.

   Vite serves this to the browser; Node loads the same file off disk. There is
   no build step between them and no second copy to drift, which is the only
   reason a hand-rolled protocol is safe to hand-roll.

   ------------------------------------------------------------------- M1

   JSON, and deliberately so. The input packet is seven numbers and a bitmask —
   forty bytes as text, and the transport is not what M1 is testing. Binary
   framing belongs with the interest management in M2, once there is something
   to measure. What matters now is that the *shape* is right: the client sends
   intent, never position, and the server answers with state.

   The client never sends where it is. That is the whole point of an
   authoritative server, and it is worth being explicit about because the
   tempting shortcut — ship `absPos` and let the server believe it — is a
   protocol you cannot add anti-cheat to later without replacing it.
   ========================================================================== */

export const PROTOCOL_VERSION = 1;

/** Server simulation rate. Fixed: every player is stepped on the same clock. */
export const TICK_HZ = 30;
export const TICK_DT = 1 / TICK_HZ;

/** How often the server broadcasts. Every second tick — see the plan's §4. */
export const SNAPSHOT_EVERY = 2;

/** Buttons, as a bitmask on the input packet. */
export const BTN = {
  FOLD: 1 << 0,
  BOOST: 1 << 1,
  STOP: 1 << 2,
  SCAN: 1 << 3,          // held, not tapped
  FIRE: 1 << 4,          // held; the cooldown does the rate limiting
};

/* ------------------------------------------------------------------ client */

export const C = {
  HELLO: 'hello',
  INPUT: 'in',
  PING: 'ping',
  JUMP: 'jump',
};

/** An empty input, and the canonical field order. */
export function emptyInput() {
  return { pitch: 0, yaw: 0, roll: 0, strafeX: 0, strafeY: 0, throttleDelta: 0, boost: 0 };
}

export function encodeInput(seq, raw, buttons, aim) {
  const m = {
    t: C.INPUT, seq,
    p: r4(raw.pitch), y: r4(raw.yaw), r: r4(raw.roll),
    sx: r4(raw.strafeX), sy: r4(raw.strafeY),
    td: r4(raw.throttleDelta), b: buttons | 0,
  };
  /* Where the pilot is looking, which is not where the ship is pointing —
     `Game.aimTarget` reads the camera, and free-look, the chase camera and a
     cutscene all move it independently of the hull. The server cannot check
     this against anything; what it can do is resolve the target from it by the
     same rules, so a client cannot name a body it is not pointing at. */
  if (aim) m.a = [r5(aim.x), r5(aim.y), r5(aim.z), r5(aim.w)];
  return JSON.stringify(m);
}

/**
 * The input as the server will reconstruct it — rounded and clamped exactly as
 * `encodeInput` then `decodeInput` would leave it.
 *
 * A predicting client MUST step through this rather than through its own raw
 * stick. The wire rounds to 1e-4; predicting from the unrounded value and
 * sending the rounded one means the two sides integrate subtly different
 * numbers on every single tick, and the error compounds through the attitude
 * integration into a displacement you can measure. It was measured: a steady
 * 0.17–0.5 units of correction, on a link with no packet loss and no
 * disagreement about anything else.
 */
export function quantizeInput(raw, buttons = 0) {
  return {
    pitch: clamp1(r4(raw.pitch)), yaw: clamp1(r4(raw.yaw)), roll: clamp1(r4(raw.roll)),
    strafeX: clamp1(r4(raw.strafeX)), strafeY: clamp1(r4(raw.strafeY)),
    throttleDelta: clamp1(r4(raw.throttleDelta)),
    boost: (buttons & BTN.BOOST) ? 1 : 0,
  };
}

/**
 * Read an input packet back, clamped.
 *
 * The clamp is not tidiness: this is the one message a client controls
 * completely, and an unclamped stick is a free speed multiplier. A malformed
 * or hostile packet has to become a *legal* input, never an error and never a
 * privilege.
 */
export function decodeInput(m) {
  return {
    seq: m.seq | 0,
    raw: {
      pitch: clamp1(m.p), yaw: clamp1(m.y), roll: clamp1(m.r),
      strafeX: clamp1(m.sx), strafeY: clamp1(m.sy),
      throttleDelta: clamp1(m.td),
      boost: (m.b & BTN.BOOST) ? 1 : 0,
    },
    buttons: m.b | 0,
    // Normalised on arrival: a client is free to send nonsense, and an
    // un-normalised quaternion would quietly skew every dot product in
    // aimTargetFrom rather than failing.
    aim: Array.isArray(m.a) && m.a.length === 4 ? normQuat(m.a) : null,
  };
}

function normQuat(a) {
  const [x, y, z, w] = a.map((n) => (Number.isFinite(n) ? n : 0));
  const l = Math.hypot(x, y, z, w);
  if (!(l > 1e-6)) return { x: 0, y: 0, z: 0, w: 1 };
  return { x: x / l, y: y / l, z: z / l, w: w / l };
}

/* ------------------------------------------------------------------ server */

export const S = {
  WELCOME: 'welcome',
  SNAPSHOT: 'snap',
  JOIN: 'join',
  LEAVE: 'leave',
  PONG: 'pong',
  ERROR: 'err',
  JUMPED: 'jumped',        // you are now in another room
  JUMP_DENIED: 'nojump',
};

/**
 * One ship on the wire.
 *
 * Position, velocity and orientation go at full precision, and that is a
 * decision rather than laziness.
 *
 * They were rounded — position to the millimetre, the quaternion to 1e-5 —
 * which sounds far below anything anyone could see. It is, for *drawing*. It
 * is not for *predicting*: the client re-seats itself on this state every
 * snapshot and then integrates forward from it, so any rounding is a small
 * permanent disagreement about where the ship is, and the fold amplifies it
 * without bound — `foldCeiling` is a function of distance and fold speed is a
 * function of the ceiling, so being a millimetre further out means going
 * faster means being further out. Measured: 0.013 units of error at cruise,
 * 167 units the moment the drive engaged.
 *
 * Quantising the wire is still the right thing to do eventually, but it only
 * works if the *server* adopts the quantised value as its own state, so both
 * sides continue from identical numbers. Until then, full precision. The
 * cosmetic scalars below still round: nothing integrates from them.
 */
export function encodeShip(id, s) {
  return {
    id,
    p: [s.absPos.x, s.absPos.y, s.absPos.z],
    v: [s.vel.x, s.vel.y, s.vel.z],
    q: [s.quat.x, s.quat.y, s.quat.z, s.quat.w],
    /* Integrator state, and it is not optional.
       Everything `stepShip` both reads and writes has to be here, or a client
       re-seats on the server's position and then carries on using its own
       leftovers — a hybrid state that belongs to neither side. `angVel` is the
       rotation integrator, so leaving it out quietly gave every reconcile a
       slightly different attitude; `foldSpeed` is worse, because in a fold
       `vel` is *recomputed* from it every tick, so the server's velocity was
       being overwritten by the client's own fold speed on the very next step.
       Measured: about a metre of error at cruise, and eight hundred the moment
       the drive lit. */
    av: [s.angVel.x, s.angVel.y, s.angVel.z],
    fs: s.foldSpeed,
    ht: s.heat,
    th: s.throttle, bo: s.boost,
    f: s.foldMode ? 1 : 0,
    hl: r4(s.hull),
    fc: s.foldCharge,
    /* The upgrade-mutable parameters.
       They change rarely — an attuned Resonator raises maxSpeed by 9% — but
       `stepFlight` reads every one of them, so a client predicting with a stale
       set is predicting a different ship. Sending them only on change would be
       cheaper and would mean a client that missed one packet drifts until it
       reconnects. Eight numbers is not the problem worth solving here. */
    ms: s.maxSpeed, sr: s.scanRate, fr: s.foldRegen,
    // combat state — the shield is drawn, the cooldown gates the trigger, and
    // both are stepped every tick, so both belong on the wire for the same
    // reason angVel does
    sh: s.shield, shm: s.shieldMax, cd: s.cooldown,
  };
}

/** One bolt in flight. Position and velocity; the client draws the streak. */
export function encodeBolt(b) {
  return {
    i: b.id, o: b.owner,
    p: [b.pos.x, b.pos.y, b.pos.z],
    v: [b.vel.x, b.vel.y, b.vel.z],
  };
}
function r4(n) { return Math.round(n * 1e4) / 1e4; }
/* The aim may be rounded — nothing integrates from it. It picks a target by a
   dot-product threshold of 0.955, and 1e-5 of slop cannot move that decision
   across a body boundary at any range that matters. */
function r5(n) { return Math.round(n * 1e5) / 1e5; }
function clamp1(n) { return Number.isFinite(n) ? Math.max(-1, Math.min(1, n)) : 0; }
