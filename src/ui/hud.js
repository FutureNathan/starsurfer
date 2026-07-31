/**
 * The combat HUD: a crosshair and a missile counter.
 *
 * The crosshair is the laser's whole sight — the beam goes exactly where
 * the camera looks, so a dot and a hairline ring at screen centre is the
 * honest reticle. It shows only while the pointer is locked (the `locked`
 * class input.js keeps on <body>): with the menu or the death screen up
 * there is a real cursor on screen, and two cursors is one too many.
 *
 * The missile counter sits under the reticle, where a shooter's ammo lives.
 * It flashes when a rocket is asked of an empty rack.
 */

const CSS = /* css */ `
#xhair {
    position: fixed;
    left: 50%;
    top: 50%;
    width: 26px;
    height: 26px;
    margin: -13px 0 0 -13px;
    z-index: 45;
    pointer-events: none;
    display: none;
}
body.locked #xhair { display: block; }
#xhair::before {
    content: "";
    position: absolute;
    inset: 0;
    border: 1px solid rgba(255, 246, 224, 0.55);
    border-radius: 50%;
}
#xhair::after {
    content: "";
    position: absolute;
    left: 50%;
    top: 50%;
    width: 3px;
    height: 3px;
    margin: -1.5px 0 0 -1.5px;
    border-radius: 50%;
    background: rgba(255, 246, 224, 0.9);
}
#ammo {
    position: fixed;
    left: 50%;
    top: calc(50% + 26px);
    transform: translateX(-50%);
    z-index: 45;
    padding: 0.2em 0.7em;
    border-radius: 999px;
    background: rgba(5, 6, 15, 0.55);
    color: rgba(255, 246, 224, 0.85);
    font-size: 11px;
    letter-spacing: 0.16em;
    pointer-events: none;
    display: none;
    transition: color 120ms ease;
}
body.locked #ammo { display: block; }
#ammo.dry { color: rgba(255, 120, 100, 0.95); }
`;

export function initHud() {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    const xhair = document.createElement("div");
    xhair.id = "xhair";
    document.body.appendChild(xhair);

    const ammo = document.createElement("div");
    ammo.id = "ammo";
    document.body.appendChild(ammo);

    let dryT = null;
    const setAmmo = (n) => {
        ammo.textContent = `⌁ missiles ${n}`;
    };
    return {
        setAmmo,
        flashDry() {
            ammo.classList.add("dry");
            clearTimeout(dryT);
            dryT = setTimeout(() => ammo.classList.remove("dry"), 450);
        },
    };
}
