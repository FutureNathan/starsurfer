/**
 * What kind of machine is this, and how much can it be asked for.
 *
 * Resolved once, before anything allocates, because the answers pick render
 * target sizes and those cannot be changed afterwards without rebuilding the
 * scene.
 *
 * The signal is the pointer, not the user agent. `(pointer: coarse)` is asking
 * the browser "is the primary input a finger", which is exactly the question
 * that decides whether the on-screen controls are needed — and it is also a good
 * proxy for the memory and bandwidth question, because the devices with fingers
 * are the devices with a shared-memory GPU. It gets tablets right, it gets a
 * touchscreen laptop wrong in the safe direction, and it needs no UA sniffing.
 *
 * Nothing here is a hard cap. Every one of these is reachable from the settings
 * overlay afterwards; the tier only decides where to start.
 */

const mq = (q) => typeof matchMedia === "function" && matchMedia(q).matches;

/**
 * `?touch=1` / `?touch=0` forces the answer, and forces it for *both* questions
 * below — the controls and the quality tier are one decision, so one switch
 * moves both. It exists for two cases: checking the phone layout from a desktop,
 * and a touchscreen laptop that reports a coarse pointer while sitting on a GPU
 * that does not need the step-down.
 */
const OVERRIDE = (() => {
    if (typeof location === "undefined") return null;
    const v = new URLSearchParams(location.search).get("touch");
    return v === "1" ? true : v === "0" ? false : null;
})();

/** The primary pointer is a finger. Drives whether the touch controls appear. */
export const COARSE_POINTER =
    OVERRIDE ?? (mq("(pointer: coarse)") || navigator.maxTouchPoints > 1);

/**
 * Treat this as a phone or tablet for the purposes of memory and fill rate.
 *
 * `deviceMemory` is Chrome-only and reports a floor rather than the real figure,
 * so it is used only to catch the low end — a coarse pointer alone is enough to
 * step down.
 */
export const MOBILE_TIER =
    OVERRIDE ??
    (COARSE_POINTER || (navigator.deviceMemory !== undefined && navigator.deviceMemory <= 4));

/**
 * Render target sizes, in texels.
 *
 * The mobile numbers are one halving each, which costs a quarter of the memory
 * per target and is worth roughly 250 MB across the scene:
 *
 *   height    4096² R32F is 67 MB on its own. At 2048² the field's texel goes
 *             from 0.5 m to 1.0 m, which the bicubic fetch absorbs — the macro
 *             layer's shortest wavelength is 13.5 m, so a metre still has it
 *             comfortably oversampled. This is the single biggest saving here.
 *   aux       slopes, shard mask and exposure. Same argument, one layer down.
 *   shadows   three cascades. 1024² doubles the world-space texel in every
 *             cascade, and the PCSS filter is measured in metres rather than in
 *             texels, so the penumbra keeps its size and only its sampling
 *             coarsens.
 *   detail    the tiled grain map. The only one of these the player looks at
 *             directly, so it steps down least willingly — but it is read at
 *             three world scales with mips, so a halving mostly costs the
 *             sub-centimetre octave that a phone's pixel density hides anyway.
 *
 * The trail buffer is not here: it is `S.deformResolution`, a live setting, and
 * the mobile preset steps it down along with everything else the overlay owns.
 */
export const QUALITY = MOBILE_TIER
    ? { heightRes: 2048, auxRes: 1024, shadowRes: 1024, detailRes: 512 }
    : { heightRes: 4096, auxRes: 2048, shadowRes: 2048, detailRes: 1024 };
