/**
 * Procedural character geometry.
 *
 * Nothing here is authored in a DCC tool. Every surface is a lofted tube, a
 * swept ring or a sphere evaluated from the bind-pose skeleton, so the whole
 * astronaut is a few hundred lines of tables and a smooth-normal pass.
 *
 * Three meshes come out, because three different vertex programs drive them:
 *
 *   body   linearly blend-skinned to the bones — helmet, faceplate, pressure
 *          suit, life-support pack, gloves, boots, and the board under them.
 *   cloth  driven from the simulated soft goods — the tether, the lower torso
 *          and the sleeves — sampled with Catmull-Rom in the vertex shader so a
 *          coarse solve renders as a smooth surface.
 *   nap    shell layers of multi-layer insulation: the same seam ring emitted N
 *          times, each pushed further along its normal, alpha-tested into
 *          fibres.
 *
 * Normals are never derived analytically. Everything is built as positions plus
 * indices and then run through one area-weighted smooth-normal pass, which is
 * both less code and immune to the sign errors that analytic normals on a swept
 * surface invite. Closed rings share their seam vertex rather than duplicating
 * it, so the seam is smooth too.
 *
 * Build time only — none of this runs after load, and it allocates freely.
 */

import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import {
    B_ROOT, B_SPINE, B_CHEST, B_NECK, B_HEAD, B_HELMET,
    B_UPPER_L, B_FORE_L, B_HAND_L, B_UPPER_R, B_FORE_R, B_HAND_R,
    B_THIGH_L, B_SHIN_L, B_FOOT_L, B_THIGH_R, B_SHIN_R, B_FOOT_R,
    B_BOARD,
} from "./figure.js";

// ------------------------------------------------------------- material slots
//
// Exactly eight, which is the ceiling: `matAlbedo`, `matParams` and `matExtra`
// are all `array<vec4f, 8>` in char.fragment.wgsl and the slot index is clamped
// to 0..7 there. A ninth would be a coordinated edit across three WGSL array
// sizes and three Float32Array sizes, so the budget is decided here and not
// discovered later.
export const M_SUIT = 0;     // white woven pressure garment
export const M_SOFT = 1;     // soft goods: joint bellows, neck dam, boots
export const M_VISOR = 2;    // gold mirror faceplate
export const M_SHELL = 3;    // white hard shell: helmet, life-support pack
export const M_GLOVE = 4;    // pressurised glove
export const M_TRIM = 5;     // emissive accent strip
export const M_METAL = 6;    // bearings and rings — bare metal
export const M_BOARD = 7;    // the board's clear-coated deck

/** Segments around a limb. 14 is smooth at the distances this is seen from. */
const SEG = 14;

// ------------------------------------------------------------- head geometry
//
// Declared before anything that reads them. The helmet is a sphere with one
// hole in it, and every part of the head assembly — the shell, the faceplate,
// the neck seam nap — is evaluated from the same centre, radius and opening
// angle, so none of them can drift apart when one is retuned.

/** Centre of the helmet bubble in bind-pose world space. */
const HELM_C = [0, 1.660, 0.005];
/** Bubble radius. 31 cm across the outside, which is a real EVA helmet. */
const HELM_R = 0.155;
/** Angular radius of the faceplate opening, measured from `FACE_DIR`. */
const VISOR_ANG = 0.98;
/** How far the sun visor stands proud of the pressure bubble at its centre. */
const VISOR_PROUD = 0.010;

/** The direction the faceplate looks: forward, tipped very slightly down. */
const FACE_DIR = (() => {
    const v = [0, -0.16, 0.987];
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
})();
/** Two axes spanning the plane the opening's azimuth sweeps. */
const FACE_U = [1, 0, 0];
const FACE_W = [0, FACE_DIR[2], -FACE_DIR[1]];

/**
 * Tessellation. Columns are shared by the shell and the faceplate so their
 * seam vertices line up exactly; rows are equal steps in polar angle, which on
 * a sphere is equal steps in surface area.
 */
const HELMET_COLS = 34;
const HELMET_ROWS = 9;
const VISOR_ROWS = 4;

// -----------------------------------------------------------------------------

class Builder {
    constructor() {
        this.pos = [];
        this.nrm = [];
        this.uv = [];
        /** (matId, ao) on the body; (shellT, ao) on the fur. */
        this.aux = [];
        this.bi = [];       // bone indices, 4 per vertex
        this.bw = [];       // bone weights, 4 per vertex
        this.idx = [];
        /** Fur supplies its own normals; everything else has them derived. */
        this.explicitNormals = false;
    }

    /** @returns {number} the new vertex's index */
    vert(x, y, z, u, v, matId, ao, b0, w0, b1, w1) {
        this.pos.push(x, y, z);
        this.nrm.push(0, 0, 0);
        this.uv.push(u, v);
        this.aux.push(matId, ao);
        this.bi.push(b0, b1 || 0, 0, 0);
        this.bw.push(w0, w1 || 0, 0, 0);
        return this.pos.length / 3 - 1;
    }

    normal(vi, x, y, z) {
        this.nrm[vi * 3] = x;
        this.nrm[vi * 3 + 1] = y;
        this.nrm[vi * 3 + 2] = z;
    }

    tri(a, b, c) {
        this.idx.push(a, b, c);
    }

    quad(a, b, c, d) {
        // Both diagonals of every quad get used across the mesh, alternating is
        // not worth the bookkeeping on shapes this smooth.
        this.idx.push(a, b, c, a, c, d);
    }
}

/**
 * Area-weighted smooth normals.
 *
 * Area weighting rather than plain averaging: a long thin triangle at a cap
 * would otherwise pull the pole normal off toward its own plane. It also makes
 * the degenerate triangles at a fan's apex free — zero area is zero weight.
 */
function computeNormals(pos, idx) {
    const n = new Float32Array(pos.length);
    for (let i = 0; i < idx.length; i += 3) {
        const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
        const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
        const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
        // Un-normalised cross product: its length is twice the triangle area,
        // which is exactly the weight we want.
        const fx = uy * vz - uz * vy;
        const fy = uz * vx - ux * vz;
        const fz = ux * vy - uy * vx;
        n[a] += fx; n[a + 1] += fy; n[a + 2] += fz;
        n[b] += fx; n[b + 1] += fy; n[b + 2] += fz;
        n[c] += fx; n[c + 1] += fy; n[c + 2] += fz;
    }
    for (let i = 0; i < n.length; i += 3) {
        const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
        n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
    }
    return n;
}

/**
 * Loft a closed tube through a list of rings.
 *
 * Each ring is `[cx, cy, cz, rx, rz, ao, b0, w0, b1, w1]` and the cross-section
 * plane is derived from the direction to the neighbouring rings, so a limb that
 * bends in the bind pose still gets circular sections rather than sheared ones.
 *
 * @param {Builder} B
 * @param {number[][]} rings
 * @param {number} matId
 * @param {[number,number,number]} ref reference axis the section frame avoids
 */
function loft(B, rings, matId, ref, capStart, capEnd) {
    const n = rings.length;
    const first = [];
    let prevRow = null;
    let vAcc = 0;

    for (let r = 0; r < n; r++) {
        const cur = rings[r];
        const prev = rings[Math.max(0, r - 1)];
        const next = rings[Math.min(n - 1, r + 1)];

        let ax = next[0] - prev[0], ay = next[1] - prev[1], az = next[2] - prev[2];
        let al = Math.hypot(ax, ay, az) || 1;
        ax /= al; ay /= al; az /= al;

        // U = axis x ref, W = axis x U — the two axes of the section plane.
        let ux = ay * ref[2] - az * ref[1];
        let uy = az * ref[0] - ax * ref[2];
        let uz = ax * ref[1] - ay * ref[0];
        let ul = Math.hypot(ux, uy, uz) || 1;
        ux /= ul; uy /= ul; uz /= ul;
        const wx = ay * uz - az * uy;
        const wy = az * ux - ax * uz;
        const wz = ax * uy - ay * ux;

        if (r > 0) {
            vAcc += Math.hypot(cur[0] - prev[0], cur[1] - prev[1], cur[2] - prev[2]);
        }

        // Texture coordinates are metres of surface, not normalised. Every
        // scale in the suit shader — the weave, the yarn slub — is a physical
        // size, and normalised UVs would make each of them a different size on
        // every part of the body.
        const circ = Math.PI * (cur[3] + cur[4]);

        const row = [];
        for (let s = 0; s < SEG; s++) {
            const a = (s / SEG) * Math.PI * 2;
            const ca = Math.cos(a), sa = Math.sin(a);
            const px = cur[0] + ux * cur[3] * sa + wx * cur[4] * ca;
            const py = cur[1] + uy * cur[3] * sa + wy * cur[4] * ca;
            const pz = cur[2] + uz * cur[3] * sa + wz * cur[4] * ca;
            row.push(B.vert(
                px, py, pz,
                (s / SEG) * circ, vAcc,
                matId, cur[5], cur[6], cur[7], cur[8], cur[9]
            ));
        }

        if (prevRow) {
            for (let s = 0; s < SEG; s++) {
                const s2 = (s + 1) % SEG;
                B.quad(prevRow[s], prevRow[s2], row[s2], row[s]);
            }
        }
        if (r === 0) first.push(...row);
        prevRow = row;
    }

    // Caps: a fan to a centre vertex placed on the ring's own axis.
    if (capStart) capRing(B, rings[0], rings[1], first, matId, true);
    if (capEnd) capRing(B, rings[n - 1], rings[n - 2], prevRow, matId, false);
}

function capRing(B, ring, neighbour, row, matId, isStart) {
    let ax = ring[0] - neighbour[0], ay = ring[1] - neighbour[1], az = ring[2] - neighbour[2];
    const al = Math.hypot(ax, ay, az) || 1;
    ax /= al; ay /= al; az /= al;
    const ext = Math.max(ring[3], ring[4]) * 0.7;
    const c = B.vert(
        ring[0] + ax * ext, ring[1] + ay * ext, ring[2] + az * ext,
        0.5, 0.5, matId, ring[5], ring[6], ring[7], ring[8], ring[9]
    );
    for (let s = 0; s < SEG; s++) {
        const s2 = (s + 1) % SEG;
        if (isStart) B.tri(c, row[s2], row[s]);
        else B.tri(c, row[s], row[s2]);
    }
}

/** Bone blend along the spine, by bind-pose height. */
function spineBones(y) {
    if (y < 1.06) {
        const t = Math.min(1, Math.max(0, (y - 0.88) / 0.18));
        return [B_ROOT, 1 - t * 0.5, B_SPINE, t * 0.5];
    }
    if (y < 1.26) {
        const t = (y - 1.06) / 0.20;
        return [B_SPINE, 1 - t, B_CHEST, t];
    }
    const t = Math.min(1, (y - 1.26) / 0.20);
    return [B_CHEST, 1 - t * 0.35, B_NECK, t * 0.35];
}

/** Ring helper: `[cx,cy,cz, rx,rz, ao, b0,w0,b1,w1]`. */
function ring(cx, cy, cz, rx, rz, ao, bones) {
    return [cx, cy, cz, rx, rz, ao, bones[0], bones[1], bones[2], bones[3]];
}

/** Rings along a straight bone segment, interpolating radius and bone weights. */
function limbRings(x0, y0, z0, x1, y1, z1, r0, r1, steps, boneA, boneB, ao, from, to) {
    const out = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        // Weight ramps from boneA to boneB across the segment's lower half, so
        // the joint bends smoothly instead of creasing at one ring.
        const w = Math.min(1, Math.max(0, (t - from) / (to - from)));
        const r = r0 + (r1 - r0) * t;
        out.push(ring(
            x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t,
            r, r, ao, [boneA, 1 - w, boneB, w]
        ));
    }
    return out;
}

// -----------------------------------------------------------------------------
//  Body
// -----------------------------------------------------------------------------

/**
 * The astronaut: helmet, faceplate, pressure suit, life-support pack, gloves,
 * boots, and the board.
 *
 * A pressure suit is a stack of bulky cylinders with hard rings at every
 * bearing, which is a gift for a lofted-tube pipeline: the bulk comes from the
 * radii and the joints read because a metal band interrupts every tube. What is
 * genuinely on screen at fifteen metres is the helmet silhouette with its gold
 * faceplate, the pack behind the shoulders, and the board — so that is where
 * the ring counts go.
 */
export function buildBody(scene) {
    const B = new Builder();

    // ---- hard upper torso -------------------------------------------------
    // Barrel-shaped and near-constant through the chest, tapering only at the
    // waist bearing and at the shoulder yoke. This is a fibreglass shell, not a
    // ribcage, and the silhouette should say so.
    const torso = [];
    const TORSO = [
        [0.88, 0.168, 0.132], [0.98, 0.176, 0.140], [1.06, 0.184, 0.146],
        [1.14, 0.196, 0.152], [1.22, 0.206, 0.158], [1.30, 0.210, 0.160],
        [1.38, 0.202, 0.154], [1.44, 0.172, 0.136],
    ];
    for (let i = 0; i < TORSO.length; i++) {
        const [y, rx, rz] = TORSO[i];
        torso.push(ring(0, y, 0, rx, rz, 0.75, spineBones(y)));
    }
    loft(B, torso, M_SUIT, [0, 0, 1], true, false);

    // ---- waist bearing ----------------------------------------------------
    // The hard ring the upper torso rotates on. Stands a centimetre proud of
    // the shell either side of it, which is the whole point of drawing it.
    const waist = [
        ring(0, 0.950, 0, 0.180, 0.146, 0.55, spineBones(0.950)),
        ring(0, 0.986, 0, 0.190, 0.156, 0.62, spineBones(0.986)),
        ring(0, 1.022, 0, 0.180, 0.146, 0.55, spineBones(1.022)),
    ];
    loft(B, waist, M_METAL, [0, 0, 1], false, false);

    // ---- chest light bar --------------------------------------------------
    // A real luminaire, not a painted stripe: it is the one thing on the front
    // of the figure that still reads when the sun is behind it, which in this
    // scene is most of the time.
    const bar = [
        ring(-0.100, 1.315, 0.148, 0.013, 0.013, 1.0, spineBones(1.315)),
        ring(0.000, 1.322, 0.156, 0.015, 0.015, 1.0, spineBones(1.322)),
        ring(0.100, 1.315, 0.148, 0.013, 0.013, 1.0, spineBones(1.315)),
    ];
    loft(B, bar, M_TRIM, [0, 1, 0], true, true);

    // ---- neck dam and helmet ring ------------------------------------------
    const neck = [
        ring(0, 1.418, -0.004, 0.072, 0.068, 0.35, [B_NECK, 1, B_HEAD, 0]),
        ring(0, 1.452, 0.000, 0.068, 0.064, 0.32, [B_NECK, 0.4, B_HEAD, 0.6]),
    ];
    loft(B, neck, M_SOFT, [0, 0, 1], false, false);

    // The helmet ring. The bubble's south pole sits at y 1.505 with a radius of
    // 78 mm at the top of this band, so the ring genuinely encircles it — the
    // helmet drops into the ring the way it does on the real disconnect.
    const collar = [
        ring(0, 1.478, 0.002, 0.098, 0.094, 0.55, [B_HEAD, 1, 0, 0]),
        ring(0, 1.502, 0.004, 0.106, 0.102, 0.62, [B_HEAD, 1, 0, 0]),
        ring(0, 1.526, 0.004, 0.098, 0.094, 0.55, [B_HEAD, 1, 0, 0]),
    ];
    loft(B, collar, M_METAL, [0, 0, 1], false, false);

    buildHelmet(B);
    buildVisor(B);

    // ---- life-support pack -------------------------------------------------
    // A rounded slab swept backward from inside the chest, so its front ring is
    // hidden and needs no cap. Bound through `spineBones` rather than to one
    // bone, so it twists with the chest during a carve instead of hanging off
    // it like a rucksack.
    // The last ring is drawn in hard before the end cap, because `capRing`
    // extends its fan by seven tenths of the ring's radius: leaving the pack
    // full width to the end would put its tip fifteen centimetres further back
    // than the geometry says and turn a box into a cone.
    const pack = [
        ring(0, 1.270, -0.128, 0.140, 0.132, 0.42, spineBones(1.270)),
        ring(0, 1.270, -0.158, 0.166, 0.158, 0.50, spineBones(1.270)),
        ring(0, 1.270, -0.212, 0.172, 0.164, 0.55, spineBones(1.270)),
        ring(0, 1.270, -0.258, 0.158, 0.150, 0.58, spineBones(1.270)),
        ring(0, 1.270, -0.286, 0.096, 0.090, 0.52, spineBones(1.270)),
    ];
    loft(B, pack, M_SHELL, [0, 1, 0], false, true);

    // Two light strips along the pack's widest line, where they are visible
    // from behind and from either side — the read that separates the astronaut
    // from the void in a trailing camera, which is the demo's default framing.
    // Each sits with its inner face inside the shell, so there is no seam to
    // catch the light between the strip and the thing it is bolted to.
    for (let i = 0; i < 2; i++) {
        const s = i === 0 ? -1 : 1;
        const strip = [
            ring(s * 0.172, 1.270, -0.160, 0.012, 0.012, 1.0, spineBones(1.270)),
            ring(s * 0.180, 1.270, -0.212, 0.014, 0.014, 1.0, spineBones(1.270)),
            ring(s * 0.170, 1.270, -0.250, 0.012, 0.012, 1.0, spineBones(1.270)),
        ];
        loft(B, strip, M_TRIM, [0, 1, 0], true, true);
    }

    // ---- arms -------------------------------------------------------------
    for (let a = 0; a < 2; a++) {
        const s = a === 0 ? -1 : 1;
        const up = a === 0 ? B_UPPER_L : B_UPPER_R;
        const fo = a === 0 ? B_FORE_L : B_FORE_R;
        const hd = a === 0 ? B_HAND_L : B_HAND_R;

        const upper = limbRings(
            s * 0.185, 1.400, 0, s * 0.230, 1.123, 0,
            0.078, 0.064, 4, up, fo, 0.62, 0.72, 1.0
        );
        loft(B, upper, M_SUIT, [0, 0, 1], true, false);

        // Convolute bellows at the shoulder and the elbow. A pressure suit's
        // limbs are otherwise two smooth tubes, and without a break at each
        // joint the arm reads as a length of pipe no matter how it is posed.
        const shoulder = [
            ring(s * 0.187, 1.386, 0, 0.085, 0.081, 0.52, [up, 1, 0, 0]),
            ring(s * 0.193, 1.350, 0, 0.088, 0.084, 0.50, [up, 1, 0, 0]),
            ring(s * 0.199, 1.314, 0, 0.084, 0.080, 0.52, [up, 1, 0, 0]),
        ];
        loft(B, shoulder, M_SOFT, [0, 0, 1], false, false);

        const elbow = [
            ring(s * 0.226, 1.152, 0, 0.070, 0.066, 0.50, [up, 0.7, fo, 0.3]),
            ring(s * 0.230, 1.123, 0, 0.074, 0.070, 0.48, [up, 0.4, fo, 0.6]),
            ring(s * 0.234, 1.094, 0.002, 0.070, 0.066, 0.50, [up, 0.1, fo, 0.9]),
        ];
        loft(B, elbow, M_SOFT, [0, 0, 1], false, false);

        const fore = limbRings(
            s * 0.230, 1.123, 0, s * 0.243, 0.866, 0.016,
            0.062, 0.054, 4, fo, hd, 0.62, 0.75, 1.0
        );
        loft(B, fore, M_SUIT, [0, 0, 1], false, false);

        // Wrist bearing: the glove disconnect. Straddles the hand bone so the
        // band turns with the glove rather than shearing across the joint.
        const wrist = [
            ring(s * 0.242, 0.906, 0.014, 0.062, 0.058, 0.55, [fo, 0.5, hd, 0.5]),
            ring(s * 0.243, 0.880, 0.016, 0.064, 0.060, 0.55, [hd, 1, 0, 0]),
            ring(s * 0.244, 0.860, 0.018, 0.060, 0.056, 0.55, [hd, 1, 0, 0]),
        ];
        loft(B, wrist, M_METAL, [0, 0, 1], false, false);

        // The glove is a mitt. Fingers at this distance are three pixels of
        // noise; a clean silhouette reads better and costs nothing, and a
        // pressurised glove barely articulates anyway.
        const hand = [
            ring(s * 0.243, 0.866, 0.016, 0.050, 0.043, 0.55, [hd, 1, 0, 0]),
            ring(s * 0.245, 0.818, 0.025, 0.057, 0.046, 0.55, [hd, 1, 0, 0]),
            ring(s * 0.247, 0.776, 0.034, 0.052, 0.041, 0.52, [hd, 1, 0, 0]),
            ring(s * 0.248, 0.748, 0.040, 0.034, 0.030, 0.50, [hd, 1, 0, 0]),
        ];
        loft(B, hand, M_GLOVE, [0, 0, 1], false, true);
    }

    // ---- legs and boots ---------------------------------------------------
    for (let l = 0; l < 2; l++) {
        const s = l === 0 ? -1 : 1;
        const th = l === 0 ? B_THIGH_L : B_THIGH_R;
        const sh = l === 0 ? B_SHIN_L : B_SHIN_R;
        const ft = l === 0 ? B_FOOT_L : B_FOOT_R;

        const thigh = limbRings(
            s * 0.100, 0.905, 0, s * 0.100, 0.460, 0,
            0.128, 0.100, 5, th, sh, 0.50, 0.74, 1.0
        );
        loft(B, thigh, M_SUIT, [0, 0, 1], true, false);

        // The leg narrows to the ankle then flares into the boot cuff.
        const shin = [
            ring(s * 0.100, 0.460, 0, 0.096, 0.096, 0.55, [sh, 1, 0, 0]),
            ring(s * 0.100, 0.360, 0.004, 0.085, 0.085, 0.55, [sh, 1, 0, 0]),
            ring(s * 0.100, 0.270, 0.006, 0.078, 0.078, 0.52, [sh, 1, 0, 0]),
            ring(s * 0.100, 0.200, 0.006, 0.084, 0.085, 0.48, [sh, 0.6, ft, 0.4]),
            ring(s * 0.100, 0.140, 0.004, 0.090, 0.092, 0.44, [sh, 0.25, ft, 0.75]),
            ring(s * 0.100, 0.100, 0.000, 0.083, 0.087, 0.42, [ft, 1, 0, 0]),
        ];
        loft(B, shin, M_SUIT, [0, 0, 1], false, false);

        // The boot runs along the foot's own axis, so it swings with the ankle
        // roll rather than being a block bolted to the shin. It is the one dark
        // mass at the bottom of the figure, which is what gives the astronaut
        // weight on the deck instead of floating above it.
        const boot = [
            ring(s * 0.100, 0.055, -0.096, 0.056, 0.063, 0.35, [ft, 1, 0, 0]),
            ring(s * 0.100, 0.058, -0.055, 0.068, 0.080, 0.38, [ft, 1, 0, 0]),
            ring(s * 0.100, 0.054, 0.011, 0.071, 0.073, 0.42, [ft, 1, 0, 0]),
            ring(s * 0.100, 0.048, 0.086, 0.068, 0.061, 0.45, [ft, 1, 0, 0]),
            ring(s * 0.100, 0.043, 0.156, 0.061, 0.052, 0.48, [ft, 1, 0, 0]),
            ring(s * 0.100, 0.040, 0.208, 0.040, 0.038, 0.48, [ft, 1, 0, 0]),
        ];
        loft(B, boot, M_SOFT, [0, 1, 0], true, true);
    }

    buildBoard(B);

    return finishSkinned(scene, "charBody", B);
}

// -----------------------------------------------------------------------------
//  Head assembly
// -----------------------------------------------------------------------------

/**
 * A unit direction on the helmet sphere: polar angle `ang` measured from the
 * face direction, at azimuth `a` around it. Azimuth 0 is over the crown and
 * 0.5 of a turn passes under the chin.
 *
 * The shell, the faceplate and the neck seam are all evaluated from this one
 * function, which is why the faceplate can never leave a sliver of a gap at the
 * opening no matter what the radii are retuned to.
 */
function helmetDir(a, ang, out) {
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const su = Math.sin(a) * sa, sw = Math.cos(a) * sa;
    out[0] = FACE_DIR[0] * ca + FACE_U[0] * su + FACE_W[0] * sw;
    out[1] = FACE_DIR[1] * ca + FACE_U[1] * su + FACE_W[1] * sw;
    out[2] = FACE_DIR[2] * ca + FACE_U[2] * su + FACE_W[2] * sw;
    return out;
}

/** Polar angle of the faceplate opening at parameter `s`. */
function visorAngle(s) {
    // A few per cent taller than it is wide, the way a faceplate is cut: the
    // eyes need the vertical field, the cheeks do not need the horizontal.
    return VISOR_ANG * (1 + 0.05 * Math.cos(s * Math.PI * 2));
}

/**
 * The helmet shell.
 *
 * A sphere with one hole in it, swept as columns of constant azimuth running
 * from the faceplate rim, back over the crown and round to a single pole
 * directly behind the face. Rows are equal steps in polar angle, so the
 * tessellation is uniform in surface area rather than piling up at the back.
 *
 * Opaque, deliberately. The shell is the white micrometeoroid cover that goes
 * over the pressure bubble, and with the faceplate rendered as an opaque mirror
 * there is no angle at which the camera can see into an empty helmet — the
 * failure mode a transparent visor over a featureless head always ends in.
 */
function buildHelmet(B) {
    const d = [0, 0, 0];
    let prevRow = null;

    // Arc length from the rim to the back pole, and the rim's own circumference
    // — the UVs are metres of surface like everywhere else.
    const sweep = HELM_R * (Math.PI - VISOR_ANG);
    const girth = 2 * Math.PI * HELM_R * Math.sin(VISOR_ANG);

    for (let r = 0; r < HELMET_ROWS; r++) {
        const t = r / HELMET_ROWS;
        const row = [];
        for (let c = 0; c < HELMET_COLS; c++) {
            const s = c / HELMET_COLS;
            const ang0 = visorAngle(s);
            const ang = ang0 + (Math.PI - ang0) * t;
            helmetDir(s * Math.PI * 2, ang, d);
            // The outside of a helmet sees the whole sky; only the back is
            // shaded, and then only by the pack it sits against.
            const ao = 0.92 - 0.16 * t;
            row.push(B.vert(
                HELM_C[0] + d[0] * HELM_R,
                HELM_C[1] + d[1] * HELM_R,
                HELM_C[2] + d[2] * HELM_R,
                s * girth, t * sweep,
                M_SHELL, ao, B_HELMET, 1, 0, 0
            ));
        }
        if (prevRow) {
            for (let c = 0; c < HELMET_COLS; c++) {
                const c2 = (c + 1) % HELMET_COLS;
                B.quad(prevRow[c], prevRow[c2], row[c2], row[c]);
            }
        }
        prevRow = row;
    }

    // Close the back with a fan to the pole rather than a ring of coincident
    // vertices: one vertex instead of thirty-four, and no degenerate quads.
    const pole = B.vert(
        HELM_C[0] - FACE_DIR[0] * HELM_R,
        HELM_C[1] - FACE_DIR[1] * HELM_R,
        HELM_C[2] - FACE_DIR[2] * HELM_R,
        girth * 0.5, sweep, M_SHELL, 0.76, B_HELMET, 1, 0, 0
    );
    for (let c = 0; c < HELMET_COLS; c++) {
        B.tri(pole, prevRow[c], prevRow[(c + 1) % HELMET_COLS]);
    }
}

/**
 * The sun visor.
 *
 * The spherical cap the shell leaves out, built from the same rim function and
 * bulged ten millimetres proud at its centre so it reads as a separate part
 * bolted over the opening rather than as a painted patch of the shell.
 *
 * This is the single most important read on the whole figure, so it carries no
 * baked occlusion at all — a mirror does not have ambient occlusion, it has a
 * reflection, and darkening it here would fight the one thing it is for.
 */
function buildVisor(B) {
    const d = [0, 0, 0];
    let prevRow = null;
    const span = HELM_R * VISOR_ANG;
    const girth = 2 * Math.PI * HELM_R * Math.sin(VISOR_ANG);

    for (let r = 0; r < VISOR_ROWS; r++) {
        const t = r / VISOR_ROWS;
        const row = [];
        for (let c = 0; c < HELMET_COLS; c++) {
            const s = c / HELMET_COLS;
            const k = 1 - t;                       // 1 at the rim, 0 at the centre
            const ang = visorAngle(s) * k;
            helmetDir(s * Math.PI * 2, ang, d);
            // Flush with the shell at the rim, proud at the centre. Quadratic,
            // so the two surfaces meet tangentially and the joint has no crease
            // for a specular highlight to catch on.
            const rad = HELM_R + VISOR_PROUD * (1 - k * k);
            row.push(B.vert(
                HELM_C[0] + d[0] * rad,
                HELM_C[1] + d[1] * rad,
                HELM_C[2] + d[2] * rad,
                s * girth, t * span,
                M_VISOR, 1.0, B_HELMET, 1, 0, 0
            ));
        }
        if (prevRow) {
            for (let c = 0; c < HELMET_COLS; c++) {
                const c2 = (c + 1) % HELMET_COLS;
                B.quad(prevRow[c], prevRow[c2], row[c2], row[c]);
            }
        }
        prevRow = row;
    }

    const centre = B.vert(
        HELM_C[0] + FACE_DIR[0] * (HELM_R + VISOR_PROUD),
        HELM_C[1] + FACE_DIR[1] * (HELM_R + VISOR_PROUD),
        HELM_C[2] + FACE_DIR[2] * (HELM_R + VISOR_PROUD),
        girth * 0.5, span, M_VISOR, 1.0, B_HELMET, 1, 0, 0
    );
    for (let c = 0; c < HELMET_COLS; c++) {
        B.tri(centre, prevRow[c], prevRow[(c + 1) % HELMET_COLS]);
    }
}

// -----------------------------------------------------------------------------
//  Board
// -----------------------------------------------------------------------------

/**
 * The board.
 *
 * Built into the *body* mesh on its own bone rather than as a mesh of its own,
 * which is the whole trick: it inherits char.vertex, char.fragment, both shadow
 * cascades through charDepth and the depth prepass through charPrepass without
 * a single new pipeline, material, caster registration or warm-up entry.
 *
 * Authored lying along +Z in bind space with its centreline on the bone origin,
 * because `B_BOARD`'s bind direction is +Z and its front reference is world up
 * — the same convention the foot bones use. Rows sweep along Z with the world
 * up as the loft reference, so a ring's `rx` is its half-width and its `rz` is
 * its half-thickness.
 *
 * The outline is a rounded pin: widest just behind the middle, drawn out to a
 * point at the nose and a narrower point at the tail. The rocker — the lift in
 * the centreline toward both ends — is what stops it reading as a plank, and it
 * is why the nose can plough into a dune face without the whole board stopping.
 */
function buildBoard(B) {
    const bone = [B_BOARD, 1, 0, 0];

    // [z, y, half-width, half-thickness]
    const OUTLINE = [
        [0.940, 0.076, 0.022, 0.008],
        [0.840, 0.058, 0.058, 0.014],
        [0.700, 0.041, 0.104, 0.021],
        [0.500, 0.029, 0.144, 0.027],
        [0.260, 0.022, 0.172, 0.031],
        [0.000, 0.020, 0.180, 0.033],
        [-0.260, 0.022, 0.172, 0.031],
        [-0.480, 0.029, 0.146, 0.027],
        [-0.680, 0.039, 0.110, 0.022],
        [-0.810, 0.052, 0.066, 0.015],
        [-0.880, 0.064, 0.024, 0.009],
    ];
    const deck = [];
    for (let i = 0; i < OUTLINE.length; i++) {
        const [z, y, w, th] = OUTLINE[i];
        deck.push(ring(0, y, z, w, th, 0.85, bone));
    }
    loft(B, deck, M_BOARD, [0, 1, 0], true, true);

    // A single centre fin. In a dust sea a fin does nothing a keel would not,
    // but it is the one silhouette element that says "board" from behind, which
    // is the angle this is nearly always seen from.
    //
    // It drops almost straight down rather than raking back, and that is what
    // decides the root ring: the loft's section plane is perpendicular to the
    // path through the rings, so a near-vertical descent puts the root's long
    // axis along the deck. Rake it and the root tips with it, and since the
    // root is 12 cm of chord inside 5 cm of deck, a tipped one has its lower
    // half hanging out below the board — and the root ring is the loft's open
    // end, so what hangs out is a hole. Vertical, it is buried.
    const fin = [
        ring(0, 0.030, -0.575, 0.010, 0.062, 0.55, bone),
        ring(0, -0.030, -0.590, 0.008, 0.050, 0.50, bone),
        ring(0, -0.088, -0.612, 0.005, 0.028, 0.45, bone),
    ];
    loft(B, fin, M_BOARD, [0, 0, 1], false, true);

    // The stringer, run as a light strip. It reads the board's whole length in
    // one line, which is what tells you which way it is pointing during a carve
    // — and it ties the board to the same accent the faceplate and the pack
    // strips carry.
    const stringer = [
        ring(0, 0.070, 0.760, 0.008, 0.006, 1.0, bone),
        ring(0, 0.050, 0.400, 0.010, 0.007, 1.0, bone),
        ring(0, 0.052, 0.000, 0.010, 0.007, 1.0, bone),
        ring(0, 0.054, -0.400, 0.010, 0.007, 1.0, bone),
        ring(0, 0.072, -0.760, 0.008, 0.006, 1.0, bone),
    ];
    loft(B, stringer, M_TRIM, [0, 1, 0], true, true);
}

// -----------------------------------------------------------------------------
//  Insulation nap
// -----------------------------------------------------------------------------

/** Shells per nap band. Short fibres, so ten is already past visible banding. */
const NECK_SHELLS = 10;
const CUFF_SHELLS = 10;

/**
 * Shell fur, repurposed as multi-layer-insulation nap.
 *
 * A seam band is modelled as a partial torus around the edge it decorates: a
 * ring of cross-sections, each an arc of directions pointing away from the
 * suit. That surface is then emitted once per shell, each copy pushed further
 * along its own direction, and the fragment shader alpha-tests a hashed fibre
 * field whose threshold rises with the shell parameter — so fibres taper, end
 * at different lengths, and the band reads as soft nap rather than as a smooth
 * sausage.
 *
 * Fourteen millimetres long, against the forty-eight a fur trim wanted. This is
 * the frayed edge of a thermal blanket where it is clamped at a bearing, not a
 * pelt, and at that length ten shells is plenty — which matters, because these
 * are the only alpha-tested layers on the character.
 *
 * Bone-bound rather than cloth-bound, deliberately: the neck seam rides the
 * head and the cuffs ride the gloves, both of which are rigid. Binding nap to a
 * simulated surface would need the shell direction to come out of the cloth
 * solve — a second vertex program, for very little visible gain.
 */
export function buildFur(scene) {
    const B = new Builder();
    B.explicitNormals = true;

    // ---- helmet-to-suit neck seam -----------------------------------------
    // A ring just under the helmet ring, fibres pointing outward and a little
    // downward — the direction the blanket's edge actually lies when it is
    // clamped at the top and free at the bottom.
    const cols = 20;
    const bases = new Float32Array(cols * 3);
    const outs = new Float32Array(cols * 3);
    for (let c = 0; c < cols; c++) {
        const ang = (c / cols) * Math.PI * 2;
        const rx = Math.sin(ang), rz = Math.cos(ang);
        bases[c * 3] = rx * 0.100;
        bases[c * 3 + 1] = 1.458;
        bases[c * 3 + 2] = 0.004 + rz * 0.100;
        const l = Math.hypot(rx, -0.25, rz) || 1;
        outs[c * 3] = rx / l; outs[c * 3 + 1] = -0.25 / l; outs[c * 3 + 2] = rz / l;
    }
    emitFurBand(B, cols, bases, outs, 0.010, 0.014, NECK_SHELLS, B_HEAD, 0.75);

    // ---- glove cuffs -------------------------------------------------------
    for (let a = 0; a < 2; a++) {
        const s = a === 0 ? -1 : 1;
        const bone = a === 0 ? B_HAND_L : B_HAND_R;
        const n = 12;
        const cb = new Float32Array(n * 3);
        const co = new Float32Array(n * 3);
        // The forearm runs almost straight down in the bind pose, so the band's
        // ring sits in the XZ plane around it and its outward is radial.
        for (let c = 0; c < n; c++) {
            const ang = (c / n) * Math.PI * 2;
            const rx = Math.sin(ang), rz = Math.cos(ang);
            // Just below the wrist bearing, on the glove side of it, where the
            // blanket is clamped hard enough that a bone-bound band cannot
            // visibly separate from what it is meant to be attached to.
            cb[c * 3] = s * 0.244 + rx * 0.058;
            cb[c * 3 + 1] = 0.848;
            cb[c * 3 + 2] = 0.018 + rz * 0.058;
            co[c * 3] = rx; co[c * 3 + 1] = 0; co[c * 3 + 2] = rz;
        }
        emitFurBand(B, n, cb, co, 0.010, 0.016, CUFF_SHELLS, bone, 0.60);
    }

    return finishSkinned(scene, "charFur", B, true);
}

/** Cross-section steps across a nap band, and the arc they cover. */
const FUR_ARC_STEPS = 4;
const FUR_ARC = 2.1; // radians, centred on the outward direction

/**
 * One nap band.
 *
 * @param {Builder} B
 * @param {number} cols positions around the ring
 * @param {Float32Array} bases ring positions, 3 floats each
 * @param {Float32Array} outs unit outward direction per ring position
 * @param {number} r0 radius of the band's core, metres
 * @param {number} len fibre length beyond the core, metres
 * @param {number} shells
 * @param {number} bone
 * @param {number} ao
 */
function emitFurBand(B, cols, bases, outs, r0, len, shells, bone, ao) {
    const dir = new Float32Array((cols * (FUR_ARC_STEPS + 1)) * 3);

    // Precompute the cross-section directions once: each is the outward vector
    // rotated about the ring's own tangent.
    for (let c = 0; c < cols; c++) {
        const cn = (c + 1) % cols;
        const cp = (c - 1 + cols) % cols;
        let tx = bases[cn * 3] - bases[cp * 3];
        let ty = bases[cn * 3 + 1] - bases[cp * 3 + 1];
        let tz = bases[cn * 3 + 2] - bases[cp * 3 + 2];
        const tl = Math.hypot(tx, ty, tz) || 1;
        tx /= tl; ty /= tl; tz /= tl;

        const ox = outs[c * 3], oy = outs[c * 3 + 1], oz = outs[c * 3 + 2];
        // Third axis of the cross-section plane.
        const ax = ty * oz - tz * oy;
        const ay = tz * ox - tx * oz;
        const az = tx * oy - ty * ox;

        for (let k = 0; k <= FUR_ARC_STEPS; k++) {
            const phi = (k / FUR_ARC_STEPS - 0.5) * FUR_ARC;
            const cs = Math.cos(phi), sn = Math.sin(phi);
            const o = (c * (FUR_ARC_STEPS + 1) + k) * 3;
            dir[o] = ox * cs + ax * sn;
            dir[o + 1] = oy * cs + ay * sn;
            dir[o + 2] = oz * cs + az * sn;
        }
    }

    // Arc length around the ring, so the fibre field has a uniform pitch in
    // metres regardless of how big the band is. The shader multiplies this by a
    // density in cells per metre; anything else makes the neck seam and the
    // cuffs come out at different scales.
    const arc = new Float32Array(cols + 1);
    for (let c = 1; c <= cols; c++) {
        const a = ((c - 1) % cols) * 3;
        const b = (c % cols) * 3;
        arc[c] = arc[c - 1] + Math.hypot(
            bases[b] - bases[a], bases[b + 1] - bases[a + 1], bases[b + 2] - bases[a + 2]
        );
    }

    const stride = FUR_ARC_STEPS + 1;
    for (let s = 0; s < shells; s++) {
        const t = s / (shells - 1);
        const rowBase = B.pos.length / 3;

        for (let c = 0; c <= cols; c++) {
            const ci = c % cols;
            for (let k = 0; k <= FUR_ARC_STEPS; k++) {
                const o = (ci * stride + k) * 3;
                const dx = dir[o], dy = dir[o + 1], dz = dir[o + 2];
                const rad = r0 + len * t;
                const across = (k / FUR_ARC_STEPS - 0.5) * FUR_ARC * r0;
                const vi = B.vert(
                    bases[ci * 3] + dx * rad,
                    bases[ci * 3 + 1] + dy * rad,
                    bases[ci * 3 + 2] + dz * rad,
                    arc[c], across,
                    t, ao, bone, 1, 0, 0
                );
                B.normal(vi, dx, dy, dz);
            }
        }

        // Shells are independent sheets: each is stitched only to itself, never
        // to its neighbours. That is the whole idea — the gaps between them are
        // where you see through to the shell behind.
        for (let c = 0; c < cols; c++) {
            for (let k = 0; k < FUR_ARC_STEPS; k++) {
                const a = rowBase + c * stride + k;
                B.quad(a, a + 1, a + stride + 1, a + stride);
            }
        }
    }
}

// -----------------------------------------------------------------------------

function finishSkinned(scene, name, B, isFur) {
    const pos = new Float32Array(B.pos);
    const idx = new Uint32Array(B.idx);
    const nrm = B.explicitNormals ? new Float32Array(B.nrm) : computeNormals(pos, idx);

    const mesh = new Mesh(name, scene);
    const vd = new VertexData();
    vd.positions = pos;
    vd.indices = idx;
    vd.normals = nrm;
    vd.uvs = new Float32Array(B.uv);
    vd.applyToMesh(mesh, false);

    mesh.setVerticesData("aux", new Float32Array(B.aux), false, 2);
    mesh.setVerticesData("boneIdx", new Float32Array(B.bi), false, 4);
    mesh.setVerticesData("boneWt", new Float32Array(B.bw), false, 4);

    // The mesh is placed entirely by the vertex shader from bone matrices, so
    // its world matrix is the identity for ever and its bounding box is a lie.
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    mesh.doNotSyncBoundingInfo = true;
    mesh.metadata = { triangles: idx.length / 3, vertices: pos.length / 3, fur: !!isFur };
    return mesh;
}

// -----------------------------------------------------------------------------
//  Cloth render mesh
// -----------------------------------------------------------------------------

/**
 * The render mesh for the simulated soft goods.
 *
 * It carries no positions of its own — `position` is `(u, v, panelIndex)` and
 * the vertex shader reconstructs the surface by Catmull-Rom interpolation of the
 * panel's simulated node grid. That decoupling is what lets a 24x14 verlet solve
 * render as a smooth 48x28 surface, and it means the sim cost is independent of
 * how finely the panel is tessellated.
 *
 * @param {import("./cloth.js").ClothPanel[]} panels
 */
export function buildClothMesh(scene, panels) {
    const pos = [];
    const uv = [];
    const aux = [];
    const idx = [];

    for (let pi = 0; pi < panels.length; pi++) {
        const p = panels[pi];
        const cu = p.renderCols;
        const cv = p.renderRows;
        const base = pos.length / 3;

        for (let j = 0; j <= cv; j++) {
            const v = j / cv;
            for (let i = 0; i <= cu; i++) {
                const u = i / cu;
                pos.push(u, v, pi);
                uv.push(u * p.weaveU, v * p.weaveV);
                // (matId, ao). Panels darken toward their free edge, where they
                // sit in their own folds.
                aux.push(p.matId, p.aoTop + (p.aoBottom - p.aoTop) * v);
            }
        }

        const stride = cu + 1;
        for (let j = 0; j < cv; j++) {
            for (let i = 0; i < cu; i++) {
                const a = base + j * stride + i;
                const b = a + 1;
                const c = a + stride;
                const d = c + 1;
                idx.push(a, b, d, a, d, c);
            }
        }
    }

    const mesh = new Mesh("charCloth", scene);
    const vd = new VertexData();
    vd.positions = new Float32Array(pos);
    vd.indices = new Uint32Array(idx);
    vd.uvs = new Float32Array(uv);
    vd.applyToMesh(mesh, false);
    mesh.setVerticesData("aux", new Float32Array(aux), false, 2);

    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    mesh.doNotSyncBoundingInfo = true;
    mesh.metadata = { triangles: idx.length / 3, vertices: pos.length / 3 };
    return mesh;
}
