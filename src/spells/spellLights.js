/**
 * The dynamic lights the powers emit.
 *
 * A tiny fixed pool — four slots, two pre-allocated Float32Arrays, no objects.
 * Powers declare their light each frame while they update; whatever is declared
 * by the end of the frame is what the materials see. Nothing is retained between
 * frames, so a power that stops updating stops lighting with no teardown.
 *
 * Every material that shades something the player can see reads the same two
 * arrays through `starSpellLights`. That is the point: a power has to light the
 * dust, the suit, the wake and the airborne grains out of one description, or it
 * reads as a glow pasted over a scene rather than as a light in it. It matters
 * more out here than it would over a brightly lit field: under one small star,
 * on a surface that reflects nine percent of what lands on it, a power is a far
 * larger fraction of the light in frame than anything else a single system
 * contributes.
 *
 * Allocation per frame: none.
 */

/** Must match `SPELL_LIGHT_MAX` in `lib/spellLights.wgsl`. */
export const MAX_SPELL_LIGHTS = 4;

/**
 * Uniform names every consumer material must declare. Exported so the material
 * constructors cannot drift from the include.
 */
export const SPELL_LIGHT_UNIFORMS = [
    "spellLightPos", "spellLightCol", "spellLightCount",
];

export class SpellLights {
    constructor() {
        /** (x, y, z, radius) per slot. */
        this.pos = new Float32Array(MAX_SPELL_LIGHTS * 4);
        /** (r, g, b, intensity) per slot. */
        this.col = new Float32Array(MAX_SPELL_LIGHTS * 4);
        this.count = 0;
        /** Multiplier the overlay drives, so the whole effect can be A/B'd. */
        this.scale = 1;
    }

    /** Drop last frame's declarations. Called once, before the powers update. */
    begin() {
        this.count = 0;
    }

    /**
     * Declare a light for this frame.
     *
     * **Full pool: the dimmest light loses, not the last one to ask.**
     *
     * Six declarations in one frame is ordinary rather than a corner case — the
     * Ion Stream is *held*, so it is up while everything else fires, and the
     * Supernova alone takes two slots. Dropping by arrival order would make the
     * loser whichever power happens to sit later in `SpellSystem.spells`, which
     * is not a property of the frame that anything can justify: a detonation
     * going off beside the player would silently delete a Gravity Well's light
     * because of an array index.
     *
     * Ranking on peak radiance is stable, costs a four-element scan, and picks
     * the light the eye would have picked. All five emitters sit within a few
     * metres of the player and their reaches are within a factor of one and a
     * half of each other, so peak radiance is an honest proxy for how much of the
     * frame each one is actually lighting.
     *
     * The hue must be **normalised** — largest channel exactly 1, which is what
     * `POWERS[*].hue` carries. That is not a stylistic preference: the ranking
     * above compares intensities, so an unnormalised hue would let a dark triple
     * with a big number in front of it out-rank a bright one that is actually
     * putting more light on the sea.
     *
     * @param {number} x @param {number} y @param {number} z
     * @param {number} radius metres; the falloff reaches exactly zero here
     * @param {number} r @param {number} g @param {number} b normalised linear hue
     * @param {number} intensity peak radiance at the emitter, linear
     */
    add(x, y, z, radius, r, g, b, intensity) {
        if (intensity <= 0 || radius <= 0) return;
        const k = intensity * this.scale;

        let i;
        if (this.count < MAX_SPELL_LIGHTS) {
            i = this.count++;
        } else {
            // Find the dimmest slot, and keep it if the newcomer cannot beat it.
            let dim = 0;
            for (let j = 1; j < MAX_SPELL_LIGHTS; j++) {
                if (this.col[j * 4 + 3] < this.col[dim * 4 + 3]) dim = j;
            }
            if (this.col[dim * 4 + 3] >= k) return;
            i = dim;
        }

        const o = i * 4;
        this.pos[o] = x;
        this.pos[o + 1] = y;
        this.pos[o + 2] = z;
        this.pos[o + 3] = radius;
        this.col[o] = r;
        this.col[o + 1] = g;
        this.col[o + 2] = b;
        this.col[o + 3] = k;
    }

    /**
     * Push the pool into one material.
     *
     * The whole array goes up whether or not every slot is live — a partial
     * upload would leave the tail holding a stale radius, and the shader's own
     * gate is the count rather than the contents.
     *
     * @param {import("@babylonjs/core/Materials/shaderMaterial").ShaderMaterial} m
     */
    apply(m) {
        m.setArray4("spellLightPos", this.pos);
        m.setArray4("spellLightCol", this.col);
        m.setFloat("spellLightCount", this.count);
    }
}
