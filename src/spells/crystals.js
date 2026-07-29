/**
 * The lattices Star Crystal grows.
 *
 * A fixed pool of prisms in one data-driven mesh: one draw, one 3 x 96 upload,
 * and no geometry generated at any point. A crystal that is not alive has zero
 * height, which collapses every one of its triangles onto its base point.
 *
 * Lifetime is deliberately long. This power alters the surface semi-permanently
 * through the charge channel of the terrain state buffer, which decays on a
 * fifteen-minute constant, so a burning patch of sea is still there long after
 * the geometry has gone. The prisms themselves come apart over about forty
 * seconds, which is long enough that the player can walk around a formation and
 * look at it, and short enough that a session does not silently fill up with
 * lattice.
 *
 * They are also the only mirror standing on the ground out here. Everything
 * else in frame is dust at nine percent albedo and a plasma boundary with no
 * coherent reflection at all; a grown facet is a real dielectric interface, so
 * this is the one caster that writes the screen-space reflection mask at full
 * strength rather than at a weight — and the pass costs nothing on every frame
 * where nobody has cast, because then nothing on the ground writes it at all.
 *
 * Allocation per frame: none.
 */

import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Vector3, Vector4 } from "@babylonjs/core/Maths/math";
import { Color3 } from "@babylonjs/core/Maths/math.color";

import { S } from "../core/settings.js";
import { whenReady, bindMatrixArray } from "../core/gpuUtil.js";
import { CASCADE_COUNT } from "../render/shadows.js";
import { SPELL_LIGHT_UNIFORMS } from "./spellLights.js";
import { POWERS } from "./powers.js";

/** Pool size. Two full formations' worth. */
export const CRYSTAL_MAX = 96;

/** Vertices per crystal: two rings of six, plus an apex. Matches the include. */
const VERTS = 13;
const RING = 6;

/** How many cascades a 40 cm prism is worth drawing into. */
const CRYSTAL_CASCADES = 2;

/**
 * Seconds for a finished crystal's emission to fall most of the way to its
 * resting ember.
 *
 * The charge is shed as the lattice *orders itself*, so the light is a property
 * of the growth rather than of the object. A crystal that kept blazing for the
 * thirty-four seconds it stands would turn a formation into a light fitting the
 * player has to walk around; one that went dark the instant it finished would
 * make the growth read as a flash with a prop left behind. A few seconds is the
 * window where it still reads as the same event settling down.
 */
const HEAT_TAU = 3.5;

/**
 * What a finished crystal settles to, as a fraction of its peak.
 *
 * Not zero. A standing formation has to stay findable from across a field whose
 * ground reflects nine percent of what lands on it, and at this fraction the
 * ember sits just under the bloom threshold — present, and not asserting
 * itself.
 */
const HEAT_EMBER = 0.18;

const _splits = new Vector4();

/**
 * What a grown lattice emits, with its radiance already folded into the hue.
 *
 * A crystal is not a lamp — most of what it shows is the galaxy behind it, bent,
 * and the dust sea reflected off its facets. But an ordered lattice is shedding
 * the charge the loose grains it grew out of were carrying, and out here that is
 * the difference between a formation the player can see from across the field
 * and one that only exists where the star happens to rake it. The gain is
 * Star Crystal's own, so the prisms, the light they cast and the patch they
 * leave in the ground are all one colour.
 *
 * Constant, so it is set once at material construction rather than restated
 * every frame; the per-crystal variation rides in the data texture instead.
 */
const _crystalGlow = new Color3(
    POWERS.lattice.hue[0] * POWERS.lattice.body,
    POWERS.lattice.hue[1] * POWERS.lattice.body,
    POWERS.lattice.hue[2] * POWERS.lattice.body
);

export class CrystalField {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {import("../render/sky.js").Sky} sky
     * @param {import("../render/shadows.js").ShadowSystem} shadows
     * @param {import("./spellLights.js").SpellLights} lights
     */
    constructor(scene, sky, shadows, lights) {
        this.scene = scene;
        this.sky = sky;
        this.shadows = shadows;
        this.lights = lights;

        // Rows: (x,y,z,height) / (axis,radius) / (growth, seed, glow scale, heat)
        this._texData = new Float32Array(CRYSTAL_MAX * 3 * 4);
        this.dataTex = RawTexture.CreateRGBATexture(
            this._texData, CRYSTAL_MAX, 3, scene,
            false, false,
            Constants.TEXTURE_NEAREST_SAMPLINGMODE,
            Constants.TEXTURETYPE_FLOAT
        );
        this.dataTex.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.dataTex.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;

        // CPU-side lifetime. Kept out of the texture because none of it is read
        // by a shader and packing it there would mean re-uploading to age.
        this.age = new Float32Array(CRYSTAL_MAX);
        this.life = new Float32Array(CRYSTAL_MAX);
        /** Seconds the crystal spends growing from nothing to full size. */
        this.grow = new Float32Array(CRYSTAL_MAX);
        this.alive = new Uint8Array(CRYSTAL_MAX);
        this._next = 0;
        this.liveCount = 0;

        this.mesh = buildMesh(scene);
        this.material = this._makeMaterial();
        this.mesh.material = this.material;
        // With the terrain. See the note at the top of the fragment shader: the
        // refracted lookup already carries what is behind the lattice, so what
        // the blend is for is the join to the ground rather than the backdrop.
        this.mesh.renderingGroupId = 1;
        this.mesh.isVisible = false;

        /** @type {ShaderMaterial[]} */
        this._depthMats = [];
        shadows.registerCaster(
            this.mesh, (c) => this._makeDepthMaterial(c), CRYSTAL_CASCADES
        );

        this._camPos = new Vector3();
        this._dirty = true;
    }

    _makeMaterial() {
        const mat = new ShaderMaterial(
            "starCrystal", this.scene, { vertex: "crystal", fragment: "crystal" },
            {
                attributes: ["position"],
                uniforms: [
                    "viewProjection", "cameraPos",
                    "sunDir", "sunRadiance", "shR",
                    "cascadeMatrices", "cascadeSplits", "cascadeParams",
                    "shadowTexel", "shadowSoftness", "shadowBias",
                    "fogDensity", "fogHeightFalloff", "fogStart", "aerialStrength",
                    "ambientIntensity", "sssStrength",
                    "glintIntensity", "glintGrazing", "crystalGlowColor",
                    ...SPELL_LIGHT_UNIFORMS,
                ],
                samplers: ["crystalTex", "skyLUT", "cascade0", "cascade1", "cascade2"],
                shaderLanguage: ShaderLanguage.WGSL,
                needAlphaBlending: true,
            }
        );
        // A prism is a closed solid, but a dead crystal's triangles are
        // degenerate and a growing one is very thin — culling buys nothing here
        // and costs a black inside face wherever the winding flips.
        mat.backFaceCulling = false;
        // Blended *and* depth-writing. See the note at the top of
        // `crystal.fragment.wgsl`: this is what gives transparency against the
        // dust without letting forty prisms blend over each other.
        mat.alphaMode = Constants.ALPHA_COMBINE;
        mat.needAlphaBlending = () => true;
        mat.disableDepthWrite = false;
        mat.forceDepthWrite = true;
        mat.setTexture("crystalTex", this.dataTex);
        mat.setTexture("skyLUT", this.sky.lut);
        for (let i = 0; i < CASCADE_COUNT; i++) {
            mat.setTexture("cascade" + i, this.shadows.maps[i]);
        }
        mat.setColor3("crystalGlowColor", _crystalGlow);
        return mat;
    }

    _makeDepthMaterial(cascade) {
        const mat = new ShaderMaterial(
            "crystalDepth" + cascade, this.scene,
            { vertex: "crystalDepth", fragment: "terrainDepth" },
            {
                attributes: ["position"],
                uniforms: ["lightViewProjection"],
                samplers: ["crystalTex"],
                shaderLanguage: ShaderLanguage.WGSL,
                defines: ["CRYSTAL_CASCADE " + cascade],
            }
        );
        mat.backFaceCulling = false;
        mat.setTexture("crystalTex", this.dataTex);
        this._depthMats.push(mat);
        return mat;
    }

    /**
     * The camera-space depth prepass material.
     *
     * The lattice writes the reflection mask at full strength, which nothing
     * else standing on the ground does: the dust sea writes a weight
     * proportional to how far a Star Crystal patch has vitrified it, and a
     * plasma body writes nothing at all. A prism is a mirror over the whole of
     * itself, so there is nothing to weight it by — and the mask is zero
     * everywhere on every frame where nobody has cast, so the reflection pass
     * costs nothing then.
     *
     * @param {import("../render/depthPass.js").DepthPass} depth
     */
    registerPrepass(depth) {
        const mat = new ShaderMaterial(
            "crystalPrepass", this.scene,
            { vertex: "crystalPrepass", fragment: "prepass" },
            {
                attributes: ["position"],
                uniforms: ["viewProjection"],
                samplers: ["crystalTex"],
                shaderLanguage: ShaderLanguage.WGSL,
            }
        );
        mat.backFaceCulling = false;
        mat.setTexture("crystalTex", this.dataTex);
        this.prepassMat = mat;
        depth.registerCaster(this.mesh, mat);
    }

    /**
     * Plant one crystal.
     *
     * @param {number} x @param {number} y @param {number} z base, world
     * @param {number} ax @param {number} ay @param {number} az growth axis
     * @param {number} height metres at full growth
     * @param {number} radius metres at full growth
     * @param {number} growSeconds time from nothing to full size
     * @param {number} life seconds before it starts coming apart
     */
    plant(x, y, z, ax, ay, az, height, radius, growSeconds, life) {
        let i = this._next;
        for (let n = 0; n < CRYSTAL_MAX; n++) {
            if (!this.alive[i]) break;
            i = (i + 1) % CRYSTAL_MAX;
            // Pool full: the oldest formation is the one to sacrifice, but
            // hunting for it costs more than it is worth at this count. Dropping
            // the new crystal loses one prism out of a cluster of forty, which
            // nobody can see.
            if (n === CRYSTAL_MAX - 1) return;
        }
        this._next = (i + 1) % CRYSTAL_MAX;

        const d = this._texData;
        const w = CRYSTAL_MAX * 4;
        let o = i * 4;
        d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = height;
        o += w;
        d[o] = ax; d[o + 1] = ay; d[o + 2] = az; d[o + 3] = radius;
        o += w;
        // Per-crystal emission scale. A cluster where every prism burns at
        // exactly the same radiance reads as forty copies of one object, and the
        // silhouette variation `seed` already gives them is not enough on its
        // own once they are all generating light. Hashed off the index and the
        // position so it is stable for the crystal's whole life and does not
        // repeat between formations.
        const gh = (i * 0.7548777 + x * 0.271 + z * 0.577) % 1;
        d[o] = 0; d[o + 1] = (i * 0.618034 + x * 0.137 + z * 0.311) % 1;
        d[o + 2] = 0.55 + 0.70 * (gh < 0 ? gh + 1 : gh); d[o + 3] = 0;
        // `heat` starts at zero and `update` writes it on the first frame this
        // crystal is aged, so a prism planted mid-frame never appears at full
        // brightness with no geometry under it.

        this.age[i] = 0;
        this.life[i] = life;
        this.grow[i] = Math.max(growSeconds, 0.05);
        this.alive[i] = 1;
        this._dirty = true;
    }

    /**
     * Age the field and upload.
     * @param {number} dt
     * @param {Vector3} cameraPos
     */
    update(dt, cameraPos) {
        this._camPos.copyFrom(cameraPos);

        const d = this._texData;
        const w = CRYSTAL_MAX * 4;
        const growRow = w * 2;
        let live = 0;

        for (let i = 0; i < CRYSTAL_MAX; i++) {
            if (!this.alive[i]) continue;
            this.age[i] += dt;
            const a = this.age[i];
            const life = this.life[i];

            let g;
            if (a < this.grow[i]) {
                g = a / this.grow[i];
            } else if (a < life) {
                g = 1;
            } else {
                // The prism retreats rather than fading, so it goes back into the
                // sea it came out of. Nothing here pops.
                const t = (a - life) / 6.0;
                if (t >= 1) {
                    this.alive[i] = 0;
                    d[growRow + i * 4] = 0;
                    d[growRow + i * 4 + 3] = 0;
                    this._dirty = true;
                    continue;
                }
                g = 1 - t;
            }

            // Temperature, on its own clock. Full while the lattice is ordering
            // itself, settling to an ember over the next few seconds, and scaled
            // by the growth at both ends so a crystal that is barely there or
            // half retreated does not emit as though it were whole.
            const settle = Math.exp(-Math.max(a - this.grow[i], 0) / HEAT_TAU);
            d[growRow + i * 4] = g;
            d[growRow + i * 4 + 3] = (HEAT_EMBER + (1 - HEAT_EMBER) * settle) * g;
            live++;
        }

        this.liveCount = live;
        this.mesh.isVisible = live > 0 && S.showSpells !== false;

        if (this.mesh.isVisible || this._dirty) {
            this.dataTex.update(d);
            this._dirty = false;
        }
        if (this.mesh.isVisible) this._pushUniforms();
    }

    _pushUniforms() {
        const m = this.material;
        const sky = this.sky;
        const sh = this.shadows;

        m.setVector3("cameraPos", this._camPos);
        m.setVector3("sunDir", sky.sunDir);
        m.setColor3("sunRadiance", sky.sunRadiance);
        m.setArray4("shR", sky.sh);

        bindMatrixArray(m, "cascadeMatrices", sh.matrixData);
        _splits.set(sh.splits[0], sh.splits[1], sh.splits[2], sh.splits[3]);
        m.setVector4("cascadeSplits", _splits);
        m.setArray4("cascadeParams", sh.paramData);
        m.setFloat("shadowTexel", sh.texelSize);
        m.setFloat("shadowSoftness", 1.3);
        m.setFloat("shadowBias", 0.012);

        m.setFloat("fogDensity", S.fogDensity);
        m.setFloat("fogHeightFalloff", S.fogHeightFalloff);
        m.setFloat("fogStart", S.fogStart);
        m.setFloat("aerialStrength", S.aerialStrength);
        m.setFloat("ambientIntensity", S.ambientIntensity);
        m.setFloat("sssStrength", S.sssStrength);
        m.setFloat("glintIntensity", S.glintIntensity);
        m.setFloat("glintGrazing", S.glintGrazing);

        this.lights.apply(m);
    }

    get triangles() {
        return this.mesh.isVisible ? this.liveCount * (RING * 3) : 0;
    }

    /**
     * Compile both pipelines behind the loading screen.
     *
     * The crystal is planted and **left standing** through the warm-up frames.
     * See the same note on `WaterBody.warmUp`: `isReady()` builds the shader
     * module, but the WebGPU render pipeline — blend state, depth state, target
     * formats — is only built when a triangle actually goes through it. Hiding
     * the mesh here moved that cost onto the first cast, where it measured
     * 156 ms.
     */
    async warmUp(x, y, z) {
        this.plant(x, y + 0.02, z, 0.1, 1, 0.05, 0.6, 0.09, 0.2, 999);
        this.update(0.21, this._camPos);
        this.mesh.isVisible = true;
        this._pushUniforms();

        await whenReady(this.material, "crystal material", [this.mesh, false]);
        for (let i = 0; i < this._depthMats.length; i++) {
            await whenReady(this._depthMats[i], this._depthMats[i].name, [this.mesh, false]);
        }
        if (this.prepassMat) {
            await whenReady(this.prepassMat, "crystal prepass", [this.mesh, false]);
        }
    }

    /**
     * Retire the warm-up crystal, after the warm-up frames have drawn it. It
     * must not be standing in the first frame the player sees.
     */
    finishWarmUp() {
        for (let i = 0; i < CRYSTAL_MAX; i++) this.alive[i] = 0;
        this._texData.fill(0);
        this.dataTex.update(this._texData);
        this.liveCount = 0;
        this._next = 0;
        this.mesh.isVisible = false;
    }

    dispose() {
        this.mesh.dispose();
        this.material.dispose();
        for (let i = 0; i < this._depthMats.length; i++) this._depthMats[i].dispose();
        this.dataTex.dispose();
    }
}

/** Static lattice: `position` is (crystal, vertex, 0). */
function buildMesh(scene) {
    const pos = new Float32Array(CRYSTAL_MAX * VERTS * 3);
    const idx = new Uint32Array(CRYSTAL_MAX * RING * 3 * 3);

    let vi = 0;
    let ii = 0;
    for (let i = 0; i < CRYSTAL_MAX; i++) {
        for (let v = 0; v < VERTS; v++) {
            pos[vi++] = i;
            pos[vi++] = v;
            pos[vi++] = 0;
        }
        const b = i * VERTS;
        for (let k = 0; k < RING; k++) {
            const k2 = (k + 1) % RING;
            const b0 = b + k;
            const b1 = b + k2;
            const s0 = b + RING + k;
            const s1 = b + RING + k2;
            const apex = b + RING * 2;
            // Side quad.
            idx[ii++] = b0; idx[ii++] = s0; idx[ii++] = s1;
            idx[ii++] = b0; idx[ii++] = s1; idx[ii++] = b1;
            // Tip.
            idx[ii++] = s0; idx[ii++] = apex; idx[ii++] = s1;
        }
    }

    const mesh = new Mesh("starCrystals", scene);
    const vd = new VertexData();
    vd.positions = pos;
    vd.indices = idx;
    vd.applyToMesh(mesh, false);
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    mesh.doNotSyncBoundingInfo = true;
    mesh.metadata = { triangles: idx.length / 3, vertices: CRYSTAL_MAX * VERTS };
    return mesh;
}
