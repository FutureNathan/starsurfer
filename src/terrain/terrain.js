/**
 * The dust field: owns the heightfield, the clipmap mesh, the surface material,
 * the shadow-pass materials and the generated grain map.
 *
 * Per frame this uploads a handful of uniforms and nothing else. No geometry is
 * rebuilt, no buffer is re-uploaded, nothing is allocated.
 */

import { Vector2, Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { ProceduralTexture } from "@babylonjs/core/Materials/Textures/Procedurals/proceduralTexture";
import { Constants } from "@babylonjs/core/Engines/constants";

import { Heightfield, WORLD_SIZE } from "./heightfield.js";
import { DeformationField } from "./deformation.js";
import {
    buildClipmapMesh,
    BASE_SPACING,
    GRID_HALF_N,
    OUTER_EXTENT,
} from "./clipmapMesh.js";
import { S } from "../core/settings.js";
import { LIN } from "../core/brand.js";
import { CASCADE_COUNT } from "../render/shadows.js";
import { SPELL_LIGHT_UNIFORMS } from "../spells/spellLights.js";
import { bakeOnce, whenReady, bindMatrixArray } from "../core/gpuUtil.js";

const DETAIL_RES = 1024;

const _splits = new Vector4(0, 0, 0, 0);
const _lod = new Vector2();
const _screen = new Vector2();

// The dust's emission ramp, straight off the brand palette. `dustGlowColor` is
// what freshly thrown and charged dust burns at; `dustCoolColor` is the slow
// nebula glow the field sits in at rest. Built once — neither is animated.
const _dustGlow = new Color3(...LIN.accent);
// Halfway between the nebula's own violet and the lit dust colour. Pure
// nebula-violet has almost no green in it, and a surface whose only light in
// shadow is that colour reads as flat magenta rather than as violet-lit dust.
const _dustCool = new Color3(
    LIN.nebulaBright[0] + 0.45 * (LIN.dust[0] - LIN.nebulaBright[0]),
    LIN.nebulaBright[1] + 0.45 * (LIN.dust[1] - LIN.nebulaBright[1]),
    LIN.nebulaBright[2] + 0.45 * (LIN.dust[2] - LIN.nebulaBright[2])
);

/**
 * Radiance per unit of `S.dustGlow`.
 *
 * The colours above are reflectances — they live in [0,1] because that is what a
 * hex code can express. Emission does not: the star puts lit dust near 5 in
 * linear units, so a glow authored in the same range as an albedo would be two
 * orders of magnitude too faint to see. This is the factor that moves it onto
 * the scene's radiance scale, and it is set so the resting glow lands near a
 * fifth of lit dust — present everywhere, dominant only in shadow.
 *
 * `DUST_EMISSION` in render/sky.js is this same quantity, averaged, and the two
 * have to move together or the horizon separates into two colours.
 */
const DUST_EMIT_SCALE = 10.0;

const DEBUG_MODES = {
    beauty: 0, deform: 1, normals: 2, depth: 3, cascades: 4,
    footprint: 5, fineNormals: 6, shadow: 7, ndotl: 8, shadowMap: 9,
    albedo: 10,
};

export class Terrain {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {import("../render/sky.js").Sky} sky
     * @param {import("../render/shadows.js").ShadowSystem} shadows
     */
    constructor(scene, sky, shadows) {
        this.scene = scene;
        this.sky = sky;
        this.shadows = shadows;

        this.heightfield = new Heightfield(scene);

        /** The terrain state buffer. Feet, the surf wake and every spell write here. */
        this.deform = new DeformationField(scene);

        // Generated dust grain, tiled at three world scales by the material.
        this.detailTex = new ProceduralTexture(
            "detailTex",
            { width: DETAIL_RES, height: DETAIL_RES },
            "detailBake",
            scene,
            {
                generateMipMaps: true,
                type: Constants.TEXTURETYPE_UNSIGNED_BYTE,
                format: Constants.TEXTUREFORMAT_RGBA,
                samplingMode: Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
                shaderLanguage: ShaderLanguage.WGSL,
                skipSceneRegistration: true,
            }
        );
        this.detailTex.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
        this.detailTex.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
        this.detailTex.refreshRate = 0;

        this.mesh = buildClipmapMesh(scene);

        this.material = this._makeDustMaterial();
        this.mesh.material = this.material;

        // One depth material per cascade, so each can carry its own matrix
        // without any mid-frame uniform-buffer swapping.
        shadows.registerCaster(this.mesh, (c) => this._makeDepthMaterial(c));

        this.setDeformTexture(this.deform.texture);
    }

    _makeDustMaterial() {
        const mat = new ShaderMaterial(
            "dust",
            this.scene,
            { vertex: "dust", fragment: "dust" },
            {
                attributes: ["position"],
                uniforms: [
                    "viewProjection", "cameraPos", "lodCenter",
                    "baseSpacing", "gridHalfN",
                    "worldOrigin", "worldSize", "heightRes",
                    "windAngle", "macroAmp", "sastrugiAmp",
                    "sunDir", "sunRadiance",
                    "shR",
                    "cascadeMatrices", "cascadeSplits", "cascadeParams",
                    "shadowTexel", "shadowSoftness", "shadowBias",
                    "detailStrength", "glintIntensity", "glintGrazing",
                    "sssStrength", "sssRadius",
                    "fogDensity", "fogHeightFalloff", "fogStart", "aerialStrength",
                    "deformCenter", "deformSize", "deformTexel", "deformDepthScale",
                    "ambientIntensity",
                    "dustEmissive", "dustGlowColor", "dustCoolColor",
                    "debugMode", "screenSize",
                    ...SPELL_LIGHT_UNIFORMS,
                ],
                samplers: [
                    "heightTex", "auxTex", "detailTex", "skyLUT",
                    "cascade0", "cascade1", "cascade2", "deformTex",
                ],
                shaderLanguage: ShaderLanguage.WGSL,
            }
        );

        mat.backFaceCulling = true;
        mat.setTexture("heightTex", this.heightfield.heightTex);
        mat.setTexture("auxTex", this.heightfield.auxTex);
        mat.setTexture("detailTex", this.detailTex);
        mat.setTexture("skyLUT", this.sky.lut);
        for (let i = 0; i < CASCADE_COUNT; i++) {
            mat.setTexture("cascade" + i, this.shadows.maps[i]);
        }
        return mat;
    }

    /**
     * The camera-space depth prepass material.
     *
     * Same clipmap and deformation code as the beauty pass through the same
     * includes; only the fragment stage differs. Registered with the prepass
     * rather than with the shadow system, so it takes `viewProjection` — which
     * Babylon binds from the active camera, and which by then carries this
     * frame's temporal jitter.
     */
    makePrepassMaterial() {
        const mat = new ShaderMaterial(
            "terrainPrepass",
            this.scene,
            { vertex: "terrainPrepass", fragment: "prepass" },
            {
                attributes: ["position"],
                uniforms: [
                    "viewProjection", "cameraPos", "lodCenter",
                    "baseSpacing", "gridHalfN",
                    "worldOrigin", "worldSize", "heightRes",
                    "windAngle", "sastrugiAmp",
                    "deformCenter", "deformSize", "deformDepthScale",
                ],
                samplers: ["heightTex", "auxTex", "deformTex"],
                shaderLanguage: ShaderLanguage.WGSL,
            }
        );
        mat.backFaceCulling = false;
        mat.setTexture("heightTex", this.heightfield.heightTex);
        mat.setTexture("auxTex", this.heightfield.auxTex);
        this.prepassMat = mat;
        return mat;
    }

    _makeDepthMaterial(cascade) {
        const mat = new ShaderMaterial(
            "terrainDepth" + cascade,
            this.scene,
            { vertex: "terrainDepth", fragment: "terrainDepth" },
            {
                attributes: ["position"],
                uniforms: [
                    "lightViewProjection", "cameraPos", "lodCenter",
                    "baseSpacing", "gridHalfN",
                    "worldOrigin", "worldSize", "heightRes",
                    "windAngle", "sastrugiAmp",
                    "deformCenter", "deformSize", "deformDepthScale",
                ],
                samplers: ["heightTex", "auxTex", "deformTex"],
                shaderLanguage: ShaderLanguage.WGSL,
                // Forces a distinct Effect per cascade, so each can carry its
                // own light matrix without mid-frame uniform swapping.
                defines: ["DEPTH_CASCADE " + cascade],
            }
        );
        mat.backFaceCulling = false;
        mat.setTexture("heightTex", this.heightfield.heightTex);
        mat.setTexture("auxTex", this.heightfield.auxTex);
        if (!this._depthMats) this._depthMats = [];
        this._depthMats.push(mat);
        return mat;
    }

    async build() {
        this.detailTex.setFloat("resolution", DETAIL_RES);
        // Tilts a grain dome's flank to roughly 30 degrees. Higher reads as
        // gravel, lower stops registering at all.
        this.detailTex.setFloat("grainScale", 0.013);
        await bakeOnce(this.detailTex, "detailBake");

        await this.heightfield.bake();

        // The cascade fitter needs the world's vertical extent to size each
        // light volume's depth range. A margin covers carved berms and anything
        // standing on the dust.
        this.shadows.setHeightBounds(
            this.heightfield.minHeight - 4,
            this.heightfield.maxHeight + 6
        );
    }

    /**
     * Force every terrain pipeline to compile. Called behind the loading screen
     * so the first rendered frame never pays a compile.
     */
    async warmUp() {
        // Before the dust material, because its first compile binds whatever is
        // in the deformation target and reading uninitialised VRAM as a height
        // can put NaN into a vertex position.
        await this.deform.warmUp();
        this.setDeformTexture(this.deform.texture);

        await whenReady(this.material, "dust material", [this.mesh, false]);
        if (this.prepassMat) {
            await whenReady(this.prepassMat, "terrain prepass", [this.mesh, false]);
        }
        if (this._depthMats) {
            for (let i = 0; i < this._depthMats.length; i++) {
                await whenReady(this._depthMats[i], "terrainDepth" + i, [this.mesh, false]);
            }
        }
    }

    /**
     * Point every terrain pipeline at a deformation target. Called once per
     * ping-pong flip, so all four materials always read the same frame's state.
     * @param {import("@babylonjs/core/Materials/Textures/texture").Texture} tex
     */
    setDeformTexture(tex) {
        this._boundDeform = tex;
        this.material.setTexture("deformTex", tex);
        if (this._depthMats) {
            for (let i = 0; i < this._depthMats.length; i++) {
                this._depthMats[i].setTexture("deformTex", tex);
            }
        }
        if (this.prepassMat) this.prepassMat.setTexture("deformTex", tex);
    }

    /**
     * Advance the terrain state buffer and push this frame's uniforms.
     *
     * The deformation window follows the *player*, not the camera: the camera can
     * be swung right around and the marks the player left have to stay where they
     * were put.
     *
     * @param {Vector3} cameraPos
     * @param {{x:number, z:number}} focus world position the deform window centres on
     * @param {number} dt seconds
     */
    update(cameraPos, focus, dt) {
        const m = this.material;
        const hf = this.heightfield;
        const windAngle = (S.windDirection * Math.PI) / 180;

        // Simulate first, then bind: the material must sample the target that
        // was written this frame, not the one from last frame, or every mark
        // lands a frame late and fast movement leaves a visible stagger.
        const deformTex = this.deform.update(dt, focus);
        if (deformTex !== this._boundDeform) {
            this.setDeformTexture(deformTex);
        }
        const deformCenter = this.deform.center;
        const deformSize = this.deform.size;

        // Clipmap rings follow the player, not the viewer — see the note on
        // `lodCenter` in dust.vertex.wgsl. No extra snapping here;
        // `placeClipmapVertex` snaps per ring already.
        _lod.set(focus.x, focus.z);

        m.setVector3("cameraPos", cameraPos);
        m.setVector2("lodCenter", _lod);
        m.setFloat("baseSpacing", BASE_SPACING);
        m.setFloat("gridHalfN", GRID_HALF_N);
        m.setVector2("worldOrigin", hf.origin);
        m.setFloat("worldSize", hf.size);
        m.setFloat("heightRes", 4096);
        m.setFloat("windAngle", windAngle);
        m.setFloat("macroAmp", S.macroHeightScale);
        m.setFloat("sastrugiAmp", S.sastrugiStrength);

        m.setVector3("sunDir", this.sky.sunDir);
        m.setColor3("sunRadiance", this.sky.sunRadiance);
        m.setArray4("shR", this.sky.sh);

        bindMatrixArray(m, "cascadeMatrices", this.shadows.matrixData);
        _splits.set(
            this.shadows.splits[0], this.shadows.splits[1],
            this.shadows.splits[2], this.shadows.splits[3]
        );
        m.setVector4("cascadeSplits", _splits);
        m.setArray4("cascadeParams", this.shadows.paramData);
        m.setFloat("shadowTexel", this.shadows.texelSize);
        m.setFloat("shadowSoftness", 1.8);
        // Metres. The field has no thin geometry to peter-pan, so this can stay
        // small and keep contact shadows attached.
        m.setFloat("shadowBias", 0.022);

        m.setFloat("detailStrength", S.detailNormalStrength);
        m.setFloat("glintIntensity", S.glintIntensity);
        m.setFloat("glintGrazing", S.glintGrazing);
        m.setFloat("sssStrength", S.sssStrength);
        m.setFloat("sssRadius", S.sssRadius);

        m.setFloat("fogDensity", S.fogDensity);
        m.setFloat("fogHeightFalloff", S.fogHeightFalloff);
        m.setFloat("fogStart", S.fogStart);
        m.setFloat("aerialStrength", S.aerialStrength);
        m.setFloat("ambientIntensity", S.ambientIntensity);

        m.setFloat("dustEmissive", S.dustGlow * DUST_EMIT_SCALE);
        m.setColor3("dustGlowColor", _dustGlow);
        m.setColor3("dustCoolColor", _dustCool);

        m.setVector2("deformCenter", deformCenter);
        m.setFloat("deformSize", deformSize);
        m.setFloat("deformTexel", this.deform.texel);
        m.setFloat("deformDepthScale", S.deformDepth);

        m.setFloat("debugMode", DEBUG_MODES[S.debugView] ?? 0);
        _screen.set(
            this.scene.getEngine().getRenderWidth(),
            this.scene.getEngine().getRenderHeight()
        );
        m.setVector2("screenSize", _screen);
        m.wireframe = S.wireframe;

        // ---- depth prepass ----------------------------------------------
        // Same clipmap parameters as everything else, for the same reason.
        const pm = this.prepassMat;
        if (pm) {
            pm.setVector3("cameraPos", cameraPos);
            pm.setVector2("lodCenter", _lod);
            pm.setFloat("baseSpacing", BASE_SPACING);
            pm.setFloat("gridHalfN", GRID_HALF_N);
            pm.setVector2("worldOrigin", hf.origin);
            pm.setFloat("worldSize", hf.size);
            pm.setFloat("heightRes", 4096);
            pm.setFloat("windAngle", windAngle);
            pm.setFloat("sastrugiAmp", S.sastrugiStrength);
            pm.setVector2("deformCenter", deformCenter);
            pm.setFloat("deformSize", deformSize);
            pm.setFloat("deformDepthScale", S.deformDepth);
        }

        // ---- shadow-pass materials --------------------------------------
        // These must see the identical clipmap parameters, or the depth pass
        // would place vertices somewhere the beauty pass does not.
        const dm = this._depthMats;
        if (dm) {
            for (let i = 0; i < dm.length; i++) {
                const d = dm[i];
                d.setVector3("cameraPos", cameraPos);
                d.setVector2("lodCenter", _lod);
                d.setFloat("baseSpacing", BASE_SPACING);
                d.setFloat("gridHalfN", GRID_HALF_N);
                d.setVector2("worldOrigin", hf.origin);
                d.setFloat("worldSize", hf.size);
                d.setFloat("heightRes", 4096);
                d.setFloat("windAngle", windAngle);
                d.setFloat("sastrugiAmp", S.sastrugiStrength);
                d.setVector2("deformCenter", deformCenter);
                d.setFloat("deformSize", deformSize);
                d.setFloat("deformDepthScale", S.deformDepth);
            }
        }
    }

    /** @param {number} x @param {number} z */
    heightAt(x, z) {
        return this.heightfield.heightAt(x, z);
    }

    /** @param {number} x @param {number} z @param {Vector3} out */
    normalAt(x, z, out) {
        return this.heightfield.normalAt(x, z, out);
    }

    dispose() {
        this.mesh.dispose();
        this.material.dispose();
        this.detailTex.dispose();
        this.deform.dispose();
        this.heightfield.dispose();
    }
}
