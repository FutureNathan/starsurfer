/**
 * The powers — dispatch, shared context, and the casting pose.
 *
 * Owns the five powers, the plasma bodies they draw into, and the light pool
 * every material reads. One `update()` per frame, in this order, and the order
 * is load-bearing:
 *
 *   1. clear the light pool
 *   2. dispatch input
 *   3. update every power — they declare lights and write brushes here
 *   4. upload the bodies
 *
 * The lights have to be cleared before the powers run and uploaded after, or a
 * power that ended last frame keeps lighting the sea. The brushes have to be
 * written before `terrain.update()` runs the simulation pass, which is why this
 * is called from `main` alongside the character contact rather than after the
 * terrain.
 *
 * Allocation per frame: none.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { input } from "../core/input.js";
import { S } from "../core/settings.js";
import { expDamp } from "../core/camera.js";
import { SpellLights } from "./spellLights.js";
import { WaterBody } from "./waterBody.js";
import { Sweep } from "./sweep.js";
import { Ribbon } from "./ribbon.js";
import { Bloom } from "./bloom.js";
import { Asteroid } from "./asteroid.js";
import { Vortex } from "./vortex.js";
import { aimPoint, clamp01 } from "./bending.js";

/**
 * @typedef {{
 *   controller: import("../character/controller.js").CharacterController,
 *   figure: import("../character/figure.js").Figure|null,
 *   rig: import("../core/camera.js").CameraRig,
 *   terrain: import("../terrain/terrain.js").Terrain,
 *   deform: import("../terrain/deformation.js").DeformationField,
 *   spray: import("../vfx/particles.js").SprayField,
 *   water: WaterBody,
 *   lights: SpellLights,
 *   time: number,
 *   sprayScale: number,
 *   handPosition: (which:number, out:Float32Array, off:number) => void,
 * }} SpellContext
 */

const _aim = new Float32Array(3);
const _hand = new Float32Array(3);

export class SpellSystem {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {import("../render/sky.js").Sky} sky
     * @param {import("../render/shadows.js").ShadowSystem} shadows
     * @param {import("../terrain/terrain.js").Terrain} terrain
     * @param {import("../character/controller.js").CharacterController} controller
     * @param {import("../character/figure.js").Figure|null} figure
     * @param {import("../core/camera.js").CameraRig} rig
     * @param {import("../vfx/particles.js").SprayField} spray
     */
    constructor(scene, sky, shadows, terrain, controller, figure, rig, spray) {
        this.lights = new SpellLights();
        this.water = new WaterBody(scene, sky, shadows, this.lights);

        /** @type {SpellContext} */
        this.ctx = {
            controller,
            figure: figure || null,
            rig,
            terrain,
            deform: terrain.deform,
            spray,
            water: this.water,
            lights: this.lights,
            time: 0,
            sprayScale: 1,
            handPosition: (which, out, off) => this._handPosition(which, out, off),
        };

        this.sweep = new Sweep(this.ctx);
        this.ribbon = new Ribbon(this.ctx);
        this.bloom = new Bloom(this.ctx);
        this.asteroid = new Asteroid(this.ctx);
        this.vortex = new Vortex(this.ctx);

        this.spells = [this.sweep, this.ribbon, this.bloom, this.asteroid, this.vortex];

        /**
         * Materials outside this system that shade with the power lights.
         *
         * They are pushed rather than pulled because the pool is only complete
         * once every power has declared, and that is later in the frame than any
         * of these systems runs. Registering them here keeps "who is lit by a
         * power" a single list in one file instead of a `lights.apply()` call
         * scattered across five unrelated `_pushUniforms`.
         *
         * @type {import("@babylonjs/core/Materials/shaderMaterial").ShaderMaterial[]}
         */
        this._consumers = [];

        /** Aim direction, refreshed each frame from the rig. */
        this.aim = new Vector3(0, 0, 1);
        /** 0..1 eased: how far into a casting stance the figure should be. */
        this.castBlend = 0;
        this._lastCast = -99;
        this._time = 0;
        /** Console override for the Ribbon hold. */
        this.debugRibbon = false;
    }

    /**
     * Declare a material that reads `starSpellLights`.
     * @param {...import("@babylonjs/core/Materials/shaderMaterial").ShaderMaterial} mats
     */
    addConsumers(...mats) {
        for (let i = 0; i < mats.length; i++) {
            if (mats[i]) this._consumers.push(mats[i]);
        }
    }

    /**
     * Where a hand is, in world space.
     *
     * Falls back to a point in front of the chest when the figure is hidden, so
     * a power cast with the astronaut switched off still comes from somewhere
     * sensible rather than from the origin.
     */
    _handPosition(which, out, off) {
        const fig = this.ctx.figure;
        if (fig && S.showCharacter !== false) {
            fig.handPosition(which, out, off);
            return;
        }
        const ch = this.ctx.controller;
        const fx = Math.sin(ch.facing);
        const fz = Math.cos(ch.facing);
        const side = which === 0 ? -0.28 : 0.28;
        out[off] = ch.position.x + fx * 0.35 + Math.cos(ch.facing) * side;
        out[off + 1] = ch.position.y + 1.25;
        out[off + 2] = ch.position.z + fz * 0.35 - Math.sin(ch.facing) * side;
    }

    /**
     * @param {number} dt
     * @param {Vector3} cameraPos
     */
    update(dt, cameraPos) {
        const ctx = this.ctx;
        this._time += dt;
        ctx.time = this._time;
        ctx.sprayScale = S.spellSpray;
        this.lights.scale = S.spellLight;

        // Aim comes off the rig rather than the character: the player points
        // with the camera, and the figure turns to follow.
        this.aim.copyFrom(this.ctx.rig.forward);

        this.lights.begin();

        if (S.showSpells !== false) this._dispatch();
        else this._cancelAll();

        for (let i = 0; i < this.spells.length; i++) this.spells[i].update(dt);

        // The casting stance eases in while anything is up and out again after.
        // Nothing about it is a switch.
        const casting =
            this.ribbon.active || this._time - this._lastCast < 0.55 ? 1 : 0;
        this.castBlend = expDamp(this.castBlend, casting, casting ? 7.0 : 3.2, dt);
        const ch = this.ctx.controller;
        ch.cast = this.castBlend;
        ch.castAimX = this.aim.x;
        ch.castAimY = this.aim.y;
        ch.castAimZ = this.aim.z;

        // Everything outside this system that answers a power's light, after the
        // last declaration and before anything renders.
        for (let i = 0; i < this._consumers.length; i++) {
            this.lights.apply(this._consumers[i]);
        }

        this.water.update(dt, cameraPos);
    }

    _dispatch() {
        // Ribbon is a hold, so it is polled rather than edge-triggered.
        // `debugRibbon` lets the console hold it without synthesising a key
        // event — the poll would otherwise release it on the very next frame.
        this.holdRibbon(input.spellHeld2 || this.debugRibbon);
        const key = input.spellPressed;
        if (key && key !== 2) this.cast(key);
    }

    /**
     * Fire one power, by key.
     *
     * Separated from the input poll so the console or a future rebind can cast
     * without synthesising a key event. `STARSURFER.spells` is the console handle.
     *
     * @param {number} key 1..5
     */
    cast(key) {
        const ctx = this.ctx;
        const rig = ctx.rig;

        if (key === 2) {
            this.holdRibbon(true);
            return;
        }

        this._lastCast = this._time;

        if (key === 1) {
            // Flat aim: the crescent runs along the ground, so a camera pointed
            // at the sky must not launch it into the air.
            const fl = Math.hypot(this.aim.x, this.aim.z) || 1;
            this.sweep.trigger(this.aim.x / fl, this.aim.z / fl);
            rig.addTrauma(0.12);
            return;
        }

        if (key === 3 || key === 4) {
            // Both are placed where the player is looking. The ray starts at the
            // eye, so what the power hits is exactly what is under the centre of
            // the screen — which is the only targeting rule that needs no
            // explanation and no reticle.
            //
            // Capped at 22 m of ray, not the 40 the terrain could answer for.
            // Looking out across the field the first surface the ray meets is
            // often forty metres away on the far side of a crater, and a
            // detonation that goes off over there is an event the player has to
            // squint at. Beyond the cap the power lands at the cap distance
            // instead, which is always in front of them and always at a size
            // worth looking at.
            //
            // The Asteroid uses the same rule and gains something the Supernova
            // does not: the cap keeps the impact close enough that the shake, the
            // ejecta and the crater all land on the player rather than being
            // watched from outside.
            const eye = rig.camera.position;
            aimPoint(
                _aim, ctx.terrain,
                eye.x, eye.y, eye.z,
                this.aim.x, this.aim.y, this.aim.z,
                22, 13
            );
            if (key === 3) this.bloom.trigger(_aim[0], _aim[1], _aim[2]);
            else this.asteroid.trigger(_aim[0], _aim[1], _aim[2]);
            return;
        }

        if (key === 5) {
            this.vortex.trigger();
            rig.addTrauma(0.10);
        }
    }

    /** @param {boolean} held */
    holdRibbon(held) {
        if (held) {
            if (!this.ribbon.held) {
                this.ribbon.trigger();
                this._lastCast = this._time;
            }
        } else if (this.ribbon.held) {
            this.ribbon.release();
        }
    }

    _cancelAll() {
        for (let i = 0; i < this.spells.length; i++) this.spells[i].cancel();
    }

    /** Live power count, for the overlay. */
    get activeCount() {
        let n = 0;
        for (let i = 0; i < this.spells.length; i++) if (this.spells[i].active) n++;
        return n;
    }

    /**
     * Nothing this system draws belongs in the depth prepass.
     *
     * A plasma body is translucent and emissive, so a depth for it would tell
     * every screen-space consumer that the ground behind it is not there — which
     * is exactly wrong for a medium you can see through and which is putting
     * light *into* what is behind it. The crystal lattices used to be the
     * exception and they are gone; the glaze a power leaves is still in the
     * prepass, but it is written by the terrain, which registers itself.
     *
     * Kept as a no-op rather than deleted from the call site, because "the powers
     * are asked and decline" is a different statement from "somebody forgot".
     */
    registerPrepass() {}

    get triangles() {
        return this.water.triangles;
    }

    /**
     * Compile every power's pipeline behind the loading screen.
     *
     * The first cast of any power must not hitch, and this is the only thing
     * standing between that and a multi-hundred-millisecond freeze the first
     * time somebody presses 3. Both body profiles are exercised with real
     * geometry — a pipeline compiled against an empty draw is a warm-up that
     * quietly covers nothing.
     */
    async warmUp(x, y, z) {
        await this.water.warmUp(x, y, z);
    }

    /**
     * Clear the warm-up geometry. Called after `main`'s warm-up frames, not
     * inside `warmUp` — the whole point is that those frames draw it.
     */
    finishWarmUp() {
        this.water.finishWarmUp();
    }

    dispose() {
        this.water.dispose();
    }
}
