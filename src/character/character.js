/**
 * The character system.
 *
 * Owns the skeleton, the two meshes and the five pipelines that draw them, and
 * the single small texture that carries every per-frame transform to the GPU.
 *
 * The transform texture is the spine of the whole thing: four rows of bone
 * skinning matrices, written into a pre-allocated staging array by one
 * `update()` per frame and uploaded once. Nothing else crosses to the GPU: no
 * per-frame buffers, no matrix uniforms, no vertex data.
 *
 * There is no soft-goods simulation. There was — a verlet solver over tubes of
 * particles, feeding a Catmull-Rom surface reconstruction in the vertex shader —
 * and it was removed rather than retuned, because the thing it was simulating
 * does not exist. A pressure suit is a laminate held between hard bearings; every
 * panel authored against it read as loose fabric no matter how hard the pins were
 * driven, and a figure in loose fabric is not an astronaut. What the suit needs
 * instead is bulk and a metal band at every joint, and both of those are lofted
 * geometry in `build.js`.
 *
 * Allocation per frame: none.
 */

import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Vector2, Vector3, Vector4, Color3 } from "@babylonjs/core/Maths/math";

import { Figure, BONE_COUNT } from "./figure.js";
import { buildBody, buildFur } from "./build.js";
import { LIN, EMIT } from "../core/brand.js";
import { S } from "../core/settings.js";
import { whenReady, bindMatrixArray } from "../core/gpuUtil.js";
import { CASCADE_COUNT } from "../render/shadows.js";
import { SPELL_LIGHT_UNIFORMS } from "../spells/spellLights.js";

/**
 * Transform texture geometry. Four rows of bone matrices, one column per bone.
 *
 * Wider and taller than the nineteen bones need, and left that way on purpose:
 * the smallest texture that would do the job is 19x4, which is not a shape any
 * driver has a fast path for, and this is one 12 KB upload per frame either way.
 */
const TEX_W = 48;
const TEX_H = 4;

/** How many cascades the figure casts into. See `ShadowSystem.registerCaster`. */
const CHAR_CASCADES = 2;

/** Linear mix of two brand colours, for the values that sit between two. */
function mixLin(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Material palette. Eight slots, uploaded as three vec4 arrays so every value is
 * live-tunable and nothing is baked into the shader.
 *
 * Every colour resolves through `brand.js`. The two exceptions are the metals,
 * and they are exceptions on purpose: a conductor's normal-incidence
 * reflectance is a measured optical constant, not a design choice, and dialling
 * aluminium away from 0.91 is how a metal stops reading as metal.
 *
 * The suit is genuinely bright — an EVA outer layer reflects about eighty per
 * cent, and against a near-black void that is the correct answer and also the
 * iconic one. It does mean the sunlit side of the figure is by some way the
 * brightest thing in frame and will sit hard against the tonemap's shoulder.
 * That is the picture, not a bug: what stops it flattening into a white blob is
 * that at thirteen degrees the sun is behind the figure for most of the framing
 * here, so what the camera mostly sees is the ambient side, the faceplate and
 * the light strips.
 */
const PALETTE = [
    // rgb, roughness
    [...LIN.suit, 0.55],                        // 0 suit, woven ortho-fabric
    [...LIN.suitDark, 0.72],                    // 1 soft goods, bellows, boots
    [...LIN.accent, 0.055],                     // 2 visor, gold film on glass
    [...LIN.suit, 0.30],                        // 3 hard shell, white composite
    [...mixLin(LIN.suit, LIN.suitDark, 0.45), 0.60], // 4 glove
    [...LIN.accent, 0.30],                      // 5 trim
    [0.912, 0.914, 0.920, 0.34],                // 6 bare aluminium, bead-blasted
    [...LIN.suit, 0.16],                        // 7 board deck, clear-coated
];

/**
 * (sheen, anisotropy, transmission, weave depth) per slot.
 *
 * Weave depth is the switch that matters. At zero the procedural weave and the
 * yarn slub are both skipped entirely in the fragment shader, which is exactly
 * what a faceplate, a composite shell, a bearing and a glassed deck want — a
 * woven surface texture on any of them is the single fastest way to make a hard
 * part read as cloth.
 *
 * Transmission stays near zero everywhere. A pressure suit is a laminate a
 * centimetre thick; nothing on this figure is a single layer of anything.
 */
const PARAMS = [
    [0.07, 0.10, 0.02, 0.26],
    [0.10, 0.16, 0.05, 0.30],
    [0.00, 0.00, 0.00, 0.00],
    [0.03, 0.05, 0.00, 0.00],
    [0.16, 0.35, 0.02, 0.70],
    [0.00, 0.00, 0.00, 0.00],
    [0.02, 0.12, 0.00, 0.00],
    [0.02, 0.00, 0.00, 0.00],
];

/**
 * (F0, metallic, emissive gain, unused) per slot.
 *
 * `metallic` is not a PBR workflow bolted on late — it is two lines in the
 * shader, and without it nothing on an astronaut is expressible. A metal takes
 * its Fresnel reflectance from its own albedo and has no diffuse lobe at all,
 * which is the whole difference between a gold mirror and a surface painted
 * gold. 0.035 is the dielectric everything else uses; 0.05 is a polyester
 * clear-coat, whose 1.55 refractive index puts it there.
 *
 * The emissive gain multiplies the slot's own albedo, and both emitting slots
 * are authored at the accent hue — so `albedo * gain` is exactly
 * `emissive(EMIT.x)` and an emitter can never disagree with its own colour.
 *
 * The gains are taken from `EMIT` unscaled, because they are already absolute
 * radiances on this scene's scale: lit dust sits near linear 5 and the post
 * chain's bright-pass knee is at 3. At 4 the faceplate's floor clears the knee
 * only in its red channel, so it blooms as a warm halo without ever competing
 * with the reflection it is meant to sit under. At 6 the strips are
 * unambiguously over it — a luminaire that does not bloom is paint, and these
 * are the only lights the astronaut carries.
 */
const EXTRA = [
    [0.035, 0.0, 0.0, 0.0],
    [0.035, 0.0, 0.0, 0.0],
    [0.040, 1.0, EMIT.visor.gain, 0.0],
    [0.040, 0.0, 0.0, 0.0],
    [0.035, 0.0, 0.0, 0.0],
    [0.040, 0.0, 0.0, 0.0],
    [0.040, 1.0, 0.0, 0.0],
    [0.050, 0.0, 0.0, 0.0],
];

// ------------------------------------------------------- module-scope scratch
const _droop = new Vector3();
const _screen = new Vector2();
/** Insulation nap is the same white as the suit it frays off. */
const _furCol = new Color3(LIN.suit[0], LIN.suit[1], LIN.suit[2]);

export class Character {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {import("../terrain/terrain.js").Terrain} terrain
     * @param {import("../render/sky.js").Sky} sky
     * @param {import("../render/shadows.js").ShadowSystem} shadows
     * @param {import("./controller.js").CharacterController} controller
     */
    constructor(scene, terrain, sky, shadows, controller) {
        this.scene = scene;
        this.terrain = terrain;
        this.sky = sky;
        this.shadows = shadows;
        this.controller = controller;

        this.figure = new Figure(terrain);

        // ---- transform texture -------------------------------------------
        this._texData = new Float32Array(TEX_W * TEX_H * 4);
        if (BONE_COUNT > TEX_W) throw new Error("more bones than the transform texture is wide");

        this.charTex = RawTexture.CreateRGBATexture(
            this._texData, TEX_W, TEX_H, scene,
            false, false,
            Constants.TEXTURE_NEAREST_SAMPLINGMODE,
            Constants.TEXTURETYPE_FLOAT
        );
        this.charTex.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.charTex.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;

        // ---- palette ------------------------------------------------------
        this._matAlbedo = new Float32Array(32);
        this._matParams = new Float32Array(32);
        this._matExtra = new Float32Array(32);
        for (let i = 0; i < 8; i++) {
            for (let k = 0; k < 4; k++) {
                this._matAlbedo[i * 4 + k] = PALETTE[i][k];
                this._matParams[i * 4 + k] = PARAMS[i][k];
                this._matExtra[i * 4 + k] = EXTRA[i][k];
            }
        }

        // ---- meshes and materials -----------------------------------------
        this.bodyMesh = buildBody(scene);
        this.furMesh = buildFur(scene);

        this.bodyMat = this._makeSurfaceMaterial("charBody", "char", "char");
        this.furMat = this._makeFurMaterial();

        this.bodyMesh.material = this.bodyMat;
        this.furMesh.material = this.furMat;

        for (const m of [this.bodyMesh, this.furMesh]) {
            m.renderingGroupId = 1;
        }

        /** @type {ShaderMaterial[]} */
        this._depthMats = [];
        shadows.registerCaster(
            this.bodyMesh, (c) => this._makeDepthMaterial("charDepth", c), CHAR_CASCADES
        );
        // The nap is not registered as a caster. Its shadow lands inside the
        // suit's own, an alpha-tested ten-shell depth pass is not free, and what
        // it would contribute is a fractionally fuzzier edge on a shadow already
        // an order of magnitude softer than that.

        this.triangles =
            this.bodyMesh.metadata.triangles + this.furMesh.metadata.triangles;

        this._cameraPos = new Vector3();
        this._splits = new Vector4(0, 0, 0, 0);

        this._visible = true;
        this.setVisible(S.showCharacter !== false);
    }

    /** The one surface material the figure has. */
    _makeSurfaceMaterial(name, vertex, fragment) {
        const uniforms = [
            "viewProjection", "cameraPos",
            "sunDir", "sunRadiance", "shR",
            "cascadeMatrices", "cascadeSplits", "cascadeParams",
            "shadowTexel", "shadowSoftness", "shadowBias",
            "matAlbedo", "matParams", "matExtra",
            "fogDensity", "fogHeightFalloff", "fogStart", "aerialStrength",
            "ambientIntensity", "sssStrength", "weaveDensity",
            "screenSize",
            ...SPELL_LIGHT_UNIFORMS,
        ];
        const mat = new ShaderMaterial(
            name, this.scene, { vertex, fragment },
            {
                attributes: ["position", "normal", "uv", "aux", "boneIdx", "boneWt"],
                uniforms,
                samplers: [
                    "charTex", "skyLUT", "cascade0", "cascade1", "cascade2",
                ],
                shaderLanguage: ShaderLanguage.WGSL,
            }
        );
        // The helmet is a shell with a hole in it, so both faces are visible.
        // The fragment shader turns the normal toward the viewer rather than
        // trusting winding — see the note there.
        mat.backFaceCulling = false;
        mat.setTexture("charTex", this.charTex);
        mat.setTexture("skyLUT", this.sky.lut);
        for (let i = 0; i < CASCADE_COUNT; i++) {
            mat.setTexture("cascade" + i, this.shadows.maps[i]);
        }
        return mat;
    }

    _makeFurMaterial() {
        const mat = new ShaderMaterial(
            "charFur", this.scene, { vertex: "fur", fragment: "fur" },
            {
                attributes: ["position", "normal", "uv", "aux", "boneIdx", "boneWt"],
                uniforms: [
                    "viewProjection", "cameraPos", "furDroop",
                    "sunDir", "sunRadiance", "shR",
                    "cascadeMatrices", "cascadeSplits", "cascadeParams",
                    "shadowTexel", "shadowSoftness", "shadowBias",
                    "fogDensity", "fogHeightFalloff", "fogStart", "aerialStrength",
                    "ambientIntensity", "furDensity", "furColor",
                ],
                samplers: ["charTex", "skyLUT", "cascade0", "cascade1", "cascade2"],
                shaderLanguage: ShaderLanguage.WGSL,
            }
        );
        mat.backFaceCulling = false;
        mat.setTexture("charTex", this.charTex);
        mat.setTexture("skyLUT", this.sky.lut);
        for (let i = 0; i < CASCADE_COUNT; i++) {
            mat.setTexture("cascade" + i, this.shadows.maps[i]);
        }
        return mat;
    }

    _makeDepthMaterial(vertex, cascade) {
        const mat = new ShaderMaterial(
            vertex + cascade, this.scene,
            { vertex, fragment: "terrainDepth" },
            {
                attributes: ["position", "boneIdx", "boneWt"],
                uniforms: ["lightViewProjection"],
                samplers: ["charTex"],
                shaderLanguage: ShaderLanguage.WGSL,
                // Forces a distinct Effect per cascade, so each can hold its own
                // matrix without any mid-frame uniform juggling.
                defines: ["CHAR_CASCADE " + cascade],
            }
        );
        mat.backFaceCulling = false;
        mat.setTexture("charTex", this.charTex);
        this._depthMats.push(mat);
        return mat;
    }

    /**
     * Depth-prepass material for the body.
     *
     * The nap is left out on the same grounds it is left out of the shadow
     * cascades: it is an alpha-tested ten-shell pass, and what it would
     * contribute is a fractionally fuzzier occlusion edge on a seam that is
     * already inside its own baked cavity.
     *
     * It carries the `aux` attribute the beauty pass does, because the prepass
     * writes the reflection mask and the only mirror on the character is the
     * faceplate.
     *
     * @param {import("../render/depthPass.js").DepthPass} depth
     */
    registerPrepass(depth) {
        const mat = new ShaderMaterial(
            "charPrepass", this.scene,
            { vertex: "charPrepass", fragment: "prepass" },
            {
                attributes: ["position", "aux", "boneIdx", "boneWt"],
                uniforms: ["viewProjection"],
                samplers: ["charTex"],
                shaderLanguage: ShaderLanguage.WGSL,
            }
        );
        mat.backFaceCulling = false;
        mat.setTexture("charTex", this.charTex);
        this._prepassMats = [mat];
        depth.registerCaster(this.bodyMesh, mat);
    }

    setVisible(v) {
        this._visible = !!v;
        this.bodyMesh.isVisible = this._visible;
        this.furMesh.isVisible = this._visible;
    }

    /**
     * Pose the figure, then push one texture upload.
     *
     * @param {number} dt
     */
    update(dt) {
        this.figure.update(dt, this.controller);
        this._uploadTransforms();
    }

    /**
     * Push this frame's uniforms. Split from `update` because the figure has to
     * be posed before the contact system reads the feet, while the uniforms
     * cannot be written until the camera has moved and the cascades have been
     * refitted. Doing both at one point in the frame means one of them is a
     * frame stale, and the visible symptom — a shadow that lags the figure by a
     * frame during a fast carve — is exactly the sort of thing that reads as
     * "cheap" without being identifiable.
     *
     * @param {Vector3} cameraPos
     */
    sync(cameraPos) {
        this._cameraPos.copyFrom(cameraPos);
        this._pushUniforms();
    }

    _uploadTransforms() {
        const d = this._texData;
        const skin = this.figure.skin;

        // Rows 0-3: bone matrices, one column per bone, one row per matrix
        // column. Written as four separate row writes rather than one blit,
        // because the texture is column-major in bones and row-major in memory.
        for (let b = 0; b < BONE_COUNT; b++) {
            const s = b * 16;
            for (let c = 0; c < 4; c++) {
                const o = (c * TEX_W + b) * 4;
                d[o] = skin[s + c * 4];
                d[o + 1] = skin[s + c * 4 + 1];
                d[o + 2] = skin[s + c * 4 + 2];
                d[o + 3] = skin[s + c * 4 + 3];
            }
        }

        this.charTex.update(d);
    }

    _pushUniforms() {
        const sky = this.sky;
        const sh = this.shadows;
        const ch = this.controller;

        // Nap droop: gravity, plus the apparent drift, plus the character's own
        // acceleration thrown the other way. Scaled to metres of fibre-tip
        // travel, so it is proportional to fibre length — these fibres are
        // fourteen millimetres, under a third of what a fur trim carried, and
        // the coefficients follow that down.
        const a = (S.windDirection * Math.PI) / 180;
        const ws = 0.6 * S.windStrength;
        _droop.set(
            Math.sin(a) * ws * 0.0018 - ch.velocity.x * 0.0005 - ch.acceleration.x * 0.00006,
            -0.006,
            Math.cos(a) * ws * 0.0018 - ch.velocity.z * 0.0005 - ch.acceleration.z * 0.00006
        );

        this._splits.set(sh.splits[0], sh.splits[1], sh.splits[2], sh.splits[3]);

        const mats = [this.bodyMat, this.furMat];
        for (let i = 0; i < mats.length; i++) {
            const m = mats[i];
            m.setVector3("cameraPos", this._cameraPos);
            m.setVector3("sunDir", sky.sunDir);
            m.setColor3("sunRadiance", sky.sunRadiance);
            m.setArray4("shR", sky.sh);

            bindMatrixArray(m, "cascadeMatrices", sh.matrixData);
            m.setVector4("cascadeSplits", this._splits);
            m.setArray4("cascadeParams", sh.paramData);
            m.setFloat("shadowTexel", sh.texelSize);
            m.setFloat("shadowSoftness", 1.4);
            // Tighter than the terrain's: the figure is small, its cascade is
            // the near one, and a large bias here detaches the contact shadow
            // between the board and the dust — which is the shadow that tells
            // you the astronaut is riding the surface rather than floating over
            // it.
            m.setFloat("shadowBias", 0.012);

            m.setFloat("fogDensity", S.fogDensity);
            m.setFloat("fogHeightFalloff", S.fogHeightFalloff);
            m.setFloat("fogStart", S.fogStart);
            m.setFloat("aerialStrength", S.aerialStrength);
            m.setFloat("ambientIntensity", S.ambientIntensity);
        }

        const eng = this.scene.getEngine();
        _screen.set(eng.getRenderWidth(), eng.getRenderHeight());

        this.bodyMat.setArray4("matAlbedo", this._matAlbedo);
        this.bodyMat.setArray4("matParams", this._matParams);
        this.bodyMat.setArray4("matExtra", this._matExtra);
        this.bodyMat.setFloat("sssStrength", S.sssStrength);
        this.bodyMat.setVector2("screenSize", _screen);
        // Threads per metre. A coarse woven ortho-fabric, which is what puts the
        // weave right at the edge of visibility at the distance the figure is
        // normally framed — present in a close-up, gone by ten metres. The hard
        // slots skip it entirely on their weave depth.
        this.bodyMat.setFloat("weaveDensity", 210);

        this.furMat.setVector3("furDroop", _droop);
        // Cells per metre. A 2.4 mm pitch: fine enough that the nap reads as the
        // frayed edge of a woven blanket rather than as fur, which at these
        // fibre lengths is the whole difference between the two.
        this.furMat.setFloat("furDensity", 420);
        this.furMat.setColor3("furColor", _furCol);
    }

    /** Compile every pipeline behind the loading screen. */
    async warmUp() {
        await whenReady(this.bodyMat, "character body material", [this.bodyMesh, false]);
        await whenReady(this.furMat, "character nap material", [this.furMesh, false]);
        for (let i = 0; i < this._depthMats.length; i++) {
            const m = this._depthMats[i];
            await whenReady(m, m.name, [this.bodyMesh, false]);
        }
        if (this._prepassMats) {
            for (let i = 0; i < this._prepassMats.length; i++) {
                const m = this._prepassMats[i];
                await whenReady(m, m.name, [this.bodyMesh, false]);
            }
        }
    }

    dispose() {
        this.bodyMesh.dispose();
        this.furMesh.dispose();
        this.bodyMat.dispose();
        this.furMat.dispose();
        this.charTex.dispose();
    }
}
