/**
 * The character system.
 *
 * Owns the skeleton, the soft-goods simulation, the three meshes and the seven
 * pipelines that draw them, and the single small texture that carries every
 * per-frame transform to the GPU.
 *
 * The transform texture is the spine of the whole thing. Rows 0-3 hold bone
 * skinning matrices, rows 4 and beyond hold simulated cloth nodes, and one
 * `update()` per frame writes both into a pre-allocated staging array and
 * uploads it once. Nothing else crosses to the GPU: no per-frame buffers, no
 * matrix uniforms, no vertex data.
 *
 * Allocation per frame: none.
 */

import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Vector2, Vector3, Vector4, Color3 } from "@babylonjs/core/Maths/math";

import { Figure, BONE_COUNT } from "./figure.js";
import { makePanels, ClothSolver } from "./cloth.js";
import { buildBody, buildFur, buildClothMesh } from "./build.js";
import { LIN, EMIT } from "../core/brand.js";
import { S } from "../core/settings.js";
import { whenReady, bindMatrixArray } from "../core/gpuUtil.js";
import { CASCADE_COUNT } from "../render/shadows.js";
import { SPELL_LIGHT_UNIFORMS } from "../spells/spellLights.js";

/** Transform texture geometry. Width covers the widest of bones or panel cols. */
const TEX_W = 48;
const TEX_H = 64;
/** First texture row available to cloth panels; 0-3 are the bone matrices. */
const CLOTH_ROW0 = 4;

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
    [0.12, 0.20, 0.02, 0.55],
    [0.30, 0.50, 0.10, 1.00],
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
    [0.040, 0.0, EMIT.trim.gain, 0.0],
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
        this.panels = makePanels();
        this.solver = new ClothSolver(this.panels, terrain);

        // ---- transform texture -------------------------------------------
        this._texData = new Float32Array(TEX_W * TEX_H * 4);
        let row = CLOTH_ROW0;
        /** Flat (rowBase, cols, rows, 0) per panel, for the vertex shaders. */
        this._panelParams = new Float32Array(6 * 4);
        for (let i = 0; i < this.panels.length; i++) {
            const p = this.panels[i];
            if (p.cols > TEX_W) throw new Error("panel wider than the transform texture");
            p.nodeRow = row;
            this._panelParams[i * 4] = row;
            this._panelParams[i * 4 + 1] = p.cols;
            this._panelParams[i * 4 + 2] = p.rows;
            row += p.rows;
        }
        if (row > TEX_H) throw new Error("transform texture too short for the panels");

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
        this.clothMesh = buildClothMesh(scene, this.panels);
        this.furMesh = buildFur(scene);

        this.bodyMat = this._makeSurfaceMaterial("charBody", "char", "char", false);
        this.clothMat = this._makeSurfaceMaterial("charCloth", "cloth", "char", true);
        this.furMat = this._makeFurMaterial();

        this.bodyMesh.material = this.bodyMat;
        this.clothMesh.material = this.clothMat;
        this.furMesh.material = this.furMat;

        for (const m of [this.bodyMesh, this.clothMesh, this.furMesh]) {
            m.renderingGroupId = 1;
        }

        /** @type {ShaderMaterial[]} */
        this._depthMats = [];
        shadows.registerCaster(
            this.bodyMesh, (c) => this._makeDepthMaterial("charDepth", c, false), CHAR_CASCADES
        );
        shadows.registerCaster(
            this.clothMesh, (c) => this._makeDepthMaterial("clothDepth", c, true), CHAR_CASCADES
        );
        // The nap is not registered as a caster. Its shadow lands inside the
        // suit's own, an alpha-tested ten-shell depth pass is not free, and what
        // it would contribute is a fractionally fuzzier edge on a shadow already
        // an order of magnitude softer than that.

        this.triangles =
            this.bodyMesh.metadata.triangles +
            this.clothMesh.metadata.triangles +
            this.furMesh.metadata.triangles;

        this._cameraPos = new Vector3();
        this._splits = new Vector4(0, 0, 0, 0);
        this._needSettle = true;

        this._visible = true;
        this.setVisible(S.showCharacter !== false);
    }

    /**
     * One surface material. The body and the soft goods differ only in their
     * vertex program — the shading, the shadow lookup and the aerial
     * perspective are literally the same code.
     */
    _makeSurfaceMaterial(name, vertex, fragment, isCloth) {
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
        const attributes = isCloth
            ? ["position", "uv", "aux"]
            : ["position", "normal", "uv", "aux", "boneIdx", "boneWt"];
        if (isCloth) uniforms.push("panelParams");

        const mat = new ShaderMaterial(
            name, this.scene, { vertex, fragment },
            {
                attributes,
                uniforms,
                samplers: [
                    "charTex", "skyLUT", "cascade0", "cascade1", "cascade2",
                ],
                shaderLanguage: ShaderLanguage.WGSL,
            }
        );
        // Every soft-goods panel is an open sheet and the helmet is a shell, so
        // both faces are visible. The fragment shader turns the normal toward
        // the viewer rather than trusting winding — see the note there.
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

    _makeDepthMaterial(vertex, cascade, isCloth) {
        const uniforms = ["lightViewProjection"];
        if (isCloth) uniforms.push("panelParams");
        const mat = new ShaderMaterial(
            vertex + cascade, this.scene,
            { vertex, fragment: "terrainDepth" },
            {
                attributes: isCloth ? ["position"] : ["position", "boneIdx", "boneWt"],
                uniforms,
                samplers: ["charTex"],
                shaderLanguage: ShaderLanguage.WGSL,
                // Forces a distinct Effect per cascade, so each can hold its own
                // matrix without any mid-frame uniform juggling.
                defines: ["CHAR_CASCADE " + cascade],
            }
        );
        mat.backFaceCulling = false;
        mat.setTexture("charTex", this.charTex);
        if (isCloth) mat.setArray4("panelParams", this._panelParams);
        this._depthMats.push(mat);
        return mat;
    }

    /**
     * Depth-prepass materials for the body and the soft goods.
     *
     * The nap is left out on the same grounds it is left out of the shadow
     * cascades: it is an alpha-tested ten-shell pass, and what it would
     * contribute is a fractionally fuzzier occlusion edge on a seam that is
     * already inside its own baked cavity.
     *
     * The body pass carries the `aux` attribute the beauty pass does, which the
     * cloth pass has no use for: the prepass writes the reflection mask, and the
     * only mirror on the character is the faceplate.
     *
     * @param {import("../render/depthPass.js").DepthPass} depth
     */
    registerPrepass(depth) {
        this._prepassMats = [];
        for (const spec of [
            { mesh: this.bodyMesh, vertex: "charPrepass", cloth: false },
            { mesh: this.clothMesh, vertex: "clothPrepass", cloth: true },
        ]) {
            const uniforms = ["viewProjection"];
            if (spec.cloth) uniforms.push("panelParams");
            const mat = new ShaderMaterial(
                spec.vertex, this.scene,
                { vertex: spec.vertex, fragment: "prepass" },
                {
                    attributes: spec.cloth
                        ? ["position"]
                        : ["position", "aux", "boneIdx", "boneWt"],
                    uniforms,
                    samplers: ["charTex"],
                    shaderLanguage: ShaderLanguage.WGSL,
                }
            );
            mat.backFaceCulling = false;
            mat.setTexture("charTex", this.charTex);
            if (spec.cloth) mat.setArray4("panelParams", this._panelParams);
            this._prepassMats.push(mat);
            depth.registerCaster(spec.mesh, mat);
        }
    }

    setVisible(v) {
        this._visible = !!v;
        this.bodyMesh.isVisible = this._visible;
        this.clothMesh.isVisible = this._visible;
        this.furMesh.isVisible = this._visible;
    }

    /**
     * Advance the figure and the soft goods, then push one texture upload and one
     * set of uniforms.
     *
     * Order matters: the skeleton has to be posed before the cloth can find its
     * kinematic targets, and both have to be written before the texture goes up,
     * or the soft goods render one frame behind the body they hang from.
     *
     * @param {number} dt
     */
    update(dt) {
        const ch = this.controller;
        this.figure.update(dt, ch);
        if (this._needSettle) {
            this._settleCloth();
            this._needSettle = false;
        }
        this.solver.update(dt, this.figure, ch);
        this._uploadTransforms();
    }

    /**
     * Push this frame's uniforms. Split from `update` because the soft goods have
     * to be solved before the contact system reads the feet, while the uniforms
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

    /**
     * Drop every soft-goods panel straight onto its kinematic target.
     *
     * Done once, on the first update. The panels are authored in bind space at
     * the world origin, and letting them fall from there to wherever the player
     * actually spawned takes a second of visible flapping — behind the loading
     * screen if we are lucky, in shot if we are not.
     */
    _settleCloth() {
        const skin = this.figure.skin;
        for (let pi = 0; pi < this.panels.length; pi++) {
            const p = this.panels[pi];
            for (let k = 0; k < p.count; k++) {
                const b = p.bone[k] * 16;
                const o = k * 3;
                const x = p.bindPos[o], y = p.bindPos[o + 1], z = p.bindPos[o + 2];
                p.pos[o] = skin[b] * x + skin[b + 4] * y + skin[b + 8] * z + skin[b + 12];
                p.pos[o + 1] = skin[b + 1] * x + skin[b + 5] * y + skin[b + 9] * z + skin[b + 13];
                p.pos[o + 2] = skin[b + 2] * x + skin[b + 6] * y + skin[b + 10] * z + skin[b + 14];
            }
            p.prev.set(p.pos);
        }
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

        for (let pi = 0; pi < this.panels.length; pi++) {
            const p = this.panels[pi];
            const pos = p.pos;
            for (let j = 0; j < p.rows; j++) {
                const rowO = ((p.nodeRow + j) * TEX_W) * 4;
                for (let i = 0; i < p.cols; i++) {
                    const s = (j * p.cols + i) * 3;
                    const o = rowO + i * 4;
                    d[o] = pos[s];
                    d[o + 1] = pos[s + 1];
                    d[o + 2] = pos[s + 2];
                    d[o + 3] = 1;
                }
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

        const mats = [this.bodyMat, this.clothMat, this.furMat];
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

        for (const m of [this.bodyMat, this.clothMat]) {
            m.setArray4("matAlbedo", this._matAlbedo);
            m.setArray4("matParams", this._matParams);
            m.setArray4("matExtra", this._matExtra);
            m.setFloat("sssStrength", S.sssStrength);
            m.setVector2("screenSize", _screen);
            // Threads per metre. A coarse woven ortho-fabric, which is what puts
            // the weave right at the edge of visibility at the distance the
            // figure is normally framed — present in a close-up, gone by ten
            // metres. The hard slots skip it entirely on their weave depth.
            m.setFloat("weaveDensity", 210);
        }
        this.clothMat.setArray4("panelParams", this._panelParams);

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
        await whenReady(this.clothMat, "character cloth material", [this.clothMesh, false]);
        await whenReady(this.furMat, "character nap material", [this.furMesh, false]);
        for (let i = 0; i < this._depthMats.length; i++) {
            const m = this._depthMats[i];
            const mesh = m.name.indexOf("cloth") === 0 ? this.clothMesh : this.bodyMesh;
            await whenReady(m, m.name, [mesh, false]);
        }
        if (this._prepassMats) {
            for (let i = 0; i < this._prepassMats.length; i++) {
                const m = this._prepassMats[i];
                const mesh = m.name.indexOf("cloth") === 0 ? this.clothMesh : this.bodyMesh;
                await whenReady(m, m.name, [mesh, false]);
            }
        }
    }

    dispose() {
        this.bodyMesh.dispose();
        this.clothMesh.dispose();
        this.furMesh.dispose();
        this.bodyMat.dispose();
        this.clothMat.dispose();
        this.furMat.dispose();
        this.charTex.dispose();
    }
}
