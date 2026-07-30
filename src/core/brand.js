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
 * The palette as authored. Black indigo void, violet and teal aurora, warm gold
 * accent — warm rather than the usual cold sci-fi cyan, which is the whole point:
 * this is meant to read as optimistic.
 *
 * The three greys at the bottom are a different kind of entry from the rest.
 * Everything above them is a design decision; those are measurements, and they
 * are in here because the ground is most of the frame and the one thing that
 * must not be redesigned by accident.
 */
export const HEX = {
    /** Near-black indigo. The colour of empty sky between stars. */
    void: "#05060f",
    /** The dark end of the violet ramp. */
    nebulaDeep: "#2a1a4d",
    /** The bright end of it, where the aurora's violet curtains sit. */
    nebulaBright: "#6b2f7a",
    /** Lit stardust — the wake, the spray, the powers. Not the ground. */
    dust: "#b8a2ff",
    /** Stardust in shadow, cooled and darkened. */
    dustShade: "#3b2f66",
    /**
     * Highland regolith — the ground, and about two thirds of it.
     *
     * 0.128 linear in red. Almost nobody guesses the moon this dark, because it
     * is the only thing in the sky and the eye has nothing to compare it
     * against; a full moon's disc reflects about as much as worn asphalt.
     * Getting it right is most of the difference between a moon and a snowfield.
     */
    regolith: "#64605c",
    /**
     * Mare basalt — the dark flood plains, roughly half as reflective and a
     * touch bluer. That contrast is why the moon has visible markings from a
     * quarter of a million miles away, and at ground level it is what stops a
     * crater field reading as one flat plane with holes in it.
     */
    regolithDark: "#4a494a",
    /**
     * Regolith thrown into the air — the wake's wall, its curtain, and the mass
     * a power lifts.
     *
     * Far brighter than the ground it came out of, and legitimately so. Airborne
     * dust is lit from every side rather than only from above, it scatters
     * strongly forward, and it has just been broken open so none of it is
     * space-weathered. Warm, because it is a warm star lighting grey rock and
     * there is nothing else in the sky to cool it.
     */
    wakeDust: "#d8d2c8",
    /**
     * The nebula fill the ground glows with in shadow.
     *
     * A radiance and not a reflectance, and the only reason it is a hex code at
     * all is that its *hue* is a design decision even though its magnitude is
     * not — the magnitude lives in `S.dustGlow`. Neutral and barely cool: it
     * used to be a saturated violet, which was right when the ground was made of
     * violet dust and was most of what made this read as lava once the ground
     * was made of rock.
     */
    nebulaFill: "#595d6a",
    /** Warm gold. Faceplate, wake lip, trim, UI accent. The signature. */
    accent: "#ffc46b",
    /**
     * Hot orange — ablation. The red end of the same warm ramp the accent sits
     * on, and the only place it is used is the Asteroid's entry trail.
     *
     * A separate entry rather than a darkened accent because the two have to be
     * *distinguishable*: the Solar Flare is the accent, and a bolide rendered in
     * the same hue reads as a Solar Flare going off in the distance rather than
     * as something arriving.
     */
    ember: "#ff7a33",
    /** Starlight white, very slightly warm so it sits with the gold. */
    star: "#fff6e0",
    /**
     * EVA suit white, and deliberately several steps down from white.
     *
     * Beta cloth really is about 0.8 reflectance, and at that value the suit
     * lands two and a half stops above the ground it stands on — a ratio no
     * display holds, so the whole figure resolves to one flat clipped white and
     * loses every bit of form the lofting put into it. Dropping it to ~0.55
     * linear buys back the top of the AgX curve, and it is the honest answer
     * anyway: a suit working a dust sea does not stay clean.
     */
    suit: "#c4bfd2",
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
    /**
     * The wall of thrown regolith, at a full carve. Comfortably over the knee.
     *
     * The gain is higher than the violet it replaced — 11.5 against 8 — and lands
     * in the same place. `LIN.dust` was a lavender whose blue channel was almost
     * exactly 1.0, so the old gain *was* the wall's peak radiance; `LIN.wakeDust`
     * peaks at 0.69, so the same 7.9 on screen costs a larger number here. The
     * wall did not get brighter. It stopped being purple.
     */
    wake: { hue: LIN.wakeDust, gain: 11.5 },
    /** Individual grains flung clear of the wake. The brightest thing thrown. */
    grain: { hue: LIN.star, gain: 14.0 },
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
