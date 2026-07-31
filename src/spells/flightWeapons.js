/**
 * The flight weapons. One click: a laser bolt. Two clicks inside a third of
 * a second: the second one is a rocket. Both fire only while the pack is
 * burning, and both aim where the camera aims — marched down to the ground,
 * because on a moon the ground is what there is to hit.
 *
 * Neither weapon owns a mesh or a shader. The laser is a line of charged
 * grains laid down the ray in one frame and dead a tenth of a second later
 * — a bolt, persistence-of-vision doing the work; the rocket is a moving
 * emitter with a light on its head. Impacts are the same three moves
 * everything else in this scene makes: a brush into the terrain state
 * buffer, a burst from the shared spray pool, a declaration into the
 * four-slot light pool. That is what keeps two whole weapon systems at
 * zero new pipelines and zero per-frame cost while holstered.
 */

import { input } from "../core/input.js";
import { POWERS } from "./powers.js";

/** Seconds between clicks that makes the second one a rocket. */
const DOUBLE = 0.33;
/** Seconds the laser beam stays lit. */
const BEAM_TIME = 0.7;
/**
 * Rocket cruise speed, m/s. Slow enough to *watch*: the missile pops off
 * the pack upward, then banks onto its locked target — the whole arc is
 * the point, and at the old thirty-eight it was over before the eye found
 * it.
 */
const ROCKET_V = 26;

export class FlightWeapons {
    /**
     * @param {import("../terrain/terrain.js").Terrain} terrain
     * @param {import("../vfx/particles.js").SprayField} spray
     * @param {import("./spellLights.js").SpellLights} lights
     * @param {import("../character/controller.js").CharacterController} character
     * @param {import("../core/camera.js").CameraRig} rig
     */
    constructor(terrain, spray, lights, character, rig) {
        this.terrain = terrain;
        this.spray = spray;
        this.lights = lights;
        this.ch = character;
        this.rig = rig;
        this._t = 0;
        this._lastFire = -9;
        /** @type {{x:number,y:number,z:number,ttl:number,max:number,big:number}[]} */
        this._pulses = [];
        /** @type {{tx:number,ty:number,tz:number,ttl:number}[]} */
        this._beams = [];
        /** @type {{x:number,y:number,z:number,vx:number,vy:number,vz:number,
         *          tx:number,ty:number,tz:number,life:number}[]} */
        this._rockets = [];
        this._hit = { x: 0, y: 0, z: 0 };
    }

    /**
     * March the camera ray onto the terrain. Aimed at the sky, the march
     * runs out and the far point serves as the target instead — a rocket
     * fired at the stars simply flies that way until its motor gives out.
     */
    _aim(out) {
        const p = this.ch.position;
        // A rig without a full look vector (the test harness) fires at the
        // ground ahead of the facing.
        const f = this.rig.forward
            || { x: Math.sin(this.ch.facing) * 0.8, y: -0.6,
                 z: Math.cos(this.ch.facing) * 0.8 };
        let x = p.x, y = p.y + 1.2, z = p.z;
        for (let i = 0; i < 90; i++) {
            x += f.x * 4; y += f.y * 4; z += f.z * 4;
            const g = this.terrain.heightAt(x, z);
            if (y <= g) {
                out.x = x; out.y = g; out.z = z;
                return;
            }
        }
        out.x = x; out.y = y; out.z = z;
    }

    _fireLaser() {
        const ch = this.ch;
        this._aim(this._hit);
        const hx = this._hit.x, hy = this._hit.y, hz = this._hit.z;

        // The scorch, once, and the first fan of sparks off it.
        this.terrain.deform.brush(
            hx, hz, 0.35, 0.04, 0.03, 0.6, 0.45,
            0, 1, 0.8
        );
        const sp = this.spray;
        for (let i = 0; i < 16; i++) {
            const a = Math.random() * Math.PI * 2;
            sp.emit(
                hx, hy + 0.05, hz,
                Math.cos(a) * (1 + Math.random() * 2.4),
                1.2 + Math.random() * 2.6,
                Math.sin(a) * (1 + Math.random() * 2.4),
                0.018 + Math.random() * 0.02,
                0.3 + Math.random() * 0.4,
                1,
                1.2
            );
        }
        // The beam itself lives as state: the target stays where it was
        // struck, the origin rides the flyer, and `_beamTick` keeps the
        // line dense every frame until it dies — a beam you can see, held
        // long enough to mean it.
        const beam = { tx: hx, ty: hy, tz: hz, ttl: BEAM_TIME };
        this._beams.push(beam);
        this._beamTick(beam);
        ch.firedLaser = true;
    }

    /** One frame of beam: a run of short-lived grains down the current ray. */
    _beamTick(b) {
        const ch = this.ch;
        const sx = ch.position.x, sy = ch.position.y + 1.1, sz = ch.position.z;
        const dx = b.tx - sx, dy = b.ty - sy, dz = b.tz - sz;
        const dist = Math.hypot(dx, dy, dz) || 1;
        const n = Math.min(26, Math.max(8, (dist / 2.6) | 0));
        const sp = this.spray;
        for (let i = 0; i < n; i++) {
            const u = Math.random();
            sp.emit(
                sx + dx * u, sy + dy * u, sz + dz * u,
                0, 0, 0,
                0.030 + Math.random() * 0.016,
                0.08 + Math.random() * 0.05,
                1,
                14
            );
        }
        // A trickle of sparks at the struck point, all beam long.
        for (let i = 0; i < 2; i++) {
            const a = Math.random() * Math.PI * 2;
            sp.emit(
                b.tx, b.ty + 0.05, b.tz,
                Math.cos(a) * (0.8 + Math.random() * 2),
                1.0 + Math.random() * 2.2,
                Math.sin(a) * (0.8 + Math.random() * 2),
                0.016 + Math.random() * 0.018,
                0.25 + Math.random() * 0.35,
                1,
                1.2
            );
        }
    }

    _fireRocket() {
        const ch = this.ch;
        this._aim(this._hit);
        const sx = ch.position.x, sy = ch.position.y + 1.0, sz = ch.position.z;
        const dx = this._hit.x - sx, dy = this._hit.y - sy, dz = this._hit.z - sz;
        const l = Math.hypot(dx, dy, dz) || 1;
        // Launched *upward* off the pack, mostly — the guidance below banks
        // it onto the locked target, and that pop-then-curve is the whole
        // "guided missile" read.
        const lx = dx / l * 0.45, ly = dy / l * 0.45 + 0.9, lz = dz / l * 0.45;
        const ll = Math.hypot(lx, ly, lz) || 1;
        this._rockets.push({
            x: sx, y: sy, z: sz,
            vx: (lx / ll) * ROCKET_V,
            vy: (ly / ll) * ROCKET_V,
            vz: (lz / ll) * ROCKET_V,
            tx: this._hit.x, ty: this._hit.y, tz: this._hit.z,
            life: 0,
        });
        ch.firedRocket = true;
    }

    _explode(r) {
        const ch = this.ch;
        // A real crater — molten-edged, a third of a metre deep — and a
        // hemisphere of ejecta.
        this.terrain.deform.brush(
            r.x, r.z, 1.7, 0.30, 0.22, 1.0, 0.55,
            Math.atan2(r.vz, r.vx), 1.1, 1.0
        );
        const sp = this.spray;
        for (let i = 0; i < 90; i++) {
            const a = Math.random() * Math.PI * 2;
            const out = 2 + Math.random() * 7;
            const drop = Math.random() < 0.5 ? 1 : 0;
            sp.emit(
                r.x + Math.cos(a) * 0.3, r.y + 0.1, r.z + Math.sin(a) * 0.3,
                Math.cos(a) * out,
                1.5 + Math.random() * 5.5,
                Math.sin(a) * out,
                drop ? 0.02 + Math.random() * 0.035 : 0.05 + Math.random() * 0.08,
                0.6 + Math.random() * 0.9,
                drop,
                drop ? 0.7 : 1.8
            );
        }
        this._pulses.push({ x: r.x, y: r.y + 0.8, z: r.z, ttl: 0.55, max: 0.55, big: 1 });
        const d = Math.hypot(r.x - ch.position.x, r.z - ch.position.z);
        const near = Math.max(0, 1 - d / 60);
        this.rig.addTrauma(0.05 + 0.20 * near);
        ch.rocketBoom = true;
    }

    /** Once per frame, before the audio reads the fire flags. */
    update(dt) {
        this._t += dt;
        const ch = this.ch;
        ch.firedLaser = false;
        ch.firedRocket = false;
        ch.rocketBoom = false;

        if (input.firePressed && ch.jetting) {
            if (this._t - this._lastFire < DOUBLE) this._fireRocket();
            else this._fireLaser();
            this._lastFire = this._t;
        }

        // The beams: each keeps its line dense until it burns out.
        const bm = this._beams;
        for (let i = bm.length - 1; i >= 0; i--) {
            const b = bm[i];
            b.ttl -= dt;
            if (b.ttl <= 0) { bm.splice(i, 1); continue; }
            this._beamTick(b);
            const ion0 = POWERS.ion;
            const bk = b.ttl / BEAM_TIME;
            this.lights.add(b.tx, b.ty + 0.4, b.tz, 5,
                ion0.hue[0], ion0.hue[1], ion0.hue[2], 10 * bk);
        }

        // Rockets fly: steered onto their locked target, the ground or the
        // proximity fuse ends them, and a spent motor ends them quietly.
        const rk = this._rockets;
        for (let i = rk.length - 1; i >= 0; i--) {
            const r = rk[i];
            r.life += dt;
            // Guidance: the velocity banks toward the target at a rate that
            // makes the arc legible — launch up, curve over, come down.
            const gx = r.tx - r.x, gy = r.ty - r.y, gz = r.tz - r.z;
            const gd = Math.hypot(gx, gy, gz) || 1;
            const gk = Math.min(1, 3.2 * dt);
            r.vx += ((gx / gd) * ROCKET_V - r.vx) * gk;
            r.vy += ((gy / gd) * ROCKET_V - r.vy) * gk;
            r.vz += ((gz / gd) * ROCKET_V - r.vz) * gk;
            r.x += r.vx * dt; r.y += r.vy * dt; r.z += r.vz * dt;

            // The missile itself: a fat glowing slug at the head, re-drawn
            // every frame, with exhaust peeling off behind it.
            for (let k = 0; k < 5; k++) {
                this.spray.emit(
                    r.x + (Math.random() - 0.5) * 0.14,
                    r.y + (Math.random() - 0.5) * 0.14,
                    r.z + (Math.random() - 0.5) * 0.14,
                    0, 0, 0,
                    0.05 + Math.random() * 0.03,
                    0.07 + Math.random() * 0.05,
                    1,
                    14
                );
            }
            for (let k = 0; k < 3; k++) {
                this.spray.emit(
                    r.x - r.vx * 0.03, r.y - r.vy * 0.03, r.z - r.vz * 0.03,
                    (Math.random() - 0.5) * 1.4,
                    (Math.random() - 0.5) * 1.4,
                    (Math.random() - 0.5) * 1.4,
                    0.022 + Math.random() * 0.022,
                    0.25 + Math.random() * 0.20,
                    1,
                    5
                );
            }
            const ion = POWERS.ion;
            this.lights.add(r.x, r.y, r.z, 7, ion.hue[0], ion.hue[1], ion.hue[2], 9);
            const nearTarget = gd < 2.0;
            if (nearTarget || r.y <= this.terrain.heightAt(r.x, r.z) + 0.2
                || r.life > 6) {
                if (r.life <= 6) this._explode(r);
                rk.splice(i, 1);
            }
        }

        // Impact light pulses, fading.
        const ps = this._pulses;
        const ion = POWERS.ion;
        for (let i = ps.length - 1; i >= 0; i--) {
            const p = ps[i];
            p.ttl -= dt;
            if (p.ttl <= 0) { ps.splice(i, 1); continue; }
            const k = p.ttl / p.max;
            this.lights.add(
                p.x, p.y, p.z,
                p.big ? 11 : 4.5,
                ion.hue[0], ion.hue[1], ion.hue[2],
                (p.big ? 26 : 8) * k * k
            );
        }
    }
}
