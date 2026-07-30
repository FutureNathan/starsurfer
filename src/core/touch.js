/**
 * On-screen controls, for when the primary pointer is a finger.
 *
 * A thumbstick at the bottom left, the five powers at the bottom right, and the
 * rest of the screen is a look pad. The layout is the one every twin-stick mobile
 * game has converged on, and it converged there for reasons worth stating,
 * because they are what the fiddly parts below are for:
 *
 *   The stick floats. Its ring is drawn where the thumb lands rather than at a
 *   fixed spot, anywhere in the lower-left quadrant. A fixed stick demands the
 *   player look down to find it; a floating one can be grabbed blind, which is
 *   the whole point of a control you use while watching something else.
 *
 *   The stick is a throttle, not a direction. A nudge walks, most of the way runs,
 *   and pushing it out to the ring drops onto the board and surfs. There is no
 *   surf button, and that is not just one fewer control: a button would make
 *   surfing a mode you are in or out of, and the whole feel of this scene is that
 *   speed is something you lean into. It also frees the corner, which is where a
 *   thumb can actually reach, for the powers.
 *
 *   Every control captures its own pointer. `setPointerCapture` means a thumb
 *   that slides off a button keeps driving that button until it lifts, and a
 *   thumb that started on the look pad cannot be stolen by a button it slides
 *   over. Without it, fast play produces stuck inputs — the single most common
 *   failure of hand-rolled touch controls.
 *
 *   The look pad tracks a specific pointer id. Two thumbs are down almost all
 *   the time here (stick plus a power), so "the touch that is looking" has to be
 *   an identity rather than "the most recent event".
 *
 *   Nothing is a click. These are `pointerdown`/`pointerup` with
 *   `touch-action: none`, so there is no 300 ms tap delay, no double-tap zoom and
 *   no synthetic mouse event arriving later to fire an action twice.
 *
 * Everything here writes into the same `input` struct the keyboard and mouse
 * write into, so no system downstream knows or cares which was used.
 */

import { COARSE_POINTER } from "./device.js";

/**
 * Axes and buttons owned by the touch layer, merged into `input` by
 * `pollInput()`. Kept separate rather than written straight into `input` because
 * `pollInput` recomputes the movement axes from held keys every frame and would
 * overwrite them.
 */
export const touch = {
    /** The controls are mounted and visible. */
    active: false,
    moveX: 0,
    moveZ: 0,
    /** Stick past `RUN_AT`: still walking, but at running speed. */
    sprint: false,
    /** Stick out at the ring: on the board. No button, the stick is the throttle. */
    surf: false,
    /** 0, or 1..5 for the frame a power button was pressed. */
    pressed: 0,
    held2: false,
};

const CSS = `
#tc {
    position: fixed;
    inset: 0;
    z-index: 60;
    /* The root is inert; only the controls inside it take events, so a drag that
       starts on empty space still reaches the canvas underneath and looks. */
    pointer-events: none;
    /* Keep the controls clear of rounded corners and home indicators. */
    padding: env(safe-area-inset-top) env(safe-area-inset-right)
             env(safe-area-inset-bottom) env(safe-area-inset-left);
    font-family: ui-sans-serif, "Inter", "Segoe UI", system-ui, sans-serif;
    -webkit-user-select: none;
    user-select: none;
    -webkit-tap-highlight-color: transparent;
    opacity: 0;
    transition: opacity 600ms ease;
}
#tc.ready { opacity: 1; }

/* ------------------------------------------------------------------- stick */

#tc-zone {
    position: absolute;
    left: 0;
    bottom: 0;
    width: 46%;
    height: 58%;
    pointer-events: auto;
}

#tc-ring, #tc-knob {
    position: absolute;
    border-radius: 50%;
    pointer-events: none;
    opacity: 0;
    transition: opacity 180ms ease;
    will-change: transform, opacity;
}

#tc-ring {
    width: 132px;
    height: 132px;
    margin: -66px 0 0 -66px;
    border: 1.5px solid rgba(184, 162, 255, 0.34);
    background: radial-gradient(circle, rgba(42, 26, 77, 0.30) 0%, rgba(5, 6, 15, 0.16) 70%, transparent 100%);
    backdrop-filter: blur(2px);
}

#tc-knob {
    width: 54px;
    height: 54px;
    margin: -27px 0 0 -27px;
    border: 1.5px solid rgba(255, 196, 107, 0.75);
    background: radial-gradient(circle, rgba(255, 196, 107, 0.30) 0%, rgba(255, 196, 107, 0.08) 100%);
    box-shadow: 0 0 18px rgba(255, 196, 107, 0.35);
}

#tc.hold #tc-ring, #tc.hold #tc-knob { opacity: 1; }

/* Out past the surf threshold: the knob and the ring both go gold. The ring
   matters more than the knob — it is the thing that tells you where the gear
   change is without having to look down and find the knob inside it. */
#tc.surf #tc-knob {
    border-color: rgba(255, 246, 224, 0.95);
    box-shadow: 0 0 26px rgba(255, 196, 107, 0.8);
}
#tc.surf #tc-ring {
    border-color: rgba(255, 196, 107, 0.7);
    box-shadow: 0 0 22px rgba(255, 196, 107, 0.22);
}

/* ------------------------------------------------------------------ buttons */

#tc-pad {
    position: absolute;
    right: 18px;
    bottom: 18px;
    pointer-events: none;
}

.tc-btn {
    position: absolute;
    display: grid;
    place-items: center;
    border-radius: 50%;
    border: 1.5px solid rgba(184, 162, 255, 0.40);
    background: radial-gradient(circle at 50% 35%,
        rgba(42, 26, 77, 0.62) 0%, rgba(5, 6, 15, 0.52) 100%);
    backdrop-filter: blur(3px);
    color: #fff6e0;
    pointer-events: auto;
    touch-action: none;
    transition: transform 90ms ease, box-shadow 140ms ease, border-color 140ms ease;
}

.tc-btn span {
    font-size: 9px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    opacity: 0.82;
    text-align: center;
    line-height: 1.15;
    pointer-events: none;
}

.tc-btn.on {
    transform: scale(0.92);
    border-color: rgba(255, 196, 107, 0.95);
    box-shadow: 0 0 22px rgba(255, 196, 107, 0.45), inset 0 0 18px rgba(255, 196, 107, 0.18);
}

.tc-power { width: 52px; height: 52px; }
.tc-power span { font-size: 8px; }

/* --------------------------------------------------------------- overlay tab */

#tc-gear {
    position: absolute;
    top: 14px;
    right: 14px;
    width: 38px;
    height: 38px;
    font-size: 15px;
    border-radius: 10px;
    opacity: 0.5;
}

/* The loading screen's hint is centred along the bottom, which is where all of
   this now lives. Moved to the top, which the controls leave empty apart from the
   settings tab in the corner. */
body.tc-on #hint {
    top: calc(18px + env(safe-area-inset-top));
    bottom: auto;
    max-width: 74vw;
    text-align: center;
    line-height: 1.9;
}

/* Landscape on a phone: barely any vertical room, so everything comes in. */
@media (max-height: 460px) {
    #tc-ring { width: 108px; height: 108px; margin: -54px 0 0 -54px; }
    #tc-knob { width: 46px; height: 46px; margin: -23px 0 0 -23px; }
    .tc-power { width: 46px; height: 46px; }
    .tc-power span { font-size: 7px; }
    #tc-pad { right: 12px; bottom: 12px; }
}
`;

/** Radius of the stick's travel, px. Matches the ring's visual radius. */
const STICK_R = 58;
/**
 * The two gear changes, as fractions of the stick's travel.
 *
 * Below `RUN_AT` the walk speed scales straight off the deflection, so a small
 * offset is a slow walk — which is the gear that actually matters, because
 * walking is what you do to turn round and line up a run.
 *
 * `SURF_ON` drops onto the board. It has hysteresis and `SURF_OFF` is a long way
 * below it, for a reason that is specific to a floating origin: a thumb still
 * travelling outward is pinned at full deflection by definition, so a resting
 * thumb sits right on top of any threshold placed near the edge and drifts back
 * and forth across it. Without the gap the astronaut would flicker between a walk
 * and a nineteen-metre-a-second carve for as long as the thumb stayed there.
 */
const RUN_AT = 0.55;
const SURF_ON = 0.84;
const SURF_OFF = 0.62;
/** Radians of camera rotation per pixel dragged. Below the mouse's, on purpose:
 *  a thumb has a fraction of a mouse's usable travel, and a 1:1 mapping makes
 *  the camera feel like it is fighting you. */
const LOOK_SCALE = 0.0042;

/**
 * The five powers, in the order the number keys fire them. Labels are short
 * enough to read at 8px on a phone, which rules out the full names.
 */
const POWERS = [
    { n: 1, label: "FLARE" },
    { n: 2, label: "ION" },
    { n: 3, label: "NOVA" },
    { n: 4, label: "CRYST" },
    { n: 5, label: "WELL" },
];

/**
 * Where each power button sits, as (right, bottom) in px from the pad's corner.
 *
 * Two tiers rather than one arc, and that is a concession to arithmetic. The
 * thumb pivots at the base of the palm, so its reach is a circular sweep and a
 * single arc is the ideal shape — but five 52 px buttons need about 60 px of
 * centre-to-centre spacing to not overlap, which puts a single arc's far end
 * 220 px from the corner. On a 393 px phone that is past the middle of the
 * screen, well outside any thumb's sweep, and directly over the look pad.
 *
 * Three low and two behind them keeps everything inside 180 px of the corner and
 * every button inside one sweep. Powers 1-3 sit on the near tier because they are
 * the ones worth reaching for first, and power 1 sits in the corner itself — the
 * only spot a thumb reaches without moving the hand at all — which is free now
 * that the stick has taken over surfing.
 */
const ARC = [
    [8, 14],
    [72, 30],
    [128, 84],
    [24, 96],
    [84, 142],
];

/**
 * Mount the controls and start feeding `touch`.
 *
 * @param {HTMLCanvasElement} canvas the look pad
 * @param {{ input: any, onToggleOverlay?: () => void }} hooks
 */
export function initTouch(canvas, hooks) {
    const input = hooks.input;

    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    const root = document.createElement("div");
    root.id = "tc";
    root.innerHTML = `
        <div id="tc-zone"></div>
        <div id="tc-ring"></div>
        <div id="tc-knob"></div>
        <div id="tc-pad"></div>
        <button class="tc-btn" id="tc-gear" aria-label="Settings"><span>⚙</span></button>
    `;
    document.body.appendChild(root);
    document.body.classList.add("tc-on");

    const zone = root.querySelector("#tc-zone");
    const ring = root.querySelector("#tc-ring");
    const knob = root.querySelector("#tc-knob");
    const pad = root.querySelector("#tc-pad");
    const gear = root.querySelector("#tc-gear");

    for (let i = 0; i < POWERS.length; i++) {
        const p = POWERS[i];
        const b = document.createElement("button");
        b.className = "tc-btn tc-power";
        b.id = "tc-p" + p.n;
        b.setAttribute("aria-label", p.label);
        b.style.right = ARC[i][0] + "px";
        b.style.bottom = ARC[i][1] + "px";
        b.innerHTML = `<span>${p.label}</span>`;
        pad.appendChild(b);
        bindPower(b, p.n);
    }

    // --------------------------------------------------------------- stick
    let stickId = -1;
    let originX = 0;
    let originY = 0;

    const place = (el, x, y) => {
        el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    };

    zone.addEventListener("pointerdown", (e) => {
        if (stickId !== -1) return;
        stickId = e.pointerId;
        zone.setPointerCapture(e.pointerId);
        originX = e.clientX;
        originY = e.clientY;
        place(ring, originX, originY);
        place(knob, originX, originY);
        root.classList.add("hold");
        e.preventDefault();
    });

    zone.addEventListener("pointermove", (e) => {
        if (e.pointerId !== stickId) return;
        let dx = e.clientX - originX;
        let dy = e.clientY - originY;
        const len = Math.hypot(dx, dy);

        // Past the ring the origin is dragged along, so the stick can never run
        // out of travel mid-turn — the alternative is the thumb pinning at the
        // edge and the player having to lift to recentre.
        if (len > STICK_R) {
            const over = len - STICK_R;
            originX += (dx / len) * over;
            originY += (dy / len) * over;
            dx = (dx / len) * STICK_R;
            dy = (dy / len) * STICK_R;
            place(ring, originX, originY);
        }

        place(knob, originX + dx, originY + dy);

        // Screen down is +y and forward is -y, hence the negation on Z. Both are
        // already inside the unit disc because `dx`/`dy` were clamped above.
        touch.moveX = dx / STICK_R;
        touch.moveZ = -dy / STICK_R;
        const t = Math.min(1, len / STICK_R);
        touch.sprint = t >= RUN_AT;
        touch.surf = t >= (touch.surf ? SURF_OFF : SURF_ON);
        root.classList.toggle("surf", touch.surf);
        e.preventDefault();
    });

    const dropStick = (e) => {
        if (e.pointerId !== stickId) return;
        stickId = -1;
        touch.moveX = 0;
        touch.moveZ = 0;
        touch.sprint = false;
        touch.surf = false;
        root.classList.remove("hold", "surf");
    };
    zone.addEventListener("pointerup", dropStick);
    zone.addEventListener("pointercancel", dropStick);

    // ---------------------------------------------------------------- look
    //
    // On the canvas, so a drag that starts on a control never looks — the
    // controls sit above it and swallow their own pointers.
    let lookId = -1;
    let lastX = 0;
    let lastY = 0;
    /** Two fingers on the look pad: pinch to zoom. */
    const pinch = new Map();
    let pinchDist = 0;

    canvas.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "mouse") return;
        pinch.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch.size === 2) {
            const [a, b] = [...pinch.values()];
            pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
            lookId = -1; // a pinch is not a look
            return;
        }
        if (lookId === -1) {
            lookId = e.pointerId;
            lastX = e.clientX;
            lastY = e.clientY;
        }
    });

    canvas.addEventListener("pointermove", (e) => {
        if (e.pointerType === "mouse") return;
        if (pinch.has(e.pointerId)) pinch.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (pinch.size === 2) {
            const [a, b] = [...pinch.values()];
            const d = Math.hypot(a.x - b.x, a.y - b.y);
            if (pinchDist > 0) input.zoomDelta += (pinchDist - d) * 0.010;
            pinchDist = d;
            return;
        }
        if (e.pointerId !== lookId) return;
        input.lookX += (e.clientX - lastX) * LOOK_SCALE;
        input.lookY += (e.clientY - lastY) * LOOK_SCALE;
        lastX = e.clientX;
        lastY = e.clientY;
    });

    const dropLook = (e) => {
        pinch.delete(e.pointerId);
        if (pinch.size < 2) pinchDist = 0;
        if (e.pointerId === lookId) lookId = -1;
    };
    canvas.addEventListener("pointerup", dropLook);
    canvas.addEventListener("pointercancel", dropLook);
    canvas.addEventListener("pointerleave", dropLook);

    gear.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        hooks.onToggleOverlay?.();
    });

    /**
     * Power 2 is a held cast, so its button holds. The other four fire once on
     * press: `pressed` is consumed and cleared by `endFrame()`, exactly as a
     * keydown is.
     */
    function bindPower(btn, n) {
        btn.addEventListener("pointerdown", (e) => {
            btn.setPointerCapture(e.pointerId);
            btn.classList.add("on");
            touch.pressed = n;
            if (n === 2) touch.held2 = true;
            e.preventDefault();
        });
        const up = (e) => {
            btn.classList.remove("on");
            if (n === 2) touch.held2 = false;
            if (e) e.preventDefault();
        };
        btn.addEventListener("pointerup", up);
        btn.addEventListener("pointercancel", up);
    }

    // A backgrounded tab keeps whatever was held, and on a phone that means a
    // locked screen leaves the astronaut carving into the void until it returns.
    const release = () => {
        touch.surf = false;
        touch.held2 = false;
        touch.moveX = 0;
        touch.moveZ = 0;
        touch.sprint = false;
        for (const b of root.querySelectorAll(".tc-btn")) b.classList.remove("on");
        root.classList.remove("hold", "surf");
    };
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) release();
    });

    // The hint the loading screen reveals talks about a mouse and a keyboard.
    const hint = document.getElementById("hint");
    if (hint) {
        hint.textContent =
            "drag to look · nudge the stick to walk · push it out to surf";
    }

    touch.active = true;
    // One frame later, so the fade-in is a transition rather than a paint.
    requestAnimationFrame(() => root.classList.add("ready"));
    return root;
}

/**
 * Whether to mount the controls at all. `core/device.js` owns the decision,
 * including the `?touch=` override, because the same answer also picks the
 * render-target sizes.
 */
export function wantsTouchControls() {
    return COARSE_POINTER;
}
