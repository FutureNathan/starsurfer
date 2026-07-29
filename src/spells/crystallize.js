/**
 * Power 4 — Star Crystal.
 *
 * Loose dust snaps into a lattice. A formation grows out of the sea at the aim
 * point, and the patch it grew from stays charged long after the prisms have
 * gone.
 *
 * Two mechanisms, and the split matters:
 *
 *   the formation   geometry, in `crystals.js`. It grows over about a second and
 *                   a half, stands for half a minute, and comes apart back into
 *                   the sea. This is the thing the player looks at.
 *   the patch       the charge channel of the terrain state buffer, which decays
 *                   on a fifteen-minute constant. This is the thing that
 *                   satisfies "permanently altering the surface": the dust shader
 *                   answers it with a roughness of 0.07, a vitrified violet
 *                   albedo and a gold emission, so a Star Crystal patch stays
 *                   visible from across the field as a burning slick.
 *
 * The prisms are planted along a short *spiral* rather than in a disc. A random
 * scatter reads as scattered; a spiral with the crystals getting shorter as they
 * go out reads as something that grew from a centre, which is what it is.
 */

import { POWERS } from "./powers.js";
import { clamp01, smooth01 } from "./bending.js";

/** Seconds the whole cast takes to finish planting. */
const PLANT_TIME = 0.85;
/** Crystals in one formation. */
const COUNT = 34;
/** Seconds the formation stands at full size before it comes apart. */
const STAND = 34;

export class Crystallize {
    /** @param {import("./spellSystem.js").SpellContext} ctx */
    constructor(ctx) {
        this.ctx = ctx;
        this.active = false;
        this.t = 0;
        this.x = 0;
        this.y = 0;
        this.z = 0;
        this._planted = 0;
        this._seed = 0;
    }

    /** @param {number} x @param {number} y @param {number} z ground target */
    trigger(x, y, z) {
        this.x = x;
        this.y = y;
        this.z = z;
        this.t = 0;
        this._planted = 0;
        this._seed = Math.random() * 1000;
        this.active = true;

        // The patch goes down immediately, under where the formation will be, so
        // the ground has already changed material by the time the first prism is
        // tall enough to see. Doing it as the crystals land instead leaves a beat
        // where a lattice is standing on undisturbed sea.
        //
        // Charge, not displacement: this power barely moves the ground. The
        // channel is taken as a max rather than accumulated, so these are plain
        // measures of how far the lattice ordered the dust under it, and they are
        // deliberately short of the ceiling — a patch at 1.0 burns at three and a
        // half times the lit ground and stays there for a quarter of an hour,
        // which turns a formation into a floodlight the player then has to stand
        // next to.
        const f = this.ctx.deform;
        f.brush(x, z, 1.55, 0.10, 0.16, 0.85, 0.55, Math.random() * Math.PI, 1.2, 0.85);
        for (let i = 0; i < 3; i++) {
            const a = Math.random() * Math.PI * 2;
            const d = 1.1 + Math.random() * 1.3;
            f.brush(
                x + Math.cos(a) * d, z + Math.sin(a) * d,
                0.55 + Math.random() * 0.5,
                0.04, 0.10, 0.5, 0.40, a, 1.5, 1.0
            );
        }
    }

    /** @param {number} dt */
    update(dt) {
        if (!this.active) return;
        const ctx = this.ctx;
        this.t += dt;

        // ---- planting ------------------------------------------------------
        // Spread over most of a second rather than all at once, so the formation
        // grows outward from the centre instead of appearing on one frame.
        const want = Math.min(COUNT, Math.ceil((this.t / PLANT_TIME) * COUNT));
        while (this._planted < want) {
            this._plantOne(this._planted);
            this._planted++;
        }

        // ---- light ---------------------------------------------------------
        // Bright and tight while the lattice is ordering itself, then a low
        // breathing ember for as long as the formation stands. Both halves are
        // the same mechanism: ordering dust into a lattice sheds the charge the
        // loose grains were carrying, fastest while it is forming and slowly
        // afterwards as the structure relaxes.
        const lattice = POWERS.lattice;
        const form = 1 - smooth01((this.t - PLANT_TIME) / 0.9);
        const ember = 0.10 + 0.06 * Math.sin(this.t * 1.7);
        const k = lattice.light * (0.03 + 0.97 * form);
        ctx.lights.add(
            this.x, this.y + 0.55, this.z, 7.5,
            lattice.hue[0], lattice.hue[1], lattice.hue[2], k * (1 + ember)
        );

        // ---- shed grains ---------------------------------------------------
        if (this.t < PLANT_TIME + 0.4) this._shedGrains(dt);

        // The power itself is done once the last prism is in; the crystals age
        // on their own clock from there.
        if (this.t > PLANT_TIME + 1.6) this.active = false;
    }

    /**
     * One prism, on the spiral.
     *
     * The golden angle is doing real work here: it is the one rotation that
     * never repeats a radial line, so no two crystals in a formation line up
     * with each other however many there are. Any rational fraction of a turn
     * gives visible spokes.
     */
    _plantOne(i) {
        const ctx = this.ctx;
        const n01 = i / (COUNT - 1);
        const ang = i * 2.39996323 + this._seed;
        const r = 0.18 + Math.sqrt(n01) * 2.05;

        const x = this.x + Math.cos(ang) * r + (Math.random() - 0.5) * 0.16;
        const z = this.z + Math.sin(ang) * r + (Math.random() - 0.5) * 0.16;
        const y = ctx.terrain.heightAt(x, z) - 0.06;

        // Tall in the middle, low at the edges, with enough scatter that the
        // envelope is not a readable cone.
        //
        // The centre crystals are chest height on the astronaut, deliberately —
        // a knee-height cluster is something the player walks past. Scale is the
        // cheapest drama there is.
        const scale = (1 - n01 * 0.58) * (0.6 + Math.random() * 0.8);
        const height = 1.75 * scale;
        const radius = 0.15 * scale * (0.7 + Math.random() * 0.7);

        // Leaning outward, more so further out — the way a real cluster grows
        // toward the space it has.
        const tilt = 0.10 + n01 * 0.42 * (0.6 + Math.random() * 0.8);
        const ax = Math.cos(ang) * tilt + (Math.random() - 0.5) * 0.12;
        const az = Math.sin(ang) * tilt + (Math.random() - 0.5) * 0.12;

        ctx.crystals.plant(
            x, y, z, ax, 1, az,
            height, radius,
            0.45 + Math.random() * 0.55,
            STAND + Math.random() * 8
        );

        // A little dust pushed aside, and charged, where each one broke the
        // surface.
        if ((i & 1) === 0) {
            ctx.deform.brush(
                x, z, radius * 3.2,
                0.05, 0.09, 0.4, 0.50, ang, 1.2, 1.0
            );
        }
    }

    /** Grains thrown clear as the lattice breaks the surface. */
    _shedGrains(dt) {
        const ctx = this.ctx;
        const sp = ctx.spray;
        if (!sp) return;
        const count = ((60 * ctx.sprayScale) * dt) | 0;
        for (let k = 0; k < count; k++) {
            const a = Math.random() * Math.PI * 2;
            const r = Math.random() * 1.8;
            sp.emit(
                this.x + Math.cos(a) * r,
                this.y + 0.05 + Math.random() * 0.5,
                this.z + Math.sin(a) * r,
                Math.cos(a) * (0.6 + Math.random() * 1.4),
                0.9 + Math.random() * 2.4,
                Math.sin(a) * (0.6 + Math.random() * 1.4),
                0.012 + Math.random() * 0.020,
                0.7 + Math.random() * 0.9,
                Math.random() < 0.4 ? 1 : 0,
                2.4
            );
        }
    }

    cancel() {
        this.active = false;
    }
}
