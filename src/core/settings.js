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
    // One distant star lights the whole scene. `sun` throughout the code and the
    // shaders means this star: it is the name every WGSL uniform block already
    // uses for "the one directional source", and it is not worth touching all of
    // them to say the same thing differently.
    sunAzimuth: 118, // degrees, bearing of the star
    // Low enough for long raking shadows across the dust swells. In vacuum
    // there is no air mass to redden the beam, so the elevation buys geometry
    // rather than colour.
    sunElevation: 13.0,
    sunIntensity: 4.2,
    // Down from 1.0 in the grey-moon pass: at full warmth the star browned
    // every sunlit surface into tan. A third keeps the light from going
    // clinical while letting the regolith read as the grey it is.
    sunTempWarm: 0.35,
    ambientIntensity: 1.0,
    ambientBlue: 1.0, // strength of the cool shadow shift

    // ------------------------------------------------------------ deep space
    // There is no atmosphere out here; what these drive is the nebula the field
    // is drifting through, which scatters in much the same way and much more
    // thinly.
    //
    // Much more thinly than it used to say, too. At 0.0072 this was a haze a
    // hundred times thicker than air hugging the ground on a 22 m scale
    // height: from a summit, everything past a kilometre and a half sat at
    // 60-97% extinction, so the mid-ground dissolved into a featureless pale
    // wash with the mountains standing on top of it — the floating-mountains
    // report, all three times, was this number, not the geometry. A fifth of
    // it keeps a whisper of depth cueing at eye level and lets the ground stay
    // ground all the way out to the massifs, which is what an airless horizon
    // does: Apollo photographs are crisp to the last ridge.
    fogDensity: 0.0014,
    fogHeightFalloff: 0.045,
    fogStart: 24,
    aerialStrength: 0.75,
    // Degrees. Drives the shear on the dust ripples and the orientation of the
    // long swells. Held 70-80 degrees away from `sunAzimuth`: the ripples run
    // along the drift, so when the two align the star rakes down every ridge,
    // lights both flanks identically and the fine structure reads as flat.
    windDirection: 42,
    windStrength: 1.0,
    /** The highland wall on the horizon, ray-marched on the skybox. */
    showMountains: true,
    /**
     * Peak height of that range, metres. Raised with the near field's own relief
     * — the ground the player rides now carries hundred-metre massifs and
     * twenty-metre crater rims, and a horizon that did not grow with it would
     * have read as a step down rather than as distance.
     */
    mountainHeight: 2900,
    /** Strength of the volumetric shafts spilling past the dust crests. */
    shaftStrength: 0.12,

    // ---------------------------------------------------------------- galaxy
    /**
     * Star field density multiplier. Halved from 1.0: a sparser field reads
     * *deeper* — what sells distance is a few unmistakable stars against real
     * void, not coverage — and it hands the frame to the planets and to the
     * beacon stars (see `starField`), which need empty sky around them to
     * register as individuals.
     */
    starDensity: 0.5,
    /** Star field brightness multiplier. */
    starBrightness: 1.0,
    /**
     * Strength of the galactic band across the sky. Well under its old 1.0:
     * at the LUT's 512x256 the band's dust-lane detail is a smear, and a smear
     * reads as fog. Held faint it reads as a distant glow instead, and the
     * crisp screen-space star field carries the sky. Down again from 0.35 in
     * the second crisp-sky pass, trading the last of the wash for the planets.
     */
    galaxyBand: 0.26,
    /** Degrees the galactic plane is tilted out of the horizon. */
    galaxyTilt: 38,
    /** Bearing, degrees, of the galactic core. */
    galaxyBearing: 205,
    /**
     * The companion worlds — a banded teal ice-giant, with a small amber world
     * high on the far side of the sky and a dim violet one low near the band.
     * The bearing and elevation here place the hero; the other two hang off
     * its bearing at fixed offsets, so this one control swings the family.
     *
     * The bright beautiful things up there, and deliberately the things
     * guaranteed never to glow: the hero's lit face stays well under the 6.5
     * bloom knee, so it stays crisp at any size — the "from within" light is
     * painted shading, not bloom. `planetSize` is the angular *radius* in
     * degrees; at 20 the hero spans forty degrees of sky, the looming-world
     * read, and the glow sits *lower* than it did when the disc was small —
     * a bigger world at the same brightness reads nearer, and this one is
     * meant to read enormous and far.
     */
    showPlanet: true,
    planetBearing: 232,
    planetElevation: 31,
    planetSize: 20,
    planetGlow: 2.7,

    /**
     * Strength of the auroral curtains. Near zero by default: at the LUT's
     * resolution a curtain is a soft vertical smear, and the ask is a mostly
     * dark, crisp sky — stars, a faint band, and the planet. The slider is
     * still here for anyone who wants the weather back.
     */
    nebulaStrength: 0.12,

    // ----------------------------------------------------------------- sound
    /**
     * Music and effects, each with a switch and a volume — the Minecraft
     * arrangement, because it is the one everybody already knows how to use.
     *
     * The music is real tracks from `public/music/` (see the README there:
     * the repo ships the player and the manifest, and the tracks are dropped
     * in from CC0 sources so the project never ships audio it does not own).
     * The effects are synthesised live in `core/audio.js` — no files at all.
     * Volumes are perceptual: they are squared on the way to the gain nodes.
     *
     * Music sits *above* the effects by default, on request: the effects are
     * meant to be audible punctuation under the soundtrack, not the other way
     * round. `musicPlaylist` names one of the playlists in
     * `public/music/manifest.json`; an unknown or empty playlist simply plays
     * nothing until its files arrive.
     */
    musicOn: true,
    musicVolume: 0.7,
    musicPlaylist: "Synthwave Chill",
    sfxOn: true,
    sfxVolume: 0.7,

    // -------------------------------------------------------------- the moon
    /**
     * Which stretch of the moon this session surfs, 0-999.
     *
     * Fresh each visit, pinned with `?seed=N` in the URL — the number is
     * logged to the console at boot so a good map can be shared. It slides
     * the height bake's noise domain (see heightBake.fragment.wgsl), so
     * every seed has its own swells, craters and massifs, and each carries
     * one landmark complex a few hundred metres from spawn: twin craters
     * joined by a canyon, and a lava-tube rille under a dome.
     */
    worldSeed: (() => {
        if (typeof location !== "undefined") {
            const q = new URLSearchParams(location.search).get("seed");
            if (q !== null && q !== "" && Number.isFinite(+q)) {
                return Math.abs(Math.floor(+q)) % 1000;
            }
        }
        return Math.floor(Math.random() * 1000);
    })(),
    /**
     * Master scale on the nebula fill the ground carries.
     *
     * Not a stylistic nicety. One small star at thirteen degrees and a sky whose
     * integrated irradiance is a rounding error beside it means a shadow here is
     * as black as the void above it — which is exactly what a shadow on the real
     * moon is, and which would leave half of most frames with nothing in them.
     * At zero the ground goes to a lit rim and nothing else.
     *
     * The hue is `nebulaFill` in brand.js and this is only its magnitude. At 0.75
     * a shadowed crater floor lands near output level 38 against sunlit highland
     * at 172 — a four-and-a-half-stop split, which is brutal by the standards of
     * a scene with an atmosphere in it and about right for one without.
     */
    dustGlow: 0.75,
    glintIntensity: 0.55,
    glintGrazing: 0.72, // how hard the grazing-angle gate bites
    // Trimmed from 1.0 in the de-glass pass: full-strength transmission put a
    // waxy glow on every backlit crest, which read as polish rather than dust.
    sssStrength: 0.75,
    sssRadius: 1.0,
    detailNormalStrength: 1.0,
    macroHeightScale: 1.0,
    sastrugiStrength: 1.0,

    // ----------------------------------------------------------- deformation
    deformDepth: 1.0,
    deformBerm: 1.0,
    refillRate: 1.0,
    deformResolution: 2048,

    // ----------------------------------------------------------- star-surf
    /** Height of the breaking wall thrown by a carve, as a multiple of 1.45 m. */
    wakeHeight: 1.0,
    /** Density of the plume shed off the wake's lip. */
    wakeSpray: 1.0,
    /**
     * The camera settles behind the direction of travel whenever the look input
     * is idle.
     *
     * Off on a desktop and on for touch — `PRESETS.mobile` turns it on. That
     * split is the whole point of the setting. A mouse aims the camera and the
     * board at once and a camera that quietly re-aimed itself would be fighting
     * the hand that is already steering it. A thumb cannot: the stick and the
     * look pad are different hands, and holding a heading through a carve while
     * also dragging the camera round to see where the carve is going is not
     * something anyone manages on a phone. So on touch the camera does it.
     */
    followCamera: false,
    /** Screen-space speed streaks while surfing. */
    windStreaks: true,
    streakStrength: 1.0,

    // ---------------------------------------------------------------- powers
    // `spell` in a key name means one of the five. The name is read by a dozen
    // files and appears in no user-facing string — the overlay labels these
    // "Powers" — so it stays.
    /** Master toggle. Off cancels everything in flight and hides both meshes. */
    showSpells: true,
    /** Brightness of the dynamic lights the powers emit. */
    spellLight: 1.0,
    /** Density of the ejecta every power throws. */
    spellSpray: 1.0,
    /**
     * Artistic scale on the plasma's absorption path — how much of the body's
     * own colour a ray picks up crossing it. Thin and near-transparent at one
     * end, dense and saturated at the other. The right value depends on how
     * bright the backdrop behind the body is, so it is a slider rather than a
     * constant.
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
    // Solved against the AgX curve rather than dialled in. The dynamic range in
    // frame is enormous — the void between stars sits four orders of magnitude
    // below the star's own disc — and the eye is a poor judge at that spread.
    //
    // Feeding the measured scene radiances through the whole chain (exposure,
    // the contrast power, AgX, its EOTF, the sRGB encode) puts the frame here,
    // in 8-bit output levels:
    //
    //     the void                  0        median sky pixel         0
    //     auroral curtain, 99th    90        curtain peak           128
    //     crater floor, shadowed   38        mare, shadowed          49
    //     mare, sunlit            145        highland, sunlit       172
    //     wake crest, full carve  211        brightest thrown grain 236
    //     sunlit suit             244
    //
    // Which is the ladder this scene wants. The sky is *black* — not dark, black,
    // at the median and at the void both — so the curtains and the star field are
    // read against nothing, and no part of the backdrop reaches the bloom
    // threshold and glows. The ground occupies the whole middle of the range with
    // an enormous gap across the terminator, which is the single most lunar thing
    // about the frame, and the suit is the brightest thing in it without touching
    // clip.
    //
    // The ground's own numbers moved twice and landed back where they started.
    // Regolith reflects a third more than the violet dust it replaced, so
    // `SUN_SCALE_BASE` in render/sky.js came down by a third to compensate and
    // sunlit ground sits at 172 where lit dust sat at 179. Nothing else in this
    // table had to move, which was the entire point of doing it that way.
    //
    // The ceiling is the AgX shoulder, and it is closer than it looks — a stop
    // over this and the wake crest, the grains and the suit all land in the region
    // where the curve's slope collapses and resolve to the same flat white,
    // which costs exactly the separation the whole look rests on. A stop under and
    // the aurora stops registering at all.
    exposure: 0.09,
    contrast: 1.14,
    bloomStrength: 0.13,
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
        group: "Sound",
        items: [
            { k: "musicOn", l: "Music", t: "b" },
            { k: "musicVolume", l: "Music volume", t: "f", min: 0, max: 1, step: 0.01 },
            { k: "sfxOn", l: "Effects", t: "b" },
            { k: "sfxVolume", l: "Effects volume", t: "f", min: 0, max: 1, step: 0.01 },
        ],
    },
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
            { k: "nebulaStrength", l: "Aurora", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "showPlanet", l: "Planet", t: "b" },
            { k: "planetBearing", l: "Planet bearing", t: "f", min: 0, max: 360, step: 1 },
            { k: "planetElevation", l: "Planet height", t: "f", min: 5, max: 70, step: 1 },
            { k: "planetSize", l: "Planet size", t: "f", min: 1, max: 45, step: 0.1 },
            { k: "planetGlow", l: "Planet bright", t: "f", min: 0, max: 6, step: 0.05 },
        ],
    },
    {
        group: "Void",
        items: [
            { k: "fogDensity", l: "Medium density", t: "f", min: 0, max: 0.03, step: 0.0001 },
            { k: "fogHeightFalloff", l: "Height falloff", t: "f", min: 0, max: 0.3, step: 0.001 },
            { k: "aerialStrength", l: "Depth haze", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "windDirection", l: "Drift dir", t: "f", min: 0, max: 360, step: 1 },
            { k: "windStrength", l: "Drift strength", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "showMountains", l: "Far range", t: "b" },
            { k: "mountainHeight", l: "Range height", t: "f", min: 0, max: 4000, step: 10 },
            { k: "showLightShafts", l: "Light shafts", t: "b" },
            { k: "shaftStrength", l: "Shaft amt", t: "f", min: 0, max: 2, step: 0.01 },
        ],
    },
    {
        group: "The moon",
        items: [
            { k: "dustGlow", l: "Nebula fill", t: "f", min: 0, max: 3, step: 0.01 },
            { k: "glintIntensity", l: "Sparkle", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "glintGrazing", l: "Sparkle gate", t: "f", min: 0, max: 1, step: 0.01 },
            { k: "sssStrength", l: "Glow strength", t: "f", min: 0, max: 3, step: 0.01 },
            { k: "sssRadius", l: "Glow radius", t: "f", min: 0.1, max: 3, step: 0.01 },
            { k: "detailNormalStrength", l: "Detail normals", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "macroHeightScale", l: "Relief height", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "sastrugiStrength", l: "Rubble", t: "f", min: 0, max: 2, step: 0.01 },
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
            { k: "followCamera", l: "Follow camera", t: "b" },
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
    /**
     * Phones and tablets. Applied automatically at boot on a coarse-pointer
     * device — see `core/device.js`, which also steps the fixed render targets
     * down, since those cannot be changed after construction.
     *
     * What survives and what goes is not arbitrary. The passes cut are the ones
     * whose cost is per-pixel and whose contribution is subtle at arm's length:
     * screen-space reflections run a march per mirror pixel to add a reflection
     * of a mostly-black sky, and depth of field runs a sixteen-tap gather to
     * defocus a background nobody is studying on a five-inch screen.
     *
     * Bloom, TAA and the tonemap all stay. Bloom is not decoration here — it is
     * how the wake's crest, the thrown grains and the galactic band read as
     * bright rather than merely pale, and without it the whole frame goes flat.
     * TAA stays because the point-star field is a two-pixel feature and aliases
     * horribly without it, and a phone's pixel density makes that worse, not
     * better. Sharpening goes because the resolution scale already softens the
     * image and sharpening a upscaled frame just amplifies its own artefacts.
     */
    mobile: {
        deformResolution: 1024,
        resolutionScale: 0.75,
        // See `followCamera` above: with the stick and the look pad on different
        // thumbs, a camera that does not follow means surfing blind.
        followCamera: true,
        ssr: false,
        dof: false,
        sharpen: false,
        shaftStrength: 0.10,
        // Fewer stars, brighter each. A dense field at a phone's pixel pitch is
        // a grey haze; a sparse one still reads as stars. Scaled against the
        // halved desktop default, same ratio as before.
        starDensity: 0.35,
        starBrightness: 1.15,
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
