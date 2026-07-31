/**
 * The weapons. One click: a laser bolt. Two clicks inside a third of a
 * second: the second one is a rocket. They fire from anywhere — walking,
 * surfing, or on the pack — and aim where the camera aims, marched down to
 * the ground, because on a moon the ground is what there is to hit.
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
import { groundRay } from "./bending.js";

/** Seconds between clicks that makes the second one a rocket. */
const DOUBLE = 0.33;
/** Metres of aim-ray reach. Past this a shot just flies out along the ray. */
const RANGE = 360;
/** Seconds the laser beam stays lit. */
const BEAM_TIME = 1.0;
/**
 * Rocket cruise speed, m/s. Slow enough to *watch*: the missile pops off
 * the pack upward, then banks onto its locked target — the whole arc is
 * the point, and at the old thirty-eight it was over before the eye found
 * it.
 */
const ROCKET_V = 26;

export class FlightWeapons {
    /**
     * @param {import("@babylonjs/core/scene").Scene|null} scene null runs headless
     * @param {import("../terrain/terrain.js").Terrain} terrain
     * @param {import("../vfx/particles.js").SprayField} spray
     * @param {import("./spellLights.js").SpellLights} lights
     * @param {import("../character/controller.js").CharacterController} character
     * @param {import("../core/camera.js").CameraRig} rig
     */
    constructor(scene, terrain, spray, lights, character, rig) {
        this.terrain = terrain;
        this.spray = spray;
        this.lights = lights;
        this.ch = character;
        this.rig = rig;
        this._t = 0;
        this._lastFire = -9;

        /** Weapons live only where a mode arms them (Martian Hunt). Free
         *  roam is a moon and a board — no guns, no crates, no reticle. */
        this.armed = false;

        /** The solid beam meshes, three shots deep. @type {any[]} */
        this._beamPool = [];
        /** Resolves once the beams exist; `warmUp` awaits it. */
        this._built = scene ? this._buildBeams(scene) : null;
        /** @type {{x:number,y:number,z:number,ttl:number,max:number,big:number}[]} */
        this._pulses = [];
        /** @type {{x:number,y:number,z:number,vx:number,vy:number,vz:number,
         *          tx:number,ty:number,tz:number,life:number}[]} */
        this._rockets = [];
        this._hit = { x: 0, y: 0, z: 0 };

        /**
         * Mode hooks, set by whoever owns targets (Martian Hunt today).
         * `rayTest(sx,sy,sz,tx,ty,tz)` may return {x,y,z,ref} where the
         * laser's ray actually crosses a target — the laser is pure aim;
         * `getLock()` may return a lock for the MISSILE only; `onHit(hit)`
         * fires when a laser connects; `onBlast(x,y,z,r)` at detonation.
         */
        this.rayTest = null;
        this.getLock = null;
        this.onHit = null;
        this.onBlast = null;

        /** Where the last aim ray left from — the eye, or the chest when
         *  headless. The target hit test runs from here, not the muzzle. */
        this._eyeX = 0;
        this._eyeY = 0;
        this._eyeZ = 0;

        /**
         * Missile ammo. Lasers are the sidearm — free forever; the guided
         * missile is spent ordnance, refilled by the crates standing out on
         * the moon. `onAmmo` tells the HUD; `onDry` is the empty *click*.
         */
        this.missiles = 2;
        this.onAmmo = null;
        this.onDry = null;
    }

    /**
     * The beam pool: three unit cylinders wearing the additive beam shader,
     * stretched shot-by-shot from muzzle to mark. Three is plenty — a beam
     * lives a second and the trigger cannot cycle three in one.
     */
    async _buildBeams(scene) {
        const [{ CreateCylinder }, { ShaderMaterial }, { ShaderLanguage },
               { Quaternion, Vector3 }, { Constants }] = await Promise.all([
            import("@babylonjs/core/Meshes/Builders/cylinderBuilder"),
            import("@babylonjs/core/Materials/shaderMaterial"),
            import("@babylonjs/core/Materials/shaderLanguage"),
            import("@babylonjs/core/Maths/math.vector"),
            import("@babylonjs/core/Engines/constants"),
        ]);
        this._Q = Quaternion;
        this._up = new Vector3(0, 1, 0);
        this._dir = new Vector3(0, 1, 0);
        for (let i = 0; i < 3; i++) {
            const mesh = CreateCylinder("beam" + i,
                { height: 1, diameter: 1, tessellation: 12 }, scene);
            const mat = new ShaderMaterial("beamMat" + i, scene,
                { vertex: "beam", fragment: "beam" },
                {
                    attributes: ["position"],
                    uniforms: ["world", "viewProjection", "beamColor", "intensity"],
                    needAlphaBlending: true,
                    shaderLanguage: ShaderLanguage.WGSL,
                });
            mat.backFaceCulling = false;
            mat.alphaMode = Constants.ALPHA_ADD;
            mat.disableDepthWrite = true;
            const ion = POWERS.ion;
            mat.setVector3("beamColor",
                new Vector3(ion.hue[0], ion.hue[1], ion.hue[2]));
            mat.setFloat("intensity", 0);
            mesh.material = mat;
            mesh.isVisible = false;
            mesh.isPickable = false;
            mesh.alwaysSelectAsActiveMesh = true;
            mesh.renderingGroupId = 1;
            mesh.rotationQuaternion = new Quaternion();
            this._beamPool.push({ mesh, mat, ttl: 0, tx: 0, ty: 0, tz: 0 });
        }
        this._beamNext = 0;
    }

    /**
     * Compile the beam pipeline behind the loading screen instead of on the
     * first shot. One beam stands through the warm-up frames at intensity 0 —
     * additive blending of nothing, so nothing shows — which is what actually
     * builds the pipeline; compiling against no draw covers nothing.
     */
    async warmUp() {
        if (!this._built) return;
        await this._built;
        if (this._beamPool.length) this._beamPool[0].mesh.isVisible = true;
    }

    /** Hide the warm-up stand-in. After `main`'s warm-up frames have drawn. */
    finishWarmUp() {
        const b = this._beamPool[0];
        if (b && b.ttl <= 0) b.mesh.isVisible = false;
    }

    /**
     * Where the reticle actually points.
     *
     * The reticle is the camera's own ray, so the aim has to be too. The
     * spring arm hangs the lens over the shoulder and above the pivot, so a
     * ray cast from the chest along a parallel forward — the old scheme —
     * landed beside and below the crosshair by the whole camera offset, and
     * its 4-metre march could overshoot a grazing crest by metres on top.
     * This one runs from the eye through the centre of the screen, and it
     * runs fine: `groundRay` steps 0.6 m and bisects to centimetres. The rig
     * already keeps the whole arm out of the dust, so the first surface this
     * ray meets is never between the camera and the rider.
     *
     * Aimed at the sky, the ray runs out and the far point serves as the
     * target instead — a rocket fired at the stars simply flies that way
     * until its motor gives out. The mode's hit test runs along the same ray
     * (see `_fireLaser`), so what the cursor covers is what a shot can hit.
     */
    _aim(out) {
        const f = this.rig.forward;
        const cam = this.rig.camera;
        if (f && cam) {
            const eye = cam.globalPosition;
            this._eyeX = eye.x; this._eyeY = eye.y; this._eyeZ = eye.z;
            const t = groundRay(
                this.terrain, eye.x, eye.y, eye.z, f.x, f.y, f.z, RANGE);
            const d = t > 0 ? t : RANGE;
            out.x = eye.x + f.x * d;
            out.y = eye.y + f.y * d;
            out.z = eye.z + f.z * d;
            return;
        }
        // A rig without a camera (the test harness): fire at the ground
        // ahead of the facing, from the chest.
        const p = this.ch.position;
        const fx = Math.sin(this.ch.facing) * 0.8;
        const fy = -0.6;
        const fz = Math.cos(this.ch.facing) * 0.8;
        this._eyeX = p.x; this._eyeY = p.y + 1.2; this._eyeZ = p.z;
        const t = groundRay(
            this.terrain, p.x, p.y + 1.2, p.z, fx, fy, fz, RANGE);
        const d = t > 0 ? t : RANGE;
        out.x = p.x + fx * d;
        out.y = p.y + 1.2 + fy * d;
        out.z = p.z + fz * d;
    }

    _fireLaser() {
        const ch = this.ch;
        this._aim(this._hit);
        // The laser is pure aim: no lock, just the ray — tested against
        // whatever the mode has standing in it. The test runs along the
        // aim ray itself, eye to mark, because that line is what the
        // reticle is covering; the muzzle only supplies the visual beam.
        // A crossing shortens the beam to the thing it hit.
        const hit = this.rayTest?.(
            this._eyeX, this._eyeY, this._eyeZ,
            this._hit.x, this._hit.y, this._hit.z
        ) || null;
        if (hit) {
            this._hit.x = hit.x; this._hit.y = hit.y; this._hit.z = hit.z;
        }
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
        // The rod of light itself: one solid mesh, planted muzzle-to-mark,
        // both endpoints locked at the moment of firing. No particles — a
        // beam is a beam.
        if (this._beamPool.length) {
            const b = this._beamPool[this._beamNext];
            this._beamNext = (this._beamNext + 1) % this._beamPool.length;
            const sx = ch.position.x, sy = ch.position.y + 1.1, sz = ch.position.z;
            const dx = hx - sx, dy = hy - sy, dz = hz - sz;
            const len = Math.hypot(dx, dy, dz) || 1;
            b.mesh.position.set(sx + dx / 2, sy + dy / 2, sz + dz / 2);
            b.mesh.scaling.set(0.22, len, 0.22);
            this._dir.set(dx / len, dy / len, dz / len);
            this._Q.FromUnitVectorsToRef(
                this._up, this._dir, b.mesh.rotationQuaternion);
            b.mesh.isVisible = true;
            b.ttl = BEAM_TIME;
            b.tx = hx; b.ty = hy; b.tz = hz;
        }
        if (hit) this.onHit?.(hit);
        ch.firedLaser = true;
    }

    _fireRocket() {
        const ch = this.ch;
        // Spent ordnance: no crate, no rocket — just the empty click.
        if (this.missiles <= 0) {
            ch.dryFire = true;
            this.onDry?.();
            return;
        }
        this.missiles -= 1;
        this.onAmmo?.(this.missiles);
        this._aim(this._hit);
        const lock = this.getLock?.();
        if (lock) {
            this._hit.x = lock.x; this._hit.y = lock.y; this._hit.z = lock.z;
        }
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
            /** Banked VFX time, in sixtieths — see the body budget below. */
            acc: 0,
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
        this.onBlast?.(r.x, r.y, r.z, 4.5);
        ch.rocketBoom = true;
    }

    /** Once per frame, before the audio reads the fire flags. */
    update(dt) {
        this._t += dt;
        const ch = this.ch;
        ch.firedLaser = false;
        ch.firedRocket = false;
        ch.rocketBoom = false;
        ch.dryFire = false;

        // Fire from anywhere — foot, board, or air — but only when a mode
        // has armed the weapons. Free roam carries no guns.
        if (input.firePressed && this.armed) {
            if (this._t - this._lastFire < DOUBLE) this._fireRocket();
            else this._fireLaser();
            this._lastFire = this._t;
        }

        // The beams: solid rods fading over their hold, sparking and lit at
        // the mark the whole while.
        const ion0 = POWERS.ion;
        for (const b of this._beamPool) {
            if (b.ttl <= 0) continue;
            b.ttl -= dt;
            if (b.ttl <= 0) {
                b.mesh.isVisible = false;
                b.mat.setFloat("intensity", 0);
                continue;
            }
            const bk = b.ttl / BEAM_TIME;
            b.mat.setFloat("intensity", 3 + 27 * bk * bk);
            this.lights.add(b.tx, b.ty + 0.4, b.tz, 6,
                ion0.hue[0], ion0.hue[1], ion0.hue[2], 16 * bk);
            // Per second, not per frame — 42/s is the 60 Hz look.
            if (this.spray && Math.random() < Math.min(1, dt * 42)) {
                const a = Math.random() * Math.PI * 2;
                this.spray.emit(
                    b.tx, b.ty + 0.05, b.tz,
                    Math.cos(a) * (0.8 + Math.random() * 2),
                    1.0 + Math.random() * 2.2,
                    Math.sin(a) * (0.8 + Math.random() * 2),
                    0.016 + Math.random() * 0.018,
                    0.25 + Math.random() * 0.35,
                    1, 1.2
                );
            }
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

            // The missile itself: a big solid slug at the head — tight
            // jitter, large grains — with a modest wisp of exhaust behind it.
            // The body should read first and the trail second, not the other
            // way round. Budgeted by time, one tick per sixtieth of a second
            // — the 60 Hz look exactly, whatever the display refresh — and
            // never starved: the slug is the missile's only visible body.
            r.acc = Math.min(r.acc + dt * 60, 3);
            let ticks = Math.min(2, r.acc | 0);
            r.acc -= ticks;
            for (; ticks > 0; ticks--) {
                for (let k = 0; k < 7; k++) {
                    this.spray.emit(
                        r.x + (Math.random() - 0.5) * 0.10,
                        r.y + (Math.random() - 0.5) * 0.10,
                        r.z + (Math.random() - 0.5) * 0.10,
                        0, 0, 0,
                        0.08 + Math.random() * 0.045,
                        0.06 + Math.random() * 0.05,
                        1,
                        16
                    );
                }
                for (let k = 0; k < 2; k++) {
                    this.spray.emit(
                        r.x - r.vx * 0.035, r.y - r.vy * 0.035, r.z - r.vz * 0.035,
                        (Math.random() - 0.5) * 1.0,
                        (Math.random() - 0.5) * 1.0,
                        (Math.random() - 0.5) * 1.0,
                        0.014 + Math.random() * 0.012,
                        0.12 + Math.random() * 0.10,
                        1,
                        6
                    );
                }
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
