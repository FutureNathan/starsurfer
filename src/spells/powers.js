/**
 * What the five powers are made of.
 *
 * Every power puts light into the frame three ways — the radiance of its own
 * body, the pool light it casts on everything around it, and the charge it
 * leaves in the ground — and all three have to agree about what colour it is.
 * One table, read by the power, by the body renderer and by the lattice
 * renderer, is what makes that true by construction rather than by three files
 * happening to hold the same triple.
 *
 * Hues come from `brand.js`. Gains do not, because a gain is a *radiance* on the
 * scene's own scale, and that scale is set by two measured numbers:
 *
 *   lit dust sits near 5 in linear, pre-exposure units
 *   the bloom bright pass thresholds at 3.0 in the same units
 *
 * So a body gain above 3 blooms, and one near 5 reads as bright as the ground it
 * is standing on. Those two numbers are what every gain below is chosen against,
 * and they are the reason none of these are in [0,1] like a hex code.
 */

import { LIN } from "../core/brand.js";

/**
 * Rescale a linear triple so its largest channel is exactly 1.
 *
 * The palette is authored as *reflectances*, so the darker entries — the nebula
 * violets — sit at a tenth of the brighter ones. As a hue that is meaningless:
 * multiplying a dark triple by a big gain and a bright triple by a small one
 * describes the same light twice in two incomparable units. Normalising first
 * means a gain is always "peak radiance of the brightest channel", and the five
 * powers can be compared to each other and to the bloom knee by reading one
 * number.
 *
 * @param {[number,number,number]} c
 * @returns {[number,number,number]}
 */
function hue(c) {
    const m = Math.max(c[0], c[1], c[2]) || 1;
    return [c[0] / m, c[1] / m, c[2] / m];
}

/**
 * @param {[number,number,number]} a
 * @param {[number,number,number]} b
 * @param {number} t
 * @returns {[number,number,number]}
 */
function blend(a, b, t) {
    return [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ];
}

/**
 * The five identities.
 *
 *   `hue`       normalised linear colour. The body's emission, the pool light and
 *               the charge left in the ground all use it, so a power cannot be
 *               one colour close up and another at range.
 *   `body`      peak radiance of the body itself, where its optical depth has
 *               saturated. Read against 5 (lit dust) and 3 (the bloom knee).
 *   `light`     peak radiance of the pool light *at its own position*.
 *
 * The two orders of magnitude between `body` and `light` are the geometry rather
 * than a preference. A body gain is what the eye sees when it looks at the thing;
 * a light gain is measured at the emitter and falls off as the inverse square, so
 * by the two or three metres at which it actually reaches the ground it is worth
 * a tenth of the number written here — and then it is multiplied by an albedo of
 * 0.085. Under a surface that dark, a light has to start an order of magnitude
 * above the body it belongs to before it puts anything on the ground at all.
 */
export const POWERS = {
    /**
     * 1 — Solar Flare. Warm gold, the house signature, and the hottest sustained
     * thing on the ground: a crescent of dust that has been ignited rather than
     * merely thrown, so it has to out-burn the wake's own crest at 10.
     */
    flare: { hue: hue(LIN.accent), body: 12.0, light: 130.0 },

    /**
     * 2 — Ion Stream. The dust's own colour, ionised. Held rather than cast, so
     * it is the one power that can be on screen continuously — which is exactly
     * why it is the dimmest of the four bodies. A tether that sits at nova
     * brightness for ten seconds stops being an event and becomes the exposure.
     */
    ion: { hue: hue(LIN.dust), body: 6.0, light: 60.0 },

    /**
     * 3 — Supernova. White-hot, and the one power allowed outside the violet and
     * gold family: a detonation is defined by being hotter than everything around
     * it, and past a certain temperature everything is white. Five times the lit
     * ground standing, three stops over the bloom knee, and the power itself
     * multiplies this again for the third of a second the burst lasts.
     */
    nova: { hue: hue(LIN.star), body: 26.0, light: 220.0 },

    /**
     * 4 — Asteroid. Hot orange, and the only entry in the table that is not gold,
     * white or violet.
     *
     * That is deliberate and it is doing a specific job. The Solar Flare is the
     * house gold and the Supernova is white, so an entry trail rendered in either
     * would read as one of those two happening a long way away. Ablation is
     * neither: it is rock and iron boiling off a surface, which sits at the red
     * end of the warm ramp, well below a detonation. The white the head runs is
     * not in this hue at all — it comes from the body's own ignition-front
     * channel, which is exactly what that channel is for.
     *
     * Sixteen puts the trail between the Flare and the Supernova standing, and
     * the power multiplies it again on the way down. The light is the second
     * highest here because for most of the cast it is a hundred metres up, and
     * the inverse square does not care how dramatic the object is.
     */
    impact: { hue: hue(LIN.ember), body: 16.0, light: 200.0 },

    /**
     * 5 — Gravity Well. The deep end of the nebula ramp, and deliberately the
     * dimmest body of the five. A well is a thing light falls *into*; the column
     * is mostly lifted dust rather than plasma, so it wells at about the
     * brightness of the ground it tore up rather than burning like the rest.
     */
    well: { hue: hue(LIN.nebulaDeep), body: 4.0, light: 90.0 },
};
