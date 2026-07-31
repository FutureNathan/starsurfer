/**
 * The mini-map: a small round chart of the moon, bottom-left, with an arrow
 * for the rider.
 *
 * The whole relief is rendered ONCE, at init, into an offscreen canvas — the
 * heightfield is baked and immutable, so its portrait is too. Per frame the
 * map costs one drawImage and a five-vertex arrow; nothing here samples the
 * terrain, allocates, or can contribute to a hitch.
 *
 * The relief comes from `heightfield.heightCPU` through the same bicubic
 * `heightAt` the physics rides, hillshaded with the scene's own sun
 * direction — so the craters on the chart are lit from the same side as the
 * craters out the window, which is what lets a person match one to the
 * other at a glance. Ground past the playable boundary is dimmed and ringed:
 * the map's job is "where can I surf and where am I", so the edge of that
 * is drawn as a fact rather than left to be discovered by hitting it.
 *
 * On a touchscreen the thumbstick owns the bottom-left corner, so the map
 * moves to the top-left, smaller.
 */

import { PLAY_RADIUS } from "../terrain/heightfield.js";
import { landmarkPoses } from "../terrain/landmark.js";
import { S } from "../core/settings.js";

/** Map half-extent in metres. A margin past the boundary shows the fence. */
const RANGE = PLAY_RADIUS + 40;
/** Relief samples across the backing image. */
const RES = 220;

const CSS = /* css */ `
#minimap {
    position: fixed;
    left: 14px;
    bottom: 14px;
    z-index: 50;
    pointer-events: none;
    width: 168px;
    height: 168px;
    border-radius: 50%;
    border: 1px solid rgba(255, 246, 224, 0.22);
    background: rgba(5, 6, 15, 0.55);
    box-shadow: 0 2px 14px rgba(0, 0, 0, 0.45);
}
body.tc-on #minimap {
    left: calc(10px + env(safe-area-inset-left));
    top: calc(10px + env(safe-area-inset-top));
    bottom: auto;
    width: 116px;
    height: 116px;
}
`;

export function initMinimap(terrain, sky, character) {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    const canvas = document.createElement("canvas");
    canvas.id = "minimap";
    document.body.appendChild(canvas);

    // Device pixels, so the relief stays crisp on a dense screen.
    //
    // Read once here and again only when the element actually resizes (the
    // touch-controls class shrinks it). Reading getBoundingClientRect every
    // frame forces a synchronous layout inside the render loop whenever
    // anything else touched the DOM that frame — and during a firefight the
    // HUD is touching it constantly.
    const cssSize = () => canvas.getBoundingClientRect().width || 168;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let size = Math.round(cssSize() * dpr);
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    new ResizeObserver(() => {
        const now = Math.round(cssSize() * dpr);
        if (now > 0 && now !== size) {
            size = now;
            // Resizing a canvas clears it, so only touch it on a real change.
            canvas.width = size;
            canvas.height = size;
        }
    }).observe(canvas);

    // ---------------------------------------------------------- the relief
    // Hillshade under the scene's sun, greys borrowed from the lit and
    // shadowed dust so the chart reads as the same moon.
    const backing = document.createElement("canvas");
    backing.width = RES;
    backing.height = RES;
    const bctx = backing.getContext("2d");
    {
        const img = bctx.createImageData(RES, RES);
        const px = img.data;
        const step = (RANGE * 2) / (RES - 1);
        const h = new Float32Array(RES * RES);
        for (let j = 0; j < RES; j++) {
            const z = -RANGE + j * step;
            for (let i = 0; i < RES; i++) {
                h[j * RES + i] = terrain.heightAt(-RANGE + i * step, z);
            }
        }
        const L = sky.sunDir;
        const lx = L.x, ly = Math.max(0.15, L.y), lz = L.z;
        const ll = Math.hypot(lx, ly, lz);
        for (let j = 0; j < RES; j++) {
            for (let i = 0; i < RES; i++) {
                const i0 = Math.max(0, i - 1), i1 = Math.min(RES - 1, i + 1);
                const j0 = Math.max(0, j - 1), j1 = Math.min(RES - 1, j + 1);
                const dhx = (h[j * RES + i1] - h[j * RES + i0]) / ((i1 - i0) * step);
                const dhz = (h[j1 * RES + i] - h[j0 * RES + i]) / ((j1 - j0) * step);
                const nl = Math.hypot(dhx, 1, dhz);
                // n = (-dhx, 1, -dhz)/nl · sun
                const shade = Math.max(0, (-dhx * lx + ly - dhz * lz) / (nl * ll));
                // Lit dust vs shadowed dust, with a soft ambient floor.
                let g = 34 + 156 * Math.min(1, shade * 1.15);
                const x = -RANGE + i * step, z = -RANGE + j * step;
                const r = Math.hypot(x, z);
                // Outside the surfable boundary the world goes dim.
                const dim = r > PLAY_RADIUS ? 0.42 : 1;
                const o = (j * RES + i) * 4;
                px[o] = g * dim;
                px[o + 1] = g * dim;
                px[o + 2] = (g + 4) * dim;
                px[o + 3] = 255;
            }
        }
        bctx.putImageData(img, 0, 0);
    }

    const toMap = (w) => ((w + RANGE) / (RANGE * 2)) * size;

    // ------------------------------------------------------- chart symbols
    // The landmark complex, marked the way a chart marks it rather than left
    // to be inferred from relief: rim circles on the twin craters, a dotted
    // trace along the rille, and solid ticks where the tube roofs stand (the
    // places you can duck in and out). Positions come from the same
    // closed-form mirror that places the meshes, so the symbols cannot drift
    // off the things they mark.
    const lm = landmarkPoses(Number(S.worldSeed));
    const INK = (a) => `rgba(255, 246, 224, ${a})`;

    /** Live markers (foes, ammo) provided by whoever owns them. */
    let markersFn = null;

    function marks() {
        const k = size / (RANGE * 2); // px per metre
        const s = size / 168;

        // Every symbol strokes twice: a dark underlay a shade wider, then
        // the ink. On a relief that swings from lit crest to black shadow, a
        // single stroke always vanishes against one of them.
        const twice = (path, ink, w) => {
            ctx.beginPath();
            path();
            ctx.strokeStyle = "rgba(8, 9, 14, 0.60)";
            ctx.lineWidth = w + 1.7 * s;
            ctx.stroke();
            ctx.strokeStyle = ink;
            ctx.lineWidth = w;
            ctx.stroke();
        };

        // Twin crater rims.
        ctx.setLineDash([3.5 * s, 3.5 * s]);
        for (const [c, r] of [[lm.c1, lm.r1], [lm.c2, lm.r2]]) {
            twice(() => ctx.arc(toMap(c.x), toMap(c.z), r * k, 0, Math.PI * 2),
                  INK(0.55), 1.4 * s);
        }

        // The rille: a dotted crawl along the open channel's course.
        ctx.setLineDash([1.8 * s, 3 * s]);
        twice(() => {
            for (let i = 0; i < lm.rille.length; i++) {
                const p = lm.rille[i];
                if (i === 0) ctx.moveTo(toMap(p.x), toMap(p.z));
                else ctx.lineTo(toMap(p.x), toMap(p.z));
            }
        }, INK(0.62), 1.5 * s);
        ctx.setLineDash([]);
    }

    return {
        /** Provide (or clear) the live-marker source. */
        setMarkers(fn) { markersFn = fn; },
        /** Once per frame: blit the portrait, draw the rider. */
        frame() {
            ctx.clearRect(0, 0, size, size);

            // Clip to the disc; the border above draws the rim.
            ctx.save();
            ctx.beginPath();
            ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
            ctx.clip();

            // Heading-up: the whole chart turns about its centre so the way
            // the rider faces is always the top of the map. Everything below
            // — relief, boundary, symbols, arrow — draws inside this one
            // rotation; the arrow's own facing rotation then cancels against
            // it, leaving the arrow pointing straight up, which is the
            // grammar every car navigator taught.
            ctx.translate(size / 2, size / 2);
            ctx.rotate(character.facing - Math.PI);
            ctx.translate(-size / 2, -size / 2);

            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(backing, 0, 0, size, size);

            // The surfable boundary.
            ctx.beginPath();
            ctx.arc(size / 2, size / 2, (PLAY_RADIUS / RANGE) * (size / 2),
                    0, Math.PI * 2);
            ctx.strokeStyle = "rgba(255, 246, 224, 0.28)";
            ctx.lineWidth = 1;
            ctx.stroke();

            marks();

            // Live markers: green for martians, gold for ammo crates —
            // inside the rotation, so they turn with the world.
            const mk = markersFn?.();
            if (mk && mk.length) {
                const s2 = size / 168;
                for (const p of mk) {
                    ctx.beginPath();
                    ctx.arc(toMap(p.x), toMap(p.z),
                        (p.kind === "ammo" ? 2.3 : 2.8) * s2, 0, Math.PI * 2);
                    ctx.fillStyle = p.kind === "ammo"
                        ? "rgba(255, 214, 110, 0.95)"
                        : "rgba(110, 255, 150, 0.95)";
                    ctx.strokeStyle = "rgba(0, 0, 0, 0.65)";
                    ctx.lineWidth = 1;
                    ctx.fill();
                    ctx.stroke();
                }
            }

            // The rider: an arrow at their position, nose to their facing.
            // Forward is (sin f, cos f) in world x/z, which maps to
            // right/down here, so the canvas rotation is pi - f.
            const px = toMap(character.position.x);
            const pz = toMap(character.position.z);
            const s = size / 168;
            ctx.translate(px, pz);
            ctx.rotate(Math.PI - character.facing);
            ctx.beginPath();
            ctx.moveTo(0, -6.5 * s);
            ctx.lineTo(4.6 * s, 5.5 * s);
            ctx.lineTo(0, 2.6 * s);
            ctx.lineTo(-4.6 * s, 5.5 * s);
            ctx.closePath();
            ctx.fillStyle = "rgba(255, 250, 235, 0.95)";
            ctx.strokeStyle = "rgba(0, 0, 0, 0.65)";
            ctx.lineWidth = 1.2 * s;
            ctx.stroke();
            ctx.fill();
            ctx.restore();
        },
    };
}
