/**
 * The landmark complex's geometry, on the CPU.
 *
 * MIRROR CONTRACT: every formula here restates `landmark()` in
 * `src/shaders/lib/terrain.wgsl`, constant for constant. The bake carves the
 * craters, the canyon and the rille into the heightfield; this file tells
 * the mini-map where to draw its chart of them. If one side moves, both
 * move — each file says so at the top of its copy.
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

    // The rille path, from the same polyline the bake marches.
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
    // The rille's own course, sampled along the same polyline — for anything
    // that wants to draw it, which today is the mini-map's tube trace.
    const rille = [];
    for (let i = 0; i <= 12; i++) rille.push(at(i / 12));

    return { c1, r1, c2, r2, rille };
}
