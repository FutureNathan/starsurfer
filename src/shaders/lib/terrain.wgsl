// -----------------------------------------------------------------------------
// starTerrain — the landform.
//
// Split into two halves that live in different places at runtime:
//
//   terrainMacro()  broad swells + medium drifts. Tens of metres down to about a
//                   metre. Baked once into a texture at load, because the CPU
//                   needs the same data for character grounding and reading back
//                   a bake is the only way to guarantee the two agree exactly.
//
//   terrainFine()   filaments and ripples, decimetre and below. Evaluated live
//                   in the vertex and fragment shaders with exact analytic
//                   derivatives — far too fine to bake at any sane texture
//                   resolution, and cheap enough not to bother.
//
// The two halves take opposite positions on anisotropy, and that split is what
// makes this read as a drifting cloud of grains rather than as a wind-carved
// snow field. The macro layer is near-isotropic: broad rolling swells with no
// prevailing grain, because nothing out here blows. The fine layer is stretched
// hard along the drift bearing, so metre-scale filaments stream across those
// swells the way gas does in a nebula. Put the anisotropy in the macro layer
// instead and you get transverse dune ridges, which is the strongest snow cue
// there is.
// -----------------------------------------------------------------------------

/// Build the combined rotate-and-anisotropically-scale matrix for a noise layer.
/// `sx` stretches along the wind, `sy` across it; `scale` is the wavelength.
/// A layer's derivative maps back to world space with `dHdq * M`.
fn windMat(angle: f32, sx: f32, sy: f32, scale: f32) -> mat2x2f {
    let c = cos(angle);
    let s = sin(angle);
    let r = mat2x2f(c, -s, s, c);
    let d = mat2x2f(sx / scale, 0.0, 0.0, sy / scale);
    return d * r;
}

// ------------------------------------------------------------------- macro

/// Broad + medium landform. Returns metres.
/// `w` is the wind bearing in radians, `amp` a global height multiplier.
fn terrainMacro(p: vec2f, w: f32, amp: f32) -> f32 {
    // --- broad swells ------------------------------------------------------
    // A dust sea is not a dune field, and the difference is almost entirely
    // anisotropy. Wind-blown snow is compressed hard along one bearing, which
    // is what puts the transverse ridge lines in it — and transverse ridge
    // lines are the single strongest "this is a snow field" cue there is. Here
    // the stretch factors run close to 1, so the form is near-isotropic: broad
    // rolling swells with no prevailing grain, the way a cloud of grains
    // settling under its own self-gravity would actually sit.
    //
    // Derivative damping stays. It keeps crests smooth and lets the fine
    // filament layer pool in the troughs, which is where the glow wells up.
    let m1 = windMat(w, 1.15, 1.0, 58.0);
    let broad = fbmDamped(m1 * p, 5, 2.03, 0.5, 0.9);
    var h = broad.x * 15.5;

    // A second, much larger and gentler swell so the field never reads as one
    // repeating wavelength. Long and tall, because this is what gives the horizon
    // its slow roll — and the horizon is a large part of the frame here, with no
    // atmosphere to hide it behind.
    let m0 = windMat(w, 1.1, 1.0, 340.0);
    let swell = fbmDamped(m0 * p, 3, 2.11, 0.55, 0.3);
    h += swell.x * 34.0;

    // --- medium drifts -----------------------------------------------------
    // The domain is still sheared by the broad height, which gives the swells
    // an asymmetry — one flank steeper than the other. It is the same trick
    // that produced dune lee faces; with the anisotropy gone it now reads as
    // the sea having a direction of travel rather than a wind.
    let m2 = windMat(w, 1.2, 1.0, 13.5);
    var q2 = m2 * p;
    q2.x += broad.x * 2.4;
    let med = fbmDamped(q2, 4, 2.07, 0.48, 1.7);

    // Loose grains pile up where the broad form is concave and get swept off
    // the exposed crests.
    let shelter = clamp(0.5 - broad.x * 0.75, 0.15, 1.0);
    h += med.x * 2.9 * shelter;

    return h * amp;
}

/// Analytic macro derivative. Only the bake uses this — at runtime the value is
/// read from the baked aux texture. Kept here so the two can be diffed.
fn terrainMacroD(p: vec2f, w: f32, amp: f32) -> vec2f {
    let e = 0.35;
    let hx = terrainMacro(p + vec2f(e, 0.0), w, amp) - terrainMacro(p - vec2f(e, 0.0), w, amp);
    let hz = terrainMacro(p + vec2f(0.0, e), w, amp) - terrainMacro(p - vec2f(0.0, e), w, amp);
    return vec2f(hx, hz) / (2.0 * e);
}

// -------------------------------------------------------------------- rocks

/// Sparse exposed rock. Jittered grid, one outcrop per cell, most of them
/// culled so the field stays "just dust and the player".
/// Returns vec2f(height contribution, rock mask 0..1).
fn rockField(p: vec2f, w: f32) -> vec2f {
    let cell = 165.0;
    let gi = floor(p / cell);

    var hSum = 0.0;
    var mask = 0.0;

    // 3x3 neighbourhood so blobs straddle cell borders cleanly.
    for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
            let id = gi + vec2f(f32(dx), f32(dy));
            let r = hash22(id);
            let r2 = hash22(id + 71.3);

            // Cull most cells: outcrops are meant to be sparse.
            if (r2.x > 0.34) { continue; }

            let centre = (id + 0.15 + r * 0.7) * cell;
            let radius = 7.0 + r2.y * 11.0;
            let d = length(p - centre);
            if (d > radius * 1.6) { continue; }

            // Smooth dome, then broken up by ridged noise so it reads as rock
            // rather than as a lump. The noise rides the dome so it never
            // detaches from the silhouette.
            let t = clamp(1.0 - d / radius, 0.0, 1.0);
            let dome = t * t * (3.0 - 2.0 * t);
            let mr = windMat(w, 1.0, 1.0, 5.5);
            let rough = ridgedd(mr * (p - centre), 3, 2.17, 0.55).x;
            let hgt = (3.5 + r2.y * 6.0);

            hSum += dome * hgt * (0.62 + 0.55 * rough);
            mask = max(mask, dome * dome);
        }
    }
    return vec2f(hSum, mask);
}

// --------------------------------------------------------------------- fine

/// Local departure of the drift from its prevailing bearing, in radians, and the
/// local anisotropy of the filaments.
///
/// One global bearing gives every filament in the field the same direction and
/// the same aspect ratio, and the result reads as corduroy — a woven texture
/// laid over the landform rather than a medium that has been flowing. Real
/// nebula filaments do not do that: the flow veers as it crosses a swell, so the
/// field breaks into patches that run at slightly different angles and are
/// streakier in some places than others. Two slow noise fields, at ~120 m and
/// ~80 m, are enough to destroy the uniformity completely while leaving the
/// prevailing direction obvious.
///
/// The stretch base is high, and deliberately so. The macro layer holds almost
/// no anisotropy, so all of it lands here: long drawn-out threads streaming
/// across broad isotropic swells, which is what a nebula does and a snow field
/// never does.
///
/// Both fine layers below read this, and so does the *filtered* twin further
/// down, which must produce the same surface — one is the vertex displacement and
/// the other is the fragment normal.
///
/// The layer derivatives ignore the chain-rule term from the veer varying with
/// position. The veer field's wavelength is fifty times the sastrugi's, so that
/// term is a couple of percent of a normal — well under what the detail maps
/// perturb it by anyway.
fn windLocal(p: vec2f) -> vec2f {
    let veer = noise2(p * 0.0083 + vec2f(31.7, 12.3)) * 0.42;
    let stretch = 4.0 + 2.4 * (noise2(p * 0.0126 + vec2f(7.1, 41.9)) * 0.5 + 0.5);
    return vec2f(veer, stretch);
}

/// Sastrugi + ripples. Returns vec3f(height in metres, dH/dx, dH/dz).
///
/// `exposure` (0..1) comes from the baked curvature channel: wind scours crests
/// into hard sastrugi and leaves hollows smooth, so the two fine layers are
/// cross-faded by it rather than applied uniformly.
fn terrainFine(p: vec2f, w: f32, exposure: f32, amp: f32) -> vec3f {
    var h = 0.0;
    var d = vec2f(0.0);

    let wl = windLocal(p);

    // --- sastrugi ----------------------------------------------------------
    // Compressed *across* the wind, so the ridges streak along it. Ridged noise
    // gives the hard scalloped crest and soft trough that sastrugi actually has.
    let m3 = windMat(w + wl.x, 1.0, wl.y, 2.3);
    let sas = ridgedd(m3 * p, 3, 2.11, 0.52);
    let scour = 0.45 + 0.55 * smoothstep(-0.25, 0.35, noise2(p * 0.021));
    let sasAmp = 0.125 * amp * mix(0.45, 1.0, exposure) * scour;
    h += (sas.x - 0.35) * sasAmp;
    d += (sas.yz * m3) * sasAmp;

    // --- wind ripples ------------------------------------------------------
    // Fine transverse corrugation, strongest in the sheltered flats where
    // sastrugi is weak. Half a wavelength of asymmetry via a soft abs.
    //
    // Veered by half of what the sastrugi is: ripples form in the boundary layer
    // and follow the local flow more closely than the metre-scale forms do, but
    // giving them the same veer makes the two layers move together and the field
    // goes back to reading as one woven sheet.
    let m4 = windMat(w + wl.x * 0.5, 2.9, 1.0, 0.42);
    let rip = noised(m4 * p);
    let ripAmp = 0.024 * amp * mix(1.0, 0.45, exposure);
    h += rip.x * ripAmp;
    d += (rip.yz * m4) * ripAmp;

    // --- grain -------------------------------------------------------------
    // Sub-centimetre. Too small to displace geometry usefully, but it keeps the
    // normal field alive right under the camera.
    let m5 = windMat(w, 1.0, 1.0, 0.115);
    let gr = noised(m5 * p);
    let grAmp = 0.0075 * amp;
    h += gr.x * grAmp;
    d += (gr.yz * m5) * grAmp;

    return vec3f(h, d);
}

/// Footprint-filtered fine layer, for the fragment shader.
///
/// Each layer fades out once its wavelength drops near the size of a pixel.
/// Without this the sastrugi turns into a crawling moiré carpet across the
/// mid-distance the moment the camera moves — and unlike geometry aliasing, TAA
/// cannot rescue normal-map aliasing, because the signal is already wrong before
/// it is sampled. Fading is not a quality compromise here; it *is* the filter.
///
/// `fp` is the world-space size of one pixel, from fwidth() on world position.
fn terrainFineFiltered(p: vec2f, w: f32, exposure: f32, amp: f32, fp: f32) -> vec3f {
    var h = 0.0;
    var d = vec2f(0.0);

    // Sastrugi: wavelength ~2.3 m. Real sastrugi stands 10-30 cm proud with a
    // hard scalloped crest — it is a landform in its own right, not a texture,
    // and underscaling it is what leaves a dust sea looking like poured icing.
    // Same local veer and anisotropy the vertex stage used. See `windLocal`.
    let wl = windLocal(p);

    let fadeS = 1.0 - smoothstep(0.35, 1.6, fp);
    if (fadeS > 0.001) {
        let m3 = windMat(w + wl.x, 1.0, wl.y, 2.3);
        let sas = ridgedd(m3 * p, 3, 2.11, 0.52);
        // Modulated by a slow field so the field has scoured patches and smooth
        // patches rather than one uniform corduroy everywhere — which is what
        // makes it read as woven fabric instead of as settled grains.
        // `scour`, not `patch` — the latter is a reserved keyword in WGSL.
        let scour = 0.45 + 0.55 * smoothstep(-0.25, 0.35, noise2(p * 0.021));
        let a = 0.125 * amp * mix(0.45, 1.0, exposure) * scour * fadeS;
        h += (sas.x - 0.35) * a;
        d += (sas.yz * m3) * a;
    }

    // Ripples: wavelength ~0.42 m.
    let fadeR = 1.0 - smoothstep(0.06, 0.3, fp);
    if (fadeR > 0.001) {
        let m4 = windMat(w + wl.x * 0.5, 2.9, 1.0, 0.42);
        let rip = noised(m4 * p);
        let a = 0.024 * amp * mix(1.0, 0.45, exposure) * fadeR;
        h += rip.x * a;
        d += (rip.yz * m4) * a;
    }

    // Grain: wavelength ~0.115 m.
    let fadeG = 1.0 - smoothstep(0.016, 0.08, fp);
    if (fadeG > 0.001) {
        let m5 = windMat(w, 1.0, 1.0, 0.115);
        let gr = noised(m5 * p);
        let a = 0.0075 * amp * fadeG;
        h += gr.x * a;
        d += (gr.yz * m5) * a;
    }

    return vec3f(h, d);
}
