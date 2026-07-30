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
 * The ejecta obeys vacuum. Every grain this power throws is launched with a drag
 * coefficient of zero, so it flies a clean parabola and lands — no hang, no
 * settling curtain, no billow. That is the one thing an impact on an airless
 * body looks like that an explosion on Earth does not, and it costs one argument
 * to say. (The field's gravity is Earth's, which is a scene-wide constant this
 * power is in no position to change, so the launch speeds are picked against
 * that rather than against the moon's — the arcs are shaped by the numbers here,
 * not by a physics constant.)
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
 * Where it comes from, relative to the impact point.
 *
 * A hundred and thirty metres up and seventy-eight back along the aim bearing,
 * which is a fifty-nine degree entry. Steep enough to read as "from space" —
 * anything much shallower reads as a firework arcing over — and shallow enough
 * that the trail crosses the frame rather than dropping straight down the middle
 * of it.
 *
 * Back along the *aim*, so it comes in over the player's shoulder and away from
 * the camera. The alternative, having it fly toward the camera, hides the trail
 * behind the head for the whole descent: a bolide seen head-on is a dot.
 */
const ENTRY_UP = 132;
const ENTRY_BACK = 78;
/** Seconds from cast to impact. */
const FALL = 1.5;
/**
 * How the distance along that path is eased.
 *
 * Above 1, so it accelerates. Partly because it should — it is falling — and
 * partly for the read: at constant speed the object covers most of its visible
 * angular travel in the last third anyway (it is far away and small for the
 * first two), and easing in flattens that into something the eye can follow the
 * whole way down.
 */
const FALL_EASE = 1.6;
/** Seconds of aftermath once it has landed. */
const AFTER = 3.4;

/** Radius of the bolide's own head, metres. */
const HEAD_R = 0.62;

export class Asteroid {
    /** @param {import("./spellSystem.js").SpellContext} ctx */
    constructor(ctx) {
        this.ctx = ctx;
        this.active = false;
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
        this._dx = 0;
        this._dy = -1;
        this._dz = 0;
        /** A fixed vector perpendicular to the path, for the section frame. */
        this._rx = 1;
        this._ry = 0;
        this._rz = 0;
        this._hit = false;
        this._curtainOwed = 0;
        this._wobble = 0;
    }

    /** @param {number} x @param {number} y @param {number} z ground target */
    trigger(x, y, z) {
        if (this.strand < 0) this.strand = this.ctx.water.acquire();
        this.x = x;
        this.y = y;
        this.z = z;
        this.t = 0;
        this._hit = false;
        this._curtainOwed = 0;
        this._wobble = Math.random() * 6.28318;

        // The bearing it comes in on: the aim, flattened, with a little scatter
        // so two casts from the same spot are not the same shot twice.
        const aim = this.ctx.rig.forward;
        const fl = Math.hypot(aim.x, aim.z) || 1;
        const ang = Math.atan2(aim.x / fl, aim.z / fl) + (Math.random() - 0.5) * 0.7;
        this.ex = x - Math.sin(ang) * ENTRY_BACK;
        this.ey = y + ENTRY_UP;
        this.ez = z - Math.cos(ang) * ENTRY_BACK;

        let dx = x - this.ex, dy = y - this.ey, dz = z - this.ez;
        const l = Math.hypot(dx, dy, dz) || 1;
        this._dx = dx / l; this._dy = dy / l; this._dz = dz / l;

        // Any perpendicular will do — the path is a straight line, so unlike
        // every other body here the frame never has to be transported. It is
        // fixed at the cast and reused for all forty samples.
        const ux = this._dz, uy = 0, uz = -this._dx;
        const ul = Math.hypot(ux, uy, uz) || 1;
        this._rx = ux / ul; this._ry = uy / ul; this._rz = uz / ul;

        this.active = true;
    }

    /** @param {number} dt */
    update(dt) {
        if (!this.active) return;
        this.t += dt;

        if (this.t >= FALL + AFTER) {
            this._end();
            return;
        }

        if (this.t < FALL) {
            this._fall();
            return;
        }

        if (!this._hit) {
            this._hit = true;
            this._crater();
            this._eject();
            // The trail goes with it. Everything after this is grains and light.
            if (this.strand >= 0) {
                this.ctx.water.setParams(this.strand, PROFILE_TUBE, 0.5, 0, 0);
            }
        }
        this._afterglow(dt);
    }

    /** How far down the path it is, 0 at entry and 1 at the ground. */
    _progress() {
        return Math.pow(clamp01(this.t / FALL), FALL_EASE);
    }

    /**
     * The bolide and its trail.
     *
     * One tube: a small hard head at the current position and an expanding,
     * cooling wake stretching back up the entry path behind it. Radius grows with
     * distance behind the head and then fades out, which is what an ablation
     * trail does — the mass shed earliest has had the longest to spread — and it
     * is also what stops the thing reading as a glowing pipe.
     */
    _fall() {
        const ctx = this.ctx;
        const water = ctx.water;
        const s = this.strand;
        if (s < 0) return;

        const u = this._progress();
        const hx = this.ex + (this.x - this.ex) * u;
        const hy = this.ey + (this.y - this.ey) * u;
        const hz = this.ez + (this.z - this.ez) * u;

        // The trail lengthens as it descends: more ablation the deeper it gets.
        // Clamped against the distance already flown, so at the very start it is
        // not drawn coming out of a point above the entry.
        const flown = Math.hypot(hx - this.ex, hy - this.ey, hz - this.ez);
        const trail = Math.min(9 + 32 * u, flown);

        for (let c = 0; c < COLS; c++) {
            const q = c / (COLS - 1);          // 0 = head, 1 = tail
            const d = q * trail;
            // A slight wander, so the trail is not a ruled line. Perpendicular
            // to the path and growing behind, which is how a wake breaks up.
            const sway = Math.sin(q * 5.4 + this._wobble) * d * 0.012;
            const x = hx - this._dx * d + this._rx * sway;
            const y = hy - this._dy * d;
            const z = hz - this._dz * d + this._rz * sway;

            // Nose cap, expanding wake, tail fade. Both ends must taper to
            // nothing or the tube shows its end caps.
            const nose = smooth01(q / 0.055);
            const tail = 1 - smooth01((q - 0.5) / 0.5);
            const rad = HEAD_R * nose * tail * (1 + 2.4 * q);

            // The ignition front is the head and only the head: that is where the
            // rock is actually being consumed. Everything behind it is the wake
            // cooling, which the body's own hue carries.
            const front = clamp01(1.15 - q * 2.6);

            water.column(
                s, c, x, y, z, rad,
                this._rx, this._ry, this._rz,
                this.t * 2.2 + q * 5, d, q, front, 1
            );
        }

        const impact = POWERS.impact;
        // Brightening as it comes: it is deeper into nothing, but the read is
        // that it is heating up, and a trail that arrives at the same radiance it
        // entered at has no build to it.
        const heat = 0.45 + 0.55 * u;
        water.setParams(s, PROFILE_TUBE, 0.55, clamp01(0.5 + u), COLS);
        water.setEmissive(s, impact.hue[0], impact.hue[1], impact.hue[2], impact.body * heat);

        // A light riding the head. Its whole job is the last third of a second,
        // when the rock is close enough for its own light to sweep across the
        // ground ahead of the impact — which is the beat that tells the player
        // something is about to happen to that patch of ground.
        ctx.lights.add(
            hx, hy, hz, 30.0,
            impact.hue[0], impact.hue[1], impact.hue[2],
            impact.light * heat * heat
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
    _crater() {
        const ctx = this.ctx;
        ctx.deform.brush(
            this.x, this.z,
            2.05,
            0.86,   // depression
            0.62,   // rim
            0.88,   // shocked and packed
            0.62,   // and left burning
            Math.random() * Math.PI,
            1.12,   // very slightly oval — a stamped circle is the tell
            1.0
        );
        for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2 + Math.random() * 1.0;
            const d = 2.4 + Math.random() * 1.6;
            ctx.deform.brush(
                this.x + Math.cos(a) * d, this.z + Math.sin(a) * d,
                0.7 + Math.random() * 0.6,
                0.06, 0.26 + Math.random() * 0.18, 0.22, 0.26,
                a, 1.5, 1.0
            );
        }
        // The hardest shake in the project, and it should be: nothing else here
        // is a rock hitting the ground fifteen metres away.
        ctx.rig.addTrauma(0.62);
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
    _eject() {
        const ctx = this.ctx;
        const sp = ctx.spray;
        if (!sp) return;

        const curtain = (620 * ctx.sprayScale) | 0;
        for (let k = 0; k < curtain; k++) {
            const a = Math.random() * Math.PI * 2;
            const r = 1.4 + Math.sqrt(Math.random()) * 1.1;
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
                this.x + Math.cos(a) * r,
                this.y + 0.12 + Math.random() * 0.4,
                this.z + Math.sin(a) * r,
                Math.cos(a) * speed * out,
                speed * climb,
                Math.sin(a) * speed * out,
                clod ? 0.030 + Math.random() * 0.055 : 0.070 + Math.random() * 0.130,
                1.6 + Math.random() * 2.2,
                clod,
                0                                   // vacuum
            );
        }

        const plume = (190 * ctx.sprayScale) | 0;
        for (let k = 0; k < plume; k++) {
            const a = Math.random() * Math.PI * 2;
            const r = Math.random() * 1.0;
            sp.emit(
                this.x + Math.cos(a) * r,
                this.y + 0.2 + Math.random() * 0.6,
                this.z + Math.sin(a) * r,
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
    _afterglow(dt) {
        const ctx = this.ctx;
        const t = this.t - FALL;
        const impact = POWERS.impact;

        // The flash is over in a third of a second; what follows is the floor of
        // the crater, which the terrain is also rendering as a charged patch. The
        // light is here so the *rim* and the falling debris are lit by it — the
        // charge channel only lights the ground it is written into.
        const flash = Math.exp(-t * 7.0);
        const glow = Math.exp(-t * 0.85) * 0.16;
        const k = impact.light * (flash * 2.4 + glow);
        if (k > 0.01) {
            ctx.lights.add(
                this.x, this.y + 0.5, this.z, 16.0,
                impact.hue[0], impact.hue[1], impact.hue[2], k
            );
        }

        // A second, slower fall of fines, thrown high enough by the impact to
        // still be coming down. Zero drag again, so these arrive rather than
        // settle — they are on their way back from wherever the burst put them.
        const rate = 300 * ctx.sprayScale * Math.exp(-t * 1.5);
        if (rate < 1) return;
        this._curtainOwed += dt * rate;
        let count = this._curtainOwed | 0;
        if (count <= 0) return;
        this._curtainOwed -= count;
        if (count > 60) count = 60;

        const sp = ctx.spray;
        if (!sp) return;
        for (let i = 0; i < count; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = Math.sqrt(Math.random()) * 6.5;
            sp.emit(
                this.x + Math.cos(a) * r,
                this.y + 5.0 + Math.random() * 9.0,
                this.z + Math.sin(a) * r,
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

    _end() {
        this.active = false;
        if (this.strand >= 0) {
            this.ctx.water.release(this.strand);
            this.strand = -1;
        }
    }

    cancel() {
        this._end();
    }
}
