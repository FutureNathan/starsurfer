/**
 * STARSURFER — entry point and frame orchestration.
 *
 * WebGPU only, by design. No WebGL path, no feature-detect branches: if the
 * adapter isn't there we say so once and stop.
 */

import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
// Side-effect import: installs `captureGPUFrameTime` / `getGPUFrameTimeCounter`
// onto the engine prototype, which is what makes the overlay's GPU row a real
// GPU number rather than the presentation cadence.
import "@babylonjs/core/Engines/AbstractEngine/abstractEngine.timeQuery";
import { Scene } from "@babylonjs/core/scene";
import { Vector3, Color3, Color4 } from "@babylonjs/core/Maths/math";

import { registerShaders } from "./shaders/registry.js";
import { S, onChange, applyPreset } from "./core/settings.js";
import {
    sample, checkSpike, stats, mark, installDrawCounter, endFrameDraws,
} from "./core/perf.js";
import { initInput, pollInput, endFrame, input } from "./core/input.js";
import { initTouch, wantsTouchControls } from "./core/touch.js";
import { initPauseMenu } from "./core/pauseMenu.js";
import { initAudio } from "./core/audio.js";
import { MOBILE_TIER } from "./core/device.js";
import { CameraRig } from "./core/camera.js";
import { CharacterController } from "./character/controller.js";
import { Character } from "./character/character.js";
import { DustContact } from "./character/dustContact.js";
import { SprayField } from "./vfx/particles.js";
import { SurfWake } from "./vfx/surfWake.js";
import { SpellSystem } from "./spells/spellSystem.js";
import { FlightWeapons } from "./spells/flightWeapons.js";
import { Overlay } from "./ui/overlay.js";
import { initMinimap } from "./ui/minimap.js";
import { Sky } from "./render/sky.js";
import { ShadowSystem } from "./render/shadows.js";
import { Terrain } from "./terrain/terrain.js";
import { DepthPass } from "./render/depthPass.js";
import { PostChain } from "./post/postChain.js";
import { whenReady } from "./core/gpuUtil.js";
import * as loading from "./core/loading.js";

// ------------------------------------------------------- module-scope scratch
const _vel = new Vector3();

async function boot() {
    const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById("view"));

    if (!navigator.gpu) {
        loading.fail("WebGPU is not available in this browser.");
        return;
    }

    // Before anything allocates. The preset's resolution scale and trail-buffer
    // size are read during construction, and `device.js` has already sized the
    // fixed render targets off the same tier.
    if (MOBILE_TIER) applyPreset("mobile");

    await loading.phase("waking the star drive", 0.05);

    const engine = new WebGPUEngine(canvas, {
        antialias: false, // TAA handles edges; MSAA here would just cost bandwidth
        stencil: false,
        powerPreference: "high-performance",
        enableAllFeatures: true,
        setMaximumLimits: true,
    });

    try {
        await engine.initAsync();
    } catch (err) {
        console.error(err);
        loading.fail("WebGPU device initialisation failed.");
        return;
    }

    // The heightfield is R32F and is filtered in the vertex shader, which needs
    // this feature. Every desktop GPU that can run this demo has it.
    const filterable = engine.getCaps().textureFloatLinearFiltering;
    if (!filterable) {
        console.warn("[starsurfer] float32-filterable unavailable; height will step");
    }

    const applyScale = () => engine.setHardwareScalingLevel(1 / S.resolutionScale);
    applyScale();
    onChange("resolutionScale", applyScale);
    window.addEventListener("resize", () => engine.resize());

    installDrawCounter(engine);
    // WebGPU timestamp queries — but only while somebody is looking at them.
    // Left running, the capture attaches a query set and a readback staging
    // buffer to every render pass of every frame (this scene runs ~15 passes),
    // to feed one overlay row that is hidden almost all of the time. Query
    // readbacks that outpace their completion are a classic way a WebGPU app
    // degrades over minutes and then falls over, so the capture now follows
    // the overlay's visibility — see `toggleOverlay` below.
    registerShaders();

    await loading.phase("charting the void", 0.12);

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);
    scene.autoClear = true;
    // Do NOT clear depth between rendering groups. Babylon clears depth before
    // every group by default; here group 1 is the opaque scene and group 2 is
    // the alpha-blended water and spray, which must depth-test against it.
    scene.setRenderingAutoClearDepthStencil(1, false);
    scene.setRenderingAutoClearDepthStencil(2, false);
    // No stock lights: every material here computes its own lighting.
    scene.ambientColor = new Color3(0, 0, 0);

    const rig = new CameraRig(scene, canvas);
    scene.activeCamera = rig.camera;

    // ------------------------------------------------------------------ sky
    await loading.phase("scattering the stars", 0.2);
    const sky = new Sky(scene);
    sky.mesh.renderingGroupId = 0;
    await sky.solve();

    // -------------------------------------------------------------- shadows
    const shadows = new ShadowSystem(scene);

    // The camera-space depth prepass. It is a custom render target, and the
    // scene renders those in registration order — so creating it here, after
    // the cascades and before anything that draws, is the whole of the
    // scheduling.
    const depthPass = new DepthPass(scene);

    // -------------------------------------------------------------- terrain
    await loading.phase("cratering the moon", 0.34);
    const terrain = new Terrain(scene, sky, shadows);
    terrain.mesh.renderingGroupId = 1;
    await terrain.build();
    onChange("showTerrain", (v) => (terrain.mesh.isVisible = v));
    depthPass.registerCaster(terrain.mesh, terrain.makePrepassMaterial());

    await loading.phase("suiting up", 0.62);

    const character = new CharacterController(terrain);
    character.position.set(0, 0, 0);
    character.position.y = terrain.heightAt(0, 0);

    // The figure: skeleton, garment simulation, shell fur.
    const figure = new Character(scene, terrain, sky, shadows, character);
    onChange("showCharacter", (v) => figure.setVisible(v));
    figure.registerPrepass(depthPass);

    // Airborne dust: footfall kick now, the surf plume and power ejecta later.
    const spray = new SprayField(scene, terrain, sky, shadows);

    // Feet and the surf groove write into the terrain state buffer through here.
    const contact = new DustContact(character, terrain.deform, figure.figure, spray);

    // The breaking wave, its bow crest and the plume it sheds.
    const wake = new SurfWake(scene, sky, shadows, character, spray, terrain);
    onChange("showWake", (v) => wake.setEnabled(v));
    wake.registerPrepass(depthPass);

    // The five spells, the water body they bend and the ice they leave. Every
    // one of them writes into the same terrain state buffer the feet and the
    // wake do, and lights the field through the same four-slot pool.
    const spells = new SpellSystem(
        scene, sky, shadows, terrain, character, figure.figure, rig, spray
    );
    // Every surface a spell can light.
    spells.addConsumers(
        terrain.material, figure.bodyMat, wake.material, spray.material
    );
    spells.registerPrepass(depthPass);

    // The flight weapons: laser and rocket, live only while the pack burns.
    // Built entirely from the pools above — no pipelines of their own.
    const weapons = new FlightWeapons(terrain, spray, spells.lights, character, rig);

    // The rig needs ground heights to keep the spring arm above the dust —
    // including the tube roofs, judged from the camera's own storey, so the
    // camera rides over a roof the rider is on instead of clipping into it.
    rig.groundAt = (x, z) =>
        terrain.surfaceAt(x, z, rig.camera.globalPosition.y);

    const post = new PostChain(scene, rig.camera, depthPass, sky);

    const overlay = new Overlay({ rig, character });
    // F1 keeps its direct route to the overlay while riding, but yields when
    // the pause menu is up — the menu's settings tab has adopted the same
    // element, and a second toggle would tug it out from under the panel.
    const toggleOverlay = () => {
        if (pauseMenu?.paused) return;
        overlay.toggle();
        engine.captureGPUFrameTime(overlay.visible);
    };
    initInput(canvas, { onToggleOverlay: toggleOverlay });
    // Sound: the music player and the effect synthesiser. Arms itself on the
    // first gesture, because browsers refuse audio before one.
    const audio = initAudio();
    // The pause menu, on every device: Escape opens it on a keyboard, the ⚙
    // button opens it on a touchscreen, and either way it pauses the loop
    // below, shows the controls and hosts the overlay on its settings tab.
    const pauseMenu = initPauseMenu(canvas, overlay, audio, wantsTouchControls());
    // The on-screen controls, when the primary pointer is a finger. Their ⚙
    // opens the menu; the overlay stays reachable through its settings tab.
    if (wantsTouchControls()) {
        initTouch(canvas, {
            input,
            onToggleOverlay: toggleOverlay,
            onMenu: () => pauseMenu.show(),
        });
    }

    // ------------------------------------------------------------- warm-up
    // Everything that can compile, compiles here — behind the loading screen.
    await loading.phase("waxing the board", 0.78);
    shadows.update(rig.camera, sky.sunDir);
    sky.render(rig, 0);
    await terrain.warmUp();
    terrain.update(rig.camera.position, character.position, 0);
    figure.update(0);
    figure.sync(rig.camera.position);
    await figure.warmUp();
    spray.update(0, rig.camera.position);
    await spray.warmUp();
    await wake.warmUp();
    await spells.warmUp(
        character.position.x + 3, character.position.y, character.position.z + 3
    );
    await whenReady(sky.material, "sky material", [sky.mesh, false]);
    await depthPass.warmUp();
    post.update(0, 0, rig.distance);
    const passes = post.passes;
    for (let i = 0; i < passes.length; i++) {
        await whenReady(passes[i], "post:" + passes[i].name);
    }

    await loading.phase("travelling the stars", 0.92);
    // A few real frames so every render target is allocated and every pipeline
    // has actually been bound at least once.
    for (let i = 0; i < 3; i++) {
        scene.render();
        await loading.nextFrame();
    }
    // Only now: the spell meshes had to be standing *through* those frames for
    // their render pipelines to exist. See `WaterBody.warmUp`.
    spells.finishWarmUp();

    // After warm-up, so the sun the relief is shaded under is the one the
    // scene settled on. Renders its whole chart here, once — see the module.
    const minimap = initMinimap(terrain, sky, character);

    // ------------------------------------------------------------- run loop
    let prev = performance.now();
    let time = 0;

    engine.runRenderLoop(() => {
        const now = performance.now();
        let dtMs = now - prev;
        prev = now;
        // Paused: keep the clock current so resume gets an honest dt, keep the
        // last rendered frame on the canvas, and spend nothing. The menu is
        // DOM, so it does not need the engine's help to draw itself. The
        // audio still gets its frame call — it ducks the ride's sounds and
        // lets the music play on, which is what a pause should sound like.
        if (pauseMenu?.paused) { audio.frame(character, true); return; }
        if (dtMs > 100) dtMs = 100;
        const dt = S.freezeTime ? 0 : dtMs / 1000;
        time += dt;

        pollInput();

        // Per-system CPU timing. Babylon's WebGPU timestamp queries are
        // whole-frame, so the GPU row is a total and these are not subdivisions
        // of it — the overlay labels them `cpu` for that reason.
        const tFrame = performance.now();

        character.update(dt, rig);
        // Before the audio, which reads the fired/boom flags this sets.
        weapons.update(dt);
        audio.frame(character, false);
        terrain.heightfield.clampToPlayArea(character.position);
        // Pose and simulate before the contact pass: the footprints are stamped
        // at the boot's actual planted position, which only exists once the
        // figure has been solved.
        figure.update(dt);
        contact.update(dt);
        const tChar = performance.now();

        _vel.copyFrom(character.velocity);
        rig.update(
            dt, character.position, _vel,
            character.lean, character.speed01, character.facing
        );

        // Jitters the projection and republishes everything the screen-space
        // passes derive from the camera. Must be after the rig has moved and
        // before anything reads `scene.getTransformMatrix()` — which the depth
        // prepass and the beauty pass both do.
        post.update(dt, character.streak01, rig.distance);
        sky.update();
        sky.render(rig, time);
        shadows.update(rig.camera, sky.sunDir);
        // After the shadow refit, so the water and the ice carry this frame's
        // cascade matrices; before the terrain, so the brushes every spell
        // writes are in the staging array when the simulation pass runs.
        spells.update(dt, rig.camera.position);
        const tSpells = performance.now();
        terrain.update(rig.camera.position, character.position, dt);
        const tTerrain = performance.now();
        // After the shadow refit, so the figure's uniforms carry this frame's
        // cascade matrices rather than last frame's.
        figure.sync(rig.camera.position);
        // Jetpack exhaust: a short blue-hot flame right off the pack, not a
        // contrail. The pack rides the back of a body whose attitude the
        // flight pitch sets, so the nozzle point and the thrust axis are
        // rebuilt from it here; the grains are charged shards — they glow —
        // fired a couple of metres a second down the thrust line and killed
        // in a fraction of a second by drag, which is what keeps the flame
        // a flame instead of a queue.
        if (character.jetting) {
            const jp = character.jetPitch || 0;
            const sj = Math.sin(jp), cj = Math.cos(jp);
            const jfx = Math.sin(character.facing), jfz = Math.cos(character.facing);
            const ux = jfx * sj, uy = cj, uz = jfz * sj;     // body up
            const bx = jfx * cj, by = -sj, bz = jfz * cj;    // body forward
            const px = character.position.x + ux * 0.78 - bx * 0.30;
            const py = character.position.y + uy * 0.78 - by * 0.30;
            const pz = character.position.z + uz * 0.78 - bz * 0.30;
            for (let i = 0; i < 4; i++) {
                const sp = 2.5 + Math.random() * 2;
                spray.emit(
                    px + (Math.random() - 0.5) * 0.10,
                    py + (Math.random() - 0.5) * 0.10,
                    pz + (Math.random() - 0.5) * 0.10,
                    -ux * sp + (Math.random() - 0.5) * 0.8,
                    -uy * sp,
                    -uz * sp + (Math.random() - 0.5) * 0.8,
                    0.020 + Math.random() * 0.022,
                    0.10 + Math.random() * 0.14,
                    1,
                    6.0
                );
            }
        }
        // Before the spray: the wake decides where its own lip is, and the
        // grains it sheds have to be in the pool before the pool is uploaded.
        wake.update(dt, rig.camera.position);
        spray.update(dt, rig.camera.position);
        const tVfx = performance.now();

        scene.render();
        post.endFrame();
        const tRender = performance.now();

        mark("cpu character", tChar - tFrame);
        mark("cpu spells", tSpells - tChar);
        mark("cpu terrain", tTerrain - tSpells);
        mark("cpu wake+spray", tVfx - tTerrain);
        mark("cpu submit", tRender - tVfx);
        mark("cpu total", tRender - tFrame);
        stats.gpuMs = engine.getGPUFrameTimeCounter().lastSecAverage / 1e6;

        endFrameDraws();
        stats.triangles =
            (terrain.mesh.metadata ? terrain.mesh.metadata.triangles : 0) +
            (S.showCharacter ? figure.triangles : 0) +
            (wake.mesh.isVisible ? wake.mesh.metadata.triangles : 0) +
            spells.triangles +
            spray.liveCount * 2;

        sample(dtMs);
        checkSpike(dtMs);
        overlay.update(dtMs, engine);
        minimap.frame();

        endFrame();
    });

    await loading.done();
    setTimeout(() => overlay.resetSpikes(), 800);

    globalThis.STARSURFER = {
        engine, scene, rig, character, figure, contact, spray, wake, spells,
        overlay, terrain, sky, shadows, post, depthPass,
        S, input, perfStats: stats,
    };
}

boot().catch((err) => {
    console.error(err);
    loading.fail("Startup failed — see console.");
});
