/**
 * Power 3 — Supernova.
 *
 * A targeted detonation. A column of white-hot dust bursts up out of the sea,
 * blowing a crater with a raised rim, then falls back as four seconds of slow
 * fallout lit from below by the crater it came out of.
 *
 * Three things run on different clocks and that is the whole design:
 *
 *   the column   fast. Up in a third of a second, held for a beat, then it
 *                collapses back down its own axis rather than fading — the mass
 *                goes back where it came from.
 *   the crater   instant, and permanent. One brush, at the moment of the burst,
 *                and it stays charged long after the geometry has gone.
 *   the fallout  slow. Four seconds of it, and it is what the player is actually
 *                looking at for most of the power. A burst with no fallout is a
 *                flash; a burst with fallout is an event.
 *
 * It is the one power allowed outside the violet and gold family, because that
 * is what being a detonation *means*: it is hotter than everything around it, so
 * it comes out white and cools to gold as the mass falls back. The cooling is
 * not a fade — the hue moves down the same warm ramp the dust field's own
 * discharge sits on, so a Supernova ends up the colour of the ground it threw.
 *
 * The column leans. A perfectly vertical cylinder reads as a rendered primitive
 * no matter what is on it, and two degrees of drift with a little sway takes
 * that away completely.
 */

import { PROFILE_TUBE } from "./waterBody.js";
import { POWERS } from "./powers.js";
import { clamp01, smooth01, bell, transport } from "./bending.js";

const COLS = 34;
/** Full height of the column at peak, metres. */
const HEIGHT = 5.6;
/**
 * Radius of the column at its widest, metres.
 *
 * A detonation is a *mass* of material leaving the ground, and the aspect ratio
 * is most of what says so. The body material's optical depth is keyed to the
 * radius as well, so a thin column is also a dim one — it saturates to a
 * fraction of its own emission where a metre-wide one saturates completely.
 */
const GIRTH = 0.66;
/** Seconds from cast to the column being gone. */
const LIFE = 1.75;
/** Seconds of fallout after that. */
const FALLOUT = 3.4;

const _rgt = new Float32Array(3);

export class Bloom {
    /** @param {import("./spellSystem.js").SpellContext} ctx */
    constructor(ctx) {
        this.ctx = ctx;
        this.active = false;
        this.strand = -1;

        this.t = 0;
        this.x = 0;
        this.y = 0;
        this.z = 0;
        this._leanX = 0;
        this._leanZ = 0;
        this._burst = false;
        this._curtainOwed = 0;
    }

    /** @param {number} x @param {number} y @param {number} z ground target */
    trigger(x, y, z) {
        if (this.strand < 0) this.strand = this.ctx.water.acquire();
        this.x = x;
        this.y = y;
        this.z = z;
        this.t = 0;
        this._burst = false;
        this._curtainOwed = 0;
        // A different lean each cast, so two Blooms in the same place are not
        // the same object twice.
        const a = Math.random() * Math.PI * 2;
        this._leanX = Math.cos(a) * 0.16;
        this._leanZ = Math.sin(a) * 0.16;
        this.active = true;
    }

    /** @param {number} dt */
    update(dt) {
        if (!this.active) return;
        const ctx = this.ctx;
        this.t += dt;

        if (this.t >= LIFE + FALLOUT) {
            this._end();
            return;
        }

        // ---- the burst ----------------------------------------------------
        // Fires once, on the frame the column reaches the surface. Everything
        // that happens at that instant — the crater, the ring of thrown dust,
        // the light spike — happens here rather than at trigger time, so they
        // are all the same event.
        if (!this._burst && this.t >= 0.10) {
            this._burst = true;
            this._crater();
            this._throw();
        }

        this._column();
        this._curtain(dt);
    }

    /**
     * The column.
     *
     * Radius runs wide at the base, waists in the middle and flares at the head,
     * which is what a real ejection does: the mass at the top has had the
     * longest to spread and the least to hold it together.
     */
    _column() {
        const ctx = this.ctx;
        const water = ctx.water;
        const s = this.strand;
        if (s < 0) return;

        const t = this.t;
        // Rise, hold, collapse. The collapse runs the height back down rather
        // than fading the alpha, so the column withdraws into the crater.
        const rise = smooth01((t - 0.10) / 0.34);
        const drop = 1 - smooth01((t - 0.95) / 0.80);
        const env = rise * drop;
        if (env <= 0.002) {
            water.setParams(s, PROFILE_TUBE, 0.5, 0, 0);
            return;
        }

        const top = HEIGHT * env;
        const sway = Math.sin(t * 3.1) * 0.12;

        let px = 0, py = 0, pz = 0;
        let rx = 1, ry = 0, rz = 0;
        let t0x = 0, t0y = 1, t0z = 0;

        for (let c = 0; c < COLS; c++) {
            const u = c / (COLS - 1);
            // Column 0 is the *head*, so `u` runs downward. That matches every
            // other strand in the project — u is always "distance behind the
            // leading edge" — and keeps the relief field drifting the right way.
            const h = 1 - u;
            const y = this.y + top * h;
            const lean = h * h;
            const x = this.x + (this._leanX + sway) * lean * top * 0.5;
            const z = this.z + (this._leanZ - sway * 0.6) * lean * top * 0.5;

            if (c > 0) {
                let t1x = x - px, t1y = y - py, t1z = z - pz;
                const l = Math.hypot(t1x, t1y, t1z) || 1e-4;
                t1x /= l; t1y /= l; t1z /= l;
                transport(_rgt, 0, rx, ry, rz, t0x, t0y, t0z, t1x, t1y, t1z);
                rx = _rgt[0]; ry = _rgt[1]; rz = _rgt[2];
                t0x = t1x; t0y = t1y; t0z = t1z;
            } else {
                rx = 1; ry = 0; rz = 0;
                t0x = 0; t0y = -1; t0z = 0;
            }

            // Flared head, waisted middle, broad foot.
            const shape =
                0.42 + 0.58 * bell(clamp01(h * 1.15))       // waist
                + 0.55 * smooth01((h - 0.72) / 0.28)        // flare
                + 0.75 * (1 - smooth01(h / 0.22));          // foot
            const rad = GIRTH * shape * env * (0.9 + 0.2 * Math.sin(u * 9 + t * 6));

            // Ignition. The head is where the column is coming apart; the
            // foot is where it is grinding against the crater rim. Both are
            // where the grains are being broken, and both run white.
            const front = clamp01(0.30 + 0.55 * smooth01((h - 0.55) / 0.45)
                                + 0.4 * (1 - smooth01(h / 0.18)));

            water.column(
                s, c, x, y, z, rad,
                rx, ry, rz, t * 1.5 + u * 4,
                u * top, u, front, 1
            );

            px = x; py = y; pz = z;
        }

        water.setParams(s, PROFILE_TUBE, 0.42, clamp01(env * 1.5), COLS);

        // ---- temperature ----------------------------------------------------
        //
        // Two curves off one clock, and they are the whole read.
        //
        //   flash   the first third of a second, when the column is a detonation
        //           rather than a plume. Two and a half times the standing gain
        //           for a moment, which puts it four stops over the bloom knee
        //           and is what makes the burst *hurt* instead of merely appear.
        //   cool    the hue walking from starlight white down to the dust's own
        //           gold over the next couple of seconds. A cooling mass moves
        //           down the warm end of the locus; running the fade on
        //           brightness alone would leave a dimming white column, which is
        //           what a light being switched off looks like rather than what
        //           hot matter does.
        //
        // Both hues have red at exactly 1.0, so mixing them cannot change which
        // channel the gain is measured in and the number below stays a radiance.
        const nova = POWERS.nova;
        const flare = POWERS.flare;
        const flash = Math.exp(-Math.max(t - 0.10, 0) * 5.5);
        const cool = 1 - Math.exp(-Math.max(t - 0.10, 0) * 1.6);
        const hr = nova.hue[0] + (flare.hue[0] - nova.hue[0]) * cool;
        const hg = nova.hue[1] + (flare.hue[1] - nova.hue[1]) * cool;
        const hb = nova.hue[2] + (flare.hue[2] - nova.hue[2]) * cool;
        water.setEmissive(s, hr, hg, hb, nova.body * env * (1 + 1.5 * flash));

        // Two lights: one down in the crater, one riding the head. The crater
        // one is what actually lights the rim and the fallout around the base,
        // and it is the reason the effect reads as a hole full of light rather
        // than a bright column standing on dark ground — which on a surface that
        // reflects nine percent of what lands on it is the difference between an
        // event and a silhouette.
        ctx.lights.add(
            this.x, this.y + 0.35, this.z,
            11.0, hr, hg, hb, nova.light * env * (1 + 1.5 * flash)
        );
        // The head stays white for longer than the crater does: it is the part
        // still being driven, and the crater is already the remnant.
        ctx.lights.add(
            this.x + this._leanX * top * 0.5, this.y + top * 0.92, this.z + this._leanZ * top * 0.5,
            7.5, nova.hue[0], nova.hue[1], nova.hue[2], nova.light * 0.41 * env
        );
    }

    /**
     * The crater: one brush, deep, with a heavy rim and a floor left burning.
     *
     * The charge argument is the highest any power writes, and it is the part of
     * this that lasts. The geometry is gone in five seconds; the terrain answers
     * a charged patch with a gold emission that decays over a quarter of an hour,
     * so what the player is left with is a hole in the sea with light still in
     * it — which is what a detonation site should be and what a plain depression
     * would not be.
     */
    _crater() {
        const ctx = this.ctx;
        ctx.deform.brush(
            this.x, this.z,
            1.15,
            0.52,   // depression
            0.40,   // rim — the mass has to go somewhere and this is where
            0.72,   // packed by the blast
            0.70,   // and left burning
            Math.random() * Math.PI,
            1.15,   // very slightly oval, so it is not a stamped circle
            1.0
        );
        // A broken outer ring, thrown clear of the rim. Four smaller brushes
        // rather than one wide one: a crater with a perfectly even rim is the
        // tell that gives a single radial brush away. Charged, but well under the
        // floor: this is mass that was thrown clear rather than mass that was at
        // the centre of it, and a ring as hot as the crater reads as a second
        // crater rather than as its ejecta.
        for (let i = 0; i < 4; i++) {
            const a = (i / 4) * Math.PI * 2 + Math.random() * 1.2;
            const d = 1.5 + Math.random() * 0.7;
            ctx.deform.brush(
                this.x + Math.cos(a) * d, this.z + Math.sin(a) * d,
                0.5 + Math.random() * 0.35,
                0, 0.20 + Math.random() * 0.14, 0.15, 0.30,
                a, 1.4, 1.0
            );
        }
        ctx.rig.addTrauma(0.28);
    }

    /** The instant of the burst: a hard ring of thrown dust. */
    _throw() {
        const ctx = this.ctx;
        const sp = ctx.spray;
        if (!sp) return;
        const n = (430 * ctx.sprayScale) | 0;

        for (let k = 0; k < n; k++) {
            const a = Math.random() * Math.PI * 2;
            // Biased toward the rim, because that is where the mass leaves.
            const r = 0.35 + Math.sqrt(Math.random()) * 1.25;
            const up = 5.5 + Math.random() * 8.5;
            const out = 1.6 + Math.random() * 5.0;
            const clod = Math.random() < 0.26 ? 1 : 0;

            sp.emit(
                this.x + Math.cos(a) * r,
                this.y + 0.10 + Math.random() * 0.5,
                this.z + Math.sin(a) * r,
                Math.cos(a) * out,
                up * (clod ? 0.7 : 1.0),
                Math.sin(a) * out,
                clod ? 0.028 + Math.random() * 0.038 : 0.075 + Math.random() * 0.115,
                clod ? 1.1 + Math.random() * 0.8 : 1.4 + Math.random() * 1.5,
                clod,
                // Ballistic, or it never leaves the crater.
                clod ? 0.65 : 1.1 + Math.random() * 0.8
            );
        }
    }

    /**
     * The fallout curtain.
     *
     * Fine, slow, high drag, and *emitted above the player's eye line* over a
     * wide disc, so it drifts down through the frame rather than sitting in a
     * cone over the crater. This is the part of the power that lasts, and the
     * one place in the demo where a whole field of airborne grains is lit from
     * *below* — by the crater, which is by then the brightest thing on the
     * ground for twenty metres.
     */
    _curtain(dt) {
        const ctx = this.ctx;
        const sp = ctx.spray;
        if (!sp) return;

        const t = this.t;
        // Ramps in behind the burst and decays over the whole fallout window.
        const k = smooth01((t - 0.25) / 0.5) * (1 - smooth01((t - 0.9) / (FALLOUT * 0.9)));
        if (k <= 0.01) return;

        const rate = 360 * ctx.sprayScale * k;
        this._curtainOwed += dt * rate;
        let count = this._curtainOwed | 0;
        if (count <= 0) return;
        this._curtainOwed -= count;
        if (count > 60) count = 60;

        for (let i = 0; i < count; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = Math.sqrt(Math.random()) * 3.6;
            sp.emit(
                this.x + Math.cos(a) * r,
                this.y + 2.2 + Math.random() * 4.2,
                this.z + Math.sin(a) * r,
                (Math.random() - 0.5) * 0.9,
                0.2 + Math.random() * 1.1,
                (Math.random() - 0.5) * 0.9,
                0.028 + Math.random() * 0.055,
                1.6 + Math.random() * 1.9,
                0,
                // High drag: this is meant to hang and settle, not to fly.
                4.6
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
