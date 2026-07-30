/**
 * Raw input state. Everything lands in one mutable struct that systems poll —
 * no events fired into game code, no per-frame allocation.
 *
 * Mouse look uses pointer lock, which frees the right button for star-surf.
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

    surf: false, // RMB held
    sprint: false, // shift

    /** @type {number} 0 = none, else 1..5 — set on keydown, cleared each frame */
    spellPressed: 0,
    /** @type {boolean} spell 2 (Ribbon) is a held cast */
    spellHeld2: false,

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

const LOOK_SCALE = 0.0022;

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
        if (!input.locked) {
            // Drop held state so the character doesn't run off while unfocused.
            for (const k in keys) keys[k] = false;
            mouseSurf = false;
            keyHeld2 = false;
        }
    });

    document.addEventListener("mousemove", (e) => {
        if (!input.locked) return;
        input.lookX += e.movementX * LOOK_SCALE;
        input.lookY += e.movementY * LOOK_SCALE;
    });

    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    document.addEventListener("mousedown", (e) => {
        if (!input.locked) return;
        if (e.button === 2) mouseSurf = true;
    });

    document.addEventListener("mouseup", (e) => {
        if (e.button === 2) mouseSurf = false;
    });

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
        // Overlay toggle works whether or not the pointer is locked.
        if (e.code === "F1" || e.code === "Backquote") {
            e.preventDefault();
            onToggleOverlay?.();
            return;
        }
        if (e.repeat) return;
        keys[e.code] = true;

        const n = SPELL_KEYS[e.code];
        if (n) {
            input.spellPressed = n;
            if (n === 2) keyHeld2 = true;
        }
    });

    window.addEventListener("keyup", (e) => {
        keys[e.code] = false;
        if (SPELL_KEYS[e.code] === 2) keyHeld2 = false;
    });

    window.addEventListener("blur", () => {
        for (const k in keys) keys[k] = false;
        mouseSurf = false;
        keyHeld2 = false;
    });
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
    // The jetpack key. "Delete" on a Mac keyboard is what every other
    // keyboard calls Backspace, so both codes count.
    input.jetKey = !!(keys.Delete || keys.Backspace);
    input.surf = mouseSurf || touch.surf;
    input.spellHeld2 = keyHeld2 || touch.held2;
    if (touch.pressed) input.spellPressed = touch.pressed;
}

/** Clear per-frame accumulators. Called at the very end of the frame. */
export function endFrame() {
    input.lookX = 0;
    input.lookY = 0;
    input.zoomDelta = 0;
    input.spellPressed = 0;
    // A button press is one frame long whichever device sent it.
    touch.pressed = 0;
}

export function isDown(code) {
    return !!keys[code];
}
