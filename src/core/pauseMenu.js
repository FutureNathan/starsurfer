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
 * Two pages, one panel. The first is the player's: keycaps and a resume
 * button, nothing else. The second *adopts* the F1 overlay — the instrument
 * panel with every art parameter and timing graph — by reparenting its
 * element into the menu, so the two are one surface with the depth behind a
 * tab instead of behind a second keyboard shortcut. F1 in-game still opens
 * the overlay directly on the right edge, undocked, for anyone tuning while
 * riding; the tab is the same DOM either way, so the two routes can never
 * show different settings.
 *
 * Desktop only. A touchscreen has no Escape key and its controls are already
 * on the screen, labelled, all the time — the ⚙ button covers the overlay.
 */

import { S } from "./settings.js";

/**
 * The rows, as (what it does, the keycaps that do it). A key string is split
 * on spaces into individual caps; a `·` inside a cap becomes a space.
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
    width: min(500px, 92vw);
    max-height: 88vh;
    display: flex;
    flex-direction: column;
    padding: 2.0em 2.3em 1.6em;
    /* Solid, not glass. The panel is read, and text over a scene showing
       through at 8% is text fighting a moonscape for contrast. */
    background: #0a0a18;
    border-radius: 16px;
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.55),
                0 0 0 1px rgba(184, 162, 255, 0.12);
    text-align: center;
    font-family: inherit;
}
.pm-mark {
    font-size: 19px;
    font-weight: 200;
    letter-spacing: 0.42em;
    text-indent: 0.42em;
    color: var(--star);
}
.pm-tabs {
    display: flex;
    justify-content: center;
    gap: 2.2em;
    margin-top: 1.5em;
}
.pm-tab {
    padding: 0.3em 0.1em;
    border: 0;
    background: none;
    color: var(--dim);
    font: inherit;
    font-size: 11px;
    letter-spacing: 0.26em;
    text-indent: 0.26em;
    text-transform: uppercase;
    cursor: pointer;
    border-bottom: 1px solid transparent;
}
.pm-tab.on {
    color: var(--accent);
    border-bottom-color: rgba(255, 196, 107, 0.55);
}
.pm-body { overflow-y: auto; margin-top: 0.2em; }
.pm-body::-webkit-scrollbar { width: 7px; }
.pm-body::-webkit-scrollbar-thumb {
    background: rgba(184, 162, 255, 0.18);
    border-radius: 4px;
}
.pm-h {
    margin: 1.6em 0 0.7em;
    font-size: 10px;
    letter-spacing: 0.26em;
    text-transform: uppercase;
    color: var(--dim);
    text-align: left;
}
.pm-row {
    display: flex;
    align-items: center;
    gap: 1em;
    margin: 0.46em 0;
}
.pm-row dt {
    flex: 1;
    text-align: left;
    font-size: 13px;
    letter-spacing: 0.06em;
    color: var(--star);
    opacity: 0.92;
    white-space: nowrap;
}
.pm-row dd { margin: 0; display: flex; gap: 0.32em; }
.pm-key {
    min-width: 2.0em;
    padding: 0.36em 0.6em;
    border-radius: 5px;
    background: rgba(255, 246, 224, 0.94);
    color: #14142c;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    box-shadow: 0 2px 0 rgba(184, 162, 255, 0.35);
}
.pm-seed {
    margin-top: 1.6em;
    font-size: 10px;
    letter-spacing: 0.12em;
    color: var(--dim);
}
.pm-seed b { color: var(--dust); font-weight: 500; }
.pm-credit {
    display: inline-flex;
    align-items: center;
    gap: 0.5em;
    margin: 1.3em auto 0;
    padding: 0.55em 1.1em;
    border-radius: 999px;
    background: #16121c;
    color: var(--dim);
    font-size: 11px;
    letter-spacing: 0.05em;
    text-decoration: none;
    transition: color 140ms ease;
}
.pm-credit:hover { color: #ffffff; }
.pm-credit .up { font-size: 9px; opacity: 0.7; }
#pm-resume {
    flex: none;
    margin: 1.4em auto 0;
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

/* The standing invitation, while playing: bottom-right, out of the frame's
   way, gone the moment the menu it advertises is open. */
#esc-hint {
    position: fixed;
    right: 18px;
    bottom: 14px;
    z-index: 50;
    font-size: 10px;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: rgba(255, 246, 224, 0.34);
    text-shadow: 0 1px 10px rgba(0, 0, 0, 0.8);
    pointer-events: none;
    transition: opacity 400ms ease;
}
#esc-hint.off { opacity: 0; }

/* The overlay, when the settings tab has adopted it: docked into the panel
   flow instead of pinned to the viewport edge. Same element, same handlers —
   only its frame changes. */
.pm-page #ov {
    position: static;
    display: block;
    width: 100%;
    border-left: 0;
    background: none;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    padding: 4px 2px 12px;
    text-align: left;
}
@media (max-height: 560px) {
    .pm-panel { padding: 1.3em 1.6em 1.2em; }
    .pm-h { margin: 1.0em 0 0.4em; }
    .pm-row { margin: 0.24em 0; }
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
 * @param {import("../ui/overlay.js").Overlay} [overlay] adopted by the
 *   settings tab when present
 * @returns {{ readonly paused: boolean }}
 */
export function initPauseMenu(canvas, overlay) {
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
            <div class="pm-tabs">
                <button class="pm-tab on" data-page="controls">controls</button>
                <button class="pm-tab" data-page="settings">settings &amp; stats</button>
            </div>
            <div class="pm-body">
                <div class="pm-page" data-page="controls">
                    ${rows}
                    <div class="pm-row" style="margin-top:1.2em">
                        <dt>pause · this menu</dt><dd>${keycaps("esc")}</dd>
                    </div>
                    <div class="pm-seed">world <b>${S.worldSeed}</b> · add
                        <b>?seed=${S.worldSeed}</b> to the address to come back
                        to it</div>
                </div>
                <div class="pm-page" data-page="settings" hidden></div>
            </div>
            <button id="pm-resume">resume</button>
            <a class="pm-credit" href="https://nathantowianski.com"
               target="_blank" rel="noopener">Made with ❤️ by Nathan
               <span class="up">↗</span></a>
        </div>`;
    document.body.appendChild(root);

    // The invitation the menu needs to be found at all: a quiet corner label
    // while riding. It is mounted here rather than in the HTML because it is
    // desktop-shaped — a touchscreen has no Escape key to advertise.
    const escHint = document.createElement("div");
    escHint.id = "esc-hint";
    escHint.textContent = "esc — pause · menu";
    document.body.appendChild(escHint);

    const tabs = /** @type {HTMLElement[]} */ ([...root.querySelectorAll(".pm-tab")]);
    const pages = /** @type {HTMLElement[]} */ ([...root.querySelectorAll(".pm-page")]);
    const settingsPage = pages.find((p) => p.dataset.page === "settings");

    let open = false;

    const selectTab = (name) => {
        for (const t of tabs) t.classList.toggle("on", t.dataset.page === name);
        for (const p of pages) p.hidden = p.dataset.page !== name;
        if (!overlay) return;
        if (name === "settings") {
            // Adopt. The element keeps its listeners and its state; only its
            // parent — and with it the .pm-page CSS frame above — changes.
            settingsPage.appendChild(overlay.el);
            overlay.el.classList.add("show");
            overlay.visible = true;
        } else if (overlay.el.parentElement === settingsPage) {
            document.body.appendChild(overlay.el);
            overlay.el.classList.remove("show");
            overlay.visible = false;
        }
    };
    for (const t of tabs) {
        t.addEventListener("click", () => selectTab(t.dataset.page));
    }

    const show = () => {
        open = true;
        root.classList.add("show");
        escHint.classList.add("off");
    };
    const hide = () => {
        open = false;
        root.classList.remove("show");
        escHint.classList.remove("off");
        // Hand the overlay back undocked and closed, and land the next open
        // on the player's page — the depth is opt-in per visit.
        selectTab("controls");
    };

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
