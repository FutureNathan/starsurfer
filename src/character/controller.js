/**
 * Character locomotion + board physics.
 *
 * This owns motion only — the rig, the board, the soft goods and the contact
 * brushes all read the state this produces. Two modes share one integrator:
 *
 *  - WALK: camera-relative desired velocity, eased facing, distance-driven gait
 *    phase so footfalls land where the feet actually are (no sliding).
 *  - SURF: momentum-carrying. Thrust along facing, steering from mouse yaw,
 *    strong lateral grip that bleeds into a drift as you push the carve, and
 *    slope-driven acceleration so dropping down a dune face feels like a gain.
 *
 * Blending between them is eased in both directions; there is no snap.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scalar } from "@babylonjs/core/Maths/math.scalar";
import { input } from "../core/input.js";
import { expDamp } from "../core/camera.js";

const _wish = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();
const _tmp = new Vector3();

const WALK_SPEED = 2.5;
const RUN_SPEED = 5.4;
const WALK_ACCEL = 26;
const WALK_DECEL = 30;

const SURF_MAX = 19.5;
const SURF_THRUST = 11.0;
/**
 * Sets the flat-ground cruise, and it went up sevenfold on purpose. At 0.42
 * the drag equilibrium on level ground sat past 30 m/s, so the 19.5 cap was
 * doing all the work and flat ground hit the identical top speed as a
 * forty-degree descent — which erased the entire reason to read the terrain.
 * At 2.8 the numbers give the ride a gradient: about 13.5 m/s cruising flat,
 * 17-18 down a gentle slope, and the cap only reachable on a genuinely steep
 * face. Downhill is now *earned*, and feels like something happening.
 */
const SURF_DRAG = 2.8;
const SURF_TURN = 2.35; // rad/s at full steer
const SURF_GRIP = 7.5;

/** Gait: metres of travel per full stride cycle, scaled by speed. */
const STRIDE_BASE = 1.55;

/**
 * The trick jump's launch speed and its gravity, m/s and m/s².
 *
 * Deliberately not the moon's 1.62 — at lunar gravity this pop would hang
 * for over five seconds, which is a cutscene, not a trick. 6.8 with a 4.3
 * launch gives about a metre and a half of air for a second and a quarter:
 * long enough to read the spin, short enough to stay a rhythm element
 * between carves.
 */
const JUMP_V = 4.3;
const AIR_G = 6.8;

/**
 * The jetpack: double-tap the Delete key and hold. The thrust axis is the
 * *body* axis and the body follows the aim — see the flight branch — so the
 * one speed here is simply how fast he goes wherever the helmet points.
 * Letting go hands straight back to the ordinary ballistic fall and
 * landing. No fuel — the hold is the limit.
 */
const JET_FLY = 17;
const JET_CEIL = 36;
/** Seconds between the two taps that arm it. */
const JET_TAP = 0.45;

export class CharacterController {
    /**
     * @param {{ heightAt(x:number,z:number):number, normalAt(x:number,z:number,out:Vector3):Vector3 }} terrain
     */
    constructor(terrain) {
        this.terrain = terrain;

        this.position = new Vector3(0, 0, 0);
        this.velocity = new Vector3(0, 0, 0);
        this.prevVelocity = new Vector3(0, 0, 0);
        this.acceleration = new Vector3(0, 0, 0);

        this.facing = 0; // yaw, radians
        this.speed = 0;
        this.speed01 = 0; // normalised against SURF_MAX, for FOV/wind

        /** 0 = walking, 1 = fully surfing. Eased. */
        this.surf = 0;
        this.surfActive = false;

        /**
         * 0 = not casting, 1 = fully in the bending stance. Written by the spell
         * system, read by the figure.
         *
         * It lives here rather than on the spell system because the figure
         * already reads the controller for everything else it poses from, and a
         * second source of "what is this character doing" is how the arms and the
         * legs end up disagreeing about which frame it is.
         */
        this.cast = 0;
        /** 1..5 — which power the current gesture belongs to. */
        this.castStyle = 2;
        this.castAimX = 0;
        this.castAimY = 0;
        this.castAimZ = 1;

        /** Signed lean, -1..1 (right positive), from lateral acceleration. */
        this.lean = 0;
        /** Signed carve amount for wake shaping. Positive = turning right. */
        this.carve = 0;
        /**
         * 0..1, how hard the screen-space speed streaks should read. Deadbanded
         * well above walking pace: streaks at a jog make the demo feel cheap.
         */
        this.streak01 = 0;

        // ------------------------------------------------------------- gait
        this.gaitPhase = 0;
        /**
         * True when the legs should be running a gait at all.
         *
         * One flag, read by the figure and by the contact system, because three
         * copies of "is this character walking" is three chances for the feet to
         * disagree with the footprints.
         */
        this.stepping = true;
        /** Set true for exactly one frame when a foot plants. */
        this.footfall = false;
        /** 0 = left foot, 1 = right foot — which foot just planted. */
        this.footIndex = 0;
        /** World position of the foot that just planted. */
        this.footPos = new Vector3();
        /** Impact strength 0..1, scales spray and deformation depth. */
        this.footImpact = 0;

        this.groundY = 0;
        this.groundNormal = new Vector3(0, 1, 0);

        this._prevSpeed = 0;

        /**
         * The trick jump. Shift on a moving board pops it off the ground;
         * on foot the same key stays sprint, so nothing anyone has learned
         * changes. While airborne the ground forces are simply absent — no
         * thrust, no scrub, no grip — which is both the physics and the
         * feel: a jump is a commitment.
         */
        this.airborne = false;
        this.vy = 0;
        this.airTime = 0;
        /** Flying on the pack — see the JET_* constants. */
        this.jetting = false;
        /** Falling after the pack cut out — thrusters still brake the drop. */
        this.jetFall = false;
        /** Body-axis pitch off vertical while flying; the figure wears it. */
        this.jetPitch = 0;
        /** 1 at a hard flight touchdown, decaying: the three-point landing. */
        this.heroLand = 0;
        this._jetArm = false;
        this._jetTapAt = -9;
        this._prevJetKey = false;
        this._clock = 0;
        /** Visual-only spin the figure adds to its stance during the trick. */
        this.trickSpin = 0;
        /**
         * Visual-only front-flip angle, radians. A second Shift inside the
         * first half of the arc converts the spin into a flip — double-tap
         * is the bigger trick, and it buys a little extra pop to fit the
         * rotation in.
         */
        this.trickFlip = 0;
        this._flip = false;
        this._flipT0 = 0;
        /** 0..1 through the arc — drives the crouch-and-grab tuck. */
        this.airTuck = 0;
        /** One-frame flag on touchdown, with the impact speed for feedback. */
        this.landed = false;
        this.landVy = 0;
        this._prevSprint = false;
    }

    /**
     * @param {number} dt
     * @param {import("../core/camera.js").CameraRig} rig
     */
    update(dt, rig) {
        const h = Math.min(dt, 1 / 30);
        this._clock += h;

        this.prevVelocity.copyFrom(this.velocity);
        this.surfActive = input.surf;

        // Ease the surf blend — entering and exiting are transitions, not switches.
        this.surf = expDamp(this.surf, this.surfActive ? 1 : 0, this.surfActive ? 2.6 : 3.4, h);

        rig.getFlatForward(_fwd);
        rig.getFlatRight(_right);

        // ---- the jetpack gesture: double-tap Delete, hold to fly ----------
        const jk = input.jetKey;
        if (jk && !this._prevJetKey) {
            if (this._clock - this._jetTapAt < JET_TAP) this._jetArm = true;
            this._jetTapAt = this._clock;
        }
        if (!jk) this._jetArm = false;
        this._prevJetKey = jk;
        const wantJet = this._jetArm && jk;
        if (wantJet && !this.jetting) {
            this.jetting = true;
            this.airborne = true;
            this.trickSpin = 0;
            this.trickFlip = 0;
            this._flip = false;
            this._jetT = 0;
            // Takeoff is always straight up; the glide takes it from there.
            this._jetPhi = Math.PI / 2;
            if (this.vy < 0) this.vy = 0;
        } else if (!wantJet && this.jetting) {
            this.jetting = false;
            this.jetFall = true;
            // Hand over to the ballistic branch with the trick timeline
            // already spent, so letting go does not replay a jump's spin.
            this.airTime = (2 * JUMP_V) / AIR_G;
            this.airTuck = 0;
        }
        this.heroLand = Math.max(0, this.heroLand - h / 1.6);

        // Neither step runs in the air. The walk step used to run through a
        // jet-release fall, and its idle deceleration scrubbed the flight's
        // momentum mid-air — an invisible air brake, in a vacuum. Ballistic
        // means ballistic: the velocity you cut thrust with is the velocity
        // you arrive with.
        if (this.surf > 0.5 && !this.airborne) this._surfStep(h, rig);
        else if (this.surf <= 0.5 && !this.jetting && !this.airborne) {
            this._walkStep(h);
        }

        // ---------------------------------------------------- integrate + snap
        this.position.x += this.velocity.x * h;
        this.position.z += this.velocity.z * h;

        this.groundY = this._ground(this.position.x, this.position.z);
        if (this.terrain.surfaceNormalAt) {
            this.terrain.surfaceNormalAt(
                this.position.x, this.position.z, this.position.y,
                this.groundNormal
            );
        } else {
            this.terrain.normalAt(this.position.x, this.position.z, this.groundNormal);
        }

        this.landed = false;
        const sprintEdge = input.sprint && !this._prevSprint;
        this._prevSprint = input.sprint;

        if (!this.airborne) {
            // Snap with a little softness so micro-ripples don't jitter the rig.
            this.position.y = expDamp(this.position.y, this.groundY, 26, h);

            if (sprintEdge && this.surf > 0.5 && this.speed > 4) {
                this.airborne = true;
                this.vy = JUMP_V;
                this.airTime = 0;
                this._flip = false;
                this.trickFlip = 0;
            }
        } else if (this.jetting) {
            // Iron Man flight. The thrust axis IS the body axis, and the
            // body follows the camera's pitch, doubled: look level or up
            // and he stands on the flame — a straight figure going straight
            // up, fast. Drop the aim and the whole body pitches over with
            // it: about forty-five degrees of look-down is level cruise in
            // the full prone pose, head leading; straight down is a hard
            // dive. He always flies where the top of the helmet points,
            // which is what makes the lean *be* the steering rather than
            // decoration on it.
            const f = rig.forward;
            const theta = f ? Math.asin(Scalar.Clamp(f.y, -1, 1)) : 0;
            // The camera-pitch → flight-elevation map, in three bands tuned
            // for what the *rider* can see. Near level or up climbs; a
            // comfortable ~14 degrees of look-down — horizon and rider both
            // in frame — is full level cruise; steeper is the dive. Each
            // band rides a hermite ease, so the response flattens out at
            // the edges instead of cornering — and the result is *glided*
            // in time below, so climb-to-cruise is a bank, not a switch.
            const t2 = theta + 0.05;
            let phiT;
            if (t2 >= 0) {
                phiT = Math.PI / 2;
            } else if (t2 >= -0.20) {
                const s = -t2 / 0.20;
                phiT = (Math.PI / 2) * (1 - s * s * (3 - 2 * s));
            } else {
                const s = Math.min(1, (-t2 - 0.20) / 1.15);
                phiT = -(Math.PI / 2) * (s * s * (3 - 2 * s));
            }
            this._jetPhi += (phiT - this._jetPhi) * Math.min(1, 5 * h);
            const phi = this._jetPhi;
            const yaw = f ? Math.atan2(f.x, f.z) : this.facing;
            const cph = Math.cos(phi);
            let dy = Math.sin(phi);
            const dx = Math.sin(yaw) * cph;
            const dz = Math.cos(yaw) * cph;
            const lift = this.position.y - this.groundY;
            if (lift >= JET_CEIL && dy > 0) dy = 0;

            const k = Math.min(1, 3.0 * h);
            this.velocity.x += (dx * JET_FLY - this.velocity.x) * k;
            this.velocity.z += (dz * JET_FLY - this.velocity.z) * k;
            this.vy += (dy * JET_FLY - this.vy) * k;
            // At the ceiling the climb bleeds off hard, not on the cruise
            // ease — seventeen up-metres a second of momentum would coast
            // sixteen metres past the lid on the gentle ramp alone.
            if (lift >= JET_CEIL && this.vy > 0) {
                this.vy += (0 - this.vy) * Math.min(1, 9 * h);
            }
            this.position.y += this.vy * h;
            this.airTuck = 0;
            this.facing = angleDamp(this.facing, yaw, 8, h);
            // Published for the figure: the body axis's forward pitch off
            // vertical this frame — 0 upright, pi/2 prone, past it diving.
            this.jetPitch = Math.PI / 2 - phi;
            this._jetT += h;
            // Touching the ground ends the flight, full stop: the landing
            // plants the three-point pose and the pack wants a fresh
            // double-tap before it lights again. The alternative — staying
            // "in flight" while pinned to the surface — read as a man being
            // dragged along the ground, which is the opposite of flying.
            // The first third of a second is exempt so takeoff can leave.
            if (this.position.y <= this.groundY && this._jetT > 0.35) {
                this.position.y = this.groundY;
                this.jetting = false;
                this.jetFall = false;
                this._jetArm = false;
                this.airborne = false;
                this.landed = true;
                this.landVy = Math.max(2, -this.vy);
                this.vy = 0;
                this.airTime = 0;
                // The trigger decides the arrival. Held: the board is
                // already out under the feet and the cruise momentum rides
                // straight into a surf run — flying-to-surfing in one
                // motion. Not held: the three-point landing.
                if (this.surf > 0.5) {
                    rig.addTrauma(0.07);
                } else {
                    this.heroLand = 1;
                    rig.addTrauma(0.12);
                }
            } else if (this.position.y < this.groundY) {
                this.position.y = this.groundY;
            }
        } else {
            this.airTime += h;
            this.vy -= AIR_G * h;
            // After flight the pack keeps braking the drop — a controlled
            // descent that arrives hard enough to land like it means it,
            // never the flailing plummet of a thirty-metre fall.
            if (this.jetFall && this.vy < -11) this.vy = -11;
            this.position.y += this.vy * h;

            // The second tap, early in the arc: convert to a front flip.
            if (sprintEdge && !this._flip && this.airTime < 0.5) {
                this._flip = true;
                this._flipT0 = this.airTime;
                this.vy += 0.7;
            }

            // The trick: one full eased rotation across the expected hang,
            // and a tuck that peaks at the apex. Both are *visual* — the
            // figure spins or flips its stance and pulls its knees, the
            // velocity never hears about it, so the landing carries on.
            const T = (2 * JUMP_V) / AIR_G;
            const p = Math.min(1, this.airTime / T);
            if (this._flip) {
                // The started spin eases back out while the flip takes over —
                // two full rotations on two axes at once is a crash, not a
                // trick.
                this.trickSpin += (0 - this.trickSpin) * Math.min(1, 9 * h);
                const q = Math.min(
                    1,
                    (this.airTime - this._flipT0) / (T + 0.18 - this._flipT0)
                );
                this.trickFlip = Math.PI * 2 * (q * q * (3 - 2 * q));
            } else {
                this.trickSpin = Math.PI * 2 * (p * p * (3 - 2 * p));
            }
            this.airTuck = Math.sin(Math.PI * p);

            if (this.vy < 0 && this.position.y <= this.groundY) {
                this.position.y = this.groundY;
                this.airborne = false;
                this.landed = true;
                this.landVy = -this.vy;
                if (this.jetFall) {
                    // The superhero arrival — unless the trigger is held,
                    // in which case the board is out and the touchdown is
                    // just the start of the next run.
                    if (this.surf <= 0.5) this.heroLand = 1;
                    this.jetFall = false;
                }
                this.trickSpin = 0;
                this.trickFlip = 0;
                this._flip = false;
                this.airTuck = 0;
                rig.addTrauma(0.05 + Math.min(0.12, this.landVy * 0.02));
            }
        }

        // --------------------------------------------------------- bookkeeping
        this.speed = Math.hypot(this.velocity.x, this.velocity.z);
        this.speed01 = Scalar.Clamp(this.speed / SURF_MAX, 0, 1);

        this.acceleration.x = (this.velocity.x - this.prevVelocity.x) / h;
        this.acceleration.z = (this.velocity.z - this.prevVelocity.z) / h;

        // Lateral acceleration → lean. Project accel onto the character's right.
        const rx = Math.cos(this.facing);
        const rz = -Math.sin(this.facing);
        const latAcc = this.acceleration.x * rx + this.acceleration.z * rz;
        const leanWant = Scalar.Clamp(latAcc / 26, -1, 1) * (0.35 + 0.65 * this.surf);
        this.lean = expDamp(this.lean, leanWant, 6.5, h);
        this.carve = expDamp(this.carve, leanWant, 9, h);

        this.streak01 = this.surf * Scalar.Clamp((this.speed - 7) / 11, 0, 1);

        this._gait(h);
    }

    /**
     * The surface under (x, z): the bake, or a tube roof when riding one.
     * Falls back to the plain heightfield when the terrain has no overhead
     * surfaces registered (tests, and the moment before the arches build).
     */
    _ground(x, z) {
        const t = this.terrain;
        return t.surfaceAt
            ? t.surfaceAt(x, z, this.position.y)
            : t.heightAt(x, z);
    }

    _walkStep(h) {
        // Speed scales with how far the stick is pushed, not just its direction.
        // A keyboard always pushes to the edge of the unit disc, so this is a no-op
        // there; on a thumbstick it is the difference between a control that can
        // place you and one that only has a top speed. The whole point of walking
        // in this scene is to turn round and line up a run, and that needs a low
        // gear.
        const throttle = Math.min(1, Math.hypot(input.moveX, input.moveZ));
        // The landing pose is planted: while it holds, walking is nearly
        // pinned, releasing as the figure rises. A hero landing you can
        // stroll straight out of reads as a stumble, not an arrival.
        const heroK = 1 - 0.85 * Math.min(1, this.heroLand);
        const maxSpeed = (input.sprint ? RUN_SPEED : WALK_SPEED) * throttle * heroK;

        _wish.set(
            _fwd.x * input.moveZ + _right.x * input.moveX,
            0,
            _fwd.z * input.moveZ + _right.z * input.moveX
        );

        const wishLen = Math.hypot(_wish.x, _wish.z);
        if (wishLen > 0.001) {
            _wish.x = (_wish.x / wishLen) * maxSpeed;
            _wish.z = (_wish.z / wishLen) * maxSpeed;

            const a = WALK_ACCEL * h;
            this.velocity.x += Scalar.Clamp(_wish.x - this.velocity.x, -a, a);
            this.velocity.z += Scalar.Clamp(_wish.z - this.velocity.z, -a, a);

            // Face the direction of travel, eased.
            const want = Math.atan2(_wish.x, _wish.z);
            this.facing = angleDamp(this.facing, want, 11, h);
        } else {
            const d = WALK_DECEL * h;
            const s = Math.hypot(this.velocity.x, this.velocity.z);
            if (s > 0.0001) {
                const k = Math.max(0, s - d) / s;
                this.velocity.x *= k;
                this.velocity.z *= k;
            }
        }
    }

    _surfStep(h, rig) {
        // Steer toward the heading the stick is *pointing*, falling back to the
        // camera's own yaw when it is not being pushed.
        //
        // The version that only read `moveX` could not come about. Its steer was a
        // lateral nudge plus a pull toward the camera yaw, so reversing direction
        // meant swinging the camera through 180 degrees and waiting — which is
        // awkward with a mouse and very nearly impossible with a thumb, because on
        // a touchscreen the look pad and the stick are different hands and the
        // board straightens itself the moment you let go of one.
        //
        // Reading the stick as a heading makes a full turn one gesture: hold the
        // stick where you want to end up and the board carves round to it. It is
        // still a carve rather than a pivot — `SURF_TURN` caps the rate, so coming
        // about at speed takes a wide arc and scrubs speed doing it, which is what
        // a board does.
        _wish.set(
            _fwd.x * input.moveZ + _right.x * input.moveX,
            0,
            _fwd.z * input.moveZ + _right.z * input.moveX
        );
        const wishLen = Math.hypot(_wish.x, _wish.z);
        const want = wishLen > 0.15 ? Math.atan2(_wish.x, _wish.z) : rig.yaw;
        const steer = Scalar.Clamp(angleDelta(this.facing, want) * 1.9, -1, 1);
        this.facing += steer * SURF_TURN * h;

        // Camera shake, and only from the one thing that earns it: an edge
        // loaded up at speed. Added as a rate rather than as an impulse, so it
        // reaches an equilibrium against the rig's own decay — hard carve at top
        // speed settles around 0.4 trauma, which is a couple of centimetres of
        // rig movement. Anything you can consciously see here is too much.
        const load = Math.abs(steer) * (this.speed / SURF_MAX);
        if (load > 0.25) rig.addTrauma((load - 0.25) * 1.35 * h);

        const fx = Math.sin(this.facing);
        const fz = Math.cos(this.facing);

        // Slope: heading downhill adds speed, uphill scrubs it.
        //
        // Three things about this term, each of them a stall that got reported
        // as "he gets caught sometimes".
        //
        // First, the sign. The old expression read the surface normal and
        // negated its dot with the facing — and the normal *leans away from*
        // the rise, so the negation put the boost on the uphill face and the
        // brake on the downhill one. Gravity, backwards: the board died
        // descending into every crater bowl (thrust clamps to zero past a
        // ~25 degree downgrade... which is exactly where a surfer expects to
        // *gain*) and rocketed up the far wall. The regression test asserted
        // no-reverse and printed top speed without judging it, so "19.4 m/s
        // straight up a 45-degree wall" sat in the output as a pass.
        //
        // Second, the sample. A point normal reads the 3.6 m bowls' rims at
        // full strength; the board is 2.2 m long and bridges them. The grade
        // is now the height difference across a board-length-and-a-bit along
        // the direction of travel, which is what the hull actually experiences.
        //
        // Third, momentum. A crest costs full price from a standstill but a
        // third of it at speed — a moving board *carries* through a short
        // rise rather than being priced per-frame as if it were parked on it.
        const hAhead = this._ground(
            this.position.x + fx * 2.6, this.position.z + fz * 2.6
        );
        const hBehind = this._ground(
            this.position.x - fx * 2.6, this.position.z - fz * 2.6
        );
        const grade = (hAhead - hBehind) / 5.2;
        const vs0 = Math.hypot(this.velocity.x, this.velocity.z);
        let slopeAssist = -grade * 26;
        let wall = 0;
        if (slopeAssist < 0) {
            // Momentum carries the board through a rise — but not up a wall.
            // Past roughly twenty-eight degrees of upgrade the carry fades
            // back to full price, and the thrust floor below lets go with it:
            // a steep canyon wall can be dropped into but not ridden up. The
            // board stalls a few metres in, and the way out is the way a
            // board actually takes — come about and go back down.
            wall = Scalar.Clamp((grade - 0.52) / 0.22, 0, 1);
            const carry = 0.35 + 0.65 * Math.exp(-vs0 / 7);
            slopeAssist *= carry + (1 - carry) * wall;
        }

        // Carving away from where you are already going scrubs speed — the harder
        // the board is turned across its own momentum, the more of it goes into
        // throwing mass instead of into travel. Keyed to the angle between the
        // heading and the velocity rather than to a single input axis, so it is
        // true whichever direction you asked for.
        //
        // Applied *against the velocity*, and that is a correctness fix rather
        // than a preference. It used to be subtracted straight out of `thrust`,
        // which quietly turned a brake into a reverse gear: at a full come-about
        // the scrub is 16 and the thrust 11, so the sum went to -21 — a force
        // pointing out of the tail — and since the grip below only removes
        // *sideways* velocity, nothing took the resulting backwards component
        // away again. Align then sat at -1, which kept the scrub at maximum,
        // which kept the thrust negative. That is a stable equilibrium, and it is
        // exactly the bug where the board occasionally gets caught and rides off
        // tail-first with the astronaut facing the other way.
        const vs = Math.hypot(this.velocity.x, this.velocity.z);
        if (vs > 1.0) {
            const align = (this.velocity.x * fx + this.velocity.z * fz) / vs;
            const scrub = 16 * Scalar.Clamp(1.0 - align, 0, 1);
            // The scrub brakes, it does not park: speed is floored at
            // steerage-way, so the hardest come-about leaves the board
            // creeping through the turn instead of pinned at zero waiting
            // for thrust to win an argument with drag.
            const k = Math.max(Math.min(vs, 1.2), vs - scrub * h) / vs;
            this.velocity.x *= k;
            this.velocity.z *= k;
        }

        // Thrust, which can only ever push forward — and never quite dies.
        // The floor is what removes the parked-facing-uphill stall: with the
        // surf held the board always inches ahead, the momentum carry above
        // then cheapens the grade, and the two together walk it out of any
        // hollow. It cannot drive the board backwards — the floor is along
        // the facing, and the reverse guard below strips anything that is not.
        const thrust = Math.max(1.5 * (1 - wall), SURF_THRUST + slopeAssist);
        this.velocity.x += fx * thrust * h;
        this.velocity.z += fz * thrust * h;

        // Lateral grip: kill sideways velocity, but not entirely — the residual
        // is what reads as a drift when you overcook the turn.
        const rx = Math.cos(this.facing);
        const rz = -Math.sin(this.facing);
        const lat = this.velocity.x * rx + this.velocity.z * rz;
        const grip = Math.min(1, SURF_GRIP * h);
        this.velocity.x -= rx * lat * grip;
        this.velocity.z -= rz * lat * grip;

        // And a board does not travel tail-first. The fin and the rails make it
        // physically impossible, and the pose here assumes it too — the rider is
        // standing across the deck looking at the nose, so any reverse component
        // draws an astronaut being pulled along backwards by their own board.
        //
        // A hard constraint rather than a strong damping, for the same reason the
        // planted foot is a hard constraint: "cannot happen" is a much easier
        // thing to reason about than "is usually pulled back within a few frames",
        // and there is no state in which a fraction of a reverse component is
        // wanted. In practice it removes almost nothing, because the lateral grip
        // has already eaten the velocity by the time the heading passes ninety
        // degrees off it — it is the guarantee that matters, not the magnitude.
        const along = this.velocity.x * fx + this.velocity.z * fz;
        if (along < 0) {
            this.velocity.x -= fx * along;
            this.velocity.z -= fz * along;
        }

        // Quadratic drag → a natural terminal speed.
        const s = Math.hypot(this.velocity.x, this.velocity.z);
        if (s > 0.0001) {
            const drag = SURF_DRAG * s * s * 0.02 + 0.9;
            const k = Math.max(0, s - drag * h) / s;
            this.velocity.x *= k;
            this.velocity.z *= k;
        }
        if (s > SURF_MAX) {
            const k = SURF_MAX / s;
            this.velocity.x *= k;
            this.velocity.z *= k;
        }
    }

    /**
     * Distance-driven gait. Phase advances with ground travelled, not with time,
     * which is what keeps feet planted instead of sliding.
     */
    _gait(h) {
        this.footfall = false;

        // Feet stay on the board while surfing — and for the run-out afterwards.
        //
        // The surf blend eases to zero in a fifth of a second, but the momentum
        // takes two thirds of one to bleed off, and in between the character is
        // travelling at nineteen metres a second. The gait is distance-driven, so
        // it answered that with a twelve-hertz cadence and the legs blurred. A
        // sprint is the fastest thing anyone walks at; above it, glide.
        this.stepping = this.surf <= 0.5 && this.speed <= RUN_SPEED * 1.2;
        if (!this.stepping) {
            this.gaitPhase = 0;
            return;
        }

        const dist = this.speed * h;
        const stride = STRIDE_BASE * (0.72 + 0.28 * Math.min(1, this.speed / RUN_SPEED));
        const prev = this.gaitPhase;
        this.gaitPhase = (this.gaitPhase + dist / stride) % 1;

        if (this.speed < 0.15) return;

        // Two plants per cycle, at phase 0.0 and 0.5.
        const crossed =
            (prev < 0.5 && this.gaitPhase >= 0.5) || this.gaitPhase < prev;
        if (!crossed) return;

        this.footfall = true;
        this.footIndex = this.gaitPhase < 0.5 ? 0 : 1;
        this.footImpact = Scalar.Clamp(0.35 + this.speed / RUN_SPEED, 0, 1.3);

        // Offset the plant to the correct side of the body.
        const side = this.footIndex === 0 ? -0.17 : 0.17;
        const rx = Math.cos(this.facing);
        const rz = -Math.sin(this.facing);
        this.footPos.set(
            this.position.x + rx * side,
            this.position.y,
            this.position.z + rz * side
        );
    }
}

// ------------------------------------------------------------------ helpers

/** Shortest signed delta from a to b, wrapped to [-PI, PI]. */
export function angleDelta(a, b) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
}

/** Framerate-independent easing across the shortest arc. */
export function angleDamp(cur, target, rate, dt) {
    return cur + angleDelta(cur, target) * (1 - Math.exp(-rate * dt));
}
