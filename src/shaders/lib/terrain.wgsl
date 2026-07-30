// -----------------------------------------------------------------------------
// starTerrain — the landform.
//
// Split into two halves that live in different places at runtime:
//
//   terrainMacro()  swells, massifs and the crater field. Hundreds of metres
//                   down to about a metre. Baked once into a texture at load,
//                   because the CPU needs the same data for character grounding
//                   and reading back a bake is the only way to guarantee the two
//                   agree exactly.
//
//   terrainFine()   rubble, pitting and grain, decimetre and below. Evaluated
//                   live in the vertex and fragment shaders with exact analytic
//                   derivatives — far too fine to bake at any sane texture
//                   resolution, and cheap enough not to bother.
//
// Both halves are near-isotropic, and that is the whole shape of this surface.
//
// Anisotropy is a wind signature. Stretch a noise layer along one bearing and you
// get transverse ridges, which is what a snow field or a dune sea looks like
// because a snow field or a dune sea has been blown into that shape. There is no
// atmosphere here and so there is no bearing: what carved this ground is impact,
// which arrives from every direction equally and leaves circles.
//
// So the landform is broad isotropic swells and highland massifs with a crater
// field cut into them at three scales, and the fine layer is knobbly rather than
// streaked — the metre-scale rubble and secondary pitting that covers every
// square metre of a regolith surface.
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

// ----------------------------------------------------------------- craters

/// One octave of impact craters, on a jittered grid.
///
/// The profile is the one a simple bowl crater actually has, and each piece of it
/// is doing a job:
///
///   floor   flat out to just over half the radius, then climbing. A parabola all
///           the way to the centre gives a cone, and a field of cones reads as a
///           displacement map rather than as ground.
///   rim     a raised ring standing on the radius itself. This is most of what
///           makes a crater legible at a distance: the shadow it throws inside
///           itself and the highlight on its far lip are a far stronger read than
///           the depression, especially with the star at thirteen degrees.
///   ejecta  the outer half of the rim's gaussian, thinning away. Cut it off at
///           the rim and every crater has a hard edge; let it run and the ground
///           between craters is gently disturbed the way it should be.
///
/// `keep` is the fraction of cells that hold one, `depthRatio` the depth as a
/// fraction of the radius (real bowl craters run about a fifth of their
/// *diameter*, so a sixth of the radius is close and a little gentler to ride),
/// and `rimRatio` the rim height as a fraction of the depth.
///
/// Radii are biased small by squaring the hash: the size-frequency distribution
/// on a real surface is steeply weighted toward the small end, and a uniform draw
/// gives a field of same-size holes that reads as a pattern.
fn craterOctave(
    p: vec2f, cell: f32, keep: f32, r0: f32, r1: f32,
    depthRatio: f32, rimRatio: f32, seed: f32
) -> f32 {
    let gi = floor(p / cell);
    var h = 0.0;

    // 3x3, so a crater whose centre sits in a neighbouring cell still reaches in.
    for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
            let id = gi + vec2f(f32(dx), f32(dy));
            let r = hash22(id + seed);
            let r2 = hash22(id + seed + 19.7);
            if (r2.x > keep) { continue; }

            let radius = mix(r0, r1, r2.y * r2.y);
            let centre = (id + 0.12 + r * 0.76) * cell;
            let dp = p - centre;
            let d2 = dot(dp, dp);
            // The rim gaussian is under a percent of its peak by 1.7 radii.
            let reach = radius * 1.7;
            if (d2 > reach * reach) { continue; }

            let t = sqrt(d2) / radius;
            let bowl = smoothstep(0.52, 1.0, t) - 1.0;
            let e = (t - 1.0) * 3.0;
            h += radius * depthRatio * (bowl + exp(-e * e) * rimRatio);
        }
    }
    return h;
}

/// The crater field: basins, craters and bowls.
///
/// Three octaves rather than one, because a cratered surface is self-similar over
/// orders of magnitude and one scale reads immediately as a texture. Between them
/// they cover a little over half the ground, which — with the rims and the ejecta
/// on top — is what a mature regolith surface looks like: nothing is flat, and
/// almost nothing is a clean circle, because every crater is sitting in the
/// wreckage of older ones.
///
/// The cost is twenty-seven cells tested per sample, and it is paid entirely at
/// load: this runs in the height bake and nowhere else, and the runtime reads the
/// result out of a texture.
fn craterField(p: vec2f) -> f32 {
    var h = 0.0;
    h += craterOctave(p, 340.0, 0.92, 60.0, 165.0, 0.135, 0.30, 0.0);
    h += craterOctave(p,  96.0, 0.95, 14.0,  46.0, 0.165, 0.34, 37.3);
    h += craterOctave(p,  27.0, 0.92,  3.6,  11.0, 0.190, 0.38, 91.1);
    // The fourth octave arrived with the reference photographs: on the real
    // surface the craters *are* the texture, down to every scale the eye can
    // resolve, and stopping at 3.6 m left the ground between bowls reading
    // as fabric. Metre-and-a-half dimples, shallow enough that the board
    // (which reads its grade over a 5.2 m base) never feels them.
    h += craterOctave(p,  11.0, 0.75,  1.5,   4.2, 0.150, 0.40, 53.7);
    return h;
}

/// Distance from `p` to the segment [a, b].
fn distSeg(p: vec2f, a: vec2f, b: vec2f) -> f32 {
    let ab = b - a;
    let t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
    return length(p - (a + ab * t));
}

/// The seed's landmark, grown from one ring into a *place*:
///
///   the ring     a complex crater — standing wall, sunken floor, central
///                peak — the profile every large lunar crater shares.
///   the second   a smaller crater driven in at an angle, its rim
///                interpenetrating the first's: two impacts, one late.
///   the canyon   the shared wall between them, breached: a channel cut
///                floor-to-floor, which the arch mesh spans overhead.
///   the rille    a collapsed lava tube winding out the ring's far side —
///                a sinuous channel with raised levees, the real landform
///                (Hadley Rille is one) that a drained lava river leaves.
///   the dome     a shield swelling over the rille's middle reach: the
///                mountain the tube runs under. The roof meshes sit over
///                the channel where it crosses the dome, so the tube is
///                intact there and open to the sky between — skylights,
///                which is exactly how real collapsed tubes breathe.
///
/// Everything here is closed-form from the seed, and `src/terrain/landmark.js`
/// MIRRORS these formulas to place the arch and roof meshes — the two files
/// must agree constant for constant, and each says so.
///
/// Placed in *unoffset* world space, so every map has all of it within an
/// easy ride. Every other feature on this ground repeats statistically; this
/// complex is singular per world, and that is its whole job.
fn landmark(p: vec2f, seed: f32) -> f32 {
    let ang = seed * 2.399963;
    let bigR = 120.0 + fract(seed * 0.7710) * 80.0;
    // Distance capped by the crater's own size so the far rim never pokes
    // past the 620 m play fence: dist + bigR <= 595, levee tail included.
    // The whole complex has to be *surfable*, not scenery past the wall.
    let dist = 340.0 + fract(seed * 0.3170) * (255.0 - bigR);
    let c1 = vec2f(sin(ang), cos(ang)) * dist;

    // Everything below lives within this reach of the main ring; the rille
    // runs the furthest, so the early-out is generous.
    if (length(p - c1) > bigR * 2.2 + 340.0) { return 0.0; }

    // ---- the companion crater, driven in at an angle -----------------------
    let phi2 = ang + 2.1 + fract(seed * 0.5310) * 1.1;
    let dir2 = vec2f(sin(phi2), cos(phi2));
    let r2 = bigR * 0.45;
    let c2 = c1 + dir2 * (bigR + r2 * 0.55);

    // ---- the canyon between the two floors ---------------------------------
    // From well inside the first ring to well inside the second, so the cut
    // opens both walls rather than stopping politely at either.
    let ca = c1 + dir2 * (bigR * 0.55);
    let cb = c2 - dir2 * (r2 * 0.40);
    let dCan = distSeg(p, ca, cb);
    // Softened from (9,3.5) / 0.94 / (14,5): the first cut made a slot
    // gorge — near-vertical twenty-metre walls — where a breach should read
    // as a pass. Wider aprons, a fifth of the wall kept, a shallower floor.
    let canyon = smoothstep(14.0, 4.0, dCan);
    let wallMask = 1.0 - 0.78 * smoothstep(22.0, 6.0, dCan);

    // ---- the rille ---------------------------------------------------------
    // A sinuous path out the ring's far side, sampled as a polyline. Ten
    // segments approximates the sine bend to well under a metre, and this
    // whole function runs in the height bake only — never per frame.
    // Aimed *inward* — toward spawn, offset to the side the companion crater
    // does not occupy. The first cut of this bearing hung off the small
    // crater's back and ran outward, which put the dome and every tube reach
    // beyond the play fence on essentially every seed: verified unreachable
    // on the CPU mirror, then re-aimed here. Inward, the rille ends 350+ m
    // from spawn at its closest and the tubes are always in bounds.
    let phi3 = ang + 3.14159 + 0.95 + fract(seed * 0.2130) * 0.35;
    let dir3 = vec2f(sin(phi3), cos(phi3));
    let perp3 = vec2f(dir3.y, -dir3.x);
    var dRil = 1e9;
    var prev = c1 + dir3 * (bigR * 0.62);
    for (var i = 1; i <= 10; i++) {
        let t = f32(i) / 10.0;
        let along = bigR * 0.62 + t * 260.0;
        let sway = sin(t * 3.6 + seed * 0.71) * 30.0 * t;
        let pt = c1 + dir3 * along + perp3 * sway;
        dRil = min(dRil, distSeg(p, prev, pt));
        prev = pt;
    }
    let rille = smoothstep(8.5, 3.2, dRil);
    // Levees: the banks a lava river builds beside itself.
    let lev = (dRil - 10.0) / 4.5;
    let levee = exp(-lev * lev) * 2.2;

    // ---- the dome the tube runs under --------------------------------------
    // Over the rille's middle reach. Its height is carried on (1 - rille), so
    // the channel keeps its floor *through* the dome — that pinch of high
    // ground either side of a sunken channel is the tunnel the roofs close.
    let domeC = c1 + dir3 * (bigR * 0.62 + 130.0)
              + perp3 * (sin(0.5 * 3.6 + seed * 0.71) * 15.0);
    let dDome = length(p - domeC);
    let dome = exp(-(dDome * dDome) / (78.0 * 78.0)) * 54.0
             * (0.88 + 0.24 * noise2(p * 0.02 + seed * 1.3));

    // ---- assemble ----------------------------------------------------------
    var h = 0.0;

    // Main ring.
    let d1 = length(p - c1);
    let w1 = bigR * 0.16;
    let g1 = (d1 - bigR) / w1;
    let broken1 = 0.80 + 0.35 * noise2(p * 0.02 + seed);
    h += exp(-g1 * g1) * bigR * 0.14 * broken1 * wallMask;
    let sunk1 = smoothstep(bigR * 0.92, bigR * 0.55, d1);
    h -= sunk1 * bigR * 0.055;
    let pk1 = d1 / (bigR * 0.16);
    h += exp(-pk1 * pk1) * bigR * 0.075;

    // Companion ring: same construction, no peak of its own — small, fresh
    // craters are bowls.
    let d2 = length(p - c2);
    let w2 = r2 * 0.20;
    let g2 = (d2 - r2) / w2;
    let broken2 = 0.80 + 0.35 * noise2(p * 0.023 + seed * 2.7);
    h += exp(-g2 * g2) * r2 * 0.17 * broken2 * wallMask;
    h -= smoothstep(r2 * 0.95, r2 * 0.45, d2) * r2 * 0.075;

    // Canyon: on top of the wall suppression, a real cut down toward the
    // floors, so the pass reads carved rather than merely unbuilt.
    h -= canyon * 4.5;

    // Dome and rille: the dome rises, the channel refuses it, the levees
    // ride its flanks, and the trench itself steps down nine metres.
    h += dome * (1.0 - 0.92 * rille);
    h += levee * (1.0 - rille);
    h -= rille * 9.0;

    return h;
}

// ------------------------------------------------------------------- macro

/// Broad + medium landform. Returns metres.
/// `w` is the wind bearing in radians, `amp` a global height multiplier.
fn terrainMacro(p: vec2f, w: f32, amp: f32) -> f32 {
    // --- broad relief ------------------------------------------------------
    // The stretch factors run close to 1, so the form is near-isotropic. There
    // is no wind here to give the ground a bearing, and the moment one of these
    // gets a real stretch the field grows transverse ridges and reads as a dune
    // sea — which is the same failure whether the material is sand or snow.
    //
    // Derivative damping stays. It keeps the crests smooth and lets the fine
    // rubble layer collect in the low ground, which is where it collects.
    let m1 = windMat(w, 1.15, 1.0, 58.0);
    let broad = fbmDamped(m1 * p, 5, 2.03, 0.5, 0.9);
    var h = broad.x * 21.0;

    // The long swell under everything else, so the field never reads as one
    // repeating wavelength. Tall, because this is what gives the horizon its
    // slow roll, and the horizon is a large part of the frame with no atmosphere
    // to hide it behind — and taller than it was, because the ground the user is
    // riding is meant to have real relief in it rather than being a plain.
    let m0 = windMat(w, 1.1, 1.0, 340.0);
    let swell = fbmDamped(m0 * p, 3, 2.11, 0.55, 0.3);
    h += swell.x * 52.0;

    // --- the crater field --------------------------------------------------
    // Cut in before the medium layer, so the loose material that follows settles
    // *into* the craters rather than being modulated by them.
    h += craterField(p);

    // --- medium relief -----------------------------------------------------
    // The domain is sheared by the broad height, which gives the swells an
    // asymmetry — one flank steeper than the other. Slumped material, and the
    // reason the ground never looks like a noise function evaluated on a plane.
    let m2 = windMat(w, 1.2, 1.0, 13.5);
    var q2 = m2 * p;
    q2.x += broad.x * 2.4;
    let med = fbmDamped(q2, 4, 2.07, 0.48, 1.7);

    // Loose regolith is deep in the hollows and thin over the high ground, where
    // it has had four billion years to creep downhill.
    let shelter = clamp(0.5 - broad.x * 0.75, 0.15, 1.0);
    h += med.x * 3.4 * shelter;

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

/// Highland massifs — the mountains.
///
/// Jittered grid, one massif per cell, most of them culled so they stay landmarks
/// rather than a mountain range. These used to be seven-metre boulders scattered
/// through the field; they are now up to a hundred metres of exposed bedrock,
/// which is what actually stands above a regolith plain. Crater rims give the
/// ground its texture and these give it its skyline.
///
/// Returns vec2f(height contribution, bedrock mask 0..1). The mask drives the
/// material: regolith settles on the shallow faces and the steep ones show the
/// rock underneath, which the fragment shader resolves by slope.
fn rockField(p: vec2f, w: f32) -> vec2f {
    let cell = 380.0;
    let gi = floor(p / cell);

    var hSum = 0.0;
    var mask = 0.0;

    // 3x3 neighbourhood so blobs straddle cell borders cleanly.
    for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
            let id = gi + vec2f(f32(dx), f32(dy));
            let r = hash22(id);
            let r2 = hash22(id + 71.3);

            // Cull most cells: massifs are meant to be sparse.
            if (r2.x > 0.30) { continue; }

            let centre = (id + 0.15 + r * 0.7) * cell;
            let radius = 46.0 + r2.y * 118.0;
            let d = length(p - centre);
            if (d > radius * 1.6) { continue; }

            // Smooth dome, then broken up by ridged noise so it reads as rock
            // rather than as a lump. The noise rides the dome so it never
            // detaches from the silhouette.
            let t = clamp(1.0 - d / radius, 0.0, 1.0);
            let dome = t * t * (3.0 - 2.0 * t);
            // Ridged noise at a wavelength that scales with the massif, so a
            // small one is not a large one with the same-size boulders on it —
            // floored, and the floor is a contract with the character.
            //
            // Grounding reads a half-resolution CPU mirror of the bake through a
            // smoothing B-spline; the render reads the full bake. On smooth
            // ground the two agree to centimetres, but at four octaves the
            // finest ridge here had metres of amplitude at a 1.4 m wavelength —
            // content the mirror cannot represent at all — and the drawn summit
            // stood half a metre above the surface the feet were planted on.
            // The astronaut waded through every peak. With the finest octave
            // held near 11 m both reconstructions carry it, and the residual
            // mismatch is back under the dust-sink the figure already has.
            let mr = windMat(w, 1.0, 1.0, max(radius * 0.30, 44.0));
            let rough = ridgedd(mr * (p - centre), 3, 1.95, 0.55).x;
            let hgt = 26.0 + r2.y * 74.0;

            hSum += dome * hgt * (0.62 + 0.55 * rough);
            mask = max(mask, dome * dome);
        }
    }
    return vec2f(hSum, mask);
}

// --------------------------------------------------------------------- fine

/// Local rotation of the fine layer, in radians, and its local aspect ratio.
///
/// A single global orientation applied to every fine feature in the field reads
/// as corduroy — a woven texture laid over the landform — and two slow noise
/// fields, at ~120 m and ~80 m, are enough to destroy that uniformity while
/// costing two hash lookups.
///
/// The stretch used to run from 4.0 to 6.4, drawing the fine layer into long
/// streaming threads. That was a nebula's flow, and this ground is not flowing:
/// it is rubble and secondary pitting, thrown radially by impacts and then
/// stirred for four billion years, and it has no long axis anywhere. So the
/// stretch now sits close to 1 and the "veer" is doing the only job left to it,
/// which is stopping the ridged noise's own grid from showing.
///
/// Both fine layers below read this, and so does the *filtered* twin further
/// down, which must produce the same surface — one is the vertex displacement and
/// the other is the fragment normal.
///
/// The layer derivatives ignore the chain-rule term from the rotation varying
/// with position. The rotation field's wavelength is fifty times the rubble's, so
/// that term is a couple of percent of a normal — well under what the detail maps
/// perturb it by anyway.
fn windLocal(p: vec2f) -> vec2f {
    let veer = noise2(p * 0.0083 + vec2f(31.7, 12.3)) * 0.85;
    let stretch = 1.0 + 0.45 * (noise2(p * 0.0126 + vec2f(7.1, 41.9)) * 0.5 + 0.5);
    return vec2f(veer, stretch);
}

/// Rubble, pitting and grain. Returns vec3f(height in metres, dH/dx, dH/dz).
///
/// `exposure` (0..1) comes from the baked curvature channel. High ground has had
/// its loose material creep off it and shows more of the broken rock underneath;
/// hollows are where the fines collect and are correspondingly smoother. So the
/// two layers are cross-faded by it rather than applied uniformly.
fn terrainFine(p: vec2f, w: f32, exposure: f32, amp: f32) -> vec3f {
    var h = 0.0;
    var d = vec2f(0.0);

    let wl = windLocal(p);

    // --- rubble ------------------------------------------------------------
    // Ridged noise, which gives a hard crest and a soft trough — the scalloped
    // lip of a metre-scale secondary crater, and the broken blocks around it.
    let m3 = windMat(w + wl.x, 1.0, wl.y, 2.3);
    let sas = ridgedd(m3 * p, 3, 2.11, 0.52);
    let scour = 0.45 + 0.55 * smoothstep(-0.25, 0.35, noise2(p * 0.021));
    let sasAmp = 0.125 * amp * mix(0.45, 1.0, exposure) * scour;
    h += (sas.x - 0.35) * sasAmp;
    d += (sas.yz * m3) * sasAmp;

    // --- pitting -----------------------------------------------------------
    // Half-metre lumpiness, strongest in the hollows where the fines are deep
    // and the rubble layer is weak.
    //
    // Rotated by half of what the rubble is, and isotropic: giving the two layers
    // the same orientation makes them move together and the field goes back to
    // reading as one sheet.
    let m4 = windMat(w + wl.x * 0.5, 1.0, 1.0, 0.42);
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

    // Rubble: wavelength ~2.3 m, standing 10-30 cm proud. It is a landform in its
    // own right rather than a texture, and underscaling it is what leaves a
    // regolith plain looking like poured icing. Same local rotation and aspect
    // the vertex stage used. See `windLocal`.
    let wl = windLocal(p);

    let fadeS = 1.0 - smoothstep(0.35, 1.6, fp);
    if (fadeS > 0.001) {
        let m3 = windMat(w + wl.x, 1.0, wl.y, 2.3);
        let sas = ridgedd(m3 * p, 3, 2.11, 0.52);
        // Modulated by a slow field so the ground has blocky patches and smooth
        // patches rather than one uniform lumpiness everywhere.
        // `scour`, not `patch` — the latter is a reserved keyword in WGSL.
        let scour = 0.45 + 0.55 * smoothstep(-0.25, 0.35, noise2(p * 0.021));
        let a = 0.125 * amp * mix(0.45, 1.0, exposure) * scour * fadeS;
        h += (sas.x - 0.35) * a;
        d += (sas.yz * m3) * a;
    }

    // Pitting: wavelength ~0.42 m.
    let fadeR = 1.0 - smoothstep(0.06, 0.3, fp);
    if (fadeR > 0.001) {
        let m4 = windMat(w + wl.x * 0.5, 1.0, 1.0, 0.42);
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
