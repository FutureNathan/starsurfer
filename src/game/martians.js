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

const COUNT = 8;
/** Martians keep inside this radius of the world centre, metres. */
const WANDER_R = 560;
/** Metres inside which a martian turns hunter. */
const HUNT_R = 14;
/** Metres inside which the bolt charges. */
const ATTACK_R = 9;
/** Seconds of crackle before the bolt lands. */
const BOLT_WINDUP = 0.75;
/** Metres of weapon auto-lock, from the player. */
const LOCK_R = 45;
/** Seconds a dead martian stays gone. */
const RESPAWN_T = 1.6;
/** Seconds of grace after a restart. */
const INVULN = 2.5;
const RUN_SPEED = 3.4;

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
        this._invuln = 0;
        this._t = 0;

        /** @type {{x:number,z:number,heading:number,bob:number,alive:boolean,
         *          respawn:number,windup:number,mesh:any}[]} */
        this.martians = [];
        for (let i = 0; i < COUNT; i++) {
            this.martians.push({
                x: 0, z: 0, heading: 0, bob: Math.random() * 7,
                alive: false, respawn: 0, windup: 0, mesh: null,
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
                    "fogDensity", "fogHeightFalloff", "fogStart", "aerialStrength",
                ],
                samplers: ["skyLUT"],
                shaderLanguage: ShaderLanguage.WGSL,
            });
        mat.backFaceCulling = true;
        proto.material = mat;
        this.material = mat;
        this._scene = scene;

        for (let i = 0; i < COUNT; i++) {
            const m = proto.clone("mz" + i);
            m.isVisible = false;
            m.isPickable = false;
            m.alwaysSelectAsActiveMesh = true;
            m.renderingGroupId = 1;
            m.material = mat;
            this.martians[i].mesh = m;
        }
        this._proto = proto;
    }

    /** Per-frame scalar uniforms off the live sky — mirrors the terrain's. */
    _pushUniforms() {
        const m = this.material;
        const sky = this.sky;
        if (!m || !sky || !this._scene) return;
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
        if (this._chip) this._chip.textContent = `☠ ${this.score}`;
    }

    _showDeath() {
        if (!this._panel) return;
        const q = qualifies(this.topScores(), this.score);
        this._panel.innerHTML = `
            <div class="mz-panel">
                <h1>⚡ SHOCKED</h1>
                <div>a martian put lightning through your suit</div>
                <div class="mz-score">☠ ${this.score}</div>
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
        this._invuln = INVULN;
        for (const m of this.martians) this._spawn(m);
        if (this._chip) {
            this._chip.style.display = "";
            this._chipText();
        }
        // The weapons lock on while the hunt is on.
        const w = this.weapons;
        if (w) {
            w.getLock = () => this._nearestLock();
            w.onHit = (lock) => { if (lock.ref) this._kill(lock.ref); };
            w.onBlast = (x, y, z, r) => this._blast(x, y, z, r);
        }
    }

    disable() {
        if (!this.active) return;
        this.active = false;
        this.dead = false;
        for (const m of this.martians) {
            m.alive = false;
            if (m.mesh) m.mesh.isVisible = false;
        }
        if (this._chip) this._chip.style.display = "none";
        if (this._panel) this._panel.style.display = "none";
        const w = this.weapons;
        if (w) { w.getLock = null; w.onHit = null; w.onBlast = null; }
    }

    restart() {
        this.dead = false;
        this.score = 0;
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

    _spawn(m) {
        const ch = this.ch;
        // An annulus around the player: near enough to matter, never on top.
        const a = Math.random() * Math.PI * 2;
        const d = 90 + Math.random() * 190;
        m.x = ch.position.x + Math.sin(a) * d;
        m.z = ch.position.z + Math.cos(a) * d;
        const r = Math.hypot(m.x, m.z);
        if (r > WANDER_R) {
            m.x *= WANDER_R / r;
            m.z *= WANDER_R / r;
        }
        m.heading = Math.random() * Math.PI * 2;
        m.alive = true;
        m.windup = 0;
        m.respawn = 0;
        if (m.mesh) m.mesh.isVisible = true;
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

    _kill(m) {
        if (!m.alive) return;
        m.alive = false;
        m.respawn = RESPAWN_T;
        m.windup = 0;
        if (m.mesh) m.mesh.isVisible = false;
        this.score += 1;
        this._chipText();
        this.ch.martianDown = true;
        const gy = this.terrain.heightAt(m.x, m.z);
        if (this.spray) {
            for (let i = 0; i < 40; i++) {
                const a = Math.random() * Math.PI * 2;
                this.spray.emit(
                    m.x, gy + 0.6 + Math.random() * 0.8, m.z,
                    Math.cos(a) * (1.5 + Math.random() * 4),
                    1 + Math.random() * 4,
                    Math.sin(a) * (1.5 + Math.random() * 4),
                    0.025 + Math.random() * 0.03,
                    0.4 + Math.random() * 0.6,
                    1, 1.4
                );
            }
        }
        this._pulse = { x: m.x, y: gy + 1, z: m.z, ttl: 0.4 };
    }

    _blast(x, y, z, r) {
        for (const m of this.martians) {
            if (!m.alive) continue;
            const gy = this.terrain.heightAt(m.x, m.z);
            if (Math.hypot(m.x - x, gy + 1 - y, m.z - z) < r) this._kill(m);
        }
    }

    _bolt(m) {
        const ch = this.ch;
        ch.boltShock = true;
        this.rig?.addTrauma?.(0.6);
        const gy = this.terrain.heightAt(m.x, m.z);
        if (this.spray) {
            // The bolt: a jagged run of hot grains from the martian's helmet
            // to the suit it just ended.
            const sx = m.x, sy = gy + 1.4, sz = m.z;
            const dx = ch.position.x - sx,
                  dy = ch.position.y + 1.0 - sy,
                  dz = ch.position.z - sz;
            for (let i = 0; i < 46; i++) {
                const u = Math.random();
                this.spray.emit(
                    sx + dx * u + (Math.random() - 0.5) * 0.5,
                    sy + dy * u + (Math.random() - 0.5) * 0.5,
                    sz + dz * u + (Math.random() - 0.5) * 0.5,
                    0, 0, 0,
                    0.03 + Math.random() * 0.02,
                    0.15 + Math.random() * 0.2,
                    1, 10
                );
            }
        }
        this._pulse = { x: m.x, y: gy + 1.4, z: m.z, ttl: 0.5 };
        m.windup = 0;
        this.dead = true;
        ch.velocity.x = 0;
        ch.velocity.z = 0;
        this._showDeath();
    }

    /** Once per frame from the main loop, before the audio reads the flags. */
    update(dt) {
        const ch = this.ch;
        ch.boltShock = false;
        ch.martianDown = false;
        if (!this.active) return;

        this._t += dt;
        this._invuln = Math.max(0, this._invuln - dt);
        this._pushUniforms();

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

            // Wander, or hunt when the prey is close.
            if (!this.dead && d3 < HUNT_R) {
                const want = Math.atan2(dx, dz);
                let delta = want - m.heading;
                while (delta > Math.PI) delta -= Math.PI * 2;
                while (delta < -Math.PI) delta += Math.PI * 2;
                m.heading += delta * Math.min(1, 6 * dt);
            } else {
                m.heading += (Math.random() - 0.5) * 1.7 * dt;
            }

            // Attack: stop, crackle, discharge.
            const attacking = !this.dead && this._invuln <= 0 && d3 < ATTACK_R;
            if (attacking) {
                m.windup += dt;
                if (this.spray && Math.random() < 0.6) {
                    this.spray.emit(
                        m.x + (Math.random() - 0.5) * 0.5,
                        gy + 1.3 + (Math.random() - 0.5) * 0.4,
                        m.z + (Math.random() - 0.5) * 0.5,
                        (Math.random() - 0.5) * 2, 1 + Math.random() * 2,
                        (Math.random() - 0.5) * 2,
                        0.02, 0.12 + Math.random() * 0.1, 1, 8
                    );
                }
                if (m.windup >= BOLT_WINDUP) this._bolt(m);
            } else {
                m.windup = Math.max(0, m.windup - dt * 2);
            }

            const speed = attacking ? 0.4 : RUN_SPEED;
            m.x += Math.sin(m.heading) * speed * dt;
            m.z += Math.cos(m.heading) * speed * dt;
            const r = Math.hypot(m.x, m.z);
            if (r > WANDER_R) {
                // Turn back toward the middle rather than clipping the fence.
                m.heading = Math.atan2(-m.x, -m.z) + (Math.random() - 0.5);
                m.x *= WANDER_R / r;
                m.z *= WANDER_R / r;
            }

            m.bob += dt * (speed > 1 ? 9 : 2);
            if (m.mesh) {
                m.mesh.position.set(
                    m.x,
                    this.terrain.heightAt(m.x, m.z)
                        + Math.abs(Math.sin(m.bob)) * 0.07,
                    m.z
                );
                m.mesh.rotation.y = m.heading;
                m.mesh.rotation.x = speed > 1 ? 0.14 : 0.02;
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
    }
}
