/**
 * Sound: a music player and a synthesiser, sharing one output.
 *
 * The two halves are deliberately different technologies, because they are
 * different problems.
 *
 * The music is *files* — real tracks, played Minecraft-style: one song, then
 * minutes of vacuum, then another, shuffled without repeats. The tracks live
 * in `public/music/` and are listed in `public/music/manifest.json`; the
 * player quietly drops anything that fails to load, so an empty folder simply
 * means silence rather than errors. See `public/music/README.md` for where to
 * get tracks that are genuinely free (CC0) and how to add one — the repo does
 * not ship audio it does not own.
 *
 * The effects are *synthesised*, right here, at trigger time. A surf hiss is
 * filtered noise keyed to speed; a footfall is seventy milliseconds of it; a
 * supernova is a sine dropping two octaves with a noise crack on top. No
 * files, no licences, a few hundred bytes of code per sound — and they can
 * never go missing, which for the sounds tied to game feel matters more than
 * fidelity.
 *
 * Everything obeys four settings — music/effects, each with an on-switch and
 * a volume — surfaced on the pause menu's sound tab and in the F1 overlay
 * alike. Volumes are squared on the way to the gain nodes, which is roughly
 * how loudness feels.
 *
 * Browsers refuse audio before a user gesture, so the whole system arms
 * itself on the first pointerdown or keydown and stays inert until then.
 */

import { S, onChange } from "./settings.js";
import { input } from "./input.js";
import { FALL } from "../spells/asteroid.js";

/** Seconds of vacuum between tracks, Minecraft-style: min + up to (max-min). */
const GAP_MIN = 70;
const GAP_MAX = 200;
/** Seconds before the first track after audio unlocks. */
const FIRST_AT = 6;

export function initAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
        // Inert stub, same shape. Nothing else needs to know.
        return {
            frame() {},
            get nowPlaying() { return null; },
            get trackCount() { return 0; },
        };
    }

    /** @type {AudioContext|null} */
    let ctx = null;
    let musicGain = null;
    let sfxGain = null;
    let noiseBuf = null;

    // ------------------------------------------------------------- music
    /** @type {{file:string,title:string,artist:string}[]} */
    let pool = [];
    let nowPlaying = null;
    let musicTimer = 0;

    fetch("/music/manifest.json")
        .then((r) => (r.ok ? r.json() : []))
        .then((list) => { if (Array.isArray(list)) pool = list.slice(); })
        .catch(() => {});

    function applyVolumes() {
        if (!ctx) return;
        const t = ctx.currentTime;
        musicGain.gain.setTargetAtTime(
            S.musicOn ? S.musicVolume * S.musicVolume : 0, t, 0.1
        );
        sfxGain.gain.setTargetAtTime(
            S.sfxOn ? S.sfxVolume * S.sfxVolume : 0, t, 0.05
        );
    }
    for (const k of ["musicOn", "musicVolume", "sfxOn", "sfxVolume"]) {
        onChange(k, applyVolumes);
    }

    function scheduleNext(delay) {
        clearTimeout(musicTimer);
        musicTimer = setTimeout(playNext, delay * 1000);
    }

    function playNext() {
        if (!ctx || pool.length === 0) return;
        if (!S.musicOn) {
            // Check back in — switching music on mid-gap should not have to
            // wait out a timer that was armed while it was off.
            scheduleNext(10);
            return;
        }
        const pick = pool[(Math.random() * pool.length) | 0];
        const el = new Audio("/music/" + pick.file);
        el.crossOrigin = "anonymous";
        el.addEventListener("error", () => {
            // Missing or unreadable: drop it from the rotation and move on.
            pool = pool.filter((p) => p !== pick);
            nowPlaying = null;
            scheduleNext(2);
        });
        el.addEventListener("ended", () => {
            nowPlaying = null;
            scheduleNext(GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN));
        });
        ctx.createMediaElementSource(el).connect(musicGain);
        el.play().then(() => { nowPlaying = pick; })
            .catch(() => scheduleNext(8));
    }

    // ---------------------------------------------------------- synthesis
    function noise(t) {
        const src = ctx.createBufferSource();
        src.buffer = noiseBuf;
        src.loop = true;
        src.start(t);
        return src;
    }

    /** gain → sfx bus, with a one-shot envelope baked in. */
    function env(t, peak, attack, decay) {
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0001), t + attack);
        g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
        g.connect(sfxGain);
        return g;
    }

    function filter(kind, freq, q) {
        const f = ctx.createBiquadFilter();
        f.type = kind;
        f.frequency.value = freq;
        if (q !== undefined) f.Q.value = q;
        return f;
    }

    // The surf bed: one looped noise source alive the whole session, shaped
    // every frame. Starting and stopping sources on the surf edge clicks;
    // riding a gain down to nothing does not.
    let surfSrc = null, surfLP = null, surfLevel = null;

    function buildSfxBed() {
        surfSrc = noise(ctx.currentTime);
        const hp = filter("highpass", 90);
        surfLP = filter("lowpass", 400, 0.4);
        surfLevel = ctx.createGain();
        surfLevel.gain.value = 0;
        surfSrc.connect(hp);
        hp.connect(surfLP);
        surfLP.connect(surfLevel);
        surfLevel.connect(sfxGain);
    }

    function footfall(t, speed01) {
        const src = noise(t);
        const lp = filter("lowpass", 380 + Math.random() * 180);
        const g = env(t, 0.10 + 0.14 * speed01, 0.012, 0.07);
        src.connect(lp); lp.connect(g);
        src.stop(t + 0.12);
    }

    // ---- the five powers ----------------------------------------------
    function sfxFlare(t) {
        const src = noise(t);
        const bp = filter("bandpass", 260, 1.4);
        bp.frequency.exponentialRampToValueAtTime(1900, t + 0.6);
        const g = env(t, 0.55, 0.10, 1.0);
        src.connect(bp); bp.connect(g);
        src.stop(t + 1.3);
    }

    let ionNodes = null;
    function ionSet(onNow) {
        if (onNow && !ionNodes) {
            const t = ctx.currentTime;
            const o1 = ctx.createOscillator(); o1.type = "sawtooth";
            const o2 = ctx.createOscillator(); o2.type = "sawtooth";
            o1.frequency.value = 96; o2.frequency.value = 97.6;
            const lp = filter("lowpass", 650, 6);
            const lfo = ctx.createOscillator(); lfo.frequency.value = 5.2;
            const lfoAmt = ctx.createGain(); lfoAmt.gain.value = 190;
            lfo.connect(lfoAmt); lfoAmt.connect(lp.frequency);
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, t);
            g.gain.exponentialRampToValueAtTime(0.17, t + 0.18);
            o1.connect(lp); o2.connect(lp); lp.connect(g); g.connect(sfxGain);
            o1.start(t); o2.start(t); lfo.start(t);
            ionNodes = { o1, o2, lfo, g };
        } else if (!onNow && ionNodes) {
            const t = ctx.currentTime;
            const n = ionNodes;
            ionNodes = null;
            n.g.gain.setTargetAtTime(0.0001, t, 0.09);
            n.o1.stop(t + 0.5); n.o2.stop(t + 0.5); n.lfo.stop(t + 0.5);
        }
    }

    function sfxNova(t) {
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.setValueAtTime(170, t);
        o.frequency.exponentialRampToValueAtTime(36, t + 0.5);
        const g = env(t, 1.0, 0.02, 1.5);
        o.connect(g);
        o.start(t); o.stop(t + 1.6);
        const crack = noise(t);
        const bp = filter("bandpass", 900, 0.8);
        const cg = env(t, 0.45, 0.008, 0.28);
        crack.connect(bp); bp.connect(cg);
        crack.stop(t + 0.35);
    }

    function sfxAsteroid(t) {
        // The rumble rides the whole fall and cuts out at contact; the impact
        // lands exactly when the rock does, because both read the same
        // exported constant the dispatcher leads the rider by.
        const rum = noise(t);
        const lp = filter("lowpass", 110);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.45, t + FALL);
        g.gain.exponentialRampToValueAtTime(0.0001, t + FALL + 0.12);
        rum.connect(lp); lp.connect(g); g.connect(sfxGain);
        rum.stop(t + FALL + 0.3);

        // The impact, in four layers — this is the loudest thing the game
        // does, and it earns it. The compressor on the bus is what lets the
        // stack run past unity and come out huge instead of shredded.
        //
        //   thud        the strike itself, a fast pitch drop
        //   sub         the ground answering, an octave under the thud and
        //               half a second longer, which is most of the "epic"
        //   crack       the broadband snap that marks the exact instant
        //   aftershock  a low rumble rolling away for two seconds, the sound
        //               of a very large thing having just happened somewhere
        const ti = t + FALL;
        const thud = ctx.createOscillator();
        thud.type = "sine";
        thud.frequency.setValueAtTime(90, ti);
        thud.frequency.exponentialRampToValueAtTime(32, ti + 0.7);
        const tg = env(ti, 1.25, 0.010, 1.1);
        thud.connect(tg);
        thud.start(ti); thud.stop(ti + 1.2);

        const sub = ctx.createOscillator();
        sub.type = "sine";
        sub.frequency.setValueAtTime(52, ti);
        sub.frequency.exponentialRampToValueAtTime(24, ti + 1.4);
        const sg = env(ti, 1.0, 0.03, 1.8);
        sub.connect(sg);
        sub.start(ti); sub.stop(ti + 1.9);

        const crack = noise(ti);
        const clp = filter("lowpass", 520);
        const cg = env(ti, 0.65, 0.008, 0.45);
        crack.connect(clp); clp.connect(cg);
        crack.stop(ti + 0.5);

        const shock = noise(ti + 0.12);
        const slp = filter("lowpass", 85);
        const shg = env(ti + 0.12, 0.5, 0.10, 2.1);
        shock.connect(slp); slp.connect(shg);
        shock.stop(ti + 2.4);
    }

    function sfxWell(t) {
        const o1 = ctx.createOscillator(); o1.type = "triangle";
        const o2 = ctx.createOscillator(); o2.type = "triangle";
        o1.frequency.value = 55; o2.frequency.value = 55.7;
        const lp = filter("lowpass", 300);
        const trem = ctx.createOscillator(); trem.frequency.value = 0.9;
        const tremAmt = ctx.createGain(); tremAmt.gain.value = 0.08;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.30, t + 0.7);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 4.2);
        trem.connect(tremAmt); tremAmt.connect(g.gain);
        o1.connect(lp); o2.connect(lp); lp.connect(g); g.connect(sfxGain);
        o1.start(t); o2.start(t); trem.start(t);
        o1.stop(t + 4.4); o2.stop(t + 4.4); trem.stop(t + 4.4);
    }

    function power(n) {
        const t = ctx.currentTime;
        if (n === 1) sfxFlare(t);
        else if (n === 3) sfxNova(t);
        else if (n === 4) sfxAsteroid(t);
        else if (n === 5) sfxWell(t);
        // 2 is held, handled by ionSet from the frame loop.
    }

    // ------------------------------------------------------------- arming
    function arm() {
        if (ctx) return;
        ctx = new AC();
        musicGain = ctx.createGain();
        sfxGain = ctx.createGain();
        musicGain.connect(ctx.destination);
        // The effects run through a compressor, and that is what buys "epic":
        // an asteroid impact is four sources stacked well past unity, and the
        // compressor turns that pile-up into loud-and-clean instead of the
        // crackle of a clipped master. Music skips it — tracks are mastered.
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.knee.value = 18;
        comp.ratio.value = 5;
        comp.attack.value = 0.004;
        comp.release.value = 0.22;
        sfxGain.connect(comp);
        comp.connect(ctx.destination);

        noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

        buildSfxBed();
        applyVolumes();
        scheduleNext(FIRST_AT);
    }
    window.addEventListener("pointerdown", arm, { once: true });
    window.addEventListener("keydown", arm, { once: true });

    // ------------------------------------------------------------- frame
    let stepAcc = 0;

    return {
        /**
         * Once per frame from the main loop.
         * @param {import("../character/controller.js").CharacterController} ch
         * @param {boolean} paused
         */
        frame(ch, paused) {
            if (!ctx) return;
            const t = ctx.currentTime;

            if (paused) {
                // The menu is up: the ride is frozen, so its sounds are too.
                // The music plays on — pause menus deserve a soundtrack.
                surfLevel.gain.setTargetAtTime(0, t, 0.15);
                ionSet(false);
                return;
            }

            // The surf bed follows the board: louder and brighter with speed,
            // gone within a fraction of a second of stepping off. It sits
            // well under the powers on purpose — it is weather, they are
            // events, and the first mix had the weather talking over them.
            const riding = ch.surf > 0.5 ? 1 : 0;
            const sp = ch.speed01;
            surfLevel.gain.setTargetAtTime(
                riding * (0.03 + 0.17 * sp), t, 0.12
            );
            surfLP.frequency.setTargetAtTime(
                380 + 2600 * sp * sp, t, 0.15
            );

            // Footfalls, walking only — the gait flag fires on the frame a
            // boot actually plants, which is what keeps this in sync with
            // the animation instead of on a timer beside it.
            if (ch.footfall && riding === 0) {
                // A light rate limit: crossing walk/run transitions can flag
                // twice in quick succession, and two thumps 30 ms apart read
                // as a glitch rather than a step.
                if (t - stepAcc > 0.13) {
                    stepAcc = t;
                    footfall(t, Math.min(1, ch.speed / 5.4));
                }
            }

            if (input.spellPressed) power(input.spellPressed);
            ionSet(input.spellHeld2);
        },
        get nowPlaying() { return nowPlaying; },
        /** How many tracks survived the manifest — 0 means none installed. */
        get trackCount() { return pool.length; },
    };
}
