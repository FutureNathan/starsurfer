/**
 * The built rock: the canyon arch and the lava-tube roofs.
 *
 * A heightfield cannot hold a tunnel — height is single-valued, and an
 * overhang needs two surfaces on one vertical. So the landmark's bake carves
 * everything *open* (the canyon, the rille trench through the dome), and this
 * module closes the parts that should be closed with real geometry: one arch
 * over the canyon between the twin craters, and three barrel-vault roofs
 * where the rille crosses under the dome — a collapsed lava tube with intact
 * reaches and skylights between them, which is the shape real lunar tubes
 * actually present to the surface.
 *
 * One mesh, one draw. Each piece is a lofted half-barrel shell: an outer
 * vault, an inner vault, closed at the ends by pinching the two together.
 * Vertices are baked in *world space* (the complex is singular and static —
 * a world matrix would multiply by identity forever), lumped by hash noise so
 * the rock reads as rock, with per-vertex AO darkening the vault interiors —
 * a cave can precompute its own darkness.
 *
 * Placement comes from `landmark.js`, which mirrors the bake's formulas; the
 * feet are planted through `terrain.heightAt` *after* the bake, so they stand
 * on the actual carved ground, buried two metres so no shell edge ever shows.
 *
 * The mesh registers into the shadow cascades (the roof's shadow falling
 * across the channel is most of the tunnel read) and into the depth prepass
 * (the streak pass reads it — without this, star streaks would smear across
 * the rock overhead exactly when surfing under it at speed).
 */

import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";

import { S } from "../core/settings.js";
import { whenReady } from "../core/gpuUtil.js";
import { landmarkPoses } from "./landmark.js";

/** Cheap deterministic value noise for the rock lumps. */
function lump(x, y, z) {
    const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
}

/**
 * Append one vault: a half-barrel shell from foot to foot.
 *
 * @param {number[]} P positions  @param {number[]} N normals
 * @param {number[]} U uvs (x = AO)  @param {number[]} I indices
 * @param {{x:number,z:number,hx:number,hz:number}} pose axis through the piece
 * @param {number} len metres along the axis
 * @param {number} span metres between the outer feet
 * @param {number} crown inner clearance at the top, metres above footY
 * @param {number} thick shell thickness, metres
 * @param {number} footY world Y the feet are planted at
 * @param {number} seed decorrelates the lumps between pieces
 */
function addVault(P, N, U, I, pose, len, span, crown, thick, footY, seed) {
    const AXIS = 10;   // rings along the piece
    const ARC = 18;    // steps across the half-arc, outer + inner
    const rx = -pose.hz, rz = pose.hx; // across the channel

    const base = P.length / 3;
    const innerHalf = span / 2 - thick;

    // Parametric shell: v walks the outer arc foot→crown→foot, then back
    // along the inner arc. The ends pinch outer to inner so the shell closes.
    const rings = [];
    for (let a = 0; a <= AXIS; a++) {
        const u = a / AXIS;
        const along = (u - 0.5) * len;
        // Pinch: the last ring and a half at each end tapers the shell shut.
        const pinch = Math.min(1, Math.min(u, 1 - u) * AXIS / 1.5);
        const ring = [];
        for (let v = 0; v <= ARC * 2; v++) {
            const outer = v <= ARC;
            const t = outer ? v / ARC : (v - ARC) / ARC;
            const th = (outer ? t : 1 - t) * Math.PI;
            const half = outer
                ? innerHalf + thick
                : innerHalf + thick * (1 - pinch);
            const ch = outer
                ? crown + thick
                : crown + thick * (1 - pinch);
            let px = Math.cos(th) * half;
            let py = Math.sin(th) * ch;
            // Rock lumps, frozen at build time. Kept off the feet so the
            // shell always meets the ground cleanly.
            const l = lump(px * 0.7 + seed, py * 0.8, along * 0.6) * 0.5
                + lump(px * 2.3, py * 2.1 + seed, along * 1.9) * 0.22;
            const lk = Math.min(1, py / 2.5);
            px += l * 0.55 * lk * Math.cos(th);
            py += l * 0.55 * lk * Math.max(0.2, Math.sin(th));
            ring.push([
                pose.x + rx * px + pose.hx * along,
                footY + py,
                pose.z + rz * px + pose.hz * along,
                outer ? 1 : 0,
            ]);
        }
        rings.push(ring);
    }

    const W = ARC * 2 + 1;
    for (let a = 0; a <= AXIS; a++) {
        for (let v = 0; v <= ARC * 2; v++) {
            const [x, y, z, outer] = rings[a][v];
            P.push(x, y, z);
            // Normals by central difference over the ring lattice.
            const va = rings[Math.min(a + 1, AXIS)][v];
            const vb = rings[Math.max(a - 1, 0)][v];
            const vc = rings[a][Math.min(v + 1, ARC * 2)];
            const vd = rings[a][Math.max(v - 1, 0)];
            const e1 = [va[0] - vb[0], va[1] - vb[1], va[2] - vb[2]];
            const e2 = [vc[0] - vd[0], vc[1] - vd[1], vc[2] - vd[2]];
            let nx = e1[1] * e2[2] - e1[2] * e2[1];
            let ny = e1[2] * e2[0] - e1[0] * e2[2];
            let nz = e1[0] * e2[1] - e1[1] * e2[0];
            const nl = Math.hypot(nx, ny, nz) || 1;
            // The lattice winds so the outer surface's cross faces out; the
            // inner pass runs reversed, so flip its normal inward.
            const s = outer ? 1 : -1;
            N.push((nx / nl) * s, (ny / nl) * s, (nz / nl) * s);
            // AO: the inner vault is dark, deepest at the crown; the outer
            // surface keeps a soft floor so its underside edges shade.
            const heightK = Math.max(0, y - footY) / (crown + thick);
            U.push(outer ? 1 - heightK * 0.12 : 0.62 - 0.34 * heightK, 0);
        }
    }
    for (let a = 0; a < AXIS; a++) {
        for (let v = 0; v < ARC * 2; v++) {
            const i0 = base + a * W + v;
            I.push(i0, i0 + 1, i0 + W, i0 + 1, i0 + W + 1, i0 + W);
        }
    }
}

export class Arches {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {import("./terrain.js").Terrain} terrain
     * @param {import("../render/sky.js").Sky} sky
     * @param {import("../render/shadows.js").ShadowSystem} shadows
     * @param {import("../render/depthPass.js").DepthPass} depthPass
     */
    constructor(scene, terrain, sky, shadows, depthPass) {
        this.sky = sky;
        const poses = landmarkPoses(Number(S.worldSeed));

        const P = [], N = [], U = [], I = [];

        // The canyon arch: spans across the cut, axis along it.
        const a = poses.arch;
        const bridge = { x: a.x, z: a.z, hx: a.hx, hz: a.hz };
        const footA = terrain.heightAt(a.x - a.hz * 9, a.z + a.hx * 9);
        const footB = terrain.heightAt(a.x + a.hz * 9, a.z - a.hx * 9);
        addVault(P, N, U, I, bridge, 8, 19, 7.2, 2.4,
                 Math.max(footA, footB) - 2, 3.1);

        // The tube roofs, feet on the levees either side of the rille.
        for (let i = 0; i < poses.roofs.length; i++) {
            const r = poses.roofs[i];
            const fa = terrain.heightAt(r.x - r.hz * 8, r.z + r.hx * 8);
            const fb = terrain.heightAt(r.x + r.hz * 8, r.z - r.hx * 8);
            addVault(P, N, U, I, r, r.len, 17, 5.6, 2.2,
                     Math.max(fa, fb) - 2, 11.7 + i * 7.3);
        }

        const mesh = new Mesh("arches", scene);
        const vd = new VertexData();
        vd.positions = new Float32Array(P);
        vd.normals = new Float32Array(N);
        vd.uvs = new Float32Array(U);
        vd.indices = new Uint32Array(I);
        vd.applyToMesh(mesh, false);
        mesh.isPickable = false;
        mesh.alwaysSelectAsActiveMesh = true; // small, singular, always near the play area
        mesh.renderingGroupId = 1;
        this.mesh = mesh;

        const mat = new ShaderMaterial("archMat", scene,
            { vertex: "arch", fragment: "arch" },
            {
                attributes: ["position", "normal", "uv"],
                uniforms: [
                    "viewProjection", "cameraPosition",
                    "sunDir", "sunRadiance", "shR", "ambientIntensity",
                    "dustEmission",
                    "fogDensity", "fogHeightFalloff", "fogStart", "aerialStrength",
                ],
                samplers: ["skyLUT"],
                shaderLanguage: ShaderLanguage.WGSL,
            });
        mat.backFaceCulling = true;
        mesh.material = mat;
        this.material = mat;

        // Shadow casting into the two near cascades: the roof's shadow across
        // the channel floor is most of what makes the tunnel a tunnel.
        /** @type {ShaderMaterial[]} */
        this._aux = [];
        shadows.registerCaster(mesh, (c) => {
            const dm = new ShaderMaterial("archDepth" + c, scene,
                { vertex: "archDepth", fragment: "terrainDepth" },
                {
                    attributes: ["position"],
                    uniforms: ["lightViewProjection"],
                    shaderLanguage: ShaderLanguage.WGSL,
                });
            this._aux.push(dm);
            return dm;
        }, 2);

        const pre = new ShaderMaterial("archPrepass", scene,
            { vertex: "archPrepass", fragment: "prepass" },
            {
                attributes: ["position"],
                uniforms: ["viewProjection"],
                shaderLanguage: ShaderLanguage.WGSL,
            });
        depthPass.registerCaster(mesh, pre);
        this._aux.push(pre);
    }

    /** Compile every pipeline behind the loading screen, like everyone else. */
    async warmUp() {
        this.update();
        await whenReady(this.material, "arch", [this.mesh, false]);
        for (let i = 0; i < this._aux.length; i++) {
            await whenReady(this._aux[i], "arch aux " + i, [this.mesh, false]);
        }
    }

    /** Once per frame — a handful of scalar uniforms off the live sky. */
    update() {
        const m = this.material;
        const sky = this.sky;
        m.setVector3("cameraPosition", this.mesh.getScene().activeCamera.globalPosition);
        m.setVector3("sunDir", sky.sunDir);
        m.setColor3("sunRadiance", sky.sunRadiance);
        m.setArray4("shR", sky.sh);
        m.setFloat("ambientIntensity", S.ambientIntensity);
        m.setColor3("dustEmission", sky.dustEmit);
        m.setTexture("skyLUT", sky.lut);
        m.setFloat("fogDensity", S.fogDensity);
        m.setFloat("fogHeightFalloff", S.fogHeightFalloff);
        m.setFloat("fogStart", S.fogStart);
        m.setFloat("aerialStrength", S.aerialStrength);
    }
}
