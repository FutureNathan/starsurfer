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
            get playlistNames() { return []; },
        };
    }

    /** @type {AudioContext|null} */
    let ctx = null;
    let musicGain = null;
    let sfxGain = null;
    let noiseBuf = null;

    // ------------------------------------------------------------- music
    /**
     * Named playlists, Minecraft-style: one is the default, the sound tab
     * switches between them, and `S.musicPlaylist` remembers the choice.
     * @type {Map<string, {file:string,title:string,artist:string}[]>}
     */
    const playlists = new Map();
    /** Files dropped for failing to load, so a bad file cannot loop forever. */
    const dead = new Set();
    let nowPlaying = null;
    let musicTimer = 0;
    /** @type {HTMLAudioElement|null} */
    let currentEl = null;

    fetch("/music/manifest.json")
        .then((r) => (r.ok ? r.json() : null))
        .then((m) => {
            if (Array.isArray(m)) {
                // The old flat shape, kept working: one anonymous playlist.
                playlists.set("Default", m.slice());
            } else if (m && Array.isArray(m.playlists)) {
                for (const p of m.playlists) {
                    if (p?.name && Array.isArray(p.tracks)) {
                        playlists.set(p.name, p.tracks.slice());
                    }
                }
            }
        })
        .catch(() => {});

    function currentPool() {
        const p = playlists.get(S.musicPlaylist);
        return p ? p.filter((tr) => !dead.has(tr.file)) : [];
    }

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
        if (!ctx) return;
        const pool = currentPool();
        if (pool.length === 0 || !S.musicOn) {
            // Check back in — an empty playlist may get its files uploaded,
            // and music switched on mid-gap should not have to wait out a
            // timer that was armed while it was off.
            scheduleNext(10);
            return;
        }
        const pick = pool[(Math.random() * pool.length) | 0];
        const el = new Audio("/music/" + pick.file);
        el.crossOrigin = "anonymous";
        el.addEventListener("error", () => {
            // Missing or unreadable: drop it from the rotation and move on.
            dead.add(pick.file);
            nowPlaying = null;
            scheduleNext(2);
        });
        el.addEventListener("ended", () => {
            nowPlaying = null;
            currentEl = null;
            scheduleNext(GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN));
        });
        ctx.createMediaElementSource(el).connect(musicGain);
        el.play().then(() => { nowPlaying = pick; currentEl = el; })
            .catch(() => scheduleNext(8));
    }

    // Changing playlist changes the sound *now* — stopping mid-track is what
    // tells the person the switch took, and the next song confirms it.
    onChange("musicPlaylist", () => {
        if (!ctx) return;
        if (currentEl) { currentEl.pause(); currentEl = null; }
        nowPlaying = null;
        scheduleNext(1.5);
    });

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

    /**
     * The Ion Stream, third design. Not a hum at all any more.
     *
     * The first version was a mosquito (sawtooths into a resonant sweep) and
     * the second was a hum that answered speed and altitude — accurate, and
     * exactly as pleasing as listening to a dial. What a *held* sound needs
     * is to be something a person would choose to keep holding: so this one
     * is a quiet piece of score. A low fifth breathes underneath — two soft
     * sines swelling and settling on a slow eight-second cycle, the Zimmer
     * pedal-tone trick — and above it a sparse motif walks the C-major
     * pentatonic on a glass tone, one soft note a second, stepwise with an
     * occasional skip, never twice the same. It sits in the same key the
     * bundled tracks lean on, so against music it reads as accompaniment
     * rather than interference.
     */
    let ionNodes = null;
    const ION_SCALE = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25];
    let ionNext = 0;
    let ionIdx = 2;

    function ionNote(t, f, vel) {
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.value = f;
        const o2 = ctx.createOscillator();
        o2.type = "sine";
        o2.frequency.value = f * 2;
        const og = ctx.createGain(); og.gain.value = 0.22;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(vel, t + 0.025);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 1.9);
        o.connect(g); o2.connect(og); og.connect(g);
        g.connect(sfxGain);
        o.start(t); o2.start(t);
        o.stop(t + 2.0); o2.stop(t + 2.0);
    }

    function ionSet(onNow) {
        if (onNow && !ionNodes) {
            const t = ctx.currentTime;
            const o1 = ctx.createOscillator(); o1.type = "sine";
            const o2 = ctx.createOscillator(); o2.type = "sine";
            o1.frequency.value = 65.41;           // C2
            o2.frequency.value = 98.0;            // G2
            const o2g = ctx.createGain(); o2g.gain.value = 0.5;
            const breathe = ctx.createOscillator();
            breathe.frequency.value = 1 / 8;
            const bAmt = ctx.createGain(); bAmt.gain.value = 0.045;
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, t);
            g.gain.exponentialRampToValueAtTime(0.14, t + 0.9);
            breathe.connect(bAmt); bAmt.connect(g.gain);
            o1.connect(g); o2.connect(o2g); o2g.connect(g);
            g.connect(sfxGain);
            o1.start(t); o2.start(t); breathe.start(t);
            ionNodes = { o1, o2, breathe, g };
            ionNext = t + 0.4;
            ionIdx = 2;
        } else if (!onNow && ionNodes) {
            const t = ctx.currentTime;
            const n = ionNodes;
            ionNodes = null;
            n.g.gain.setTargetAtTime(0.0001, t, 0.25);
            n.o1.stop(t + 1.2); n.o2.stop(t + 1.2); n.breathe.stop(t + 1.2);
        }
    }

    /** The motif scheduler, run once a frame while the stream is held. */
    function ionRide() {
        if (!ionNodes) return;
        const t = ctx.currentTime;
        if (t < ionNext) return;
        // A stepwise walk with the odd skip, reflected off the scale's ends.
        const step = Math.random() < 0.72
            ? (Math.random() < 0.5 ? -1 : 1)
            : (Math.random() < 0.5 ? -2 : 2);
        ionIdx = Math.max(0, Math.min(ION_SCALE.length - 1, ionIdx + step));
        ionNote(t, ION_SCALE[ionIdx], 0.09 + Math.random() * 0.05);
        // Mostly a calm pulse, with an occasional held breath — the rests are
        // what keep it a phrase instead of a sequencer.
        ionNext = t + (Math.random() < 0.2 ? 2.2 : 0.85 + Math.random() * 0.35);
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
        g.gain.exponentialRampToValueAtTime(0.62, t + FALL);
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
        const tg = env(ti, 1.7, 0.010, 1.1);
        thud.connect(tg);
        thud.start(ti); thud.stop(ti + 1.2);

        const sub = ctx.createOscillator();
        sub.type = "sine";
        sub.frequency.setValueAtTime(52, ti);
        sub.frequency.exponentialRampToValueAtTime(24, ti + 1.4);
        const sg = env(ti, 1.45, 0.03, 1.8);
        sub.connect(sg);
        sub.start(ti); sub.stop(ti + 1.9);

        const crack = noise(ti);
        const clp = filter("lowpass", 520);
        const cg = env(ti, 0.9, 0.008, 0.45);
        crack.connect(clp); clp.connect(cg);
        crack.stop(ti + 0.5);

        const shock = noise(ti + 0.12);
        const slp = filter("lowpass", 85);
        const shg = env(ti + 0.12, 0.75, 0.10, 2.1);
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
    let surfGainSent = -1;
    let surfFreqSent = -1;
    let airPrev = false;

    /**
     * Write an AudioParam without leaking its timeline.
     *
     * The naive loop wrote `setTargetAtTime` on the surf bed's gain and
     * filter every frame. Each of those events is open-ended and *stays in
     * the param's event list*, which the audio thread then walks every
     * render quantum — sixty new entries a second, forever. That list is
     * the "game gets slower and slower until unplayable" leak: nothing in
     * a heap profile, just an audio thread doing linearly more work every
     * minute played. So: prune the timeline first where the engine allows
     * it, and — the part that matters everywhere — only send at all when
     * the target has actually moved.
     */
    function send(param, v, t, tau) {
        if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
        param.setTargetAtTime(v, t, tau);
    }

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
                if (surfGainSent !== 0) {
                    surfGainSent = 0;
                    send(surfLevel.gain, 0, t, 0.15);
                }
                ionSet(false);
                return;
            }

            // The surf bed follows the board: louder and brighter with speed,
            // gone within a fraction of a second of stepping off. It sits
            // well under the powers on purpose — it is weather, they are
            // events, and the first mix had the weather talking over them.
            const riding = ch.surf > 0.5 ? 1 : 0;
            const sp = ch.speed01;
            const wantGain = riding * (0.03 + 0.17 * sp);
            if (Math.abs(wantGain - surfGainSent) > 0.004) {
                surfGainSent = wantGain;
                send(surfLevel.gain, wantGain, t, 0.12);
            }
            const wantFreq = 380 + 2600 * sp * sp;
            if (Math.abs(wantFreq - surfFreqSent) > 40) {
                surfFreqSent = wantFreq;
                send(surfLP.frequency, wantFreq, t, 0.15);
            }

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

            // The trick jump: a soft swoosh off the lip, a board slap on
            // touchdown scaled by how hard it came back.
            if (ch.airborne && !airPrev) {
                const src = noise(t);
                const bp = filter("bandpass", 620, 0.9);
                const g = env(t, 0.16, 0.05, 0.30);
                src.connect(bp); bp.connect(g);
                src.stop(t + 0.4);
            }
            airPrev = ch.airborne;
            if (ch.landed) {
                const hard = Math.min(1, (ch.landVy || 3) / 5);
                const src = noise(t);
                const lp = filter("lowpass", 300 + 380 * hard);
                const g = env(t, 0.30 + 0.25 * hard, 0.010, 0.28);
                src.connect(lp); lp.connect(g);
                src.stop(t + 0.35);
            }

            if (input.spellPressed) power(input.spellPressed);
            ionSet(input.spellHeld2);
            ionRide();
        },
        get nowPlaying() { return nowPlaying; },
        /** Tracks in the *selected* playlist — 0 means it is empty. */
        get trackCount() { return currentPool().length; },
        /** Playlist names, for the sound tab's picker. */
        get playlistNames() { return [...playlists.keys()]; },
    };
}
