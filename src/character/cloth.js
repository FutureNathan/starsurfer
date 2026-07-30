/**
 * Soft-goods simulation — verlet cloth on coarse grids.
 *
 * Each panel is a closed tube of particles, `cols` around by `rows` down.
 * The grids are deliberately coarse (ten by eight for a sleeve) because the
 * render mesh does not use them directly: the vertex shader reconstructs a
 * smooth surface from them with Catmull-Rom, so tessellation and simulation cost
 * are completely decoupled. Doubling the visible smoothness costs nothing here.
 *
 * Every particle carries a bind-pose position and one bone. Its kinematic target
 * each frame is that bind position pushed through the bone's skinning matrix —
 * exactly what a rigidly-skinned vertex would do. A per-particle `pinRate`
 * decides how hard it is pulled toward that target, in units of 1/second:
 *
 *   Infinity   the waist seam, the shoulder of a sleeve — anywhere the garment
 *              is clamped to hardware and cannot move at all.
 *   10-60      follows the body closely, with a frame or two of give.
 *   1-5        follows loosely — this is where fabric starts to read as fabric.
 *   0.2-0.5    shape memory only. Stops a free end from slowly collapsing into
 *              a rope without meaningfully resisting motion.
 *
 * Expressing the pull as a rate rather than a per-frame blend is not a detail:
 * a "0.05 blend" applied 165 times a second is a 12 ms time constant, which is
 * a weld. Anything time-based in a system that also has to survive a frame-rate
 * change has to be written as a rate.
 *
 * Wind is *apparent* wind — the field wind minus the character's own velocity —
 * with quadratic drag. Over a dust sea the field term is a slow drift at most,
 * so it is the velocity term that does the work: at nineteen metres a second the
 * soft goods are pressed flat back against the figure, with no special case for
 * it anywhere.
 *
 * Allocation: none per frame. All state is typed arrays sized at construction.
 */

import { S } from "../core/settings.js";
import {
    B_ROOT, B_CHEST, B_UPPER_L, B_FORE_L, B_HAND_L,
    B_UPPER_R, B_FORE_R, B_HAND_R, B_NECK, B_SHIN_L, B_SHIN_R,
    B_THIGH_L, B_THIGH_R, B_FOOT_L, B_FOOT_R,
} from "./figure.js";
import { M_SOFT } from "./build.js";

/** Which body capsules a panel is allowed to collide against. */
const C_TORSO = 1;
const C_LEGS = 2;
const C_ARM_L = 4;
const C_ARM_R = 8;

export class ClothPanel {
    constructor(spec) {
        this.name = spec.name;
        this.cols = spec.cols;
        this.rows = spec.rows;
        this.matId = spec.matId;
        this.renderCols = spec.renderCols;
        this.renderRows = spec.renderRows;
        this.weaveU = spec.weaveU;
        this.weaveV = spec.weaveV;
        this.aoTop = spec.aoTop;
        this.aoBottom = spec.aoBottom;
        this.collide = spec.collide;
        /** Rows at the bottom that check the dust surface. */
        this.groundRows = spec.groundRows || 0;
        /** Row in the shared transform texture where this panel's grid starts. */
        this.nodeRow = 0;

        const n = this.cols * this.rows;
        this.count = n;
        this.bindPos = new Float32Array(n * 3);
        this.pos = new Float32Array(n * 3);
        this.prev = new Float32Array(n * 3);
        this.target = new Float32Array(n * 3);
        this.bone = new Int32Array(n);
        this.pinRate = new Float32Array(n);

        // Rest lengths: around the ring, down the panel, and the bending pair
        // two rows apart. Measured from the bind pose, so a panel's rest
        // shape *is* its authored shape.
        this.restU = new Float32Array(n);
        this.restV = new Float32Array(n);
        this.restB = new Float32Array(n);
    }

    /** Called once the bind positions are filled in. */
    finalise() {
        const { cols, rows, bindPos } = this;
        for (let j = 0; j < rows; j++) {
            for (let i = 0; i < cols; i++) {
                const a = (j * cols + i) * 3;
                const bu = (j * cols + ((i + 1) % cols)) * 3;
                this.restU[j * cols + i] = dist3(bindPos, a, bindPos, bu);
                if (j + 1 < rows) {
                    const bv = ((j + 1) * cols + i) * 3;
                    this.restV[j * cols + i] = dist3(bindPos, a, bindPos, bv);
                }
                if (j + 2 < rows) {
                    const bb = ((j + 2) * cols + i) * 3;
                    this.restB[j * cols + i] = dist3(bindPos, a, bindPos, bb);
                }
            }
        }
        this.pos.set(bindPos);
        this.prev.set(bindPos);
    }
}

function dist3(a, ia, b, ib) {
    return Math.hypot(a[ia] - b[ib], a[ia + 1] - b[ib + 1], a[ia + 2] - b[ib + 2]);
}

// -----------------------------------------------------------------------------
//  Panel shapes
// -----------------------------------------------------------------------------

/** Piecewise-linear lookup over a table of `[t, a, b]` control points. */
function curve(table, t) {
    let i = 0;
    while (i < table.length - 2 && t > table[i + 1][0]) i++;
    const A = table[i], Bb = table[i + 1];
    const s = Bb[0] > A[0] ? (t - A[0]) / (Bb[0] - A[0]) : 0;
    const k = Math.min(1, Math.max(0, s));
    return [A[1] + (Bb[1] - A[1]) * k, A[2] + (Bb[2] - A[2]) * k];
}

/**
 * A sleeve. Pinned tightly along the arm and genuinely loose only past the
 * wrist, where the cuff drapes. A fully free sleeve looks wonderful for about
 * four seconds and then slides off the elbow.
 */
function makeSleeve(side) {
    const s = side === 0 ? -1 : 1;
    const p = new ClothPanel({
        name: "sleeve" + side, cols: 10, rows: 8, matId: M_SOFT,
        renderCols: 26, renderRows: 20,
        weaveU: 0.46, weaveV: 0.66,
        aoTop: 0.6, aoBottom: 0.5,
        collide: side === 0 ? C_ARM_L : C_ARM_R,
    });

    const UP = [s * 0.185, 1.400, 0.000];
    const EL = [s * 0.230, 1.123, 0.000];
    const WR = [s * 0.243, 0.866, 0.016];

    // Beyond the wrist, continuing the forearm's direction.
    let dx = WR[0] - EL[0], dy = WR[1] - EL[1], dz = WR[2] - EL[2];
    const dl = Math.hypot(dx, dy, dz);
    dx /= dl; dy /= dl; dz /= dl;

    // (segment, t, radius) per row. Segment 0 = upper arm, 1 = forearm,
    // 2 = past the wrist. Every radius clears the pressurised limb under it by
    // about a centimetre — a suit arm is far fatter than the arm inside it, and
    // a sleeve cut to the old figure would be worn *inside* this one.
    const ROWS = [
        [0, 0.00, 0.094], [0, 0.45, 0.086], [0, 1.00, 0.081],
        [1, 0.40, 0.076], [1, 0.75, 0.072], [1, 1.00, 0.069],
        [2, 0.045, 0.080], [2, 0.125, 0.106],
    ];
    const BONE = [
        B_UPPER_L, B_UPPER_L, B_UPPER_L,
        B_FORE_L, B_FORE_L, B_FORE_L, B_FORE_L, B_HAND_L,
    ];
    const BONE_R = [
        B_UPPER_R, B_UPPER_R, B_UPPER_R,
        B_FORE_R, B_FORE_R, B_FORE_R, B_FORE_R, B_HAND_R,
    ];
    // Same argument as the lower torso, and the cuff rows matter most: at 5 and
    // 1.2 the end of the sleeve was free to swing, and a suit arm ends in a
    // machined wrist bearing that does not.
    const RATE = [Infinity, 70, 55, 60, 42, 30, 22, 14];

    for (let j = 0; j < p.rows; j++) {
        const [seg, t, r] = ROWS[j];
        let cx, cy, cz;
        if (seg === 0) {
            cx = UP[0] + (EL[0] - UP[0]) * t;
            cy = UP[1] + (EL[1] - UP[1]) * t;
            cz = UP[2] + (EL[2] - UP[2]) * t;
        } else if (seg === 1) {
            cx = EL[0] + (WR[0] - EL[0]) * t;
            cy = EL[1] + (WR[1] - EL[1]) * t;
            cz = EL[2] + (WR[2] - EL[2]) * t;
        } else {
            cx = WR[0] + dx * t; cy = WR[1] + dy * t; cz = WR[2] + dz * t;
        }
        for (let i = 0; i < p.cols; i++) {
            const a = (i / p.cols) * Math.PI * 2;
            const o = (j * p.cols + i) * 3;
            // The arm is near-vertical in the bind pose, so the ring lies in XZ.
            p.bindPos[o] = cx + Math.sin(a) * r;
            p.bindPos[o + 1] = cy;
            p.bindPos[o + 2] = cz + Math.cos(a) * r;
            p.bone[j * p.cols + i] = (side === 0 ? BONE : BONE_R)[j];
            p.pinRate[j * p.cols + i] = RATE[j];
        }
    }
    p.finalise();
    return p;
}

export function makePanels() {
    return [makeSleeve(0), makeSleeve(1)];
}

// -----------------------------------------------------------------------------
//  Solver
// -----------------------------------------------------------------------------

/** Constraint relaxation iterations. Six is where fabric stops looking rubbery. */
const ITERATIONS = 6;

/**
 * Capsule table: [boneA, boneB, radius, mask]. Rebuilt from joints each frame.
 *
 * Every radius is the pressurised limb's, not the body's — the suit adds one to
 * two centimetres everywhere and a capsule cut to the figure inside it lets the
 * soft goods sink straight through the shell they are supposed to lie on. The
 * torso is the one exception: it is kept a little under the hard shell's widest
 * so that the lower torso's welded top row starts inside its own capsule instead
 * of being shoved out of it on the first frame.
 */
const CAPSULES = [
    [B_ROOT, B_NECK, 0.195, C_TORSO],
    [B_THIGH_L, B_SHIN_L, 0.142, C_LEGS],
    [B_SHIN_L, B_FOOT_L, 0.112, C_LEGS],
    [B_THIGH_R, B_SHIN_R, 0.142, C_LEGS],
    [B_SHIN_R, B_FOOT_R, 0.112, C_LEGS],
    [B_UPPER_L, B_FORE_L, 0.092, C_ARM_L],
    [B_FORE_L, B_HAND_L, 0.080, C_ARM_L],
    [B_UPPER_R, B_FORE_R, 0.092, C_ARM_R],
    [B_FORE_R, B_HAND_R, 0.080, C_ARM_R],
];

export class ClothSolver {
    /**
     * @param {ClothPanel[]} panels
     * @param {{heightAt(x:number,z:number):number}} terrain
     */
    constructor(panels, terrain) {
        this.panels = panels;
        this.terrain = terrain;
        this._wind = new Float32Array(3);
        this._acc = new Float32Array(3);
        this._t = 0;
    }

    /**
     * @param {number} dt
     * @param {import("./figure.js").Figure} fig
     * @param {import("./controller.js").CharacterController} ch
     */
    update(dt, fig, ch) {
        // Two sub-steps at 30 Hz and below. Verlet with hard pins is stable but
        // a long step lets a free edge overshoot through the legs before the
        // collision pass sees it.
        let h = Math.min(dt, 1 / 30);
        let steps = 1;
        if (h > 1 / 55) { steps = 2; h *= 0.5; }
        this._t += dt;

        // ---- apparent wind ----------------------------------------------
        const a = (S.windDirection * Math.PI) / 180;
        const ws = 3.2 * S.windStrength;
        // Gusts in the drift, so a standing figure is never quite dead still.
        const gust = 1 + 0.35 * Math.sin(this._t * 0.7) + 0.18 * Math.sin(this._t * 2.3 + 1.1);
        this._wind[0] = Math.sin(a) * ws * gust - ch.velocity.x;
        this._wind[1] = 0.35 * Math.sin(this._t * 1.9);
        this._wind[2] = Math.cos(a) * ws * gust - ch.velocity.z;

        for (let s = 0; s < steps; s++) {
            for (let i = 0; i < this.panels.length; i++) {
                this._step(this.panels[i], h, fig);
            }
        }
    }

    _step(p, h, fig) {
        const n = p.count;
        const pos = p.pos;
        const prev = p.prev;
        const target = p.target;
        const skin = fig.skin;

        // ---- kinematic targets, from the skeleton -------------------------
        for (let k = 0; k < n; k++) {
            const b = p.bone[k] * 16;
            const o = k * 3;
            const x = p.bindPos[o], y = p.bindPos[o + 1], z = p.bindPos[o + 2];
            target[o] = skin[b] * x + skin[b + 4] * y + skin[b + 8] * z + skin[b + 12];
            target[o + 1] = skin[b + 1] * x + skin[b + 5] * y + skin[b + 9] * z + skin[b + 13];
            target[o + 2] = skin[b + 2] * x + skin[b + 6] * y + skin[b + 10] * z + skin[b + 14];
        }

        // ---- integrate ----------------------------------------------------
        // Quadratic drag against the apparent wind. At walking pace this is a
        // fraction of gravity; at nineteen metres a second it is four times it,
        // which is what presses the soft goods flat against the figure through a
        // surf run with no special case anywhere.
        const wx = this._wind[0], wy = this._wind[1], wz = this._wind[2];
        const wmag = Math.hypot(wx, wy, wz);
        const drag = 0.085 * wmag;
        const damp = Math.pow(0.90, h * 60);
        const h2 = h * h;

        for (let k = 0; k < n; k++) {
            if (!isFinite(p.pinRate[k])) continue; // welded; skip the integrator
            const o = k * 3;
            // Turbulence, hashed off the particle index so it does not pulse in
            // unison across the panel.
            const ph = k * 1.7 + this._t * 4.5;
            const tx = Math.sin(ph) * 0.9;
            const ty = Math.sin(ph * 1.31 + 2.1) * 0.7;
            const tz = Math.cos(ph * 0.87 + 0.4) * 0.9;

            const ax = wx * drag + tx * drag * 0.25;
            const ay = wy * drag - 9.81 + ty * drag * 0.25;
            const az = wz * drag + tz * drag * 0.25;

            const vx = (pos[o] - prev[o]) * damp;
            const vy = (pos[o + 1] - prev[o + 1]) * damp;
            const vz = (pos[o + 2] - prev[o + 2]) * damp;

            prev[o] = pos[o]; prev[o + 1] = pos[o + 1]; prev[o + 2] = pos[o + 2];
            pos[o] += vx + ax * h2;
            pos[o + 1] += vy + ay * h2;
            pos[o + 2] += vz + az * h2;
        }

        // ---- constraints ---------------------------------------------------
        for (let it = 0; it < ITERATIONS; it++) {
            this._anchors(p, h);
            this._distance(p, it);
        }
        this._collide(p, fig);
    }

    /** Pull each particle toward its skinned target at its own rate. */
    _anchors(p, h) {
        const n = p.count;
        const pos = p.pos;
        const target = p.target;
        for (let k = 0; k < n; k++) {
            const rate = p.pinRate[k];
            const o = k * 3;
            if (!isFinite(rate)) {
                pos[o] = target[o];
                pos[o + 1] = target[o + 1];
                pos[o + 2] = target[o + 2];
                continue;
            }
            if (rate <= 0) continue;
            // Divided by the iteration count so the total pull over one frame is
            // the rate the table asks for, not six times it.
            const w = (1 - Math.exp(-rate * h)) / ITERATIONS;
            pos[o] += (target[o] - pos[o]) * w;
            pos[o + 1] += (target[o + 1] - pos[o + 1]) * w;
            pos[o + 2] += (target[o + 2] - pos[o + 2]) * w;
        }
    }

    /**
     * Distance and bending constraints, Gauss-Seidel.
     *
     * Welded particles have infinite mass: they take none of the correction, so
     * a free end cannot drag its anchor off the pack.
     */
    _distance(p, iteration) {
        const { cols, rows, pos, restU, restV, restB, pinRate } = p;
        // Bending is solved softly and only on the later iterations. Solved hard
        // it fights the distance constraints and the fabric goes stiff.
        const bendK = iteration >= ITERATIONS - 3 ? 0.22 : 0;

        for (let j = 0; j < rows; j++) {
            for (let i = 0; i < cols; i++) {
                const k = j * cols + i;

                // around the ring
                solveLink(pos, k, j * cols + ((i + 1) % cols), restU[k], pinRate, 1);
                // down the panel
                if (j + 1 < rows) {
                    solveLink(pos, k, (j + 1) * cols + i, restV[k], pinRate, 1);
                }
                // bending, two rows apart
                if (bendK > 0 && j + 2 < rows) {
                    solveLink(pos, k, (j + 2) * cols + i, restB[k], pinRate, bendK);
                }
            }
        }
    }

    /** Push particles out of the body capsules and off the dust. */
    _collide(p, fig) {
        const n = p.count;
        const pos = p.pos;
        const joint = fig.joint;

        for (let c = 0; c < CAPSULES.length; c++) {
            const cap = CAPSULES[c];
            if ((p.collide & cap[3]) === 0) continue;
            const a = cap[0] * 3, b = cap[1] * 3;
            const ax = joint[a], ay = joint[a + 1], az = joint[a + 2];
            const bx = joint[b], by = joint[b + 1], bz = joint[b + 2];
            const ex = bx - ax, ey = by - ay, ez = bz - az;
            const elen2 = ex * ex + ey * ey + ez * ez || 1e-6;
            const r = cap[2];

            for (let k = 0; k < n; k++) {
                if (!isFinite(p.pinRate[k])) continue;
                const o = k * 3;
                let t = ((pos[o] - ax) * ex + (pos[o + 1] - ay) * ey + (pos[o + 2] - az) * ez) / elen2;
                t = t < 0 ? 0 : t > 1 ? 1 : t;
                const cx = ax + ex * t, cy = ay + ey * t, cz = az + ez * t;
                let dx = pos[o] - cx, dy = pos[o + 1] - cy, dz = pos[o + 2] - cz;
                const d = Math.hypot(dx, dy, dz);
                if (d >= r || d < 1e-6) continue;
                const push = (r - d) / d;
                pos[o] += dx * push;
                pos[o + 1] += dy * push;
                pos[o + 2] += dz * push;
            }
        }

        // A free edge rides on the dust rather than through it. Only the bottom rows
        // check, because that is the only place it can happen and `heightAt` is
        // a filtered lookup, not free.
        if (p.groundRows > 0) {
            const start = (p.rows - p.groundRows) * p.cols;
            for (let k = start; k < n; k++) {
                const o = k * 3;
                const g = this.terrain.heightAt(pos[o], pos[o + 2]) + 0.012;
                if (pos[o + 1] < g) pos[o + 1] = g;
            }
        }
    }
}

/**
 * One distance constraint. Mass weighting is binary — a welded particle does not
 * move at all — which is both correct and much cheaper than carrying inverse
 * masses through the inner loop.
 */
function solveLink(pos, ka, kb, rest, pinRate, stiffness) {
    const a = ka * 3, b = kb * 3;
    const dx = pos[b] - pos[a];
    const dy = pos[b + 1] - pos[a + 1];
    const dz = pos[b + 2] - pos[a + 2];
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-7) return;
    const diff = ((d - rest) / d) * stiffness;

    const fa = isFinite(pinRate[ka]);
    const fb = isFinite(pinRate[kb]);
    if (fa && fb) {
        const h = diff * 0.5;
        pos[a] += dx * h; pos[a + 1] += dy * h; pos[a + 2] += dz * h;
        pos[b] -= dx * h; pos[b + 1] -= dy * h; pos[b + 2] -= dz * h;
    } else if (fa) {
        pos[a] += dx * diff; pos[a + 1] += dy * diff; pos[a + 2] += dz * diff;
    } else if (fb) {
        pos[b] -= dx * diff; pos[b + 1] -= dy * diff; pos[b + 2] -= dz * diff;
    }
}
