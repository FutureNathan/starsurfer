/**
 * Power 4 — Asteroid.
 *
 * A rock comes in from orbit and hits the ground where you are looking.
 *
 * Three acts on three clocks, and the split is the whole design — the same
 * argument the Supernova makes, one scale up:
 *
 *   the fall    a second and a half of it, and it is the reason this power is
 *               worth having. Every other power here is instantaneous: you press
 *               a key and a thing is already happening. This one you *watch
 *               arrive*, which makes the impact something the player has been
 *               anticipating for a second rather than something that has
 *               occurred. It is also the only object in the demo that exists
 *               a hundred and fifty metres from the camera.
 *   the impact  one frame. Crater, rim, ejecta curtain, flash, and the hardest
 *               camera shake in the project.
 *   the site    permanent. The crater goes into the terrain state buffer as a
 *               depression with a raised rim and a charged floor, and the charge
 *               decays on a fifteen-minute constant — so what is left behind is
 *               a fresh crater on a surface already covered in old ones, still
 *               glowing, long after the dust has landed.
 *
 * Everything about it obeys vacuum, and the second screenshot review is what
 * made that absolute. There is no atmosphere here, so an incoming rock does not
 * burn: no ablation trail, no glowing head, no sputter — the first two versions
 * had all three, and read as an orange blob instead of an asteroid. What falls
 * now is a rock: a grey tumbling lump, bright only because it is in full
 * sunlight against a black sky, which is exactly how a real object in vacuum is
 * seen. The fire happens where the physics puts it — at the ground, for the
 * fraction of a second the impact turns kinetic energy into incandescent
 * vapour, and in the molten floor it leaves.
 *
 * The ejecta obeys the same rule. Every grain is launched with a drag
 * coefficient of zero, so it flies a clean parabola and lands — no hang, no
 * settling curtain, no billow.
 *
 * It replaced Star Crystal, which grew a lattice of violet prisms out of the
 * ground. That power was built for a sea of cosmic dust and did not survive the
 * ground becoming rock: a crystal formation on a cratered regolith plain reads
 * as decoration rather than as something that happened to the place.
 */

import { PROFILE_TUBE } from "./waterBody.js";
import { POWERS } from "./powers.js";
import { clamp01, smooth01 } from "./bending.js";

/** Spine samples along the bolide and its trail. */
const COLS = 40;

/**
 * Metres ahead of the rider the impact is placed.
 *
 * Exported, because the dispatcher needs it and so does the lead: this power is
 * the one that is *not* aimed at whatever the crosshair happens to be over. See
 * the note in `spellSystem.js`.
 */
export const STANDOFF = 38;

/**
 * Seconds from cast to impact.
 *
 * Exported for the same reason. The dispatcher leads the rider's own velocity by
 * exactly this, so the two cannot disagree — get it wrong and at nineteen metres
 * a second the player arrives at the crater at the same moment the rock does.
 */
export const FALL = 2.6;

/**
 * Where it comes from, relative to the impact point: a hundred and ten metres up,
 * two hundred and forty-five out along the aim bearing *beyond* the target, and a
 * hundred to one side. A twenty-three degree entry over two hundred and ninety
 * metres of path.
 *
 * Every one of those numbers is set by one question — is the thing on screen —
 * and the first version of this power got that question badly wrong. It entered
 * behind the rider and fell steeply, which put it sixty-seven degrees above the
 * horizon at the moment of entry. The camera sits 6.1 m back and 2.9 m up,
 * pitched ten degrees down, with a fifty-eight degree vertical field: the top
 * edge of the frame is nineteen and a half degrees above the horizon. So the
 * asteroid spent the first ninety-three per cent of its fall *outside the
 * picture* and appeared for the last tenth of a second. It was in the frame for
 * 0.11 s of a 1.5 s cast.
 *
 * The geometry is unforgiving about this. An object falling to a point in front
 * of you is at its highest apparent elevation the moment it enters — elevation
 * falls monotonically the whole way down, because the height shrinks faster than
 * the distance does — so there is exactly one condition, at entry, and it decides
 * the entire trajectory. Satisfying it needs the entry *ahead* of the impact
 * rather than behind it, and it needs the path shallow: roughly, the horizontal
 * run has to be about two and three quarter times the entry height.
 *
 * At these numbers the entry sits at 19.3 degrees, a fraction under the frame's
 * top edge, and the whole 2.6 s is on screen at the default pitch and at anything
 * shallower. Only a player staring twenty degrees down at their own board loses
 * the first part of it, and they were not looking at the sky anyway.
 *
 * The lateral hundred metres is what stops it being head-on. Coming straight down
 * the view axis a bolide is a dot with its own trail hidden behind it; twenty
 * degrees off in azimuth and twenty-three in elevation gives the trail a proper
 * oblique length across the frame.
 */
const ENTRY_UP = 110;
const ENTRY_FWD = 245;
const ENTRY_SIDE = 100;
/**
 * How the distance along that path is eased.
 *
 * Above 1, so it accelerates — it is falling. Only just above, though, and that
 * is a change from the first version's 1.6. Back when the object was only in
 * frame for the last tenth of a second there was nothing to lose by rushing the
 * part nobody saw; now that the whole descent is visible, a hard ease spends most
 * of the two and a half seconds crawling and then throws the interesting part
 * away in a blur.
 */
const FALL_EASE = 1.25;
/** Seconds of aftermath once it has landed. */
const AFTER = 3.4;

/**
 * The rock: half-length and radius of the lump, metres.
 *
 * A boulder, not a boulder-sized fireball. It is drawn on the plasma strand
 * because that is the one swept body the project has, with a flat grey emission
 * standing in for sunlit rock — the body material has no N·L path, so "lit by
 * the star" is approximated as a constant at the radiance a mid-grey rock under
 * this star actually reaches (~5 linear). Under the 6.5 bloom knee, so the rock
 * never glows; it is simply a bright object against black, which is how things
 * in vacuum look.
 */
const ROCK_HALF = 2.1;
const ROCK_R = 0.62;

/**
 * The flash: seconds of incandescence at the impact, and its size, metres.
 *
 * Real lunar impacts flash — telescopes photograph them from Earth — and it is
 * the one moment this power has earned fire. It is brief and compact: a squat
 * burst that pops, whites, and is embers within a third of a second. The
 * nine-metre boiling dome an earlier pass drew here is exactly the thing the
 * review called a glowing blob, and it is gone.
 */
const FLASH_T = 0.38;
const FLASH_H = 3.6;
const FLASH_W = 2.3;

/**
 * The rock's flat radiance in flight. Mid-grey regolith's sunlit face under
 * this star: albedo ~0.6 of white x sunRadiance/pi x a generous N·L ≈ 5.
 * Deliberately under the 6.5 bloom knee.
 */
const ROCK_RADIANCE = 5.0;

/**
 * How many can be in the air at once.
 *
 * Every press of the key launches one, and each is fully independent — its own
 * entry, its own target, its own clock, its own strand. Five is where the storm
 * stops being additive: at that many the ejecta of the first is still in the air
 * when the last one lands, which is the whole point, and it is also as many as
 * the plasma body's strand pool can hold alongside every other power being up at
 * the same time.
 */
const ROCKS = 5;

/**
 * How far apart they land, per rock already in the air.
 *
 * The first rock of a storm goes exactly where it was aimed. Every one after it
 * is thrown wider, up to a cap — five rocks converging on one crater is not a
 * storm, it is a stutter, and the dispersion is what turns repeated presses into
 * something that reads as weather.
 */
const SPREAD_STEP = 6.0;
const SPREAD_MAX = 21.0;

/** One rock. Everything that used to be a field of the power itself. */
class Rock {
    constructor() {
        this.live = false;
        this.strand = -1;
        this.t = 0;
        /** Impact point. */
        this.x = 0;
        this.y = 0;
        this.z = 0;
        /** Entry point, and the unit vector from it to the impact. */
        this.ex = 0;
        this.ey = 0;
        this.ez = 0;
        this.dx = 0;
        this.dy = -1;
        this.dz = 0;
        /** A fixed vector perpendicular to the path, for the section frame. */
        this.rx = 1;
        this.ry = 0;
        this.rz = 0;
        this.hit = false;
        this.owed = 0;
        this.wobble = 0;
        /**
         * This rock's share of the storm's budgets — grains and camera shake
         * alike. 1 when it is the only one in the sky. See `trigger`.
         */
        this.share = 1;
    }
}

export class Asteroid {

    /** @param {import("./spellSystem.js").SpellContext} ctx */
    constructor(ctx) {
        this.ctx = ctx;
        /** @type {Rock[]} */
        this._rocks = [];
        for (let i = 0; i < ROCKS; i++) this._rocks.push(new Rock());
    }

    /** True while anything is falling or still settling. */
    get active() {
        for (let i = 0; i < ROCKS; i++) if (this._rocks[i].live) return true;
        return false;
    }

    /** How many are in the air or still throwing dust. */
    get liveCount() {
        let n = 0;
        for (let i = 0; i < ROCKS; i++) if (this._rocks[i].live) n++;
        return n;
    }

    /**
     * Launch one.
     *
     * Called once per key press, and each press adds a rock rather than
     * restarting the one already falling — which is what it used to do, and why
     * hitting the key five times gave you one asteroid five times over.
     *
     * When all five slots are busy the oldest is recycled: its strand and its
     * grains stay where they are and the slot starts a new descent. Dropping the
     * press instead would be more correct and feels broken — a key that does
     * nothing is indistinguishable from a key that did not register.
     *
     * @param {number} x @param {number} y @param {number} z ground target
     */
    trigger(x, y, z) {
        const live = this.liveCount;

        // A free slot, or failing that the one furthest through its own life.
        let r = null;
        let oldest = null;
        for (let i = 0; i < ROCKS; i++) {
            const c = this._rocks[i];
            if (!c.live) { r = c; break; }
            if (!oldest || c.t > oldest.t) oldest = c;
        }
        if (!r) {
            r = oldest;
            if (r.strand >= 0) this.ctx.water.release(r.strand);
            r.strand = -1;
        }

        if (r.strand < 0) r.strand = this.ctx.water.acquire();

        // Thrown wider the busier the sky already is. See `SPREAD_STEP`.
        const spread = Math.min(SPREAD_MAX, SPREAD_STEP * live);
        const sa = Math.random() * Math.PI * 2;
        const sr = spread * Math.sqrt(Math.random());
        r.x = x + Math.cos(sa) * sr;
        r.z = z + Math.sin(sa) * sr;
        r.y = this.ctx.terrain.heightAt(r.x, r.z);

        r.t = 0;
        r.hit = false;
        r.owed = 0;
        r.wobble = Math.random() * 6.28318;
        r.live = true;

        // This rock's share of two budgets that a storm would otherwise blow.
        //
        //   grains  The spray pool is a fixed ring of 5120 and `emit` silently
        //           drops once it is full. Five impacts at a lone rock's count
        //           hold about 3,200 at once, and the thing that would visibly
        //           break is not the asteroid — it is the *wake*, which would
        //           thin out for a second and a half with no obvious cause.
        //   shake   `addTrauma` accumulates and clamps at one, so five impacts at
        //           a lone rock's value pin the camera at maximum for the best
        //           part of a second and the storm becomes unwatchable.
        //
        // Harmonic rather than linear: the first rock is completely unaffected,
        // and five together throw about 2.7 times one rock's dust and shake about
        // 2.7 times as hard — more than one and nowhere near five. That leaves
        // roughly half the spray pool for everything else.
        r.share = 1 / (1 + 0.62 * live);

        // The bearing it comes in on: the aim, flattened, with a little scatter
        // so two casts from the same spot are not the same shot twice, and the
        // lateral offset thrown to either side at random.
        const aim = this.ctx.rig.forward;
        const fl = Math.hypot(aim.x, aim.z) || 1;
        const ang = Math.atan2(aim.x / fl, aim.z / fl) + (Math.random() - 0.5) * 0.35;
        const fx = Math.sin(ang), fz = Math.cos(ang);
        const side = Math.random() < 0.5 ? -ENTRY_SIDE : ENTRY_SIDE;
        // Jittered per rock, so a storm is five different trajectories rather
        // than five copies of one. Only the *entry* moves — the fall time is
        // fixed, because the dispatcher leads the rider's velocity by exactly it.
        //
        // Both jitters are one-sided, and that is not fussiness. The nominal entry
        // sits 19.3 degrees up against a frame whose top edge is 19.5, so it has
        // two tenths of a degree of margin; a symmetric jitter spends that on the
        // first draw and a third of the storm starts off screen. Pushing the entry
        // further out or lower only ever *reduces* its elevation, so every rock is
        // at least as visible as the nominal one and most are more so.
        const jf = 1.0 + Math.random() * 0.26;
        const ju = 0.84 + Math.random() * 0.16;
        // Right of the bearing, in the engine's left-handed frame.
        r.ex = r.x + fx * ENTRY_FWD * jf + fz * side;
        r.ey = r.y + ENTRY_UP * ju;
        r.ez = r.z + fz * ENTRY_FWD * jf - fx * side;

        let dx = r.x - r.ex, dy = r.y - r.ey, dz = r.z - r.ez;
        const l = Math.hypot(dx, dy, dz) || 1;
        r.dx = dx / l; r.dy = dy / l; r.dz = dz / l;

        // Any perpendicular will do — the path is a straight line, so unlike
        // every other body here the frame never has to be transported. It is
        // fixed at the cast and reused for all forty samples.
        const ux = r.dz, uz = -r.dx;
        const ul = Math.hypot(ux, uz) || 1;
        r.rx = ux / ul; r.ry = 0; r.rz = uz / ul;
    }

    /** @param {number} dt */
    update(dt) {
        for (let i = 0; i < ROCKS; i++) {
            const r = this._rocks[i];
            if (!r.live) continue;
            r.t += dt;

            if (r.t >= FALL + AFTER) { this._retire(r); continue; }

            if (r.t < FALL) { this._fall(r, dt); continue; }

            if (!r.hit) {
                r.hit = true;
                this._crater(r);
                this._eject(r);
            }
            // The strand stays live past the impact: the rock becomes the
            // flash. See `_flash`.
            if (r.t < FALL + FLASH_T) this._flash(r);
            else if (r.strand >= 0) {
                this.ctx.water.setParams(r.strand, PROFILE_TUBE, 0.5, 0, 0);
            }
            this._afterglow(r, dt);
        }
    }

    /** How far down its path a rock is, 0 at entry and 1 at the ground. */
    _progress(r) {
        return Math.pow(clamp01(r.t / FALL), FALL_EASE);
    }

    /**
     * The rock in flight.
     *
     * A grey tumbling lump on the strand — no trail, no glow, because there is
     * no air for either. Its visibility comes from contrast: a sunlit object
     * against a black sky, moving fast. The lump's radius is modulated along
     * its length and by a slow tumble so the silhouette changes as it falls;
     * a perfectly smooth capsule reads as a projectile, and a projectile is
     * exactly the read the review objected to.
     */
    _fall(r, dt) {
        const ctx = this.ctx;
        const water = ctx.water;
        const s = r.strand;
        if (s < 0) return;

        const u = this._progress(r);
        const hx = r.ex + (r.x - r.ex) * u;
        const hy = r.ey + (r.y - r.ey) * u;
        const hz = r.ez + (r.z - r.ez) * u;

        // The tumble: the section frame rolls slowly about the flight axis, and
        // the radius profile drifts with it, so the lump turns over as it falls.
        const spin = r.t * 1.7 + r.wobble;

        for (let c = 0; c < COLS; c++) {
            const q = c / (COLS - 1);              // 0 = nose, 1 = tail
            const d = (q - 0.5) * 2 * ROCK_HALF;   // centred on the position
            const x = hx - r.dx * d;
            const y = hy - r.dy * d;
            const z = hz - r.dz * d;

            // An irregular lump: a bell along the length, dented by two slow
            // sine lobes tied to the tumble. Ends must reach zero or the tube
            // shows its caps.
            const bell = Math.sin(Math.PI * clamp01(q));
            const dent = 1
                + 0.22 * Math.sin(q * 9.0 + spin)
                + 0.14 * Math.sin(q * 17.0 - spin * 1.6 + r.wobble * 3.0);
            const rad = ROCK_R * bell * dent;

            water.column(
                s, c, x, y, z, rad,
                r.rx, r.ry, r.rz,
                spin + q * 2.0, d + ROCK_HALF, q, 0.0, 1
            );
        }

        // Sunlit rock, approximated as a constant because the body material has
        // no N·L path: mid-grey regolith under this star reaches about 5 linear
        // on its lit side, and that is what the whole lump is held at. Under
        // the bloom knee — a rock does not glow, it is simply bright against
        // nothing. The front channel stays at zero everywhere: no ignition,
        // no white-hot anything, until the ground supplies the energy.
        water.setParams(s, PROFILE_TUBE, 0.30, 1.0, COLS);
        water.setEmissive(s, 0.62, 0.585, 0.545, ROCK_RADIANCE);
    }

    /**
     * The impact flash.
     *
     * The one moment of fire this power has: kinetic energy becoming
     * incandescent vapour, the way real lunar impacts genuinely flash. Brief
     * and compact — a squat burst that pops, whites, and is embers within a
     * third of a second — on the strand the rock just vacated. An earlier pass
     * drew a nine-metre dome boiling for most of a second here, and the review
     * named it precisely: a glowing blob. The event now is the *crater*, which
     * stays molten and cools; the flash only marks the instant.
     */
    _flash(r) {
        const water = this.ctx.water;
        const s = r.strand;
        if (s < 0) return;

        const t = r.t - FALL;
        const k = t / FLASH_T;
        const pop = smooth01(t / 0.05);
        const die = 1 - smooth01((t - 0.08) / (FLASH_T - 0.08));
        const env = pop * die;
        const height = FLASH_H * (0.4 + 0.6 * pop);

        for (let c = 0; c < COLS; c++) {
            const q = c / (COLS - 1);              // 0 = crown, 1 = ground
            const y = r.y + height * (1 - q);
            const bulge = Math.sin(Math.min(1, q * 1.12) * Math.PI * 0.5);
            const rad = FLASH_W * (0.55 + 0.65 * k) * bulge * env;
            water.column(
                s, c, r.x, y, r.z, rad,
                1, 0, 0,
                t * 9.0 + q * 3.0, q * height, k, clamp01(1.4 - k * 2.2), 1
            );
        }

        const impact = POWERS.impact;
        water.setParams(s, PROFILE_TUBE, 0.5, env, COLS);
        water.setEmissive(
            s, impact.hue[0], impact.hue[1], impact.hue[2],
            impact.body * (1.9 * Math.exp(-t * 6.5) + 0.2) * env
        );
    }

    /**
     * The crater.
     *
     * Bigger than the Supernova's in every channel, because this is the largest
     * single thing that happens in the demo and a crater the size of the one a
     * detonation leaves would undersell a rock arriving from orbit. The rim
     * carries most of the depression's mass back out, which is what makes it read
     * as excavated rather than as pressed in.
     *
     * Six broken outer brushes rather than four, and further out: this is an
     * ejecta blanket, and the thing that gives a real one away is that it is not
     * a ring. Charged well under the floor, for the same reason the Supernova's
     * is — mass thrown clear was never at the centre of it, and an ejecta blanket
     * as hot as the crater reads as a second crater.
     */
    _crater(r) {
        const ctx = this.ctx;
        ctx.deform.brush(
            r.x, r.z,
            2.45,
            0.86,   // depression
            0.62,   // rim
            0.88,   // shocked and packed
            1.00,   // molten. The only writer that reaches the top of the
                    // channel: the floor burns at the ember hue over the bloom
                    // knee and cools through gold to glass in the first half
                    // minute — see the hot decay in deformSim and the molten
                    // band in the ground material.
            Math.random() * Math.PI,
            1.12,   // very slightly oval — a stamped circle is the tell
            1.0
        );
        for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2 + Math.random() * 1.0;
            const d = 2.4 + Math.random() * 1.6;
            ctx.deform.brush(
                r.x + Math.cos(a) * d, r.z + Math.sin(a) * d,
                0.7 + Math.random() * 0.6,
                0.06, 0.26 + Math.random() * 0.18, 0.22, 0.26,
                a, 1.5, 1.0
            );
        }
        // The hardest shake in the project, and it should be — but it falls off
        // with distance, which the fixed value it started with did not. The
        // impact is now placed a good way out and led against the rider's own
        // velocity, so it can land anywhere from thirty-eight metres away (stood
        // still) to ninety (surfing flat out and then stopping), and a ninety
        // metre impact that kicks the camera as hard as one at arm's length reads
        // as the shake being scripted rather than felt.
        //
        // And it is shared out across a storm, on the same inverse square root
        // the grains use. `addTrauma` *accumulates* — it is a sum clamped at one,
        // not a max — so five impacts at a lone rock's value would pin the shake
        // at maximum for the best part of a second and the storm would be
        // unwatchable. Divided, five together still shake harder than one, which
        // is right, without the frame coming apart.
        const pos = ctx.controller.position;
        const d = Math.hypot(r.x - pos.x, r.z - pos.z);
        const near = 0.24 + 0.62 * clamp01(1 - (d - 24) / 74);
        ctx.rig.addTrauma(near * r.share);
    }

    /**
     * The instant of impact.
     *
     * Two populations, and the split is what makes it read as an impact rather
     * than as a firework:
     *
     *   the curtain  a low, fast, *outward* sheet — the inverted cone of debris
     *                that leaves the rim of every impact crater. This is the
     *                shape people recognise, and it only exists because the
     *                launch angle is shallow and the speed is high.
     *   the plume    a smaller, near-vertical population of heavier clods thrown
     *                straight up out of the middle, which come down last.
     *
     * Every one of them is launched with zero drag. See the note at the top: an
     * impact on an airless body throws debris on clean parabolas that land, and
     * the absence of hang is more of the read than any amount of it would be.
     */
    _eject(r) {
        const ctx = this.ctx;
        const sp = ctx.spray;
        if (!sp) return;
        const budget = ctx.sprayScale * r.share;

        const curtain = (620 * budget) | 0;
        for (let k = 0; k < curtain; k++) {
            const a = Math.random() * Math.PI * 2;
            const rr = 1.4 + Math.sqrt(Math.random()) * 1.1;
            // Shallow: between about twenty and fifty degrees, which is the band
            // a real ejecta curtain leaves in. The ceiling on both is set by the
            // grain's own lifetime rather than by taste — launch it harder and the
            // longest arcs outlive their particle and fade out in mid-air, which
            // is the one thing this population must not do. It is thrown debris,
            // and thrown debris lands.
            const speed = 6.5 + Math.random() * 9.5;
            const climb = 0.34 + Math.random() * 0.46;
            const out = Math.sqrt(Math.max(0, 1 - climb * climb));
            const clod = Math.random() < 0.40 ? 1 : 0;
            sp.emit(
                r.x + Math.cos(a) * rr,
                r.y + 0.12 + Math.random() * 0.4,
                r.z + Math.sin(a) * rr,
                Math.cos(a) * speed * out,
                speed * climb,
                Math.sin(a) * speed * out,
                clod ? 0.045 + Math.random() * 0.075 : 0.070 + Math.random() * 0.130,
                1.6 + Math.random() * 2.2,
                clod,
                0                                   // vacuum
            );
        }

        const plume = (190 * budget) | 0;
        for (let k = 0; k < plume; k++) {
            const a = Math.random() * Math.PI * 2;
            const rr = Math.random() * 1.0;
            sp.emit(
                r.x + Math.cos(a) * rr,
                r.y + 0.2 + Math.random() * 0.6,
                r.z + Math.sin(a) * rr,
                Math.cos(a) * (0.4 + Math.random() * 2.2),
                9.0 + Math.random() * 7.0,
                Math.sin(a) * (0.4 + Math.random() * 2.2),
                0.034 + Math.random() * 0.070,
                2.2 + Math.random() * 1.8,
                Math.random() < 0.55 ? 1 : 0,
                0
            );
        }
    }

    /**
     * What is left: a flash that dies fast, a crater floor that stays lit, and a
     * thin second wave of fines still coming down.
     */
    _afterglow(r, dt) {
        const ctx = this.ctx;
        const t = r.t - FALL;
        const impact = POWERS.impact;

        // The flash is over in a third of a second; what follows is the floor of
        // the crater, which the terrain is also rendering as a charged patch. The
        // light is here so the *rim* and the falling debris are lit by it — the
        // charge channel only lights the ground it is written into.
        // Wider and slower than it was: the fireball above is the thing you see,
        // and this is the ground around it answering — a pool of light sweeping
        // out across the regolith and dying back. Twenty-four metres of radius
        // reaches the nearest swell crests, which is what places the impact even
        // when the crater itself is behind one.
        const flash = Math.exp(-t * 8.0);
        const glow = Math.exp(-t * 0.85) * 0.10;
        const k = impact.light * (flash * 2.2 + glow) * r.share;
        if (k > 0.01) {
            ctx.lights.add(
                r.x, r.y + 0.5, r.z, 24.0,
                impact.hue[0], impact.hue[1], impact.hue[2], k
            );
        }

        // A second, slower fall of fines, thrown high enough by the impact to
        // still be coming down. Zero drag again, so these arrive rather than
        // settle — they are on their way back from wherever the burst put them.
        const rate = 300 * ctx.sprayScale * r.share * Math.exp(-t * 1.5);
        if (rate < 1) return;
        r.owed += dt * rate;
        let count = r.owed | 0;
        if (count <= 0) return;
        r.owed -= count;
        if (count > 60) count = 60;

        const sp = ctx.spray;
        if (!sp) return;
        for (let i = 0; i < count; i++) {
            const a = Math.random() * Math.PI * 2;
            const rr = Math.sqrt(Math.random()) * 6.5;
            sp.emit(
                r.x + Math.cos(a) * rr,
                r.y + 5.0 + Math.random() * 9.0,
                r.z + Math.sin(a) * rr,
                (Math.random() - 0.5) * 1.6,
                -1.0 - Math.random() * 3.0,
                (Math.random() - 0.5) * 1.6,
                0.024 + Math.random() * 0.050,
                1.4 + Math.random() * 1.6,
                0,
                0
            );
        }
    }

    _retire(r) {
        r.live = false;
        if (r.strand >= 0) {
            this.ctx.water.release(r.strand);
            r.strand = -1;
        }
    }

    cancel() {
        for (let i = 0; i < ROCKS; i++) this._retire(this._rocks[i]);
    }
}
