/**
 * Martian Hunt.
 *
 * Eight green-suited martians run this stretch of moon. Wander is their
 * resting state; inside about fourteen metres they turn and come for you,
 * and inside nine they stop, crackle for three quarters of a second, and
 * put a lightning bolt through your suit — which is death, the score board,
 * and the restart. The flight weapons are the answer: while the mode is on
 * they auto-lock the nearest martian within range, a laser is a kill, a
 * rocket kills everything near where it lands, and every kill is a point.
 * The population is maintained — a dead martian respawns elsewhere after a
 * moment — so the score is bounded by nerve, not by supply.
 *
 * The scores keep: a top-twenty table in localStorage, initials-and-all,
 * offered on death only when the run actually places.
 *
 * Structure: the logic here runs headless (the test suite drives it with
 * stubs — no scene, no DOM); the meshes, the score chip and the death panel
 * only build when a scene is provided. The martian body is merged rigid
 * primitives sharing one ShaderMaterial — Babylon binds `world` per clone —
 * animated by bob and lean alone, with dust kicks selling the run. No
 * skeleton: at combat range, posture is silhouette, and the silhouette is
 * the merged pose.
 */

import { S } from "../core/settings.js";

const COUNT = 14;
/** Martians keep inside this radius of the world centre, metres. */
const WANDER_R = 560;
/** Hit points. Both sides carry three — an even match, by request. */
const HP = 3;
const PLAYER_HP = 3;
/**
 * Escalation. Every kill raises the threat level (capped), and each
 * REPLACEMENT spawns at the current level: hunting from farther, running
 * harder, charging faster, leading your movement better, and — past level
 * five — strafing sideways between shots instead of standing to be shot.
 * Veterans are visibly bigger, so a big martian read means "respect this
 * one" before it proves it. The numbers below are level-zero baselines and
 * per-level steps.
 */
const LVL_CAP = 20;
const HUNT_R0 = 34, HUNT_R_STEP = 6;        // up to 154 m at cap
const FIRE_R0 = 28, FIRE_R_STEP = 2;        // up to 68 m
const RUN0 = 3.4, RUN_STEP = 0.22;          // up to ~7.8 m/s
const WINDUP0 = 0.85, WINDUP_STEP = 0.02, WINDUP_MIN = 0.5;
const COOLDOWN0 = 2.2, COOLDOWN_STEP = 0.06, COOLDOWN_MIN = 1.2;
const BOLT_V0 = 12, BOLT_V_STEP = 0.45;     // up to ~21 m/s
const LEAD0 = 0.35, LEAD_STEP = 0.03;       // up to ~0.95 s of your velocity
const STRAFE_LVL = 5;
const BOLT_HIT_R = 1.7;
const BOLT_LIFE = 3.5;
/** Seconds of grace after taking a hit. */
const HIT_INVULN = 1.2;
/** Seconds a hit martian staggers. */
const STAGGER = 0.45;
/** Metres of weapon auto-lock, from the player. */
const LOCK_R = 45;
/** Seconds a dead martian stays gone. */
const RESPAWN_T = 1.6;
/** Missile ammo packs standing on the ground, world-wide. */
const PACK_COUNT = 5;
const PACK_R = 2.8;
const PACK_AMMO = 3;
const AMMO_CAP = 9;
const PACK_RESPAWN = 18;
/** Seconds of grace after a restart. */
const INVULN = 2.5;

const STORE_KEY = "ss-martian-scores";

/** Does this score place on a top-twenty board? Exported for the tests. */
export function qualifies(scores, score) {
    if (score <= 0) return false;
    if (scores.length < 20) return true;
    return score > scores[scores.length - 1].score;
}

const CSS = /* css */ `
#mz-score {
    position: fixed;
    top: 14px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 50;
    padding: 0.5em 1.1em;
    border: 1px solid rgba(120, 255, 150, 0.35);
    border-radius: 999px;
    background: rgba(5, 12, 6, 0.72);
    color: rgba(160, 255, 180, 0.95);
    font-size: 13px;
    letter-spacing: 0.18em;
    pointer-events: none;
}
#mz-death {
    position: fixed;
    inset: 0;
    z-index: 80;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(2, 4, 3, 0.82);
    color: rgba(220, 245, 225, 0.96);
    text-align: center;
    font-size: 14px;
    letter-spacing: 0.08em;
}
#mz-death .mz-panel {
    max-width: 340px;
    padding: 2em 2.4em;
    border: 1px solid rgba(120, 255, 150, 0.30);
    border-radius: 14px;
    background: rgba(5, 10, 6, 0.92);
}
#mz-death h1 {
    font-size: 20px;
    letter-spacing: 0.3em;
    color: rgba(150, 255, 175, 0.95);
    margin: 0 0 0.6em;
}
#mz-death .mz-score { font-size: 26px; margin: 0.2em 0 0.8em; }
#mz-death input {
    width: 12em;
    padding: 0.45em 0.7em;
    border: 1px solid rgba(120, 255, 150, 0.4);
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.5);
    color: inherit;
    font: inherit;
    text-align: center;
}
#mz-death button {
    margin: 0.9em 0.3em 0;
    padding: 0.55em 1.4em;
    border: 1px solid rgba(120, 255, 150, 0.45);
    border-radius: 999px;
    background: rgba(20, 44, 24, 0.9);
    color: inherit;
    font: inherit;
    letter-spacing: 0.15em;
    cursor: pointer;
}
#mz-death button:hover { background: rgba(30, 66, 36, 0.95); }
#mz-death ol {
    margin: 0.8em 0 0;
    padding: 0;
    list-style-position: inside;
    text-align: left;
    font-size: 12px;
    max-height: 200px;
    overflow-y: auto;
}
#mz-death li { padding: 0.12em 0; }
#mz-death li b { float: right; }
`;

export class MartianMode {
    /**
     * @param {{
     *   scene?: import("@babylonjs/core/scene").Scene|null,
     *   terrain: {heightAt(x:number,z:number):number},
     *   sky?: any, spray?: {emit:Function}|null,
     *   lights?: {add:Function}|null,
     *   character: any, rig?: {addTrauma(v:number):void}|null,
     *   canvas?: HTMLCanvasElement|null,
     * }} opts
     */
    constructor(opts) {
        this.terrain = opts.terrain;
        this.sky = opts.sky || null;
        this.spray = opts.spray || null;
        this.lights = opts.lights || null;
        this.ch = opts.character;
        this.rig = opts.rig || null;
        this.canvas = opts.canvas || null;

        this.active = false;
        this.dead = false;
        this.score = 0;
        this.hp = PLAYER_HP;
        this._invuln = 0;
        this._t = 0;

        /** Live bolt projectiles — the dodgeable part of the fight.
         * @type {{x:number,y:number,z:number,vx:number,vy:number,vz:number,
         *         life:number}[]} */
        this._bolts = [];

        /** Missile ammo packs. Alive in every mode — the rocket eats ammo
         *  whether or not anything is hunting you.
         * @type {{x:number,z:number,alive:boolean,respawn:number,mesh:any}[]} */
        this.packs = [];
        for (let i = 0; i < PACK_COUNT; i++) {
            this.packs.push({ x: 0, z: 0, alive: false, respawn: 0, mesh: null });
        }

        /** @type {{x:number,z:number,heading:number,bob:number,alive:boolean,
         *          hp:number,respawn:number,windup:number,cooldown:number,
         *          stagger:number,mesh:any}[]} */
        this.martians = [];
        for (let i = 0; i < COUNT; i++) {
            this.martians.push({
                x: 0, z: 0, heading: 0, bob: Math.random() * 7,
                alive: false, hp: HP, respawn: 0, windup: 0,
                cooldown: 0, stagger: 0, mesh: null,
            });
        }

        if (opts.scene) this._buildSkin(opts.scene);
        if (typeof document !== "undefined" && opts.scene) this._buildUI();
    }

    // ------------------------------------------------------------- the body
    async _buildSkin(scene) {
        const [{ Mesh }, { CreateCapsule }, { CreateSphere }, { CreateBox },
               { ShaderMaterial }, { ShaderLanguage }] = await Promise.all([
            import("@babylonjs/core/Meshes/mesh"),
            import("@babylonjs/core/Meshes/Builders/capsuleBuilder"),
            import("@babylonjs/core/Meshes/Builders/sphereBuilder"),
            import("@babylonjs/core/Meshes/Builders/boxBuilder"),
            import("@babylonjs/core/Materials/shaderMaterial"),
            import("@babylonjs/core/Materials/shaderLanguage"),
        ]);

        const part = (m, x, y, z, rx = 0, rz = 0) => {
            m.position.set(x, y, z);
            m.rotation.x = rx;
            m.rotation.z = rz;
            m.bakeCurrentTransformIntoVertices();
            return m;
        };
        // A runner, frozen mid-stride; the bob and the dust do the moving.
        const parts = [
            part(CreateCapsule("mzT", { height: 0.66, radius: 0.24 }, scene), 0, 0.92, 0),
            part(CreateSphere("mzH", { diameter: 0.46, segments: 10 }, scene), 0, 1.40, 0.02),
            part(CreateCapsule("mzL1", { height: 0.56, radius: 0.10 }, scene), -0.11, 0.34, 0.10, 0.55),
            part(CreateCapsule("mzL2", { height: 0.56, radius: 0.10 }, scene), 0.11, 0.34, -0.10, -0.5),
            part(CreateCapsule("mzA1", { height: 0.5, radius: 0.075 }, scene), -0.31, 0.98, -0.08, -0.55),
            part(CreateCapsule("mzA2", { height: 0.5, radius: 0.075 }, scene), 0.31, 0.98, 0.10, 0.6),
            part(CreateBox("mzP", { width: 0.36, height: 0.44, depth: 0.18 }, scene), 0, 1.02, -0.27),
        ];
        const proto = Mesh.MergeMeshes(parts, true, true);
        proto.isVisible = false;
        proto.isPickable = false;

        const mat = new ShaderMaterial("martianMat", scene,
            { vertex: "martian", fragment: "martian" },
            {
                attributes: ["position", "normal"],
                uniforms: [
                    "world", "viewProjection", "cameraPosition",
                    "sunDir", "sunRadiance", "shR", "ambientIntensity",
                    "hitFlash",
                    "fogDensity", "fogHeightFalloff", "fogStart", "aerialStrength",
                ],
                samplers: ["skyLUT"],
                shaderLanguage: ShaderLanguage.WGSL,
            });
        mat.backFaceCulling = true;
        proto.material = mat;
        this.material = mat;
        this._scene = scene;
        /** Every live material — the base (crates wear it) plus one clone
         *  per martian, so each can carry its own red hit-flash. */
        this._mats = [mat];

        for (let i = 0; i < COUNT; i++) {
            const m = proto.clone("mz" + i);
            m.isVisible = false;
            m.isPickable = false;
            m.alwaysSelectAsActiveMesh = true;
            m.renderingGroupId = 1;
            const mi = mat.clone("martianMat" + i);
            m.material = mi;
            this._mats.push(mi);
            this.martians[i].mesh = m;
            this.martians[i].mat = mi;
        }
        this._proto = proto;

        // The ammo crates: the same suit material — a box's local Y sits
        // under the visor band, so it comes out dark crate-green — with a
        // beacon of glowing grains doing the long-distance advertising.
        const crateProto = CreateBox("mzCrate", {
            width: 0.6, height: 0.5, depth: 0.6,
        }, scene);
        crateProto.material = mat;
        crateProto.isVisible = false;
        crateProto.isPickable = false;
        for (const p of this.packs) {
            const c = crateProto.clone("mzPack");
            c.isVisible = false;
            c.isPickable = false;
            c.alwaysSelectAsActiveMesh = true;
            c.renderingGroupId = 1;
            c.material = mat;
            p.mesh = c;
        }
        this._crateProto = crateProto;
        // Meshes may finish building after the first spawns.
        for (const p of this.packs) {
            if (p.alive && p.mesh) {
                p.mesh.isVisible = true;
                p.mesh.position.set(
                    p.x, this.terrain.heightAt(p.x, p.z) + 0.26, p.z);
            }
        }
    }

    /** Per-frame scalar uniforms off the live sky — mirrors the terrain's,
     *  for the base material and every martian's own clone. */
    _pushUniforms() {
        const sky = this.sky;
        if (!this._mats || !sky || !this._scene) return;
        for (const m of this._mats) {
            m.setVector3("cameraPosition", this._scene.activeCamera.globalPosition);
            m.setVector3("sunDir", sky.sunDir);
            m.setColor3("sunRadiance", sky.sunRadiance);
            m.setArray4("shR", sky.sh);
            m.setFloat("ambientIntensity", S.ambientIntensity);
            m.setTexture("skyLUT", sky.lut);
            m.setFloat("fogDensity", S.fogDensity);
            m.setFloat("fogHeightFalloff", S.fogHeightFalloff);
            m.setFloat("fogStart", S.fogStart);
            m.setFloat("aerialStrength", S.aerialStrength);
        }
    }

    // --------------------------------------------------------------- the UI
    _buildUI() {
        const style = document.createElement("style");
        style.textContent = CSS;
        document.head.appendChild(style);

        this._chip = document.createElement("div");
        this._chip.id = "mz-score";
        this._chip.style.display = "none";
        document.body.appendChild(this._chip);

        this._panel = document.createElement("div");
        this._panel.id = "mz-death";
        this._panel.style.display = "none";
        document.body.appendChild(this._panel);
    }

    _chipText() {
        if (!this._chip) return;
        const hearts = "♥".repeat(this.hp) + "♡".repeat(PLAYER_HP - this.hp);
        this._chip.textContent =
            `☠ ${this.score}   ${hearts}   ⚠ threat ${this.level()}`;
    }

    _showDeath() {
        if (!this._panel) return;
        const q = qualifies(this.topScores(), this.score);
        this._panel.innerHTML = `
            <div class="mz-panel">
                <h1>⚡ SHOCKED</h1>
                <div>a martian put lightning through your suit</div>
                <div class="mz-score">☠ ${this.score}</div>
                <div>threat level reached: ${this.level()}</div>
                ${q ? `
                    <div>that places in the top twenty</div>
                    <input id="mz-name" maxlength="16" placeholder="your name" />
                    <div><button id="mz-save">save score</button></div>
                ` : ""}
                <ol id="mz-list"></ol>
                <div><button id="mz-restart">restart</button></div>
            </div>`;
        this._renderBoard();
        this._panel.style.display = "flex";
        document.exitPointerLock?.();
        const save = this._panel.querySelector("#mz-save");
        save?.addEventListener("click", () => {
            const name = (this._panel.querySelector("#mz-name")?.value || "surfer")
                .trim().slice(0, 16) || "surfer";
            this._saveScore(name, this.score);
            save.parentElement.style.display = "none";
            this._panel.querySelector("#mz-name").style.display = "none";
            this._renderBoard();
        });
        this._panel.querySelector("#mz-restart")?.addEventListener("click", () => {
            this.restart();
            this.canvas?.requestPointerLock?.();
        });
    }

    _renderBoard() {
        const ol = this._panel?.querySelector("#mz-list");
        if (!ol) return;
        const sc = this.topScores();
        ol.innerHTML = sc.length
            ? sc.map((s) => `<li>${s.name.replace(/[<>&]/g, "")} <b>${s.score}</b></li>`).join("")
            : "<li>no hunts on the board yet</li>";
    }

    // ------------------------------------------------------------ the board
    topScores() {
        try {
            const raw = localStorage.getItem(STORE_KEY);
            const v = raw ? JSON.parse(raw) : [];
            return Array.isArray(v) ? v : [];
        } catch {
            return this._memScores || [];
        }
    }

    _saveScore(name, score) {
        const sc = this.topScores();
        sc.push({ name, score });
        sc.sort((a, b) => b.score - a.score);
        const top = sc.slice(0, 20);
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify(top));
        } catch {
            this._memScores = top;
        }
    }

    // ------------------------------------------------------------- the mode
    enable() {
        if (this.active) return;
        this.active = true;
        this.dead = false;
        this.score = 0;
        this.hp = PLAYER_HP;
        this._bolts.length = 0;
        this._invuln = INVULN;
        for (const m of this.martians) this._spawn(m);
        for (const p of this.packs) this._spawnPack(p);
        if (this._chip) {
            this._chip.style.display = "";
            this._chipText();
        }
        if (typeof document !== "undefined") {
            document.body.classList.add("combat");
        }
        // While the hunt is on: the LASER is pure aim — its ray is tested
        // against the martians, one point of damage on a true hit — and only
        // the MISSILE keeps the auto-lock, paying for the privilege in ammo.
        // A blast is the full three points, the heavy answer.
        const w = this.weapons;
        if (w) {
            w.armed = true;
            w.rayTest = (sx, sy, sz, tx, ty, tz) =>
                this._rayHit(sx, sy, sz, tx, ty, tz);
            w.getLock = () => this._nearestLock();
            w.onHit = (lock) => { if (lock.ref) this._damage(lock.ref, 1); };
            w.onBlast = (x, y, z, r) => this._blast(x, y, z, r);
        }
    }

    disable() {
        if (!this.active) return;
        this.active = false;
        this.dead = false;
        this._bolts.length = 0;
        for (const m of this.martians) {
            m.alive = false;
            if (m.mesh) m.mesh.isVisible = false;
        }
        // The crates leave with the mode — free roam carries no ordnance.
        for (const p of this.packs) {
            p.alive = false;
            p.respawn = 0;
            if (p.mesh) p.mesh.isVisible = false;
        }
        if (this._chip) this._chip.style.display = "none";
        if (this._panel) this._panel.style.display = "none";
        if (typeof document !== "undefined") {
            document.body.classList.remove("combat");
        }
        const w = this.weapons;
        if (w) {
            w.armed = false;
            w.rayTest = null;
            w.getLock = null;
            w.onHit = null;
            w.onBlast = null;
        }
    }

    restart() {
        this.dead = false;
        this.score = 0;
        this.hp = PLAYER_HP;
        this._bolts.length = 0;
        this._invuln = INVULN;
        this._chipText();
        const ch = this.ch;
        ch.position.x = 0;
        ch.position.z = 0;
        ch.position.y = this.terrain.heightAt(0, 0);
        ch.velocity.x = 0;
        ch.velocity.z = 0;
        for (const m of this.martians) this._spawn(m);
        if (this._panel) this._panel.style.display = "none";
    }

    /** The current threat level: one per kill so far, capped. */
    level() {
        return Math.min(LVL_CAP, this.score);
    }

    _spawn(m) {
        const ch = this.ch;
        // An annulus around the player: near enough to matter, never on top.
        const a = Math.random() * Math.PI * 2;
        const d = 60 + Math.random() * 160;
        m.x = ch.position.x + Math.sin(a) * d;
        m.z = ch.position.z + Math.cos(a) * d;
        const r = Math.hypot(m.x, m.z);
        if (r > WANDER_R) {
            m.x *= WANDER_R / r;
            m.z *= WANDER_R / r;
        }
        m.heading = Math.random() * Math.PI * 2;
        m.alive = true;
        m.hp = HP;
        m.windup = 0;
        m.cooldown = 0;
        m.stagger = 0;
        m.respawn = 0;
        m.flash = 0;

        // The replacement is a veteran of everything you have done so far.
        const lvl = this.level();
        m.gen = lvl;
        m.huntR = HUNT_R0 + lvl * HUNT_R_STEP;
        m.fireR = FIRE_R0 + lvl * FIRE_R_STEP;
        m.runSpeed = RUN0 + lvl * RUN_STEP;
        m.windupT = Math.max(WINDUP_MIN, WINDUP0 - lvl * WINDUP_STEP);
        m.cooldownT = Math.max(COOLDOWN_MIN, COOLDOWN0 - lvl * COOLDOWN_STEP);
        m.boltV = BOLT_V0 + lvl * BOLT_V_STEP;
        m.lead = LEAD0 + lvl * LEAD_STEP;
        m.strafes = lvl >= STRAFE_LVL;
        m.strafeDir = Math.random() < 0.5 ? -1 : 1;

        if (m.mesh) {
            m.mesh.isVisible = true;
            // The veteran's tell: up to thirty percent bigger at the cap.
            m.mesh.scaling.setAll(1 + Math.min(10, lvl) * 0.03);
        }
    }

    // ------------------------------------------------------------ ammo packs
    _spawnPack(p) {
        const ch = this.ch;
        const a = Math.random() * Math.PI * 2;
        const d = 70 + Math.random() * 250;
        p.x = ch.position.x + Math.sin(a) * d;
        p.z = ch.position.z + Math.cos(a) * d;
        const r = Math.hypot(p.x, p.z);
        if (r > WANDER_R) { p.x *= WANDER_R / r; p.z *= WANDER_R / r; }
        p.alive = true;
        p.respawn = 0;
        if (p.mesh) {
            p.mesh.isVisible = true;
            p.mesh.position.set(
                p.x, this.terrain.heightAt(p.x, p.z) + 0.26, p.z);
        }
    }

    /** Runs in every mode: the crates stand, beckon, and refill missiles. */
    _updatePacks(dt) {
        const ch = this.ch;
        const w = this.weapons;
        for (const p of this.packs) {
            if (!p.alive) {
                p.respawn -= dt;
                if (p.respawn <= 0) this._spawnPack(p);
                continue;
            }
            const gy = this.terrain.heightAt(p.x, p.z);
            // The beacon: a slow fountain of charged grains off the crate.
            if (this.spray && Math.random() < 0.45) {
                this.spray.emit(
                    p.x + (Math.random() - 0.5) * 0.4,
                    gy + 0.5, p.z + (Math.random() - 0.5) * 0.4,
                    (Math.random() - 0.5) * 0.4,
                    1.6 + Math.random() * 1.4,
                    (Math.random() - 0.5) * 0.4,
                    0.022 + Math.random() * 0.018,
                    0.6 + Math.random() * 0.5,
                    1, 0.4
                );
            }
            const d = Math.hypot(
                p.x - ch.position.x,
                gy + 0.3 - ch.position.y,
                p.z - ch.position.z
            );
            if (d < PACK_R && w && w.missiles < AMMO_CAP) {
                w.missiles = Math.min(AMMO_CAP, w.missiles + PACK_AMMO);
                w.onAmmo?.(w.missiles);
                ch.ammoPickup = true;
                p.alive = false;
                p.respawn = PACK_RESPAWN;
                if (p.mesh) p.mesh.isVisible = false;
            }
        }
    }

    /**
     * The laser's hit test: the nearest live martian within arm's width of
     * the fired ray, if any — aim is the whole game now, the lock is gone.
     */
    _rayHit(sx, sy, sz, tx, ty, tz) {
        const dx = tx - sx, dy = ty - sy, dz = tz - sz;
        const len2 = dx * dx + dy * dy + dz * dz;
        if (len2 < 1e-6) return null;
        let best = null, bestU = 2;
        for (const m of this.martians) {
            if (!m.alive) continue;
            const my = this.terrain.heightAt(m.x, m.z) + 1.0;
            const u = ((m.x - sx) * dx + (my - sy) * dy + (m.z - sz) * dz) / len2;
            if (u < 0 || u > 1) continue;
            const px = sx + dx * u, py = sy + dy * u, pz = sz + dz * u;
            const d = Math.hypot(m.x - px, my - py, m.z - pz);
            if (d < 1.9 && u < bestU) {
                bestU = u;
                best = { x: m.x, y: my, z: m.z, ref: m };
            }
        }
        return best;
    }

    /** Mini-map markers: foes and ammo, drawn by the chart. */
    mapMarkers() {
        const out = [];
        if (this.active) {
            for (const m of this.martians) {
                if (m.alive) out.push({ x: m.x, z: m.z, kind: "foe" });
            }
        }
        for (const p of this.packs) {
            if (p.alive) out.push({ x: p.x, z: p.z, kind: "ammo" });
        }
        return out;
    }

    _nearestLock() {
        const ch = this.ch;
        let best = null, bestD = LOCK_R;
        for (const m of this.martians) {
            if (!m.alive) continue;
            const d = Math.hypot(m.x - ch.position.x, m.z - ch.position.z);
            if (d < bestD) { bestD = d; best = m; }
        }
        if (!best) return null;
        return {
            x: best.x,
            y: this.terrain.heightAt(best.x, best.z) + 1.0,
            z: best.z,
            ref: best,
        };
    }

    /**
     * A hit on a martian. One point of damage flashes and staggers; the
     * third is the kill — a real little explosion, a scorch on the ground,
     * and the score.
     */
    _damage(m, amount) {
        if (!m.alive) return;
        m.hp -= amount;
        const gy = this.terrain.heightAt(m.x, m.z);
        m.flash = 1;
        if (m.hp > 0) {
            m.stagger = STAGGER;
            this.ch.martianHit = true;
            if (this.spray) {
                for (let i = 0; i < 12; i++) {
                    const a = Math.random() * Math.PI * 2;
                    this.spray.emit(
                        m.x, gy + 0.9 + Math.random() * 0.6, m.z,
                        Math.cos(a) * (1 + Math.random() * 2.5),
                        0.8 + Math.random() * 2,
                        Math.sin(a) * (1 + Math.random() * 2.5),
                        0.018 + Math.random() * 0.02,
                        0.25 + Math.random() * 0.3,
                        1, 1.6
                    );
                }
            }
            this._pulse = { x: m.x, y: gy + 1, z: m.z, ttl: 0.22 };
            return;
        }

        // The kill: down, exploded, scored, and replaced elsewhere.
        m.alive = false;
        m.respawn = RESPAWN_T;
        m.windup = 0;
        if (m.mesh) m.mesh.isVisible = false;
        this.score += 1;
        this._chipText();
        this.ch.martianDown = true;
        this.terrain.deform?.brush?.(
            m.x, m.z, 0.9, 0.10, 0.08, 0.9, 0.35, m.heading, 1.1, 1.0
        );
        if (this.spray) {
            for (let i = 0; i < 64; i++) {
                const a = Math.random() * Math.PI * 2;
                const clod = Math.random() < 0.35 ? 1 : 0;
                this.spray.emit(
                    m.x, gy + 0.5 + Math.random() * 1.0, m.z,
                    Math.cos(a) * (2 + Math.random() * 5.5),
                    1.2 + Math.random() * 5,
                    Math.sin(a) * (2 + Math.random() * 5.5),
                    clod ? 0.02 + Math.random() * 0.02 : 0.03 + Math.random() * 0.04,
                    0.5 + Math.random() * 0.8,
                    clod, clod ? 0.8 : 1.6
                );
            }
        }
        this._pulse = { x: m.x, y: gy + 1, z: m.z, ttl: 0.5 };
    }

    _blast(x, y, z, r) {
        for (const m of this.martians) {
            if (!m.alive) continue;
            const gy = this.terrain.heightAt(m.x, m.z);
            if (Math.hypot(m.x - x, gy + 1 - y, m.z - z) < r) {
                this._damage(m, HP);
            }
        }
    }

    /**
     * The charged shot leaves: a slow, bright bolt projectile aimed at where
     * the player is heading, not just where they are — dodging is a change
     * of direction, which is the shooter contract.
     */
    _fireBolt(m) {
        const ch = this.ch;
        const gy = this.terrain.heightAt(m.x, m.z);
        const sx = m.x, sy = gy + 1.4, sz = m.z;
        // The veterans lead the target harder — dodging them takes a real
        // change of direction, not a stroll.
        const lead = m.lead || LEAD0;
        const v = m.boltV || BOLT_V0;
        const tx = ch.position.x + (ch.velocity.x || 0) * lead;
        const ty = ch.position.y + 0.9;
        const tz = ch.position.z + (ch.velocity.z || 0) * lead;
        let dx = tx - sx, dy = ty - sy, dz = tz - sz;
        const l = Math.hypot(dx, dy, dz) || 1;
        this._bolts.push({
            x: sx, y: sy, z: sz,
            vx: (dx / l) * v,
            vy: (dy / l) * v,
            vz: (dz / l) * v,
            life: 0,
        });
        m.windup = 0;
        m.cooldown = m.cooldownT || COOLDOWN0;
    }

    /** A bolt connected. One heart; the third is the death screen. */
    _playerHit(x, y, z) {
        const ch = this.ch;
        if (this._invuln > 0 || this.dead) return;
        this.hp -= 1;
        this._invuln = HIT_INVULN;
        ch.boltShock = true;
        this.rig?.addTrauma?.(0.45);
        this._chipText();
        if (this.spray) {
            for (let i = 0; i < 26; i++) {
                const a = Math.random() * Math.PI * 2;
                this.spray.emit(
                    ch.position.x, ch.position.y + 0.7 + Math.random() * 0.6,
                    ch.position.z,
                    Math.cos(a) * (1.5 + Math.random() * 3),
                    1 + Math.random() * 3,
                    Math.sin(a) * (1.5 + Math.random() * 3),
                    0.02 + Math.random() * 0.02,
                    0.2 + Math.random() * 0.3,
                    1, 2
                );
            }
        }
        this._pulse = { x, y, z, ttl: 0.35 };
        if (this.hp <= 0) {
            this.dead = true;
            ch.velocity.x = 0;
            ch.velocity.z = 0;
            this._showDeath();
        }
    }

    /** Once per frame from the main loop, before the audio reads the flags. */
    update(dt) {
        const ch = this.ch;
        ch.boltShock = false;
        ch.martianDown = false;
        ch.martianHit = false;
        ch.ammoPickup = false;

        this._t += dt;
        if (!this.active) return;

        this._pushUniforms();
        this._updatePacks(dt);
        this._invuln = Math.max(0, this._invuln - dt);

        // The kill/bolt flash, while it lasts.
        if (this._pulse && this.lights) {
            const p = this._pulse;
            p.ttl -= dt;
            if (p.ttl <= 0) this._pulse = null;
            else {
                this.lights.add(p.x, p.y, p.z, 9, 0.3, 1.0, 0.4,
                    22 * (p.ttl / 0.5));
            }
        }

        for (const m of this.martians) {
            if (!m.alive) {
                m.respawn -= dt;
                if (m.respawn <= 0 && !this.dead) this._spawn(m);
                continue;
            }

            const dx = ch.position.x - m.x, dz = ch.position.z - m.z;
            const gy = this.terrain.heightAt(m.x, m.z);
            const d3 = Math.hypot(dx, dz, ch.position.y - gy);

            m.cooldown = Math.max(0, m.cooldown - dt);
            m.stagger = Math.max(0, m.stagger - dt);

            // Wander, or hunt when the prey is inside this one's own range —
            // which the veterans stretch far past the rookies'.
            const hunting = !this.dead && d3 < (m.huntR || HUNT_R0);
            if (hunting) {
                const want = Math.atan2(dx, dz);
                let delta = want - m.heading;
                while (delta > Math.PI) delta -= Math.PI * 2;
                while (delta < -Math.PI) delta += Math.PI * 2;
                m.heading += delta * Math.min(1, 6 * dt);
            } else {
                m.heading += (Math.random() - 0.5) * 1.7 * dt;
            }

            // Attack: plant, charge visibly, loose the bolt. The charge is
            // the warning — crackle off the helmet and a glow that swells
            // before anything leaves (less of it, the older the soldier).
            // Break the range and the charge drains; the shot itself is
            // dodged in flight.
            const windupT = m.windupT || WINDUP0;
            const charging = !this.dead && this._invuln <= 0
                && m.stagger <= 0 && m.cooldown <= 0
                && d3 < (m.fireR || FIRE_R0);
            if (charging) {
                m.windup += dt;
                if (this.spray && Math.random() < 0.7) {
                    this.spray.emit(
                        m.x + (Math.random() - 0.5) * 0.5,
                        gy + 1.3 + (Math.random() - 0.5) * 0.4,
                        m.z + (Math.random() - 0.5) * 0.5,
                        (Math.random() - 0.5) * 2, 1 + Math.random() * 2,
                        (Math.random() - 0.5) * 2,
                        0.02, 0.12 + Math.random() * 0.1, 1, 8
                    );
                }
                this.lights?.add(m.x, gy + 1.4, m.z, 6, 0.35, 1.0, 0.45,
                    16 * (m.windup / windupT));
                if (m.windup >= windupT) this._fireBolt(m);
            } else {
                m.windup = Math.max(0, m.windup - dt * 2);
            }

            // Veterans do not stand around between shots: while the bolt
            // recharges they slide sideways across your aim, flipping
            // direction now and then — the strafe that makes them harder
            // to laser and smarter to fight.
            let speed;
            let moveHeading = m.heading;
            const run = m.runSpeed || RUN0;
            if (m.stagger > 0) speed = 0;
            else if (charging) speed = 0.35;
            else if (hunting && m.strafes && m.cooldown > 0) {
                speed = run * 0.8;
                if (Math.random() < dt * 0.7) m.strafeDir *= -1;
                moveHeading = m.heading + m.strafeDir * Math.PI / 2;
            } else if (hunting) speed = Math.min(run, 2.4 + (m.gen || 0) * 0.25);
            else speed = run;
            m.x += Math.sin(moveHeading) * speed * dt;
            m.z += Math.cos(moveHeading) * speed * dt;
            const r = Math.hypot(m.x, m.z);
            if (r > WANDER_R) {
                // Turn back toward the middle rather than clipping the fence.
                m.heading = Math.atan2(-m.x, -m.z) + (Math.random() - 0.5);
                m.x *= WANDER_R / r;
                m.z *= WANDER_R / r;
            }

            m.bob += dt * (speed > 1 ? 9 : 2);
            m.flash = Math.max(0, (m.flash || 0) - dt * 4);
            if (m.mesh) {
                m.mesh.position.set(
                    m.x,
                    this.terrain.heightAt(m.x, m.z)
                        + Math.abs(Math.sin(m.bob)) * 0.07,
                    m.z
                );
                m.mesh.rotation.y = m.heading;
                m.mesh.rotation.x = speed > 1 ? 0.14 : 0.02;
                m.mat?.setFloat("hitFlash", m.flash);
            }

            // Dust off the boots at the stride rate.
            if (this.spray && speed > 1 && Math.random() < 0.25) {
                this.spray.emit(
                    m.x, gy + 0.05, m.z,
                    -Math.sin(m.heading) * 1.2 + (Math.random() - 0.5),
                    0.6 + Math.random(),
                    -Math.cos(m.heading) * 1.2 + (Math.random() - 0.5),
                    0.03 + Math.random() * 0.03,
                    0.5 + Math.random() * 0.5,
                    0, 4
                );
            }
        }

        // The bolts in flight: bright, slow, and honest — a crackling head
        // with its own light, killable by footwork alone. The ground fizzles
        // them; the player they were promised to costs one heart.
        const bolts = this._bolts;
        for (let i = bolts.length - 1; i >= 0; i--) {
            const b = bolts[i];
            b.life += dt;
            b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
            if (this.spray) {
                // A fat crackling head you cannot miss...
                for (let k = 0; k < 6; k++) {
                    this.spray.emit(
                        b.x + (Math.random() - 0.5) * 0.3,
                        b.y + (Math.random() - 0.5) * 0.3,
                        b.z + (Math.random() - 0.5) * 0.3,
                        0, 0, 0,
                        0.055 + Math.random() * 0.035,
                        0.08 + Math.random() * 0.06,
                        1, 14
                    );
                }
                // ...towing a lingering tail that marks the whole flight
                // path, which is what makes the dodge readable.
                for (let k = 0; k < 3; k++) {
                    this.spray.emit(
                        b.x - b.vx * 0.03 * k, b.y - b.vy * 0.03 * k,
                        b.z - b.vz * 0.03 * k,
                        (Math.random() - 0.5) * 0.6,
                        (Math.random() - 0.5) * 0.6,
                        (Math.random() - 0.5) * 0.6,
                        0.028 + Math.random() * 0.016,
                        0.35 + Math.random() * 0.25,
                        1, 3
                    );
                }
            }
            this.lights?.add(b.x, b.y, b.z, 8, 0.35, 1.0, 0.45, 15);

            const pd = Math.hypot(
                b.x - ch.position.x,
                b.y - (ch.position.y + 0.9),
                b.z - ch.position.z
            );
            const grounded = b.y <= this.terrain.heightAt(b.x, b.z) + 0.1;
            if (pd < BOLT_HIT_R && !this.dead) {
                this._playerHit(b.x, b.y, b.z);
                bolts.splice(i, 1);
            } else if (grounded || b.life > BOLT_LIFE) {
                if (grounded && this.spray) {
                    for (let k = 0; k < 10; k++) {
                        const a = Math.random() * Math.PI * 2;
                        this.spray.emit(
                            b.x, b.y + 0.05, b.z,
                            Math.cos(a) * (1 + Math.random() * 2),
                            0.8 + Math.random() * 1.6,
                            Math.sin(a) * (1 + Math.random() * 2),
                            0.016 + Math.random() * 0.016,
                            0.2 + Math.random() * 0.25,
                            1, 1.6
                        );
                    }
                }
                bolts.splice(i, 1);
            }
        }
    }
}
