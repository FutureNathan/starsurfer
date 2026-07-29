/**
 * STARSURFER — the one place the palette lives.
 *
 * Every colour in the demo resolves through here: the boot screen and the
 * settings overlay read the hex strings, and every material, LUT bake and
 * particle system reads the linear triples. Retuning the look is editing this
 * file, not hunting literals through twenty shaders.
 *
 * Two representations, because the two consumers want different things:
 *
 *   HEX     sRGB, for CSS and for anything a human reads. What you would paste
 *           into a design tool.
 *   linear  The same colours with the sRGB transfer curve removed. Shading maths
 *           is linear, and mixing gamma-encoded values is the single most
 *           common way a procedural scene ends up muddy.
 *
 * Anything that is a *radiance* rather than a *reflectance* — the star, the
 * visor glow, the wake — carries its own intensity multiplier alongside the
 * hue, because those live well above 1.0 in an HDR scene and clamping them to
 * the [0,1] a hex code can express would flatten exactly the parts bloom is
 * supposed to catch.
 */

// ---------------------------------------------------------------- sRGB → linear

/** @param {number} c one sRGB channel in [0,1] */
function toLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * "#rrggbb" → [r, g, b] in linear space.
 * @param {string} hex
 * @returns {[number, number, number]}
 */
export function linear(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [
        toLinear(((n >> 16) & 255) / 255),
        toLinear(((n >> 8) & 255) / 255),
        toLinear((n & 255) / 255),
    ];
}

// --------------------------------------------------------------------- the hues

/**
 * The palette as authored. Deep indigo void, violet-magenta nebula, warm gold
 * accent — warm rather than the usual cold sci-fi cyan, which is the whole
 * point: this is meant to read as optimistic.
 */
export const HEX = {
    /** Near-black indigo. The colour of empty sky between stars. */
    void: "#05060f",
    /** The dark end of the nebula ramp. */
    nebulaDeep: "#2a1a4d",
    /** The bright end of the nebula ramp, where the galactic band burns. */
    nebulaBright: "#6b2f7a",
    /** Lit cosmic dust — the surface being surfed. */
    dust: "#b8a2ff",
    /** The dust in shadow, cooled and darkened. */
    dustShade: "#3b2f66",
    /** Warm gold. Visor, wake, trim, UI accent. The signature. */
    accent: "#ffc46b",
    /** Starlight white, very slightly warm so it sits with the gold. */
    star: "#fff6e0",
    /** EVA suit white — never pure white, or it blows out against the void. */
    suit: "#e6e2f0",
    /** Muted violet-grey for secondary UI text. */
    dim: "#7a6f9e",
    /** Suit panels and soft goods, a step down from the shell. */
    suitDark: "#5a5470",
};

/** The same palette, linear, ready to hand to a shader or a Color3. */
export const LIN = /** @type {Record<keyof typeof HEX, [number,number,number]>} */ (
    Object.fromEntries(Object.entries(HEX).map(([k, v]) => [k, linear(v)]))
);

// ------------------------------------------------------------------- emissives

/**
 * Emissive colours, as (linear hue, radiance gain).
 *
 * Kept apart from `HEX` because these are the values that are *supposed* to
 * exceed 1.0. A hex code can only describe a reflectance; these are radiances,
 * and they live on the scene's own scale — where dust lit by the star sits near
 * 5 and the bloom bright-pass threshold is 3.0 in linear, pre-exposure units.
 * So the gains here are chosen against those two numbers: a gain that puts its
 * hue above 3 will bloom, and one that leaves it near 1 will read as a glow that
 * only asserts itself in shadow.
 */
export const EMIT = {
    /** The visor's own glow. It is mostly a mirror, not a lamp — but it blooms. */
    visor: { hue: LIN.accent, gain: 4.0 },
    /** The crest of the stardust wake, at a full carve. Comfortably over. */
    wake: { hue: LIN.dust, gain: 8.0 },
    /** Individual grains flung clear of the wake. The brightest thing thrown. */
    grain: { hue: LIN.star, gain: 14.0 },
    /** The suit's trim strip. Present in shadow, not a light source. */
    trim: { hue: LIN.accent, gain: 6.0 },
};

/**
 * Convenience: an emissive as a plain linear triple with its gain folded in.
 * @param {{hue:[number,number,number], gain:number}} e
 * @returns {[number, number, number]}
 */
export function emissive(e) {
    return [e.hue[0] * e.gain, e.hue[1] * e.gain, e.hue[2] * e.gain];
}

// ----------------------------------------------------------------------- naming

export const NAME = "STARSURFER";
export const TAGLINE = "a study in stars";
