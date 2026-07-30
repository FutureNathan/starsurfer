/**
 * Loading-screen driver, and the one place the controls are written down.
 *
 * A phase-weighted progress model: each phase declares how much of the bar it
 * owns, and the bar only ever moves forward. `phase()` also yields to the
 * browser so the DOM actually repaints between heavy synchronous steps.
 *
 * The control list lives here rather than in the markup because there are two of
 * them — one for a keyboard and one for a touchscreen — and which is right is a
 * question only the JS can answer. Putting both in the HTML and hiding one would
 * mean the wrong list is briefly visible on first paint, and would put the
 * bindings in two files.
 */

import { COARSE_POINTER } from "./device.js";

const bar = /** @type {HTMLElement} */ (document.getElementById("boot-bar"));
const label = /** @type {HTMLElement} */ (document.getElementById("boot-phase"));
const root = /** @type {HTMLElement} */ (document.getElementById("boot"));
const hint = /** @type {HTMLElement} */ (document.getElementById("hint"));

let progress = 0;

/**
 * The controls, as (what you press, what it does).
 *
 * Shown on the loading screen, which is the only moment anyone is going to read
 * them. There is a captive audience there for as long as the pipelines take and
 * nothing else on screen; a demo whose controls appear for six seconds *after*
 * the loading screen has gone is a demo where a fair number of people never find
 * the powers at all.
 *
 * Six rows, and that is a ceiling rather than a coincidence. The boot screen has
 * to fit a landscape phone, and past six the list stops being something the eye
 * takes in at a glance and becomes a manual — at which point nobody reads it and
 * the whole point is lost.
 */
const KEYS = [
    ["W A S D", "move"],
    ["mouse", "look · wheel to zoom"],
    ["shift", "sprint"],
    ["right mouse", "star-surf"],
    ["1 – 5", "the five powers · 2 is held"],
    ["F1", "settings and stats"],
];

const TOUCH_KEYS = [
    ["drag", "look"],
    ["thumbstick", "walk · push out to surf"],
    ["two fingers", "zoom"],
    ["five buttons", "powers · ion is held"],
    ["⚙", "settings and stats"],
];

/**
 * The one-line version, revealed under the frame once the scene is up. The same
 * source as the table above, cut to the three things somebody who skipped the
 * loading screen still needs.
 */
const HINT = "click to look · wasd to move · right mouse to surf · f1 for settings";
const TOUCH_HINT = "drag to look · nudge the stick to walk · push it out to surf";

/**
 * Fill in the control list. Runs on import, which is early enough: the module
 * graph is resolved before any of the loading phases begin, so the list is on
 * screen for the whole of the load rather than arriving partway through it.
 */
(function writeControls() {
    const touch = COARSE_POINTER;
    if (hint) hint.textContent = touch ? TOUCH_HINT : HINT;

    const list = document.getElementById("boot-keys");
    if (!list) return;
    const rows = touch ? TOUCH_KEYS : KEYS;
    let html = "";
    for (let i = 0; i < rows.length; i++) {
        // textContent-equivalent escaping is not needed — every string above is
        // a literal in this file — but the entities keep the markup honest.
        html += "<dt>" + rows[i][0] + "</dt><dd>" + rows[i][1] + "</dd>";
    }
    list.innerHTML = html;
})();

/** Yield to the compositor so the loading screen repaints. */
export function nextFrame() {
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

/**
 * @param {string} text shown under the bar
 * @param {number} to target progress, 0..1
 */
export async function phase(text, to) {
    if (label) label.textContent = text;
    progress = Math.max(progress, to);
    if (bar) bar.style.width = (progress * 100).toFixed(1) + "%";
    await nextFrame();
}

export async function done() {
    await phase("ready", 1);
    // Let the bar visibly land before the fade starts.
    await new Promise((r) => setTimeout(r, 360));
    root?.classList.add("gone");
    hint?.classList.add("show");
    setTimeout(() => {
        root?.remove();
        hint?.classList.remove("show");
    }, 6000);
}

export function fail(message) {
    root?.remove();
    const el = document.getElementById("nogpu");
    if (el) {
        el.classList.add("show");
        const b = el.querySelector("b");
        if (b && message) b.textContent = message;
    }
}
