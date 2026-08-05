/**
 * On-screen controls, for when the primary pointer is a finger.
 *
 * A thumbstick at the bottom left, the five powers plus the two board buttons at
 * the bottom right, and the rest of the screen is a look pad. The layout is the
 * one every twin-stick mobile game has converged on, and it converged there for
 * reasons worth stating, because they are what the fiddly parts below are for:
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
    /**
     * 0, or 1 for the frame TRICK was pressed. A press rather than a hold,
     * exactly like a power — and it is a separate signal from `sprint` because
     * the stick is already holding that high through every surf, so a trick
     * routed through it would never have an edge. See `input.trickPressed`.
     */
    trick: 0,
    /** FLY, held: the pack burns while the thumb is down. */
    jet: false,
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

/* The stick sits at one fixed spot, and the zone is a square centred on it —
   104 px each way, so the furthest a touch inside the zone can start from the
   base is a deliberate poke into a corner.

   It used to float: the ring was drawn wherever the thumb landed anywhere in the
   bottom-left 46% x 58% of the screen. That is the better ergonomic on paper —
   grab it without looking — and worse in practice for one reason. A stick with no
   fixed home has no *memory*: every re-grab starts a new frame of reference, so
   after a couple of lifts you no longer know where centre is, and on a control
   whose whole job is a graduated throttle that matters more than the convenience
   of not aiming. Pinned, the ring is always on screen, always in the same place,
   and half a second of use is enough to stop looking at it. */
#tc-zone {
    position: absolute;
    left: 0;
    bottom: 0;
    width: 196px;
    height: 196px;
    pointer-events: auto;
    /* Without this the browser reads the very first millimetre of a stick push
       as the start of a pan, takes the gesture for the compositor, and sends a
       pointercancel — which drops the stick back to centre in the middle of a
       carve. Cancelling the pointerdown cannot stop it: by then the scroll
       decision has already been made. The buttons and the canvas both carry
       this already; the zone was the one interactive surface that did not. */
    touch-action: none;
}

#tc-ring, #tc-knob {
    position: absolute;
    border-radius: 50%;
    pointer-events: none;
    transition: opacity 180ms ease;
    will-change: transform, opacity;
}

/* Both are anchored on the zone's centre by their own negative margins, so the
   base is one pair of numbers and nothing in the JS has to know where it is. */
#tc-ring {
    width: 132px;
    height: 132px;
    left: 104px;
    bottom: 104px;
    margin: 0 0 -66px -66px;
    border: 1.5px solid rgba(184, 162, 255, 0.34);
    background: radial-gradient(circle, rgba(42, 26, 77, 0.30) 0%, rgba(5, 6, 15, 0.16) 70%, transparent 100%);
    backdrop-filter: blur(2px);
    /* Always visible, at a level that reads as furniture rather than as UI. A
       fixed stick you cannot see is worse than a floating one. */
    opacity: 0.5;
}

#tc-knob {
    width: 54px;
    height: 54px;
    left: 104px;
    bottom: 104px;
    margin: 0 0 -27px -27px;
    border: 1.5px solid rgba(255, 196, 107, 0.75);
    background: radial-gradient(circle, rgba(255, 196, 107, 0.30) 0%, rgba(255, 196, 107, 0.08) 100%);
    box-shadow: 0 0 18px rgba(255, 196, 107, 0.35);
    opacity: 0.55;
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

/* Position comes from two custom properties the mount sets off ARC, rather
   than from inline left/bottom, so a media query can scale the whole fan with
   one rule instead of the JS having to know about breakpoints. */
.tc-power {
    width: 52px;
    height: 52px;
    right: var(--tc-r);
    bottom: var(--tc-b);
}
.tc-power span { font-size: 8px; }

/* The two board buttons — the trick and the pack.
 *
 * They sit in the power fan's two free horns rather than in the fan itself,
 * and they are deliberately not powers to look at: smaller, and outlined in
 * the star white instead of the dust violet the five wear. A player reaching
 * for a power in a hurry is reaching by position and by colour, and a sixth
 * and seventh circle in the same livery is exactly how a Gravity Well gets
 * cast when what was wanted was a jump. */
.tc-board {
    width: 46px;
    height: 46px;
    right: var(--tc-r);
    bottom: var(--tc-b);
    border-color: rgba(255, 246, 224, 0.34);
    background: radial-gradient(circle at 50% 35%,
        rgba(28, 30, 56, 0.62) 0%, rgba(5, 6, 15, 0.52) 100%);
}
.tc-board span { font-size: 8px; opacity: 0.9; }

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

/* A narrow phone. 320 px is the floor worth supporting and it is genuinely
   tight: at full size the stick's ring reaches x=171 and the power fan starts at
   x=140, so the two overlap by thirty pixels. The buttons still take the taps —
   they are later siblings and hit-test above the ring — but a control ring drawn
   through a button reads as broken whether or not it behaves.

   Both sides give a little: the stick comes down to a 112 px ring and the fan
   pulls in toward its corner. That leaves 27 px of clear space between them. */
@media (max-width: 380px) {
    #tc-zone { width: 168px; height: 168px; }
    #tc-ring {
        width: 112px; height: 112px;
        left: 86px; bottom: 92px; margin: 0 0 -56px -56px;
    }
    #tc-knob {
        width: 48px; height: 48px;
        left: 86px; bottom: 92px; margin: 0 0 -24px -24px;
    }
    .tc-power {
        width: 46px; height: 46px;
        right: calc(var(--tc-r) * 0.82);
        bottom: calc(var(--tc-b) * 0.86);
    }
    .tc-power span { font-size: 7px; }
    .tc-board {
        width: 42px; height: 42px;
        right: calc(var(--tc-r) * 0.82);
        bottom: calc(var(--tc-b) * 0.86);
    }
    .tc-board span { font-size: 7px; }
}

/* Landscape on a phone: barely any vertical room, so everything comes in. */
@media (max-height: 460px) {
    #tc-zone { width: 172px; height: 160px; }
    #tc-ring {
        width: 108px; height: 108px;
        left: 86px; bottom: 80px; margin: 0 0 -54px -54px;
    }
    #tc-knob {
        width: 46px; height: 46px;
        left: 86px; bottom: 80px; margin: 0 0 -23px -23px;
    }
    .tc-power { width: 46px; height: 46px; }
    .tc-power span { font-size: 7px; }
    .tc-board { width: 42px; height: 42px; }
    .tc-board span { font-size: 7px; }
    #tc-pad { right: 12px; bottom: 12px; }
}
`;

/**
 * How far the knob's centre travels, as a fraction of the ring's width.
 *
 * A fraction rather than a fixed pixel count, because the ring has three sizes
 * across the breakpoints and a constant would only be right for one of them —
 * the landscape ring was already 108 px wide against a hard-coded 58 px travel,
 * so the knob ran past its own ring there. Reading the ring's real width makes
 * the CSS the single place the stick's size is stated.
 *
 * 0.44 puts the knob's centre a little inside the ring, so its outer edge sits
 * on the ring's line at full deflection rather than clear of it. That contact is
 * the visual cue that there is no more travel.
 */
const STICK_TRAVEL = 0.44;
/**
 * The two gear changes, as fractions of the stick's travel.
 *
 * Below `RUN_AT` the walk speed scales straight off the deflection, so a small
 * offset is a slow walk — which is the gear that actually matters, because
 * walking is what you do to turn round and line up a run.
 *
 * `SURF_ON` drops onto the board, and it still has hysteresis — a thumb resting
 * at a threshold shakes across it, and the cost of a false crossing here is the
 * astronaut flickering between a walk and a nineteen-metre-a-second carve. But
 * the gap is much narrower than it was. With a floating origin a thumb still
 * travelling outward was pinned at full deflection *by definition*, so any
 * threshold near the edge sat right under a resting thumb and the band had to be
 * wide enough to cover an entire gear. Pinned, full deflection means the thumb is
 * genuinely at the edge of the ring, which is a place it can be held; the band
 * only has to cover a tremor.
 */
const RUN_AT = 0.55;
const SURF_ON = 0.78;
const SURF_OFF = 0.64;
/** Radians of camera rotation per pixel dragged. Below the mouse's, on purpose:
 *  a thumb has a fraction of a mouse's usable travel, and a 1:1 mapping makes
 *  the camera feel like it is fighting you. */
const LOOK_SCALE = 0.0042;

/**
 * The five powers, in the order the number keys fire them. Labels are short
 * enough to read at 8px on a phone — but they are the powers' *names*, not
 * abbreviations of them: "ROCK" and "WELL" read as placeholder text, and a
 * button that sounds boring is a button that never gets pressed.
 */
const POWERS = [
    { n: 1, label: "FLARE" },
    { n: 2, label: "ION" },
    { n: 3, label: "NOVA" },
    { n: 4, label: "ASTEROID" },
    { n: 5, label: "GRAVITY" },
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
 * The two board buttons, in the same (right, bottom) frame as `ARC`.
 *
 * These are the moves rather than the powers: TRICK pops the board off the
 * ground and, pressed again in the air, turns the spin into a front flip; FLY
 * is held, and holds the jetpack lit for as long as the thumb is down.
 *
 * Both have to be under the *right* thumb, and that is forced rather than
 * chosen. Surfing means the left thumb is pinned at the edge of the stick's
 * ring — that is what surfing *is* here — so it cannot leave to press anything,
 * and a trick is a thing you do in the middle of a carve.
 *
 * Where they go is what is left after the five powers, and the honest answer is
 * that the fan already fills the comfortable sweep: there is no room for a pair
 * side by side without moving powers that have their positions for reasons of
 * their own. So they take the fan's two free horns — TRICK out at the low end,
 * along the bottom edge, which is the easiest travel there is and the right
 * place for the button pressed most; FLY at the high end, straight up the right
 * edge above the fan, which is a longer reach for something entered
 * deliberately and then held. Both sit inside the radius the fan already
 * spends, so nothing here asks for a stretch the powers do not.
 */
const BOARD = [
    { key: "trick", label: "TRICK", r: 142, b: 8 },
    { key: "fly", label: "FLY", r: 10, b: 156 },
];

/**
 * Mount the controls and start feeding `touch`.
 *
 * @param {HTMLCanvasElement} canvas the look pad
 * @param {{ input: any, onToggleOverlay?: () => void, onMenu?: () => void }} hooks
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
        <button class="tc-btn" id="tc-gear" aria-label="Menu"><span>⚙</span></button>
    `;
    document.body.appendChild(root);
    document.body.classList.add("tc-on");

    const zone = root.querySelector("#tc-zone");
    const ring = root.querySelector("#tc-ring");
    const knob = root.querySelector("#tc-knob");
    const pad = root.querySelector("#tc-pad");
    const gear = root.querySelector("#tc-gear");

    /** One circular button on the pad, placed off the (right, bottom) pair. */
    const mount = (cls, id, label, r, b) => {
        const el = document.createElement("button");
        el.className = "tc-btn " + cls;
        el.id = id;
        el.setAttribute("aria-label", label);
        el.style.setProperty("--tc-r", r + "px");
        el.style.setProperty("--tc-b", b + "px");
        el.innerHTML = `<span>${label}</span>`;
        pad.appendChild(el);
        return el;
    };

    for (let i = 0; i < POWERS.length; i++) {
        const p = POWERS[i];
        const b = mount("tc-power", "tc-p" + p.n, p.label, ARC[i][0], ARC[i][1]);
        bindButton(
            b,
            () => {
                touch.pressed = p.n;
                if (p.n === 2) touch.held2 = true;
            },
            () => {
                if (p.n === 2) touch.held2 = false;
            }
        );
    }

    for (const d of BOARD) {
        const b = mount("tc-board", "tc-" + d.key, d.label, d.r, d.b);
        if (d.key === "fly") {
            // Held. The controller wants a fresh press to relight the pack
            // after a landing, and a hold gives it one for free: the thumb has
            // to come up and go down again, which is what the key does too.
            bindButton(b, () => (touch.jet = true), () => (touch.jet = false));
        } else {
            // A press, consumed and cleared by `endFrame()` exactly as a power
            // is — and pressed again in the air it is the flip, because the
            // controller reads the second edge inside the arc.
            bindButton(b, () => (touch.trick = 1));
        }
    }

    // --------------------------------------------------------------- stick
    let stickId = -1;
    /** Viewport coordinates of the ring's centre, and its travel radius in px. */
    let baseX = 0;
    let baseY = 0;
    let stickR = 58;

    // Read off the element rather than computed, so the CSS above is the only
    // place the stick's position and size are stated — including both media
    // overrides and the safe-area padding the root applies. Re-read on every
    // grab, which also covers rotation and resize without a listener.
    const readBase = () => {
        const r = ring.getBoundingClientRect();
        baseX = r.left + r.width * 0.5;
        baseY = r.top + r.height * 0.5;
        stickR = Math.max(24, r.width * STICK_TRAVEL);
    };

    /** Move the knob off its pinned base by a deflection in px. */
    const placeKnob = (dx, dy) => {
        knob.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
    };

    const applyStick = (e) => {
        let dx = e.clientX - baseX;
        let dy = e.clientY - baseY;
        const len = Math.hypot(dx, dy);

        // Clamped to the ring. The origin no longer travels with the thumb, so a
        // thumb pushed past the edge simply stays at full deflection — which is
        // what a stick does, and what makes "all the way out" a place rather than
        // a moment.
        if (len > stickR) {
            dx = (dx / len) * stickR;
            dy = (dy / len) * stickR;
        }
        placeKnob(dx, dy);

        // Screen down is +y and forward is -y, hence the negation on Z. Both are
        // already inside the unit disc because `dx`/`dy` were clamped above.
        touch.moveX = dx / stickR;
        touch.moveZ = -dy / stickR;
        const t = Math.min(1, len / stickR);
        touch.sprint = t >= RUN_AT;
        touch.surf = t >= (touch.surf ? SURF_OFF : SURF_ON);
        root.classList.toggle("surf", touch.surf);
    };

    zone.addEventListener("pointerdown", (e) => {
        if (stickId !== -1) return;
        stickId = e.pointerId;
        zone.setPointerCapture(e.pointerId);
        readBase();
        root.classList.add("hold");
        applyStick(e);
        e.preventDefault();
    });

    zone.addEventListener("pointermove", (e) => {
        if (e.pointerId !== stickId) return;
        applyStick(e);
        e.preventDefault();
    });

    const dropStick = (e) => {
        if (e.pointerId !== stickId) return;
        stickId = -1;
        touch.moveX = 0;
        touch.moveZ = 0;
        touch.sprint = false;
        touch.surf = false;
        placeKnob(0, 0);
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
        // The ⚙ opens the pause menu when one is mounted — controls, sound
        // and the settings overlay in one tabbed place — and falls back to
        // toggling the raw overlay where it is not.
        if (hooks.onMenu) hooks.onMenu();
        else hooks.onToggleOverlay?.();
    });

    /**
     * The press/release plumbing every button on the pad shares: capture the
     * pointer, so a thumb that slides off keeps driving the button it started
     * on; mirror the state in the `on` class; and swallow the event so no
     * synthetic mouse click arrives later to fire the same thing twice.
     *
     * `down` and `up` are what the button *means* — a one-frame flag for the
     * momentary ones (the four powers that cast on press, and TRICK), a
     * boolean set and cleared for the held ones (ION and FLY).
     */
    function bindButton(btn, down, up) {
        btn.addEventListener("pointerdown", (e) => {
            btn.setPointerCapture(e.pointerId);
            btn.classList.add("on");
            down();
            e.preventDefault();
        });
        const release = (e) => {
            btn.classList.remove("on");
            up?.();
            if (e) e.preventDefault();
        };
        btn.addEventListener("pointerup", release);
        btn.addEventListener("pointercancel", release);
    }

    // A backgrounded tab keeps whatever was held, and on a phone that means a
    // locked screen leaves the astronaut carving into the void until it returns.
    const release = () => {
        touch.surf = false;
        touch.held2 = false;
        touch.jet = false;
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
