/**
 * Registers every WGSL source into Babylon's shader store.
 *
 * Shared libraries go in as `#include<...>` fragments so the height bake and the
 * runtime dust material compile literally the same text — the terrain would pull
 * apart at the seams if they ever drifted. Whole shaders go in under the names
 * Babylon expects: `<name>VertexShader` and `<name>PixelShader`.
 *
 * Import this once, before any material is constructed.
 */

import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";

import noiseLib from "./lib/noise.wgsl?raw";
import terrainLib from "./lib/terrain.wgsl?raw";
import shadingLib from "./lib/shading.wgsl?raw";
import shadowLookupLib from "./lib/shadowLookup.wgsl?raw";
import atmosphereLib from "./lib/atmosphere.wgsl?raw";
import clipmapLib from "./lib/clipmap.wgsl?raw";
import deformLib from "./lib/deform.wgsl?raw";
import charSkinLib from "./lib/charSkin.wgsl?raw";
import wakeLib from "./lib/wake.wgsl?raw";
import spellLightsLib from "./lib/spellLights.wgsl?raw";
import waterLib from "./lib/water.wgsl?raw";
import postCommonLib from "./lib/postCommon.wgsl?raw";
import ridgeLib from "./lib/ridge.wgsl?raw";

import heightBakeFrag from "./heightBake.fragment.wgsl?raw";
import auxBakeFrag from "./auxBake.fragment.wgsl?raw";
import detailBakeFrag from "./detailBake.fragment.wgsl?raw";
import skyBakeFrag from "./skyBake.fragment.wgsl?raw";
import deformSimFrag from "./deformSim.fragment.wgsl?raw";

import dustVert from "./dust.vertex.wgsl?raw";
import dustFrag from "./dust.fragment.wgsl?raw";
import depthVert from "./terrainDepth.vertex.wgsl?raw";
import depthFrag from "./terrainDepth.fragment.wgsl?raw";
import skyVert from "./sky.vertex.wgsl?raw";
import skyFrag from "./sky.fragment.wgsl?raw";

import charVert from "./char.vertex.wgsl?raw";
import charFrag from "./char.fragment.wgsl?raw";
import charDepthVert from "./charDepth.vertex.wgsl?raw";
import furVert from "./fur.vertex.wgsl?raw";
import furFrag from "./fur.fragment.wgsl?raw";
import sprayVert from "./spray.vertex.wgsl?raw";
import sprayFrag from "./spray.fragment.wgsl?raw";
import wakeVert from "./wake.vertex.wgsl?raw";
import wakeFrag from "./wake.fragment.wgsl?raw";
import wakeDepthVert from "./wakeDepth.vertex.wgsl?raw";
import wakeDepthFrag from "./wakeDepth.fragment.wgsl?raw";
import waterVert from "./water.vertex.wgsl?raw";
import waterFrag from "./water.fragment.wgsl?raw";

import prepassFrag from "./prepass.fragment.wgsl?raw";
import archVert from "./arch.vertex.wgsl?raw";
import archFrag from "./arch.fragment.wgsl?raw";
import archDepthVert from "./archDepth.vertex.wgsl?raw";
import archPrepassVert from "./archPrepass.vertex.wgsl?raw";
import terrainPrepassVert from "./terrainPrepass.vertex.wgsl?raw";
import charPrepassVert from "./charPrepass.vertex.wgsl?raw";
import wakePrepassVert from "./wakePrepass.vertex.wgsl?raw";
import wakePrepassFrag from "./wakePrepass.fragment.wgsl?raw";


const INCLUDES = {
    starNoise: noiseLib,
    starTerrain: terrainLib,
    starShading: shadingLib,
    starShadowLookup: shadowLookupLib,
    starAtmosphere: atmosphereLib,
    starClipmap: clipmapLib,
    starDeform: deformLib,
    starCharSkin: charSkinLib,
    starWake: wakeLib,
    starSpellLights: spellLightsLib,
    starWater: waterLib,
    starPostCommon: postCommonLib,
    starRidge: ridgeLib,
};

const SHADERS = {
    heightBakePixelShader: heightBakeFrag,
    auxBakePixelShader: auxBakeFrag,
    detailBakePixelShader: detailBakeFrag,
    skyBakePixelShader: skyBakeFrag,
    deformSimPixelShader: deformSimFrag,

    dustVertexShader: dustVert,
    dustPixelShader: dustFrag,

    terrainDepthVertexShader: depthVert,
    terrainDepthPixelShader: depthFrag,

    skyVertexShader: skyVert,
    skyPixelShader: skyFrag,

    charVertexShader: charVert,
    charPixelShader: charFrag,
    charDepthVertexShader: charDepthVert,
    furVertexShader: furVert,
    furPixelShader: furFrag,
    sprayVertexShader: sprayVert,
    sprayPixelShader: sprayFrag,
    wakeVertexShader: wakeVert,
    wakePixelShader: wakeFrag,
    wakeDepthVertexShader: wakeDepthVert,
    wakeDepthPixelShader: wakeDepthFrag,

    waterVertexShader: waterVert,
    waterPixelShader: waterFrag,

    // The camera-space depth prepass. One fragment stage shared by everything
    // that has nothing to discard; the wake carries its own because it does.
    prepassPixelShader: prepassFrag,
    // The landmark's built rock — the canyon arch and the lava-tube roofs.
    archVertexShader: archVert,
    archPixelShader: archFrag,
    archDepthVertexShader: archDepthVert,
    archPrepassVertexShader: archPrepassVert,
    terrainPrepassVertexShader: terrainPrepassVert,
    charPrepassVertexShader: charPrepassVert,
    wakePrepassVertexShader: wakePrepassVert,
    wakePrepassPixelShader: wakePrepassFrag,
};

let registered = false;

export function registerShaders() {
    if (registered) return;
    registered = true;

    for (const name in INCLUDES) {
        ShaderStore.IncludesShadersStoreWGSL[name] = INCLUDES[name];
    }
    for (const name in SHADERS) {
        ShaderStore.ShadersStoreWGSL[name] = SHADERS[name];
    }
}
