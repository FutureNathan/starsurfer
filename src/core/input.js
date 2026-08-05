/**
 * Raw input state. Everything lands in one mutable struct that systems poll —
 * no events fired into game code, no per-frame allocation.
 *
 * Mouse look uses pointer lock, which frees the right button for star-surf.
 * Holding a right button turns out to be the one gesture browsers genuinely
 * disagree about, so the whole of that hold is assembled from several signals
 * at once — see the block in `initInput`, which is the longest comment here
 * and earns it.
 *
 * Touch arrives through the same struct. `core/touch.js` owns the on-screen
 * controls and keeps its own axes; they are folded in here rather than written
 * straight into `input`, because `pollInput` rebuilds the movement axes from
 * held keys every frame and would overwrite anything already sitting in them.
 * Nothing downstream of this file can tell which device drove it.
 */

import { touch } from "./touch.js";

export const input = {
    // Movement axes, camera-relative, already normalised to a unit disc.
    moveX: 0,
    moveZ: 0,
    moving: false,

    // Accumulated mouse delta since last `endFrame()`, in radians.
    lookX: 0,
    lookY: 0,

    // Zoom, consumed by the camera rig.
    zoomDelta: 0,

    surf: false, // right mouse or space held
    sprint: false, // shift

    /** @type {number} 0 = none, else 1..5 — set on keydown, cleared each frame */
    spellPressed: 0,
    /** @type {boolean} spell 2 (Ribbon) is a held cast */
    spellHeld2: false,

    /**
     * One frame long: a trick was asked for *this* frame.
     *
     * The keyboard does not need it — the controller reads the trick off
     * `sprint`'s rising edge, because Shift is sprint on foot and the pop on
     * the board. A touchscreen does: its `sprint` comes from the stick's
     * throttle, which is already held high the entire time anyone is surfing,
     * so a TRICK button routed through `sprint` would never produce an edge to
     * find. It gets its own flag instead.
     */
    trickPressed: false,

    locked: false,
};

const keys = Object.create(null);

/**
 * Held state for the two inputs that can arrive from either device, tracked per
 * device and combined in `pollInput`.
 *
 * The naive version — have each device write `input.surf` directly — cannot work:
 * `pollInput` runs every frame, so an OR leaves the flag stuck on once either
 * device has set it, and a plain assignment lets whichever device ran last clear
 * the other's hold. Keeping one flag per device and combining them is the only
 * arrangement where releasing a mouse button and lifting a thumb both do what
 * they say.
 */
let mouseSurf = false;
let keyHeld2 = false;

/**
 * Two things about this browser's right button, learned at runtime rather than
 * assumed. Both start pessimistic and are only ever turned on by evidence, so a
 * browser that never provides the signal is never held to it.
 */
/** It dispatches `mousedown` for button 2 at all. */
let sawRightDown = false;
/** Its `buttons` bitmask actually carries the secondary bit while held. */
let buttonsTrusted = false;

const LOOK_SCALE = 0.0022;

/**
 * The pause menu, the settings overlay and the hunt's death panel are ordinary
 * web pages, not the game. Presses that land inside them are theirs — they must
 * not arm a surf, and they keep their native context menu so the world seed can
 * be copied out of one, a name pasted into another and the credit link opened
 * from the third.
 *
 * Each is `display: none` or absent unless it is actually up, so this only
 * matches while the panel in question is really on screen.
 */
const inUi = (target) =>
    target instanceof Element && !!target.closest("#pause, #ov, #mz-death");

/**
 * A text field has first claim on every key it is sent.
 *
 * The hunt's death panel takes a name, and the game keeps running behind it —
 * the panel vetoes the pause the lost pointer lock would otherwise trigger. So
 * without this, typing a name walks the astronaut around: `a` and `d` strafe,
 * `w` strides, and a space between two words drops him onto the board.
 */
const typing = () => {
    const a = document.activeElement;
    if (!(a instanceof HTMLElement)) return false;
    return a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable;
};

/** @type {(() => void)|null} */
let onToggleOverlay = null;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ onToggleOverlay?: () => void }} [hooks]
 */
export function initInput(canvas, hooks) {
    onToggleOverlay = hooks?.onToggleOverlay ?? null;

    // Pointer lock only makes sense for a mouse. Requesting it from a tap either
    // fails silently or, worse, succeeds and hides the controls behind a
    // fullscreen prompt.
    canvas.addEventListener("click", () => {
        if (touch.active) return;
        if (!input.locked) canvas.requestPointerLock();
    });

    document.addEventListener("pointerlockchange", () => {
        input.locked = document.pointerLockElement === canvas;
        // The HUD's reticle keys off this: crosshair only when the mouse is
        // the aim, never alongside a real cursor.
        document.body.classList.toggle("locked", input.locked);
        // Drop held state so the character doesn't run off while unfocused.
        if (!input.locked) releaseHeld();
    });

    document.addEventListener("mousemove", (e) => {
        // The release watchdog, and it teaches itself whether it may be
        // trusted. A browser that sets the secondary bit while the button is
        // genuinely down has earned the right to tell us it came back up; one
        // that never sets it is never believed, so a `buttons` field this
        // browser does not fill in can never cancel a surf that is being held.
        // It has to sit above the lock gate: a surf that outlived its button is
        // worth catching whether or not the pointer is captured.
        if (mouseSurf) {
            if (e.buttons & 2) buttonsTrusted = true;
            else if (buttonsTrusted) mouseSurf = false;
        }
        if (!input.locked) return;
        input.lookX += e.movementX * LOOK_SCALE;
        input.lookY += e.movementY * LOOK_SCALE;
    });

    // ------------------------------------------------------- the right button
    //
    // Star-surf is a held right button, and a held right button is the one
    // gesture the browsers do not agree on. Three separate things here exist
    // because of Safari:
    //
    //   *The context menu is killed on `window`, in the capture phase.* It used
    //   to be killed on the canvas, which is only correct if the event actually
    //   arrives at the canvas — and under pointer lock it may not, because the
    //   retargeting rule that puts mouse events on the locked element is not
    //   applied to `contextmenu` everywhere. One that gets through is not
    //   untidy, it is fatal: showing the native menu drops the pointer lock,
    //   and losing the lock is this game's *pause* gesture. Hold the right
    //   button to surf and what you get instead is a context menu and the pause
    //   panel over the scene — which is the bug this fixes. Capture phase so
    //   nothing downstream can stop it first.
    //
    //   *The press is not gated on the pointer being locked.* It was, and that
    //   turned a lock which quietly failed or was quietly dropped into a right
    //   button that did nothing at all, with no way to tell from the outside.
    //   Surfing does not need the lock; only looking does.
    //
    //   *`contextmenu` doubles as a press signal* — but only for a browser that
    //   has never once sent a right-button `mousedown`, which WebKit has been
    //   known to swallow when it opens a menu. The condition is the whole
    //   safety of it: on Windows the context menu fires on *release*, so a
    //   version of this that trusted it unconditionally would latch the surf on
    //   at the exact moment the button came up and leave it stuck there.
    window.addEventListener("contextmenu", (e) => {
        if (inUi(e.target)) return;
        e.preventDefault();
        // Never from a finger. A long press raises this same event, and a surf
        // armed by one would have no button release to end it — the thumb is
        // already up by the time the event arrives. Chrome tags the event with
        // a `pointerType`; Safari sends a plain MouseEvent, where the mounted
        // on-screen controls are the answer to the same question.
        const finger = touch.active || ("pointerType" in e && e.pointerType !== "mouse");
        if (!sawRightDown && !finger) mouseSurf = true;
    }, { capture: true });

    window.addEventListener("mousedown", (e) => {
        if (inUi(e.target)) return;
        if (e.button === 2) {
            sawRightDown = true;
            mouseSurf = true;
            return;
        }
        // The left button is the flight trigger — a one-frame event flag,
        // like `spellPressed`, consumed by whatever cares (the weapons only
        // listen while flying). It stays behind the lock, because unlocked a
        // left click is the gesture that *takes* the lock.
        if (e.button === 0 && input.locked) input.firePressed = true;
    }, { capture: true });

    // Two dispatch paths for the same release, because they are separate code
    // in the engines and dropping one of them is a thing that happens.
    const rightUp = (e) => {
        if (e.button === 2) mouseSurf = false;
    };
    window.addEventListener("mouseup", rightUp, { capture: true });
    window.addEventListener("pointerup", rightUp, { capture: true });

    document.addEventListener(
        "wheel",
        (e) => {
            if (!input.locked) return;
            e.preventDefault();
            input.zoomDelta += e.deltaY * 0.0016;
        },
        { passive: false }
    );

    window.addEventListener("keydown", (e) => {
        // Whoever is typing owns the keyboard. See `typing`.
        if (typing()) return;

        // Overlay toggle works whether or not the pointer is locked.
        if (e.code === "F1" || e.code === "Backquote") {
            e.preventDefault();
            onToggleOverlay?.();
            return;
        }
        // Space is the second way to surf, and it is not a convenience. "Hold
        // the right button" is a gesture a Mac trackpad does not have: the
        // secondary click there is a two-finger *tap*, over the instant it
        // happens, so there is nothing to hold — and Safari's users are largely
        // on trackpads. A key can be held by anybody, on any machine, and it
        // sits under the left thumb while the same hand steers on WASD.
        //
        // Swallowed so it cannot also press whatever button happens to hold
        // focus — but not inside the menu or the overlay, where Space activating
        // the focused control is exactly right.
        if (e.code === "Space" && !inUi(document.activeElement)) e.preventDefault();

        if (e.repeat) return;
        keys[e.code] = true;

        const n = SPELL_KEYS[e.code];
        if (n) {
            input.spellPressed = n;
            if (n === 2) keyHeld2 = true;
        }
    });

    // Never gated on `typing()`, unlike the press: letting go is always safe,
    // and skipping it is how a key held at the moment a text box takes focus
    // gets stranded down forever.
    window.addEventListener("keyup", (e) => {
        keys[e.code] = false;
        if (SPELL_KEYS[e.code] === 2) keyHeld2 = false;
    });

    // Anything that takes the page out from under the player drops every hold:
    // alt-tab, a hidden tab, and the lock loss above all land here. Without it
    // the astronaut carves on into the void while nobody is watching.
    window.addEventListener("blur", releaseHeld);
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) releaseHeld();
    });
}

/** Let go of everything currently held. */
function releaseHeld() {
    for (const k in keys) keys[k] = false;
    mouseSurf = false;
    keyHeld2 = false;
}

const SPELL_KEYS = {
    Digit1: 1,
    Digit2: 2,
    Digit3: 3,
    Digit4: 4,
    Digit5: 5,
};

/** Resolve held keys into movement axes. Called once per frame before update. */
export function pollInput() {
    let x = 0;
    let z = 0;
    if (keys.KeyW || keys.ArrowUp) z += 1;
    if (keys.KeyS || keys.ArrowDown) z -= 1;
    if (keys.KeyD || keys.ArrowRight) x += 1;
    if (keys.KeyA || keys.ArrowLeft) x -= 1;

    // Clamp to a unit disc so diagonals aren't faster.
    const len = Math.sqrt(x * x + z * z);
    if (len > 1) {
        x /= len;
        z /= len;
    }
    // The stick wins when it is being held: a finger on it is an explicit
    // instruction, and on a hybrid device the keys are almost certainly at rest.
    if (touch.active && (touch.moveX !== 0 || touch.moveZ !== 0)) {
        x = touch.moveX;
        z = touch.moveZ;
    }

    input.moveX = x;
    input.moveZ = z;
    input.moving = Math.hypot(x, z) > 0.001;

    input.sprint = !!(keys.ShiftLeft || keys.ShiftRight) || touch.sprint;
    // The jetpack. "Delete" on a Mac keyboard is what every other keyboard
    // calls Backspace, so both codes count; on a touchscreen it is the FLY
    // button, held, which is the same hold by another name.
    input.jetKey = !!(keys.Delete || keys.Backspace) || touch.jet;
    input.surf = mouseSurf || !!keys.Space || touch.surf;
    input.spellHeld2 = keyHeld2 || touch.held2;
    if (touch.pressed) input.spellPressed = touch.pressed;
    // See the note on the field: the keyboard's trick is Shift's rising edge
    // and never comes through here.
    input.trickPressed = touch.trick !== 0;
}

/** Clear per-frame accumulators. Called at the very end of the frame. */
export function endFrame() {
    input.lookX = 0;
    input.lookY = 0;
    input.zoomDelta = 0;
    input.spellPressed = 0;
    input.firePressed = false;
    input.trickPressed = false;
    // A button press is one frame long whichever device sent it.
    touch.pressed = 0;
    touch.trick = 0;
}

export function isDown(code) {
    return !!keys[code];
}
