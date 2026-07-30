/**
 * The landmark complex's geometry, on the CPU.
 *
 * MIRROR CONTRACT: every formula here restates `landmark()` in
 * `src/shaders/lib/terrain.wgsl`, constant for constant. The bake carves the
 * craters, the canyon and the rille into the heightfield; this file tells the
 * mesh builder where the arch and the tube roofs belong over them. If one
 * side moves, both move — each file says so at the top of its copy.
 *
 * Everything is closed-form from the world seed, so the two sides cannot
 * drift through accumulation — only through an edit, which is what the
 * contract comment is for.
 */

function fract(x) {
    return x - Math.floor(x);
}

/**
 * Where everything in the complex sits, for one seed.
 *
 * @param {number} seed
 * @returns {{
 *   c1: {x:number,z:number}, r1: number,
 *   c2: {x:number,z:number}, r2: number,
 *   arch: {x:number,z:number,hx:number,hz:number},
 *   roofs: {x:number,z:number,hx:number,hz:number,len:number}[],
 *   rille: {x:number,z:number}[],
 * }}
 */
export function landmarkPoses(seed) {
    const ang = seed * 2.399963;
    const r1 = 120 + fract(seed * 0.771) * 80;
    // Capped so the far rim stays inside the 620 m play fence.
    const dist = 340 + fract(seed * 0.317) * (255 - r1);
    const c1 = { x: Math.sin(ang) * dist, z: Math.cos(ang) * dist };

    const phi2 = ang + 2.1 + fract(seed * 0.531) * 1.1;
    const d2 = { x: Math.sin(phi2), z: Math.cos(phi2) };
    const r2 = r1 * 0.45;
    const c2 = {
        x: c1.x + d2.x * (r1 + r2 * 0.55),
        z: c1.z + d2.z * (r1 + r2 * 0.55),
    };

    // The canyon arch stands at the midpoint of the cut, bridging across it:
    // its own axis runs along the canyon so its feet land on the two walls.
    const ca = { x: c1.x + d2.x * r1 * 0.55, z: c1.z + d2.z * r1 * 0.55 };
    const cb = { x: c2.x - d2.x * r2 * 0.4, z: c2.z - d2.z * r2 * 0.4 };
    const arch = {
        x: (ca.x + cb.x) / 2,
        z: (ca.z + cb.z) / 2,
        hx: d2.x,
        hz: d2.z,
    };

    // The rille path, and the three roofed reaches along it. Midpoints and
    // tangents come from the same ten-segment polyline the bake marches.
    // Inward, clear of the companion crater — see the bake's note.
    const phi3 = ang + Math.PI + 0.95 + fract(seed * 0.213) * 0.35;
    const d3 = { x: Math.sin(phi3), z: Math.cos(phi3) };
    const p3 = { x: d3.z, z: -d3.x };
    const at = (t) => {
        const along = r1 * 0.62 + t * 260;
        const sway = Math.sin(t * 3.6 + seed * 0.71) * 30 * t;
        return {
            x: c1.x + d3.x * along + p3.x * sway,
            z: c1.z + d3.z * along + p3.z * sway,
        };
    };
    const roofs = [];
    for (const [t, len] of [[0.32, 24], [0.50, 20], [0.68, 26]]) {
        const p = at(t);
        const a = at(t - 0.02);
        const b = at(t + 0.02);
        const hl = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        roofs.push({
            x: p.x, z: p.z,
            hx: (b.x - a.x) / hl, hz: (b.z - a.z) / hl,
            len,
        });
    }

    // The rille's own course, sampled along the same polyline — for anything
    // that wants to draw it, which today is the mini-map's tube trace.
    const rille = [];
    for (let i = 0; i <= 12; i++) rille.push(at(i / 12));

    return { c1, r1, c2, r2, arch, roofs, rille };
}
