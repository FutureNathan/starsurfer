/**
 * Central tuning + toggle store.
 *
 * `S` is a flat plain object read directly by systems every frame — no getters,
 * no proxies, no allocation. `SCHEMA` is metadata the settings overlay builds
 * its widgets from, and `onChange` lets systems react to edits that need work
 * (rebuilding a render target, re-freezing a material) rather than just being
 * sampled next frame.
 */

/** @type {Record<string, number|boolean|string>} */
export const S = {
    // ---------------------------------------------------------------- quality
    preset: "ultra",
    resolutionScale: 1.0,

    // ------------------------------------------------------- the nearby star
    // The scene is lit by one distant star. Its key names are unchanged from
    // the demo this grew out of — `sunX` throughout the code and the shaders
    // means "the star", and renaming it would touch every WGSL uniform block
    // for no visual gain.
    sunAzimuth: 118, // degrees, bearing of the star
    // Low enough for long raking shadows across the dust swells. In vacuum
    // there is no air mass to redden the beam, so the elevation buys geometry
    // rather than colour.
    sunElevation: 13.0,
    sunIntensity: 4.2,
    sunTempWarm: 1.0, // 0 = neutral white, 1 = full warm reddening
    ambientIntensity: 1.0,
    ambientBlue: 1.0, // strength of the cool shadow shift

    // ------------------------------------------------------------ deep space
    // There is no atmosphere out here; what these drive is the nebula the field
    // is drifting through, which scatters in much the same way and much more
    // thinly.
    fogDensity: 0.0072,
    fogHeightFalloff: 0.045,
    fogStart: 24,
    aerialStrength: 1.0,
    // Degrees. Drives the shear on the dust ripples and the orientation of the
    // long swells. Held 70-80 degrees away from `sunAzimuth`: the ripples run
    // along the drift, so when the two align the star rakes down every ridge,
    // lights both flanks identically and the fine structure reads as flat.
    windDirection: 42,
    windStrength: 1.0,
    /** Far-field ridge of crystalline debris on the skybox. */
    showMountains: true,
    /** Peak height of that ridge, metres. */
    mountainHeight: 2150,
    /** Strength of the volumetric shafts spilling past the dust crests. */
    shaftStrength: 0.30,

    // ---------------------------------------------------------------- galaxy
    /** Star field density multiplier. */
    starDensity: 1.0,
    /** Star field brightness multiplier. */
    starBrightness: 1.0,
    /** Strength of the galactic band across the sky. */
    galaxyBand: 1.0,
    /** Degrees the galactic plane is tilted out of the horizon. */
    galaxyTilt: 38,
    /** Bearing, degrees, of the galactic core. */
    galaxyBearing: 205,
    /** Density of the nebula clouds hanging in the void. */
    nebulaStrength: 1.0,

    // ----------------------------------------------------------- cosmic dust
    /**
     * Master scale on the light the dust field emits. This is not a stylistic
     * nicety — reflected light alone leaves a 0.09-albedo surface under one
     * small star with no readable form, so at zero the ground goes essentially
     * black and only its lit rim survives.
     */
    dustGlow: 1.0,
    glintIntensity: 0.55,
    glintGrazing: 0.72, // how hard the grazing-angle gate bites
    sssStrength: 1.0,
    sssRadius: 1.0,
    detailNormalStrength: 1.0,
    macroHeightScale: 1.0,
    sastrugiStrength: 1.0,

    // ----------------------------------------------------------- deformation
    deformDepth: 1.0,
    deformBerm: 1.0,
    refillRate: 1.0,
    deformResolution: 2048,

    // ------------------------------------------------------------- snow-surf
    /** Height of the breaking wall thrown by a carve, as a multiple of 1.45 m. */
    wakeHeight: 1.0,
    /** Density of the plume shed off the wake's lip. */
    wakeSpray: 1.0,
    /** Screen-space speed streaks while surfing. */
    windStreaks: true,
    streakStrength: 1.0,

    // ---------------------------------------------------------------- spells
    /** Master toggle. Off cancels everything in flight and hides both meshes. */
    showSpells: true,
    /** Brightness of the dynamic lights the spells emit. */
    spellLight: 1.0,
    /** Density of the spray every spell throws. */
    spellSpray: 1.0,
    /**
     * Artistic scale on the water's absorption path — glacial melt at one end,
     * tap water at the other. The right value depends on the sun elevation, so
     * it is a slider rather than a constant.
     */
    waterDepthTint: 1.0,

    // ------------------------------------------------------------------ post
    taa: true,
    ssr: true,
    dof: true,
    bloom: true,
    grain: true,
    sharpen: true,
    tonemap: "agx", // "agx" | "aces" | "none"
    // Measured, not guessed. Dust lit by the star sits near 5 in linear — a
    // 0.085-albedo surface under a source scaled to compensate for exactly that
    // — and the galactic band's core reaches about 6. This exposure puts both a
    // little below where sunlit snow used to sit, which is the point: it is a
    // night scene, and the brightest thing in the frame should be the galaxy
    // rather than the ground.
    //
    // The ceiling is the AgX shoulder. Push much past this and the lit faces of
    // the swells, the wake's crest and the band all arrive in the region where
    // the curve's slope collapses, and they resolve to the same flat value —
    // which costs exactly the separation the whole look depends on.
    exposure: 0.16,
    contrast: 1.14,
    bloomStrength: 0.22,
    grainStrength: 0.022,
    sharpenStrength: 0.55,

    // --------------------------------------------------------------- systems
    showTerrain: true,
    showCharacter: true,
    showWake: true,
    showLightShafts: true,
    wireframe: false,
    freezeTime: false,

    // ----------------------------------------------------------------- debug
    debugView: "beauty", // beauty | deform | normals | depth | cascades | footprint | fineNormals
};

/**
 * Widget metadata. `t`: "f" float slider, "b" bool toggle, "e" enum.
 * @type {{group:string, items:Array<{k:string,l:string,t:string,min?:number,max?:number,step?:number,opts?:string[]}>}[]}
 */
export const SCHEMA = [
    {
        group: "Star",
        items: [
            { k: "sunAzimuth", l: "Bearing", t: "f", min: 0, max: 360, step: 1 },
            { k: "sunElevation", l: "Elevation", t: "f", min: 0.5, max: 45, step: 0.1 },
            { k: "sunIntensity", l: "Intensity", t: "f", min: 0, max: 10, step: 0.05 },
            { k: "sunTempWarm", l: "Warmth", t: "f", min: 0, max: 1, step: 0.01 },
            { k: "ambientIntensity", l: "Ambient", t: "f", min: 0, max: 3, step: 0.01 },
            { k: "ambientBlue", l: "Ambient blue", t: "f", min: 0, max: 2, step: 0.01 },
        ],
    },
    {
        group: "Galaxy",
        items: [
            { k: "starDensity", l: "Star density", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "starBrightness", l: "Star brightness", t: "f", min: 0, max: 3, step: 0.01 },
            { k: "galaxyBand", l: "Galactic band", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "galaxyTilt", l: "Band tilt", t: "f", min: -60, max: 60, step: 1 },
            { k: "galaxyBearing", l: "Core bearing", t: "f", min: 0, max: 360, step: 1 },
            { k: "nebulaStrength", l: "Nebula", t: "f", min: 0, max: 2, step: 0.01 },
        ],
    },
    {
        group: "Void",
        items: [
            { k: "fogDensity", l: "Nebula density", t: "f", min: 0, max: 0.03, step: 0.0001 },
            { k: "fogHeightFalloff", l: "Height falloff", t: "f", min: 0, max: 0.3, step: 0.001 },
            { k: "aerialStrength", l: "Depth haze", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "windDirection", l: "Drift dir", t: "f", min: 0, max: 360, step: 1 },
            { k: "windStrength", l: "Drift strength", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "showMountains", l: "Far ridges", t: "b" },
            { k: "mountainHeight", l: "Ridge height", t: "f", min: 0, max: 2500, step: 10 },
            { k: "showLightShafts", l: "Light shafts", t: "b" },
            { k: "shaftStrength", l: "Shaft amt", t: "f", min: 0, max: 2, step: 0.01 },
        ],
    },
    {
        group: "Cosmic dust",
        items: [
            { k: "dustGlow", l: "Dust glow", t: "f", min: 0, max: 3, step: 0.01 },
            { k: "glintIntensity", l: "Sparkle", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "glintGrazing", l: "Sparkle gate", t: "f", min: 0, max: 1, step: 0.01 },
            { k: "sssStrength", l: "Glow strength", t: "f", min: 0, max: 3, step: 0.01 },
            { k: "sssRadius", l: "Glow radius", t: "f", min: 0.1, max: 3, step: 0.01 },
            { k: "detailNormalStrength", l: "Detail normals", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "macroHeightScale", l: "Swell height", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "sastrugiStrength", l: "Ripples", t: "f", min: 0, max: 2, step: 0.01 },
        ],
    },
    {
        group: "Displacement",
        items: [
            { k: "deformDepth", l: "Depth", t: "f", min: 0, max: 3, step: 0.01 },
            { k: "deformBerm", l: "Berm mass", t: "f", min: 0, max: 3, step: 0.01 },
            { k: "refillRate", l: "Refill rate", t: "f", min: 0, max: 4, step: 0.01 },
        ],
    },
    {
        group: "Surf",
        items: [
            { k: "wakeHeight", l: "Wake height", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "wakeSpray", l: "Plume density", t: "f", min: 0, max: 2.5, step: 0.01 },
            { k: "windStreaks", l: "Speed streaks", t: "b" },
            { k: "streakStrength", l: "Streak amt", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "showWake", l: "Wake mesh", t: "b" },
        ],
    },
    {
        group: "Powers",
        items: [
            { k: "showSpells", l: "Powers", t: "b" },
            { k: "spellLight", l: "Emitted light", t: "f", min: 0, max: 3, step: 0.01 },
            { k: "spellSpray", l: "Ejecta", t: "f", min: 0, max: 2.5, step: 0.01 },
            { k: "waterDepthTint", l: "Plasma depth", t: "f", min: 0, max: 3, step: 0.01 },
        ],
    },
    {
        group: "Post",
        items: [
            { k: "taa", l: "TAA", t: "b" },
            { k: "ssr", l: "SSR (ice)", t: "b" },
            { k: "dof", l: "Depth of field", t: "b" },
            { k: "bloom", l: "Bloom", t: "b" },
            { k: "grain", l: "Film grain", t: "b" },
            { k: "sharpen", l: "Sharpen", t: "b" },
            { k: "tonemap", l: "Tonemap", t: "e", opts: ["agx", "aces", "none"] },
            { k: "exposure", l: "Exposure", t: "f", min: 0.01, max: 0.6, step: 0.005 },
            { k: "contrast", l: "Contrast", t: "f", min: 0.5, max: 2, step: 0.01 },
            { k: "bloomStrength", l: "Bloom amt", t: "f", min: 0, max: 1, step: 0.005 },
            { k: "grainStrength", l: "Grain amt", t: "f", min: 0, max: 0.1, step: 0.001 },
            { k: "sharpenStrength", l: "Sharpen amt", t: "f", min: 0, max: 1, step: 0.01 },
        ],
    },
    {
        group: "Systems",
        items: [
            { k: "showTerrain", l: "Terrain", t: "b" },
            { k: "showCharacter", l: "Character", t: "b" },
            { k: "wireframe", l: "Wireframe", t: "b" },
            { k: "freezeTime", l: "Freeze time", t: "b" },
            { k: "resolutionScale", l: "Resolution", t: "f", min: 0.5, max: 1.5, step: 0.05 },
            {
                k: "debugView", l: "Debug view", t: "e",
                opts: ["beauty", "deform", "normals", "depth", "cascades", "footprint",
                       "fineNormals", "shadow", "ndotl", "shadowMap", "albedo"],
            },
        ],
    },
];

/** Quality presets. Only the keys that differ from `ultra` need listing. */
export const PRESETS = {
    ultra: {},
    high: { deformResolution: 2048, resolutionScale: 1.0, ssr: true, dof: true },
    balanced: {
        deformResolution: 1024, resolutionScale: 0.85,
        ssr: false, dof: false,
    },
};

/** @type {Map<string, Set<(v:any, k:string) => void>>} */
const listeners = new Map();

/**
 * Subscribe to a settings key. Returns an unsubscribe function.
 * @param {string|string[]} keys
 * @param {(v:any, k:string) => void} fn
 */
export function onChange(keys, fn) {
    const list = typeof keys === "string" ? [keys] : keys;
    for (let i = 0; i < list.length; i++) {
        let set = listeners.get(list[i]);
        if (!set) {
            set = new Set();
            listeners.set(list[i], set);
        }
        set.add(fn);
    }
    return () => {
        for (let i = 0; i < list.length; i++) listeners.get(list[i])?.delete(fn);
    };
}

/**
 * Write a settings value and notify subscribers. Never called from the render
 * loop — only from the overlay and preset application.
 * @param {string} k
 * @param {number|boolean|string} v
 */
export function set(k, v) {
    if (S[k] === v) return;
    S[k] = v;
    const set_ = listeners.get(k);
    if (set_) for (const fn of set_) fn(v, k);
}

/** @param {keyof typeof PRESETS} name */
export function applyPreset(name) {
    const p = PRESETS[name];
    if (!p) return;
    S.preset = name;
    for (const k in p) set(k, p[k]);
}
