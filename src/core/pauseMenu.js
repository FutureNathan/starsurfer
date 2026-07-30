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

import { S, set } from "./settings.js";

/**
 * The rows, as (what it does, the keycaps that do it). A key string is split
 * on spaces into individual caps; a `·` inside a cap becomes a space.
 */
const SECTIONS = [
    ["surfing", [
        ["move", "W A S D"],
        ["look", "mouse"],
        ["zoom", "wheel"],
        ["sprint · trick jump", "shift"],
        ["star-surf · hold", "right·mouse"],
        ["jetpack · double-tap, hold", "delete"],
    ]],
    ["the five powers", [
        ["solar flare", "1"],
        ["ion stream · hold", "2"],
        ["supernova", "3"],
        ["asteroid · storms stack", "4"],
        ["gravity well", "5"],
    ]],
];

/** The same panel on a touchscreen, with the gestures where the keys were. */
const SECTIONS_TOUCH = [
    ["surfing", [
        ["look", "drag"],
        ["walk · push out to surf", "stick"],
        ["zoom", "two·fingers"],
        ["pause · this menu", "⚙"],
    ]],
    ["the five powers", [
        ["solar flare", "flare"],
        ["ion stream · hold", "ion"],
        ["supernova", "nova"],
        ["asteroid · storms stack", "asteroid"],
        ["gravity well", "gravity"],
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
/* The one scroll container in the panel. min-height: 0 is load-bearing: a
   flex child's default minimum is its content height, so without it the body
   refuses to shrink below the overlay's full height and nothing ever
   scrolls — the panel just quietly overflows its own max-height instead. */
.pm-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    margin-top: 0.2em;
}
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

/* The sound tab: two switch-and-slider rows, Minecraft's arrangement. */
.pm-srow {
    display: flex;
    align-items: center;
    gap: 0.9em;
    margin: 0.9em 0;
}
.pm-srow dt {
    flex: 0 0 7.5em;
    text-align: left;
    font-size: 13px;
    letter-spacing: 0.06em;
    color: var(--star);
    opacity: 0.92;
}
.pm-tgl {
    flex: none;
    width: 34px;
    height: 18px;
    border: 0;
    border-radius: 9px;
    background: rgba(184, 162, 255, 0.18);
    position: relative;
    cursor: pointer;
    transition: background 140ms ease;
}
.pm-tgl::after {
    content: "";
    position: absolute;
    top: 3px;
    left: 3px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--dim);
    transition: transform 140ms ease, background 140ms ease;
}
.pm-tgl.on { background: rgba(255, 196, 107, 0.38); }
.pm-tgl.on::after { transform: translateX(16px); background: var(--accent); }
.pm-srow input[type=range] {
    flex: 1;
    -webkit-appearance: none;
    appearance: none;
    height: 3px;
    border-radius: 2px;
    background: rgba(184, 162, 255, 0.22);
    cursor: pointer;
}
.pm-srow input[type=range]::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 13px;
    height: 13px;
    border-radius: 50%;
    background: var(--accent);
}
#pm-pl { display: flex; flex-wrap: wrap; gap: 0.5em; }
.pm-pill {
    padding: 0.45em 1.0em;
    border: 1px solid rgba(184, 162, 255, 0.25);
    border-radius: 999px;
    background: none;
    color: var(--dim);
    font: inherit;
    font-size: 10px;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    cursor: pointer;
}
.pm-pill.on {
    border-color: rgba(255, 196, 107, 0.55);
    color: var(--accent);
}
.pm-np {
    margin-top: 1.5em;
    font-size: 10px;
    letter-spacing: 0.12em;
    color: var(--dim);
    min-height: 1.4em;
}
.pm-np b { color: var(--dust); font-weight: 500; }
.pm-note {
    margin-top: 1.1em;
    font-size: 10px;
    line-height: 1.7;
    letter-spacing: 0.06em;
    color: var(--dim);
    text-align: left;
}
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
   way, gone the moment the menu it advertises is open. A real button — chip
   background, border, keycap — because bare dim text over a sunlit moonscape
   was invisible exactly when it was needed. It is clickable for whenever the
   mouse is free (before the first pointer lock, or on a trackpad); with the
   pointer locked there is no cursor to click it with, and the keycap it is
   wearing *is* the instruction for that case. */
#esc-hint {
    position: fixed;
    right: 16px;
    bottom: 14px;
    z-index: 50;
    display: inline-flex;
    align-items: center;
    gap: 0.6em;
    padding: 0.55em 1.0em;
    border: 1px solid rgba(255, 246, 224, 0.30);
    border-radius: 999px;
    background: rgba(5, 6, 15, 0.78);
    color: rgba(255, 246, 224, 0.85);
    font: inherit;
    font-size: 10px;
    letter-spacing: 0.20em;
    text-transform: uppercase;
    cursor: pointer;
    transition: opacity 400ms ease, background 140ms ease;
}
#esc-hint:hover { background: rgba(20, 20, 44, 0.92); }
#esc-hint .pm-key { font-size: 9px; padding: 0.3em 0.5em; }
#esc-hint.off { opacity: 0; pointer-events: none; }

/* The overlay, when the settings tab has adopted it: docked into the panel
   flow instead of pinned to the viewport edge. Same element, same handlers —
   only its frame changes.

   The scroll overrides are the fix for the wheel doing nothing on this tab.
   Standalone, #ov is its own scroller and carries overscroll-behavior:
   contain; docked, it has no height limit, so it can never scroll itself —
   and "contain" then swallows every wheel event instead of letting it chain
   up to .pm-body, which is the element actually holding the scrollbar. */
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
    overflow-y: visible;
    overscroll-behavior: auto;
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
 * @param {{ nowPlaying: {title:string,artist:string}|null }} [audio] read by
 *   the sound tab's now-playing line
 * @param {boolean} [touch] touchscreen: gesture rows instead of keycaps, no
 *   esc chip (there is no Escape key to advertise — the ⚙ button opens this),
 *   and no pointer-lock dance on resume
 * @returns {{ readonly paused: boolean, show(): void }}
 */
export function initPauseMenu(canvas, overlay, audio, touch) {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    let rows = "";
    for (const [title, list] of (touch ? SECTIONS_TOUCH : SECTIONS)) {
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
                <button class="pm-tab" data-page="sound">sound</button>
                <button class="pm-tab" data-page="settings">settings &amp; stats</button>
            </div>
            <div class="pm-body">
                <div class="pm-page" data-page="controls">
                    ${rows}
                    ${touch ? "" : `<div class="pm-row" style="margin-top:1.2em">
                        <dt>pause · this menu</dt><dd>${keycaps("esc")}</dd>
                    </div>`}
                    <div class="pm-seed">world <b>${S.worldSeed}</b> · add
                        <b>?seed=${S.worldSeed}</b> to the address to come back
                        to it</div>
                </div>
                <div class="pm-page" data-page="sound" hidden>
                    <div class="pm-h">music</div>
                    <div class="pm-srow"><dt>music</dt>
                        <button class="pm-tgl" data-k="musicOn"></button>
                        <input type="range" min="0" max="1" step="0.01" data-k="musicVolume" />
                    </div>
                    <div class="pm-h">playlist</div>
                    <div id="pm-pl"></div>
                    <div class="pm-h">effects</div>
                    <div class="pm-srow"><dt>effects</dt>
                        <button class="pm-tgl" data-k="sfxOn"></button>
                        <input type="range" min="0" max="1" step="0.01" data-k="sfxVolume" />
                    </div>
                    <div class="pm-np" id="pm-np"></div>
                    <div class="pm-note">The effects — the board, the boots,
                    the five powers — are synthesised live in the engine.
                    The music is real tracks from <b>public/music/</b>, played
                    one at a time with a stretch of vacuum between, the way
                    Minecraft does it; every track is CC0 public domain.</div>
                </div>
                <div class="pm-page" data-page="settings" hidden></div>
            </div>
            <button id="pm-resume">resume</button>
            <a class="pm-credit" href="https://nathantowianski.com"
               target="_blank" rel="noopener">Made with ❤️ by Nathan
               <span class="up">↗</span></a>
        </div>`;
    document.body.appendChild(root);

    // The invitation the menu needs to be found at all: a corner chip while
    // riding. Desktop only — a touchscreen has no Escape key to advertise,
    // and its ⚙ button is already on screen doing this job.
    let escHint = null;
    if (!touch) {
        escHint = document.createElement("button");
        escHint.id = "esc-hint";
        escHint.innerHTML = `<span class="pm-key">esc</span> pause · menu`;
        document.body.appendChild(escHint);
    }

    const tabs = /** @type {HTMLElement[]} */ ([...root.querySelectorAll(".pm-tab")]);
    const pages = /** @type {HTMLElement[]} */ ([...root.querySelectorAll(".pm-page")]);
    const settingsPage = pages.find((p) => p.dataset.page === "settings");

    // The sound rows write straight into the same settings the F1 overlay
    // reads, through the same `set`, so the two surfaces can never disagree.
    for (const b of root.querySelectorAll(".pm-tgl")) {
        const k = b.dataset.k;
        const sync = () => b.classList.toggle("on", !!S[k]);
        sync();
        b.addEventListener("click", () => { set(k, !S[k]); sync(); });
    }
    for (const r of root.querySelectorAll(".pm-srow input[type=range]")) {
        const k = r.dataset.k;
        r.value = String(S[k]);
        r.addEventListener("input", () => set(k, parseFloat(r.value)));
    }
    const np = root.querySelector("#pm-np");
    const pl = root.querySelector("#pm-pl");
    const syncPlaylists = () => {
        if (!pl || !audio) return;
        // Rebuilt on every visit to the tab, because the manifest loads
        // asynchronously and playlists may appear after the menu mounts.
        pl.innerHTML = "";
        for (const name of audio.playlistNames) {
            const b = document.createElement("button");
            b.className = "pm-pill" + (S.musicPlaylist === name ? " on" : "");
            b.textContent = name;
            b.addEventListener("click", () => {
                set("musicPlaylist", name);
                syncPlaylists();
                syncNowPlaying();
            });
            pl.appendChild(b);
        }
    };
    const syncNowPlaying = () => {
        if (!np) return;
        const track = audio?.nowPlaying;
        if (track) {
            np.innerHTML = `now playing · <b>${track.title}</b>`
                + (track.artist ? ` — ${track.artist}` : "");
        } else if (!audio || audio.trackCount === 0) {
            // Say it plainly. "Nothing playing" against an empty playlist
            // reads as a bug; the truth reads as a to-do.
            np.innerHTML = `<b>${S.musicPlaylist}</b> has no tracks yet — `
                + "upload MP3s to <b>public/music/</b> and list them in "
                + "<b>manifest.json</b>";
        } else {
            np.innerHTML = "between tracks — the vacuum is part of the mix";
        }
    };

    let open = false;

    const selectTab = (name) => {
        for (const t of tabs) t.classList.toggle("on", t.dataset.page === name);
        for (const p of pages) p.hidden = p.dataset.page !== name;
        if (name === "sound") { syncPlaylists(); syncNowPlaying(); }
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
        escHint?.classList.add("off");
    };
    const hide = () => {
        open = false;
        root.classList.remove("show");
        escHint?.classList.remove("off");
        // Hand the overlay back undocked and closed, and land the next open
        // on the player's page — the depth is opt-in per visit.
        selectTab("controls");
    };
    escHint?.addEventListener("click", () => { if (!open) show(); });

    // Resume re-locks the pointer, because a click is a real user activation
    // and Escape is not — the browser refuses a lock request made from the
    // very key that just broke one. On touch there is no lock to restore.
    const resume = () => {
        hide();
        if (!touch) canvas.requestPointerLock?.();
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

    return { get paused() { return open; }, show };
}
