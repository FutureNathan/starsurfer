/**
 * The pause menu — Escape, on a keyboard.
 *
 * The boot screen shows the controls once, for as long as the shaders take to
 * compile, and then they are gone. This is the other half of that design: a
 * menu a player can *return* to, mid-session, without hunting for it — and
 * Escape is where every game keyboard hand already knows to look.
 *
 * It does three things at once, because on a pointer-locked page they are the
 * same gesture. Escape drops pointer lock (the browser does that part, and no
 * page is allowed to veto it), which frees the mouse; the lock loss opens this
 * menu; and the menu's presence pauses the simulation. Alt-tab and window
 * focus loss come through the identical path, so walking away from the game
 * pauses it too, which is what anyone would want it to do anyway.
 *
 * This is the *player's* menu, deliberately separate from the F1 overlay,
 * which is an instrument panel: every art parameter, timing graphs, debug
 * views. Normal people need eleven keycaps and a resume button, and they need
 * them typeset, not logged.
 *
 * Desktop only. A touchscreen has no Escape key and its controls are already
 * on the screen, labelled, all the time — the problem this menu solves does
 * not exist there.
 */

import { S } from "./settings.js";

/**
 * The rows, as (what it does, the keycaps that do it). A key string is split
 * on spaces into individual caps; a `+`-joined string stays one cap.
 */
const SECTIONS = [
    ["surfing", [
        ["move", "W A S D"],
        ["look", "mouse"],
        ["zoom", "wheel"],
        ["sprint", "shift"],
        ["star-surf · hold", "right·mouse"],
    ]],
    ["the five powers", [
        ["solar flare", "1"],
        ["ion stream · hold", "2"],
        ["supernova", "3"],
        ["asteroid · storms stack", "4"],
        ["gravity well", "5"],
    ]],
    ["system", [
        ["settings and stats", "F1"],
        ["pause", "esc"],
    ]],
];

const CSS = `
#pause {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: none;
    place-items: center;
    background: rgba(5, 6, 15, 0.82);
    backdrop-filter: blur(3px);
    -webkit-backdrop-filter: blur(3px);
}
#pause.show { display: grid; }
.pm-panel {
    width: min(430px, 88vw);
    max-height: 86vh;
    overflow-y: auto;
    padding: 2.1em 2.4em 1.9em;
    background: rgba(10, 10, 26, 0.86);
    border: 1px solid rgba(184, 162, 255, 0.16);
    border-radius: 14px;
    text-align: center;
    font-family: inherit;
}
.pm-mark {
    font-size: 17px;
    font-weight: 200;
    letter-spacing: 0.42em;
    text-indent: 0.42em;
    color: var(--star);
}
.pm-sub {
    margin-top: 0.7em;
    font-size: 9px;
    letter-spacing: 0.30em;
    text-indent: 0.30em;
    text-transform: uppercase;
    color: var(--dim);
}
.pm-h {
    margin: 1.9em 0 0.9em;
    font-size: 9px;
    letter-spacing: 0.26em;
    text-transform: uppercase;
    color: var(--accent);
    text-align: left;
}
.pm-row {
    display: flex;
    align-items: center;
    gap: 1em;
    margin: 0.44em 0;
}
.pm-row dt {
    flex: 1;
    text-align: left;
    font-size: 11px;
    letter-spacing: 0.08em;
    color: var(--star);
    opacity: 0.85;
    white-space: nowrap;
}
.pm-row dd { margin: 0; display: flex; gap: 0.32em; }
.pm-key {
    min-width: 1.9em;
    padding: 0.34em 0.55em;
    border-radius: 5px;
    background: rgba(255, 246, 224, 0.92);
    color: #14142c;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    box-shadow: 0 2px 0 rgba(184, 162, 255, 0.35);
}
.pm-seed {
    margin-top: 1.7em;
    font-size: 9px;
    letter-spacing: 0.14em;
    color: var(--dim);
}
.pm-seed b { color: var(--dust); font-weight: 500; }
#pm-resume {
    margin-top: 1.5em;
    padding: 0.85em 2.6em;
    border: 1px solid rgba(255, 196, 107, 0.45);
    border-radius: 999px;
    background: none;
    color: var(--accent);
    font: inherit;
    font-size: 11px;
    letter-spacing: 0.30em;
    text-indent: 0.30em;
    text-transform: uppercase;
    cursor: pointer;
}
#pm-resume:hover { background: rgba(255, 196, 107, 0.12); }
@media (max-height: 560px) {
    .pm-panel { padding: 1.4em 1.8em 1.3em; }
    .pm-h { margin: 1.1em 0 0.5em; }
    .pm-row { margin: 0.26em 0; }
}
`;

function keycaps(spec) {
    let out = "";
    for (const k of spec.split(" ")) {
        out += `<span class="pm-key">${k.replace(/·/g, " ")}</span>`;
    }
    return out;
}

/**
 * Mount the menu.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {{ readonly paused: boolean }}
 */
export function initPauseMenu(canvas) {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    let rows = "";
    for (const [title, list] of SECTIONS) {
        rows += `<div class="pm-h">${title}</div><dl>`;
        for (const [what, keys] of list) {
            rows += `<div class="pm-row"><dt>${what}</dt><dd>${keycaps(keys)}</dd></div>`;
        }
        rows += `</dl>`;
    }

    const root = document.createElement("div");
    root.id = "pause";
    root.innerHTML = `
        <div class="pm-panel">
            <div class="pm-mark">STARSURFER</div>
            <div class="pm-sub">paused</div>
            ${rows}
            <div class="pm-seed">world <b>${S.worldSeed}</b> · add
                <b>?seed=${S.worldSeed}</b> to the address to come back to it</div>
            <button id="pm-resume">resume</button>
        </div>`;
    document.body.appendChild(root);

    let open = false;

    const show = () => { open = true; root.classList.add("show"); };
    const hide = () => { open = false; root.classList.remove("show"); };

    // Resume re-locks the pointer, because a click is a real user activation
    // and Escape is not — the browser refuses a lock request made from the
    // very key that just broke one.
    const resume = () => {
        hide();
        canvas.requestPointerLock?.();
    };
    root.querySelector("#pm-resume")?.addEventListener("click", (e) => {
        e.stopPropagation();
        resume();
    });
    // The backdrop resumes too — a full-screen "away" target beats aiming for
    // one small button — but clicks inside the panel stay in the panel.
    root.addEventListener("click", (e) => { if (e.target === root) resume(); });

    // Losing pointer lock *is* the pause gesture. Escape, alt-tab and focus
    // loss all arrive here, and all of them mean the player has left the game.
    document.addEventListener("pointerlockchange", () => {
        if (document.pointerLockElement !== canvas && !open) show();
    });

    // With the pointer never locked (first load, or a trackpad user who
    // never clicked into the scene) Escape still reaches the page as a real
    // keydown, so the menu keeps working without the lock dance.
    window.addEventListener("keydown", (e) => {
        if (e.code !== "Escape") return;
        if (open) { hide(); }
        else if (document.pointerLockElement !== canvas) { show(); }
    });

    return { get paused() { return open; } };
}
