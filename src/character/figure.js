/**
 * The figure — skeleton, bind pose, and the procedural locomotion that poses it.
 *
 * There is no rig file and no animation data. Everything here is solved from the
 * motion state the controller already produces. The one thing that buys has to
 * be paid for in exchange: **feet plant rather than slide**.
 *
 * Planting is not approximated. When a foot enters stance its world position is
 * recorded and then held absolutely fixed while the body travels over it; the
 * leg is solved by two-bone IK to reach that fixed point. A foot in this rig
 * cannot slide, because during stance nothing in the code is capable of moving
 * it. The gait phase itself is driven by distance travelled, not by a clock, so
 * the stride length and the ground speed are the same number by construction.
 *
 * Bone convention: a bone's local +Y runs from its own joint toward its child,
 * so a hanging arm has +Y pointing at the floor. Geometry is authored in
 * bind-pose world space and skinned by `world * inverseBind`.
 *
 * Allocation: none per frame. Everything lives in flat arrays sized at
 * construction.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { setFrameFromDir, invertRigid, mul, xformPoint } from "../core/mat4.js";

// --------------------------------------------------------------- bone indices
export const B_ROOT = 0;
export const B_SPINE = 1;
export const B_CHEST = 2;
export const B_NECK = 3;
export const B_HEAD = 4;
export const B_HELMET = 5;
export const B_UPPER_L = 6;
export const B_FORE_L = 7;
export const B_HAND_L = 8;
export const B_UPPER_R = 9;
export const B_FORE_R = 10;
export const B_HAND_R = 11;
export const B_THIGH_L = 12;
export const B_SHIN_L = 13;
export const B_FOOT_L = 14;
export const B_THIGH_R = 15;
export const B_SHIN_R = 16;
export const B_FOOT_R = 17;
/**
 * The board. Not parented to the figure at all — it is driven from the surface
 * it is planing on, and the legs are solved down to it.
 */
export const B_BOARD = 18;
export const BONE_COUNT = 19;

/**
 * Bind pose, nine floats per bone: joint position, bone direction, front
 * reference. A 1.84 m figure with the pelvis at 0.95 — deliberately a little
 * long in the leg and narrow in the shoulder, because the silhouette is read at
 * fifteen metres inside a pressure suit and slightly heroic proportions survive
 * that better than accurate ones. The overall height is not in this table: the
 * skeleton stops at the head joint at 1.55 and the last 26 cm is the helmet
 * bubble `build.js` hangs off it, so retuning `HELM_C` or `HELM_R` moves it.
 */
const BIND = new Float32Array([
    /* ROOT    */ 0, 0.95, 0, 0, 1, 0, 0, 0, 1,
    /* SPINE   */ 0, 1.06, 0, 0, 1, 0, 0, 0, 1,
    /* CHEST   */ 0, 1.26, 0, 0, 1, 0, 0, 0, 1,
    /* NECK    */ 0, 1.46, 0, 0, 1, 0, 0, 0, 1,
    /* HEAD    */ 0, 1.55, 0, 0, 1, 0, 0, 0, 1,
    /* HELMET  */ 0, 1.55, 0, 0, 1, 0, 0, 0, 1,

    /* UPPER_L */ -0.185, 1.400, 0.000, -0.16, -0.987, 0, 0, 0, 1,
    /* FORE_L  */ -0.230, 1.123, 0.000, -0.05, -0.997, 0.06, 0, 0, 1,
    /* HAND_L  */ -0.243, 0.866, 0.016, -0.02, -0.992, 0.12, 0, 0, 1,
    /* UPPER_R */ 0.185, 1.400, 0.000, 0.16, -0.987, 0, 0, 0, 1,
    /* FORE_R  */ 0.230, 1.123, 0.000, 0.05, -0.997, 0.06, 0, 0, 1,
    /* HAND_R  */ 0.243, 0.866, 0.016, 0.02, -0.992, 0.12, 0, 0, 1,

    /* THIGH_L */ -0.100, 0.900, 0, 0, -1, 0, 0, 0, 1,
    /* SHIN_L  */ -0.100, 0.460, 0, 0, -1, 0, 0, 0, 1,
    /* FOOT_L  */ -0.100, 0.090, 0, 0, 0, 1, 0, 1, 0,
    /* THIGH_R */ 0.100, 0.900, 0, 0, -1, 0, 0, 0, 1,
    /* SHIN_R  */ 0.100, 0.460, 0, 0, -1, 0, 0, 0, 1,
    /* FOOT_R  */ 0.100, 0.090, 0, 0, 0, 1, 0, 1, 0,

    // Deck-forward along +Z with world up as its front reference — the same
    // convention the feet use, so the board's geometry can be authored lying
    // flat along Z with its centreline on the joint.
    /* BOARD   */ 0, 0.020, 0, 0, 0, 1, 0, 1, 0,
]);

/** Segment lengths implied by the bind table, metres. */
const THIGH_LEN = 0.44;
const SHIN_LEN = 0.37;
const UPPER_LEN = 0.28;
const FORE_LEN = 0.26;

/** Pelvis height above the feet in the bind pose. */
const HIP_HEIGHT = 0.95;

/**
 * Board geometry the pose has to agree with, in bind metres.
 *
 * Both numbers are fixed by `build.js`; restating them here is what lets the
 * surf stance put the soles *on* the deck rather than an inch through it, and it
 * is the only coupling between the two files that is not a bone.
 */
/** Half the deck's thickness at the stance — the widest ring of the board loft. */
const BOARD_HALF_T = 0.033;
/**
 * How far the boot's sole hangs below the ankle *beyond* the 9 cm `_poseLeg`
 * already allows for. The boot's lowest ring reaches 11.2 cm under the foot
 * joint, so this is the remainder; move the boot rings and this moves with them.
 */
const BOOT_SOLE = 0.022;
/**
 * How far above the dust the target sole height sits while surfing: the board's
 * full thickness plus that extra sole drop, less four millimetres so the boots
 * bite into the deck instead of hovering over it.
 */
const BOARD_STAND = 2 * BOARD_HALF_T + BOOT_SOLE - 0.004;

/**
 * The surf stance, in board-local metres and radians.
 *
 * A surfer does not face the way the board is pointing. Both feet stand *on* the
 * stringer, one behind the other, and the body is turned across the deck — which
 * is the read that separates surfing from standing on a plank, and it is what the
 * earlier stance was missing: two feet either side of the centreline with the
 * chest pointed down the nose is a snowboarder's beginner traverse at best.
 *
 * Regular-footed, so the left foot is the front one. `STANCE_OPEN` is how far the
 * pelvis turns toward the toe-side rail, and the derivation for its sign is worth
 * keeping: with the nose along +Z the toe side is +X, a body facing +X has its
 * left flank toward +Z, and +X is `facing` rotated by +90 degrees about the up
 * axis in this left-handed frame. So a *positive* open angle is what puts the left
 * foot forward.
 *
 * Sixty-six degrees rather than a full ninety. Ninety is a photograph of a bottom
 * turn, not a cruise, and it also puts the figure's own forward axis exactly
 * across the direction of travel, where every fore-aft term in the pose — the
 * speed lean, the acceleration pitch — would be applied sideways.
 */
const STANCE_OPEN = 1.15;

/**
 * The five cast gestures — one per power, so throwing a Supernova and
 * sowing a Flare stop sharing an arm. Each entry is (outward, along-aim,
 * lift) for the leading right hand (`lo`, `la`, `ll`) and the trailing left
 * (`to`, `ta`, `tl`), in the same shoulder-relative metres the original
 * single gesture used. The tall reaches (Nova's slam, the Rock's call to
 * the sky) deliberately point past the arm's 0.54 m: the solve clamps the
 * target onto the reach sphere, so what survives is the *direction* of the
 * gesture with the arm at its true length.
 *
 *   1 Flare  the sower: leading arm sweeps low and wide, releasing along
 *            the ground the crescent is about to plough.
 *   2 Ion    the conduit: both hands pushed forward along the aim, stacked,
 *            holding a stream that is trying to leave.
 *   3 Nova   the slam: both arms thrown high before the detonation.
 *   4 Rock   the caller: one arm at the sky it is calling from, the other
 *            braced low across the body.
 *   5 Well   the gather: both arms low and inboard, scooping toward the
 *            centre the well is about to become.
 */
const CAST_STYLES = [
    { lo: 0.44, la: 0.30, ll: -0.10, to: -0.22, ta: 0.08, tl: 0.16 },
    { lo: 0.10, la: 0.56, ll: 0.12,  to: 0.04,  ta: 0.42, tl: -0.04 },
    { lo: 0.26, la: 0.18, ll: 0.48,  to: -0.26, ta: 0.14, tl: 0.44 },
    { lo: 0.14, la: 0.26, ll: 0.58,  to: -0.24, ta: 0.02, tl: -0.10 },
    { lo: -0.04, la: 0.28, ll: -0.16, to: -0.12, ta: 0.24, tl: -0.18 },
];
/**
 * How much of the open angle the neck takes back, so the visor keeps looking
 * down the line rather than out at the rail. Anything much under this and the
 * astronaut is riding blind, which reads instantly as wrong even at fifteen
 * metres — the helmet is the one part of the silhouette that says where the
 * attention is.
 */
const STANCE_LOOK = 0.80;
/**
 * Each foot's own angle across the deck, as a multiple of `STANCE_OPEN`. The
 * front foot sits open at about fifty degrees and the back foot nearly square
 * across at eighty-five, which is the asymmetry every stance actually has: the
 * front foot steers and the back foot drives.
 */
const FOOT_OPEN_FRONT = 0.76;
const FOOT_OPEN_BACK = 1.28;
/** Front and back foot positions along the stringer, metres from the waist. */
const STANCE_FRONT = 0.260;
const STANCE_BACK = 0.300;
/**
 * How far off the stringer each foot sits. Almost nothing, and in opposite
 * directions: the front foot a little toward the toe-side rail, the back foot a
 * little toward the heel. Both are inside the boot's own half-width, so what this
 * actually does is stop the two boots reading as one line.
 */
const STANCE_TOE = 0.045;
const STANCE_HEEL = 0.028;

// ------------------------------------------------------- module-scope scratch
const _axes = new Float32Array(9);   // X, Y, Z of a composed basis
const _p = new Float32Array(3);
const _knee = new Float32Array(3);
const _hip = new Float32Array(3);
const _sh = new Float32Array(3);
const _gnd = new Vector3(0, 1, 0);   // terrain normal under the board
const _flipV = [0, 0, 0];            // scratch for the trick-flip rotation

/**
 * Compose an orthonormal basis from yaw, then pitch about its own right axis,
 * then roll about its own forward axis, then `open` about its own up axis.
 * Writes X, Y, Z into `_axes`.
 *
 * Positive pitch leans forward, positive roll tips the head to the character's
 * right — which is the sign the controller's `lean` already uses.
 *
 * `open` is the surf stance, and it is deliberately applied *last* rather than
 * folded into `yaw`. Everything the pose computes about pitch and roll is stated
 * relative to the direction of travel: the speed lean, the acceleration lean, the
 * bank into a carve. Turning the figure by adding to `yaw` would rotate those
 * axes with it, so leaning into a turn would tip the surfer toward the nose
 * instead of over the inside rail. Turning it about the already-leaned up axis
 * keeps travel-relative attitude travel-relative and makes the stance a pure
 * twist on top of it.
 */
function composeBasis(yaw, pitch, roll, open) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    let xx = cy, xy = 0, xz = -sy;
    let yx = 0, yy = 1, yz = 0;
    let zx = sy, zy = 0, zz = cy;

    if (pitch !== 0) {
        const c = Math.cos(pitch), s = Math.sin(pitch);
        const nyx = yx * c + zx * s, nyy = yy * c + zy * s, nyz = yz * c + zz * s;
        const nzx = zx * c - yx * s, nzy = zy * c - yy * s, nzz = zz * c - yz * s;
        yx = nyx; yy = nyy; yz = nyz; zx = nzx; zy = nzy; zz = nzz;
    }
    if (roll !== 0) {
        const c = Math.cos(roll), s = Math.sin(roll);
        const nxx = xx * c - yx * s, nxy = xy * c - yy * s, nxz = xz * c - yz * s;
        const nyx = yx * c + xx * s, nyy = yy * c + xy * s, nyz = yz * c + xz * s;
        xx = nxx; xy = nxy; xz = nxz; yx = nyx; yy = nyy; yz = nyz;
    }
    if (open) {
        // Z' = Z cos + X sin, and X' = Y x Z' works out to X cos - Z sin. Both
        // stay unit-length and mutually perpendicular for free, which is why this
        // is written out rather than run through a re-orthogonalisation.
        const c = Math.cos(open), s = Math.sin(open);
        const nzx = zx * c + xx * s, nzy = zy * c + xy * s, nzz = zz * c + xz * s;
        const nxx = xx * c - zx * s, nxy = xy * c - zy * s, nxz = xz * c - zz * s;
        xx = nxx; xy = nxy; xz = nxz; zx = nzx; zy = nzy; zz = nzz;
    }

    _axes[0] = xx; _axes[1] = xy; _axes[2] = xz;
    _axes[3] = yx; _axes[4] = yy; _axes[5] = yz;
    _axes[6] = zx; _axes[7] = zy; _axes[8] = zz;
}

/**
 * Two-bone IK. Given a root joint, an end target and a pole direction, writes
 * the middle joint's world position into `out`.
 *
 * The target is pulled inside reach rather than clamped at it: a fully extended
 * leg reads as a stiff peg, and the last centimetre of reach is where all the
 * knee-lock artefacts live.
 */
function solveTwoBone(rx, ry, rz, tx, ty, tz, px, py, pz, l1, l2, out) {
    let dx = tx - rx, dy = ty - ry, dz = tz - rz;
    let dist = Math.hypot(dx, dy, dz);
    const maxReach = (l1 + l2) * 0.995;
    if (dist < 1e-4) { dx = 0; dy = -1; dz = 0; dist = 1e-4; }
    if (dist > maxReach) dist = maxReach;
    const inv = 1 / Math.hypot(dx, dy, dz);
    dx *= inv; dy *= inv; dz *= inv;

    // Cosine rule: how far along the root→target axis the middle joint projects.
    const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));

    // Pole, orthogonalised against the axis — this is what decides which way the
    // knee or elbow bends, and it has to be re-derived every frame because the
    // axis swings through it during a stride.
    const d = px * dx + py * dy + pz * dz;
    let ox = px - dx * d, oy = py - dy * d, oz = pz - dz * d;
    let ol = Math.hypot(ox, oy, oz);
    if (ol < 1e-5) { ox = 0; oy = 0; oz = 1; ol = 1; }
    ox /= ol; oy /= ol; oz /= ol;

    out[0] = rx + dx * a + ox * h;
    out[1] = ry + dy * a + oy * h;
    out[2] = rz + dz * a + oz * h;
}

/** Framerate-independent exponential approach. */
function damp(cur, target, rate, dt) {
    return target + (cur - target) * Math.exp(-rate * dt);
}

function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

export class Figure {
    /**
     * @param {{heightAt(x:number,z:number):number, normalAt(x:number,z:number,out:any):any}} terrain
     */
    constructor(terrain) {
        this.terrain = terrain;

        /** World matrix per bone. */
        this.world = new Float32Array(BONE_COUNT * 16);
        /** Bind-pose world matrix per bone. */
        this.bind = new Float32Array(BONE_COUNT * 16);
        /** Inverse of the above. */
        this.invBind = new Float32Array(BONE_COUNT * 16);
        /** `world * invBind` — the matrix geometry is actually skinned by. */
        this.skin = new Float32Array(BONE_COUNT * 16);

        /** World joint positions, three floats per bone. Cloth collision reads these. */
        this.joint = new Float32Array(BONE_COUNT * 3);

        for (let b = 0; b < BONE_COUNT; b++) {
            const o = b * 9;
            setFrameFromDir(
                this.bind, b * 16,
                BIND[o], BIND[o + 1], BIND[o + 2],
                BIND[o + 3], BIND[o + 4], BIND[o + 5],
                BIND[o + 6], BIND[o + 7], BIND[o + 8]
            );
            invertRigid(this.invBind, b * 16, this.bind, b * 16);
        }

        // ------------------------------------------------------------- gait
        /** Where each foot is planted, world. Frozen for the whole stance phase. */
        this.plant = new Float32Array(6);
        /** Live foot position (equals `plant` during stance). */
        this.footPos = new Float32Array(6);
        /** Ground normal under each planted foot. */
        this.footNormal = new Float32Array([0, 1, 0, 0, 1, 0]);
        /** 1 while the foot carries weight, 0 mid-swing. Eased. */
        this.footWeight = new Float32Array([1, 1]);
        this._wasStance = [true, true];
        /** Set for one frame when a foot touches down. Drives spray and splats. */
        this.touchdown = [false, false];

        // ------------------------------------------------- smoothed pose state
        this.hipY = HIP_HEIGHT;
        this.pitch = 0;
        this.roll = 0;
        this.bob = 0;
        this.headYaw = 0;
        this.headPitch = 0;
        this.helmetYaw = 0;
        this.helmetPitch = 0;
        /** How far the head and helmet are turned off the direction of travel. */
        this.headOpen = 0;
        this.helmetOpen = 0;
        this.armPhase = 0;
        /** How far the figure has settled into the dust, metres. */
        this.sink = 0.04;

        this._t = 0;
        this._prevGait = 0;
    }

    /**
     * Pose the skeleton for this frame.
     * @param {number} dt
     * @param {import("./controller.js").CharacterController} ch
     */
    update(dt, ch) {
        const h = Math.min(dt, 1 / 30);
        this._t += h;
        // The storey the body is on this frame — see `Terrain.surfaceAt`.
        // Feet planted from here ground on the tube roofs when riding one.
        this._refY = ch.position.y;

        const surf = ch.surf;
        const speed = ch.speed;
        const run = Math.min(1, speed / 5.4);

        // The trick jump, seen from the figure's side: the controller owns
        // the ballistics and publishes three numbers — a visual spin, a tuck,
        // and (implicitly) how far the position rides above the ground. The
        // spin is added to every stance yaw, so rider, feet and board turn as
        // one; the lift raises everything rigidly; the tuck deepens the
        // crouch so the rotation reads as a grabbed trick, not a pirouette.
        const spinYaw = ch.facing + (ch.trickSpin || 0);
        const flip = ch.trickFlip || 0;
        // `?? position.y` so a driver without ground bookkeeping reads as
        // grounded — NaN here would ride the root into every bone.
        const lift = Math.max(0, ch.position.y - (ch.groundY ?? ch.position.y));

        // ---------------------------------------------------------- footfalls
        // Stance/swing is derived from the same distance-driven phase the
        // controller uses to fire footfall events, so the visual plant and the
        // splat in the dust are the same instant by construction.
        this._updateFeet(h, ch);

        // -------------------------------------------------------- body attitude
        // Lean forward with speed, and *into* acceleration — the classic read
        // that a figure is pushing rather than being dragged.
        const fwdAcc =
            ch.acceleration.x * Math.sin(ch.facing) + ch.acceleration.z * Math.cos(ch.facing);
        // Clamped, because the accelerations at either end of a surf run are an
        // order of magnitude larger than anything walking produces: letting go at
        // top speed decelerates at 30 m/s^2, which unclamped throws the torso
        // twenty degrees backwards and reads as a fall rather than as a scrub.
        const pitchWant =
            0.10 * run
            + 0.012 * clamp(fwdAcc, -9, 22)
            + surf * (0.30 + 0.16 * ch.speed01);
        this.pitch = damp(this.pitch, pitchWant, 7, h);

        const rollWant = ch.lean * (0.16 + 0.34 * surf);
        this.roll = damp(this.roll, rollWant, 8, h);

        // Vertical bob: the pelvis drops through each stance and rises over the
        // supporting leg, twice per stride. Suppressed while surfing, where the
        // stance is a static crouch.
        const bobWant =
            (1 - surf) * (-0.028 * run * (0.5 - 0.5 * Math.cos(4 * Math.PI * ch.gaitPhase)));
        this.bob = damp(this.bob, bobWant, 18, h);

        // Crouch: a little at running speed, a lot on the board — and most
        // of all at the apex of a trick.
        const crouch = 0.035 * run + surf * (0.13 + 0.05 * ch.speed01)
            + (ch.airTuck || 0) * 0.17;
        this.hipY = damp(this.hipY, HIP_HEIGHT - crouch, 9, h);

        // The figure settles into the dust it is standing on. Reading the real
        // depth would mean a GPU readback; this is the same number the contact
        // brushes are writing, held on the CPU.
        this.sink = damp(
            this.sink, (0.045 + surf * 0.055) * (lift > 0.05 ? 0 : 1), 4, h
        );

        // ------------------------------------------------------------- spine
        const gx = ch.position.x;
        const gz = ch.position.z;
        const groundY = this.terrain.heightAt(gx, gz);

        const rootY = groundY - this.sink + this.hipY + this.bob + lift;

        // How far across the board the figure is standing this frame. Eased by
        // `surf` exactly like the crouch and the board's own attitude, so the
        // astronaut turns into the stance as the board comes under the feet
        // rather than snapping into it.
        const open = surf * STANCE_OPEN;

        // The travel-aligned frame. The legs and the feet are solved in this one
        // — a planted foot points where the figure is going, and while surfing
        // each boot is turned off it by its own angle in `_poseLeg`.
        composeBasis(spinYaw, this.pitch + flip, this.roll);
        const rX = _axes[0], rY = _axes[1], rZ = _axes[2];
        const uX = _axes[3], uY = _axes[4], uZ = _axes[5];
        const fX = _axes[6], fY = _axes[7], fZ = _axes[8];

        // Pelvis. Its yaw counter-rotates against the shoulders during a stride,
        // which is most of what stops a procedural walk reading as a shop dummy.
        const twist = (1 - surf) * 0.13 * run * Math.sin(2 * Math.PI * ch.gaitPhase);
        composeBasis(spinYaw + twist, this.pitch + flip, this.roll, open);
        const pRx = _axes[0], pRy = _axes[1], pRz = _axes[2];
        const pUx = _axes[3], pUy = _axes[4], pUz = _axes[5];
        const pFx = _axes[6], pFy = _axes[7], pFz = _axes[8];
        this._setBone(B_ROOT, gx, rootY, gz, pUx, pUy, pUz, pFx, pFy, pFz);

        // The front flip: the feet (and with them the legs and the board,
        // which follows the feet) orbit the hip about the stance's right
        // axis, while every torso frame above picked up the same angle as
        // extra pitch. One Rodrigues rotation per foot, once per frame,
        // only while the trick is actually running.
        if (flip > 0.0005) {
            const ca = Math.cos(flip), sa = Math.sin(flip);
            const ax = Math.cos(spinYaw), az = -Math.sin(spinYaw);
            for (let f = 0; f < 2; f++) {
                const o = f * 3;
                const dx = this.footPos[o] - gx;
                const dy = this.footPos[o + 1] - rootY;
                const dz = this.footPos[o + 2] - gz;
                const ad = ax * dx + az * dz;
                // r x d with r = (ax, 0, az)
                const cx = -az * dy;
                const cy = az * dx - ax * dz;
                const cz = ax * dy;
                this.footPos[o] = gx + dx * ca + cx * sa + ax * ad * (1 - ca);
                this.footPos[o + 1] = rootY + dy * ca + cy * sa;
                this.footPos[o + 2] = gz + dz * ca + cz * sa + az * ad * (1 - ca);
            }
        }

        // Spine and chest lift along the pelvis up-axis, with the chest twisting
        // the opposite way and leaning a little further forward.
        const spineY = rootY + uY * 0.11;
        this._setBone(
            B_SPINE, gx + uX * 0.11, spineY, gz + uZ * 0.11,
            pUx, pUy, pUz, pFx, pFy, pFz
        );

        const chestTwist = -twist * 1.5;
        const chestPitch = this.pitch + flip + 0.05 * run + surf * 0.10;
        // The shoulders open a little further than the hips — about eight degrees
        // at a full stance. A surfer's chest leads the pelvis round, and the small
        // difference is what stops the torso reading as one rigid block.
        composeBasis(spinYaw + chestTwist, chestPitch, this.roll * 1.15, open * 1.12);
        const cUx = _axes[3], cUy = _axes[4], cUz = _axes[5];
        const cFx = _axes[6], cFy = _axes[7], cFz = _axes[8];
        const cRx = _axes[0], cRy = _axes[1], cRz = _axes[2];

        const chestX = gx + uX * 0.31, chestY = rootY + uY * 0.31, chestZ = gz + uZ * 0.31;
        this._setBone(B_CHEST, chestX, chestY, chestZ, cUx, cUy, cUz, cFx, cFy, cFz);

        const neckX = chestX + cUx * 0.20, neckY = chestY + cUy * 0.20, neckZ = chestZ + cUz * 0.20;
        this._setBone(B_NECK, neckX, neckY, neckZ, cUx, cUy, cUz, cFx, cFy, cFz);

        // ------------------------------------------------------------- head
        // Head stabilisation: the head stays much closer to level than the chest
        // it sits on. Real necks do this and it is very obvious when missing.
        this.headPitch = damp(
            this.headPitch, -(chestPitch - flip) * 0.62 + surf * 0.10, 9, h
        );
        this.headYaw = damp(this.headYaw, ch.lean * -0.22, 6, h);
        // The neck takes most of the stance back, so what is left is a head
        // turned about fifteen degrees off the direction of travel — looking down
        // the line, which is where a surfer looks.
        this.headOpen = damp(this.headOpen, open * (1 - STANCE_LOOK), 9, h);
        composeBasis(
            spinYaw + chestTwist + this.headYaw, chestPitch + this.headPitch,
            this.roll * 0.5, this.headOpen
        );
        const headX = neckX + cUx * 0.09, headY = neckY + cUy * 0.09, headZ = neckZ + cUz * 0.09;
        this._setBone(B_HEAD, headX, headY, headZ, _axes[3], _axes[4], _axes[5], _axes[6], _axes[7], _axes[8]);

        // The helmet is bolted to a metal disconnect ring, so it tracks the head
        // essentially rigidly. Soft headwear wants a few frames of lag — that is
        // what makes it read as fabric — but a rigid shell that slides around
        // the skull during a carve just reads as broken. All the bearing has is
        // about a frame of compliance, which is what these rates come to at
        // sixty hertz, and it is enough to keep the helmet from feeling welded.
        this.helmetYaw = damp(this.helmetYaw, spinYaw + chestTwist + this.headYaw, 60, h);
        this.helmetPitch = damp(this.helmetPitch, chestPitch + this.headPitch, 60, h);
        this.helmetOpen = damp(this.helmetOpen, this.headOpen, 60, h);
        composeBasis(this.helmetYaw, this.helmetPitch, this.roll * 0.5, this.helmetOpen);
        this._setBone(B_HELMET, headX, headY, headZ, _axes[3], _axes[4], _axes[5], _axes[6], _axes[7], _axes[8]);

        // -------------------------------------------------------------- arms
        this._poseArms(h, ch, chestX, chestY, chestZ, cRx, cRy, cRz, cUx, cUy, cUz, cFx, cFy, cFz);

        // -------------------------------------------------------------- legs
        // The hips are carried by the *pelvis* frame, so with the stance open the
        // left hip sits toward the nose and the right toward the tail — which is
        // what keeps the leg IK short and natural in a sideways stance instead of
        // making each leg reach diagonally across the board.
        this._poseLeg(0, gx, rootY, gz, pRx, pRy, pRz, uX, uY, uZ, fX, fY, fZ,
                      open * FOOT_OPEN_FRONT);
        this._poseLeg(1, gx, rootY, gz, pRx, pRy, pRz, uX, uY, uZ, fX, fY, fZ,
                      open * FOOT_OPEN_BACK);

        // ------------------------------------------------------------- board
        this._poseBoard(ch, gx, groundY + lift, gz, chestX, chestY, chestZ,
                        cUx, cUy, cUz, cFx, cFy, cFz);

        // ------------------------------------------------------------- skin
        for (let b = 0; b < BONE_COUNT; b++) {
            mul(this.skin, b * 16, this.world, b * 16, this.invBind, b * 16);
            this.joint[b * 3] = this.world[b * 16 + 12];
            this.joint[b * 3 + 1] = this.world[b * 16 + 13];
            this.joint[b * 3 + 2] = this.world[b * 16 + 14];
        }
    }

    _setBone(b, px, py, pz, yx, yy, yz, zx, zy, zz) {
        // X = Y x Z, completing the frame from the bone axis and its front
        // reference. Both are already orthonormal at every call site.
        setFrameFromDir(this.world, b * 16, px, py, pz, yx, yy, yz, zx, zy, zz);
    }

    /**
     * Advance the stance/swing state machine and place both ankles.
     *
     * Stance is the whole point. `plant` is written exactly once, on touchdown,
     * and read unchanged for the rest of the stance — so no amount of body
     * motion, camera motion or frame-rate variation can move a planted foot.
     */
    _updateFeet(h, ch) {
        const surf = ch.surf;
        const speed = ch.speed;
        const run = Math.min(1, speed / 5.4);
        // Duty factor: a walk keeps both feet down for a moment, a run has a
        // flight phase. Interpolating between them is what makes the transition
        // from walk to run read as a gait change and not a speed change.
        const duty = 0.66 - 0.20 * run;

        const feetYaw = ch.facing + (ch.trickSpin || 0);
        const fwdX = Math.sin(feetYaw), fwdZ = Math.cos(feetYaw);
        const rgtX = Math.cos(feetYaw), rgtZ = -Math.sin(feetYaw);

        // Half a stride ahead, scaled by speed — this is the step length, and it
        // has to match the controller's stride or the feet skate.
        const half = 0.34 + 0.42 * run;
        // The controller owns this decision — see `stepping` there. Re-deriving
        // it from `surf` here is how the feet and the footprints end up
        // disagreeing about whether the character is walking.
        const moving = speed > 0.2 && ch.stepping;

        for (let f = 0; f < 2; f++) {
            const side = f === 0 ? -0.105 : 0.105;
            // Left foot leads; the right is half a cycle behind.
            const ph = (ch.gaitPhase + (f === 0 ? 0 : 0.5)) % 1;
            const stance = !moving || ph < duty;

            // Where this foot would land if it touched down right now.
            const nx = ch.position.x + fwdX * half + rgtX * side;
            const nz = ch.position.z + fwdZ * half + rgtZ * side;

            if (stance) {
                if (!this._wasStance[f]) {
                    // Touchdown. This is the only line in the file that writes a
                    // plant position.
                    this.plant[f * 3] = nx;
                    this.plant[f * 3 + 1] = this._ground(nx, nz) - this.sink * 0.7;
                    this.plant[f * 3 + 2] = nz;
                    this.touchdown[f] = true;
                } else {
                    this.touchdown[f] = false;
                }
                if (!moving) {
                    // Standing: ease the feet back under the hips rather than
                    // leaving them wherever the last stride dropped them.
                    const sx = ch.position.x + rgtX * side + fwdX * 0.02;
                    const sz = ch.position.z + rgtZ * side + fwdZ * 0.02;
                    this.plant[f * 3] = damp(this.plant[f * 3], sx, 7, h);
                    this.plant[f * 3 + 2] = damp(this.plant[f * 3 + 2], sz, 7, h);
                    this.plant[f * 3 + 1] = damp(
                        this.plant[f * 3 + 1],
                        this._ground(this.plant[f * 3], this.plant[f * 3 + 2]) - this.sink * 0.7,
                        7, h
                    );
                }
                this.footPos[f * 3] = this.plant[f * 3];
                this.footPos[f * 3 + 1] = this.plant[f * 3 + 1];
                this.footPos[f * 3 + 2] = this.plant[f * 3 + 2];
                this.footWeight[f] = damp(this.footWeight[f], 1, 22, h);
            } else {
                this.touchdown[f] = false;
                // Swing: from the plant it is leaving to the plant it is heading
                // for, on an arc. `nx/nz` keeps updating as the body moves, so
                // the foot is always aimed at where the body will actually be.
                const s = (ph - duty) / (1 - duty);
                const e = s * s * (3 - 2 * s);
                const ny = this._ground(nx, nz) - this.sink * 0.7;
                const px = this.plant[f * 3], py = this.plant[f * 3 + 1], pz = this.plant[f * 3 + 2];
                this.footPos[f * 3] = px + (nx - px) * e;
                this.footPos[f * 3 + 2] = pz + (nz - pz) * e;
                this.footPos[f * 3 + 1] =
                    py + (ny - py) * e + Math.sin(Math.PI * s) * (0.055 + 0.12 * run);
                this.footWeight[f] = damp(this.footWeight[f], 0, 22, h);
            }

            this._wasStance[f] = stance;
        }

        // Surfing: both feet ride the board. Blended in, never snapped.
        if (surf > 0.001) {
            for (let f = 0; f < 2; f++) {
                // Both feet on the stringer, one behind the other: left foot
                // forward of the waist, right foot behind it, and each only a
                // few centimetres off the centreline in opposite directions.
                // `STANCE_FRONT + STANCE_BACK` is what decides how long the deck
                // has to be — 56 cm here, against a deck that runs 94 cm forward
                // of the bone and 88 back.
                const lateral = f === 0 ? STANCE_TOE : -STANCE_HEEL;
                const along = f === 0 ? STANCE_FRONT : -STANCE_BACK;
                const sx = ch.position.x + fwdX * along + rgtX * lateral;
                const sz = ch.position.z + fwdZ * along + rgtZ * lateral;
                // Standing on the deck, which is itself planing on the dust the
                // board has already compressed — hence the `sink` and then the
                // board's own thickness back up again.
                const sy = this._ground(sx, sz) - this.sink + BOARD_STAND
                    + Math.max(0, ch.position.y - (ch.groundY ?? ch.position.y));
                const o = f * 3;
                this.footPos[o] += (sx - this.footPos[o]) * surf;
                this.footPos[o + 1] += (sy - this.footPos[o + 1]) * surf;
                this.footPos[o + 2] += (sz - this.footPos[o + 2]) * surf;
                this.footWeight[f] = Math.max(this.footWeight[f], surf);
            }
        }
    }

    /**
     * Ground under a foot: the bake, or a tube roof when standing on one.
     * Falls back to the plain heightfield for terrains without overhead
     * surfaces — which includes every test harness.
     */
    _ground(x, z) {
        const t = this.terrain;
        return t.surfaceAt ? t.surfaceAt(x, z, this._refY ?? 0) : t.heightAt(x, z);
    }

    /**
     * Solve one leg. `f` is 0 for left, 1 for right.
     *
     * The knee pole tilts outward as well as forward, because a knee that bends
     * in a perfectly sagittal plane looks mechanical — real legs track slightly
     * wide of the hip.
     *
     * `rX/rY/rZ` is the *pelvis* right axis, so the hips travel round with the
     * surf stance; `fX..fZ` and `uX..uZ` are the travel-aligned frame, and `open`
     * is how far this particular boot is turned off it. Rotating the forward
     * reference rather than the whole frame is what lets one foot sit at fifty
     * degrees across the deck and the other at eighty-five, which no single body
     * transform can express.
     */
    _poseLeg(f, rootX, rootY, rootZ, rX, rY, rZ, uX, uY, uZ, fX, fY, fZ, open) {
        const side = f === 0 ? -0.10 : 0.10;
        const hipB = f === 0 ? B_THIGH_L : B_THIGH_R;
        const shinB = f === 0 ? B_SHIN_L : B_SHIN_R;
        const footB = f === 0 ? B_FOOT_L : B_FOOT_R;

        // Hip joint, carried by the pelvis frame.
        _hip[0] = rootX + rX * side - uX * 0.05;
        _hip[1] = rootY + rY * side - uY * 0.05;
        _hip[2] = rootZ + rZ * side - uZ * 0.05;

        let ax = this.footPos[f * 3];
        let ay = this.footPos[f * 3 + 1] + 0.09; // ankle sits above the sole
        let az = this.footPos[f * 3 + 2];

        // Never hand the solver an ankle past the leg — the same contract the
        // arms hold. A body stopped mid-air over its plants, or hips high on
        // a canyon wall above a foot still glued to its plant, used to
        // stretch the shin to span the gap; clamped onto the reach sphere,
        // the boot floats toward its target at the leg's true length. The
        // foot bone reads these same coordinates, so boot and ankle move
        // together.
        {
            const dx = ax - _hip[0], dy = ay - _hip[1], dz = az - _hip[2];
            const dl = Math.hypot(dx, dy, dz);
            const rMax = THIGH_LEN + SHIN_LEN;
            if (dl > rMax) {
                const k = rMax / dl;
                ax = _hip[0] + dx * k;
                ay = _hip[1] + dy * k;
                az = _hip[2] + dz * k;
            }
        }

        // This boot's own heading: the travel frame turned about the up axis by
        // `open`, the same rotation `composeBasis` applies to the body.
        let tFx = fX, tFy = fY, tFz = fZ;
        let tRx = uY * fZ - uZ * fY, tRy = uZ * fX - uX * fZ, tRz = uX * fY - uY * fX;
        if (open) {
            const c = Math.cos(open), s = Math.sin(open);
            const nFx = fX * c + tRx * s, nFy = fY * c + tRy * s, nFz = fZ * c + tRz * s;
            const nRx = tRx * c - fX * s, nRy = tRy * c - fY * s, nRz = tRz * c - fZ * s;
            tFx = nFx; tFy = nFy; tFz = nFz;
            tRx = nRx; tRy = nRy; tRz = nRz;
        }

        // The knee tracks out over the toes, so the pole follows the boot round
        // rather than staying square to the direction of travel. In a surf stance
        // that is the difference between two knees bent over the rail and two
        // bent along the board with the feet pointing across it.
        const outward = f === 0 ? -0.22 : 0.22;
        solveTwoBone(
            _hip[0], _hip[1], _hip[2], ax, ay, az,
            tFx + tRx * outward, tFy + tRy * outward, tFz + tRz * outward,
            THIGH_LEN, SHIN_LEN, _knee
        );

        this._setBone(
            hipB, _hip[0], _hip[1], _hip[2],
            _knee[0] - _hip[0], _knee[1] - _hip[1], _knee[2] - _hip[2],
            tFx, tFy, tFz
        );
        this._setBone(
            shinB, _knee[0], _knee[1], _knee[2],
            ax - _knee[0], ay - _knee[1], az - _knee[2],
            tFx, tFy, tFz
        );

        // The foot rolls: flat while loaded, toe-down through the swing. The
        // ground normal is folded in so a foot on a dune face lies along it.
        const w = this.footWeight[f];
        const toeDown = (1 - w) * 0.55;
        const c = Math.cos(toeDown), s = Math.sin(toeDown);
        // Rotate the boot's own forward axis down about its own right axis.
        const dx = tFx * c - uX * s, dy = tFy * c - uY * s, dz = tFz * c - uZ * s;
        this._setBone(footB, ax, ay, az, dx, dy, dz, uX, uY, uZ);
    }

    /**
     * Place the board.
     *
     * The board does not hang off the skeleton — it is driven from the surface
     * it is planing on. Its deck normal is the terrain normal banked by the same
     * lean the torso is already carrying, and its nose is the direction of
     * travel flattened into that plane, so on a dune face the board lies along
     * the face instead of sitting level in a hole.
     *
     * When the astronaut is not surfing it has to go somewhere. A bone is a
     * rigid orthonormal frame with no scale channel, so there is no way to
     * shrink the board out of frame; it is slung nose-up across the life-support
     * pack instead. The two poses are blended by `surf`, which is the same eased
     * blend the stance itself rides, so the board arrives under the feet exactly
     * as the crouch does.
     */
    _poseBoard(ch, gx, groundY, gz, chestX, chestY, chestZ, uX, uY, uZ, fX, fY, fZ) {
        const w = ch.surf;

        // ---- riding ------------------------------------------------------
        const n = this.terrain.surfaceNormalAt
            ? this.terrain.surfaceNormalAt(gx, gz, this._refY ?? 0, _gnd)
            : this.terrain.normalAt(gx, gz, _gnd);

        // Nose: the direction of travel, flattened into the surface plane.
        const noseYaw = ch.facing + (ch.trickSpin || 0);
        let nx = Math.sin(noseYaw), ny = 0, nz = Math.cos(noseYaw);
        const proj = nx * n.x + ny * n.y + nz * n.z;
        nx -= n.x * proj; ny -= n.y * proj; nz -= n.z * proj;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;

        // Bank. Right = up x nose, and rolling the up vector toward it is the
        // same sign convention `composeBasis` uses, so the deck tips into the
        // turn the body is already leaning into.
        const rx = n.y * nz - n.z * ny;
        const ry = n.z * nx - n.x * nz;
        const rz = n.x * ny - n.y * nx;
        const cb = Math.cos(this.roll), sb = Math.sin(this.roll);
        const bx = n.x * cb + rx * sb;
        const by = n.y * cb + ry * sb;
        const bz = n.z * cb + rz * sb;

        // The underside rides on the dust the board has just compressed, which
        // is `sink` below the undisturbed surface — the same depth the contact
        // system is carving the groove to.
        let rideY = groundY - this.sink + BOARD_HALF_T;
        let ridePX = gx, ridePZ = gz;

        // The front flip carries the board with the feet: the same hip pivot
        // and right axis the feet orbit in `update`, applied to the riding
        // position and both riding axes. See the flip note there.
        const flip = ch.trickFlip || 0;
        if (flip > 0.0005) {
            const ca = Math.cos(flip), sa = Math.sin(flip);
            const spinYaw = ch.facing + (ch.trickSpin || 0);
            const ax = Math.cos(spinYaw), az = -Math.sin(spinYaw);
            const pivotY = groundY - this.sink + this.hipY + this.bob;
            const dy = rideY - pivotY;
            ridePX = gx - az * dy * sa;
            rideY = pivotY + dy * ca;
            ridePZ = gz + ax * dy * sa;
            const rot = (vx, vy, vz, out) => {
                const ad = ax * vx + az * vz;
                out[0] = vx * ca + (-az * vy) * sa + ax * ad * (1 - ca);
                out[1] = vy * ca + (az * vx - ax * vz) * sa;
                out[2] = vz * ca + (ax * vy) * sa + az * ad * (1 - ca);
            };
            rot(nx, ny, nz, _flipV);
            nx = _flipV[0]; ny = _flipV[1]; nz = _flipV[2];
            rot(bx, by, bz, _flipV);
        }
        const fbx = flip > 0.0005 ? _flipV[0] : bx;
        const fby = flip > 0.0005 ? _flipV[1] : by;
        const fbz = flip > 0.0005 ? _flipV[2] : bz;

        // ---- slung on the pack -------------------------------------------
        // Nose up and tilted twenty degrees back, deck facing outward. Both
        // axes are combinations of the chest's own orthonormal up and forward,
        // so the pair stays orthonormal for free.
        const sNx = uX * 0.94 - fX * 0.34;
        const sNy = uY * 0.94 - fY * 0.34;
        const sNz = uZ * 0.94 - fZ * 0.34;
        const sUx = -(uX * 0.34 + fX * 0.94);
        const sUy = -(uY * 0.34 + fY * 0.94);
        const sUz = -(uZ * 0.34 + fZ * 0.94);
        const sPx = chestX - fX * 0.42 + uX * 0.10;
        const sPy = chestY - fY * 0.42 + uY * 0.10;
        const sPz = chestZ - fZ * 0.42 + uZ * 0.10;

        // Lerped, then handed to `setFrameFromDir`, which re-normalises the
        // direction and re-orthogonalises the reference against it — so an
        // interpolated pair does not have to be orthonormal on the way through.
        //
        // The one thing it does have to avoid is antiparallel endpoints, which
        // would collapse to a zero-length axis half way along the blend. The two
        // attitudes are about a hundred and ten degrees apart, and swept over
        // every facing, pitch, carve and slope the shortest interpolated axis
        // comes to 0.26 — far above the degenerate case. Re-check that if the
        // stowed attitude is ever retuned toward the direction of travel.
        this._setBone(
            B_BOARD,
            sPx + (ridePX - sPx) * w,
            sPy + (rideY - sPy) * w,
            sPz + (ridePZ - sPz) * w,
            sNx + (nx - sNx) * w, sNy + (ny - sNy) * w, sNz + (nz - sNz) * w,
            sUx + (fbx - sUx) * w, sUy + (fby - sUy) * w, sUz + (fbz - sUz) * w
        );
    }

    /**
     * Arms. Counter-swing against the legs while walking, and a wide, low
     * bending stance while surfing — hands out and forward, which is what a
     * person does at twenty metres a second whether or not there is a board
     * under them.
     */
    _poseArms(h, ch, cx, cy, cz, rX, rY, rZ, uX, uY, uZ, fX, fY, fZ) {
        const surf = ch.surf;
        const run = Math.min(1, ch.speed / 5.4);
        const swing = Math.sin(2 * Math.PI * ch.gaitPhase) * (0.20 + 0.42 * run) * (1 - surf);
        // Slow idle drift so a standing figure is never perfectly still.
        const idle = Math.sin(this._t * 0.9) * 0.02 + Math.sin(this._t * 1.7 + 1.3) * 0.012;

        for (let a = 0; a < 2; a++) {
            const sgn = a === 0 ? -1 : 1;
            const upperB = a === 0 ? B_UPPER_L : B_UPPER_R;
            const foreB = a === 0 ? B_FORE_L : B_FORE_R;
            const handB = a === 0 ? B_HAND_L : B_HAND_R;

            // Shoulder, on the chest frame.
            _sh[0] = cx + rX * (sgn * 0.185) + uX * 0.14;
            _sh[1] = cy + rY * (sgn * 0.185) + uY * 0.14;
            _sh[2] = cz + rZ * (sgn * 0.185) + uZ * 0.14;

            // ---- walk target: hand swings fore and aft below the hip --------
            //
            // Every offset here is kept comfortably inside the arm's 0.54 m
            // reach. Put the target at or past full extension and the IK solver
            // does exactly what it is told — locks the elbow — and the figure
            // walks around with two straight poles for arms.
            const sw = swing * -sgn;
            let tx = _sh[0] + fX * (sw * 0.38) - uX * 0.43 + rX * (sgn * 0.11);
            let ty = _sh[1] + fY * (sw * 0.38) - uY * 0.43 + rY * (sgn * 0.11);
            let tz = _sh[2] + fZ * (sw * 0.38) - uZ * 0.43 + rZ * (sgn * 0.11);
            ty += idle * sgn;

            // ---- cast target: both hands up and out along the aim -----------
            //
            // A wide base, the leading hand extended along the aim and the
            // trailing hand drawn back across the body, so the arms describe the
            // arc the cast is about to take. The right hand leads because that
            // is the hand the ribbon is emitted from.
            //
            // Blended, not switched, and it composes with the walk swing rather
            // than replacing it — a character casting while walking still walks.
            const cast = ch.cast;
            if (cast > 0.001) {
                const ax = ch.castAimX, ay = ch.castAimY, az = ch.castAimZ;
                // Each power gets its own gesture — see CAST_STYLES. The
                // leading hand is the right one, because that is the hand
                // the ribbon is emitted from.
                const st = CAST_STYLES[((ch.castStyle || 2) - 1) | 0]
                    || CAST_STYLES[1];
                const lead = a === 1 ? 1 : 0;
                const outward = lead ? st.lo : st.to;
                const along = lead ? st.la : st.ta;
                const lift = lead ? st.ll : st.tl;
                const cx = _sh[0] + rX * (sgn * 0.30 + outward * sgn) + ax * along + uX * lift;
                const cy = _sh[1] + rY * (sgn * 0.30) + ay * along + uY * lift + lift * 0.6;
                const cz = _sh[2] + rZ * (sgn * 0.30 + outward * sgn) + az * along + uZ * lift;
                tx += (cx - tx) * cast;
                ty += (cy - ty) * cast;
                tz += (cz - tz) * cast;
            }

            // ---- surf target: out, forward and a little down ----------------
            if (surf > 0.001) {
                const carve = ch.carve;
                // Trailing arm rises, leading arm drops into the turn — the
                // same asymmetry anyone riding a rail holds through a carve.
                const rise = 0.02 + carve * sgn * 0.22;
                const sx = _sh[0] + rX * (sgn * 0.33) + fX * 0.24 + uX * rise;
                const sy = _sh[1] + rY * (sgn * 0.33) + fY * 0.24 + uY * rise;
                const sz = _sh[2] + rZ * (sgn * 0.33) + fZ * 0.24 + uZ * rise;
                tx += (sx - tx) * surf;
                ty += (sy - ty) * surf;
                tz += (sz - tz) * surf;
            }

            // Never hand the solver a target past the arm. The IK clamps the
            // *elbow* against an unreachable target, but the forearm is then
            // drawn elbow-to-target and the hand planted on it, so the arm
            // stretches to whatever length reaches — the asteroid gesture's
            // sky-reach sat over a metre from the shoulder against 0.54 m of
            // arm, and hyper-extended exactly like that. Pulling the target
            // onto the reach sphere keeps the gesture's *direction* while the
            // arm keeps its length.
            {
                const dx = tx - _sh[0], dy = ty - _sh[1], dz = tz - _sh[2];
                const dl = Math.hypot(dx, dy, dz);
                const rMax = (UPPER_LEN + FORE_LEN) * 0.97;
                if (dl > rMax) {
                    const ck = rMax / dl;
                    tx = _sh[0] + dx * ck;
                    ty = _sh[1] + dy * ck;
                    tz = _sh[2] + dz * ck;
                }
            }

            // Elbows point back and out.
            const px = -fX + rX * (sgn * 0.55), py = -fY + rY * (sgn * 0.55) - 0.35, pz = -fZ + rZ * (sgn * 0.55);
            solveTwoBone(
                _sh[0], _sh[1], _sh[2], tx, ty, tz, px, py, pz,
                UPPER_LEN, FORE_LEN, _p
            );

            this._setBone(
                upperB, _sh[0], _sh[1], _sh[2],
                _p[0] - _sh[0], _p[1] - _sh[1], _p[2] - _sh[2],
                fX, fY, fZ
            );
            this._setBone(
                foreB, _p[0], _p[1], _p[2],
                tx - _p[0], ty - _p[1], tz - _p[2],
                fX, fY, fZ
            );
            // The hand continues the forearm, rolled palm-inward.
            let hx = tx - _p[0], hy = ty - _p[1], hz = tz - _p[2];
            const hl = Math.hypot(hx, hy, hz) || 1;
            hx /= hl; hy /= hl; hz /= hl;
            this._setBone(handB, tx, ty, tz, hx, hy, hz, fX, fY, fZ);
        }
    }

    /** World position of a hand, for spell emitters. Writes 3 floats to `out`. */
    handPosition(which, out, od) {
        const b = which === 0 ? B_HAND_L : B_HAND_R;
        xformPoint(this.world, b * 16, 0, 0.09, 0, out, od);
    }
}

export { HIP_HEIGHT };
