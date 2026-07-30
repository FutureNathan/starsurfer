// -----------------------------------------------------------------------------
// starRidge — the far-field mountains.
//
// The constraint is that the range must never read as flat, and that is what
// rules out the two cheap answers. A silhouette cut out of the sky reads as a
// sticker. A band
// of noise shaded by its own azimuth gradient reads as corrugated cardboard,
// because a ridge's *form* comes from slopes facing toward and away from the sun,
// and a one-dimensional profile has no such thing.
//
// So this raymarches an actual two-dimensional heightfield, on the skybox, in
// world space. It costs nothing in geometry, it is behind everything by
// construction, and because the field is real:
//
//   * ridges occlude other ridges, so the range has depth rather than a single
//     outline;
//   * the normal is analytic, so faces light and shade correctly against the low
//     sun;
//   * a short second march toward the sun gives the range its own cast shadows,
//     which is most of what makes a mountain read as a solid rather than a
//     gradient;
//   * extinction is integrated per pixel over the true distance, so nearer
//     massifs sit in front of hazier ones without any hand-placed layers.
//
// It is confined to a narrow band of view directions around the horizon and
// early-outs above the tallest possible peak, so it touches a few per cent of the
// frame.
//
// Distances are in metres. The range sits from 9 km to 45 km, well beyond the
// 870 m clipmap, so nothing here can ever intersect the terrain.
// -----------------------------------------------------------------------------

/// Tallest a peak can be, metres. The march's early-out depends on this being a
/// true bound, so it is derived from the amplitude rather than guessed.
fn ridgeCeiling(amp: f32) -> f32 {
    return amp * 1.05;
}

/// Height of the range at a world XZ, in metres, with its analytic gradient.
/// Returns vec3f(height, dH/dx, dH/dz).
///
/// Three layers, and the first one is the one that stops this reading as a wall:
/// a slow massif field decides *where there is a range at all*, so the horizon
/// gets massifs and gaps and long low saddles instead of an unbroken row of
/// triangles.
fn ridgeField(p: vec2f, amp: f32) -> vec3f {
    // Kilometres. The whole range is authored at this scale.
    let q = p * 0.001;
    let kq = 0.001;

    // ---- the bowl ----------------------------------------------------------
    // The *massifs* are excluded from a seven-kilometre disc centred on the
    // world origin, so no mountain can start closer than the near plane and
    // clamp into a flat-faced slab. The bowl is no longer empty, though — see
    // the mid-field below.
    let rad = length(p);
    let bt = clamp((rad - 7000.0) / 6000.0, 0.0, 1.0);
    let bowl = bt * bt * (3.0 - 2.0 * bt);

    // ---- the ground between ------------------------------------------------
    // The clipmap ends 870 m out and the massifs start kilometres later, and
    // the strip between used to be genuinely empty — a flat floor at zero. From
    // eye level the haze hid it; from a hundred-metre summit the eye looks
    // *over* the haze, and the strip showed as a pale featureless band with the
    // range floating on top of it. That band was the floating-mountains
    // artefact, both times it was reported.
    //
    // So the bowl now holds rolling mid-ground: two octaves at the near
    // terrain's own swell wavelengths, in absolute metres (the range-height
    // slider must not inflate the plains), biased four metres low so its seam
    // with the real terrain hides behind the real silhouette rather than
    // poking through it.
    let g1 = noised(p * (1.0 / 380.0));
    let g2 = noised(p * (1.0 / 155.0) + vec2f(37.1, 11.7));
    let midH = g1.x * 24.0 + g2.x * 9.0 - 4.0;
    let midG = g1.yz * (24.0 / 380.0) + g2.yz * (9.0 / 155.0);
    if (bowl <= 0.0) { return vec3f(midH, midG); }
    let dbowl = select(
        vec2f(0.0),
        (p / max(rad, 1.0)) * (6.0 * bt * (1.0 - bt) / 6000.0),
        bt > 0.0 && bt < 1.0
    );

    // ---- where there is a range at all ------------------------------------
    let massif = fbmd(q * 0.10 + vec2f(11.3, 4.7), 2, 2.13, 0.52);
    let mk = 0.10 * kq;
    let t = clamp((massif.x + 0.34) / 0.70, 0.0, 1.0);
    let env = t * t * (3.0 - 2.0 * t);
    // d(smoothstep)/dx = 6t(1-t)/width, chained through the massif's own slope.
    let denv = select(
        vec2f(0.0),
        massif.yz * mk * (6.0 * t * (1.0 - t) / 0.62),
        t > 0.0 && t < 1.0
    );

    // ---- domain warp -------------------------------------------------------
    // The single largest difference between "ridged noise" and "mountains".
    //
    // An unwarped ridged field runs its crests in straight, roughly parallel
    // lines, because the lattice underneath it does — and the eye reads that as
    // procedural immediately, however many octaves are stacked on top. Displacing
    // the lookup by a slower noise makes every ridgeline curve, fork and run out
    // into a spur, which is what real ranges do.
    //
    // The height gradient below ignores this warp's Jacobian, so the normals are
    // rotated slightly against the true surface. On a matte 10-45 km away that is
    // not resolvable, and carrying the chain rule through two extra fields would
    // cost more than the shading error is worth.
    let w1 = noised(q * 0.26 + vec2f(2.7, 8.1));
    let w2 = noised(q * 0.26 + vec2f(19.4, 3.6));
    let qw = q + vec2f(w1.x, w2.x) * 1.35;

    // ---- the peaks ---------------------------------------------------------
    // Four octaves, not three. At three the lowest octave dominates and the
    // range reads as smooth meringue mounds: no crest line anywhere, and a
    // mountain without a crest line has no scale.
    let r = ridgedd(qw * 0.30, 4, 2.09, 0.50);
    let rk = 0.30 * kq;
    // A second, finer set at a different phase. One ridged stack alone gives
    // every peak the same profile; two at incommensurate scales does not.
    let s = ridgedd(qw * 1.05 + vec2f(31.0, 17.0), 3, 2.11, 0.50);
    let sk = 1.05 * kq;

    let raw = r.x * 0.78 + s.x * 0.22;
    let draw = r.yz * (0.78 * rk) + s.yz * (0.22 * sk);

    // Sharpen the crests and widen the valleys. Ridged noise squares its ridge
    // term, which rounds the top and is right for sastrugi; a mountain wants the
    // opposite bias. Chain-ruled so the normals follow.
    let peaks = raw * raw * raw * 0.55 + raw * 0.45;
    let dpeaks = draw * (3.0 * raw * raw * 0.55 + 0.45);

    // A *small* floor under the envelope: low foothills in the gaps between
    // massifs rather than absolute nothing, which reads as a cut-out.
    //
    // Small is the operative word. At 0.22 this was a continuous four-hundred
    // metre barrier at the near edge of the range, and since every ray at the
    // horizon meets it immediately, the result was a flat-topped vertical wall
    // wrapped right around the field. The gaps have to genuinely open, or rays
    // can never reach the massifs behind them and the range has no depth at all.
    let e = 0.06 + 0.94 * env;
    let h = peaks * e;
    let dh = dpeaks * e + peaks * denv * 0.94;
    // The mid-field continues underneath the massifs — thirty metres of rolling
    // ground under a three-kilometre mountain is a foothill, not a seam.
    return vec3f(
        h * bowl * amp + midH,
        (dh * bowl + h * dbowl) * amp + midG
    );
}

/// Earth curvature drop at a horizontal distance, metres. Small at these ranges
/// — 50 m at 25 km — but it is what sinks the farthest massifs' feet below the
/// horizon and lets the near ones stand in front of them.
fn ridgeDrop(d: f32) -> f32 {
    return d * d / 12742000.0;
}

struct RidgeHit {
    hit: bool,
    dist: f32,     // horizontal metres to the hit
    height: f32,   // world Y of the surface there
    normal: vec3f,
    pos: vec2f,    // world XZ of the hit
};

/// March the range along a view ray.
///
/// Steps grow geometrically, which is the right distribution for a field whose
/// features subtend a roughly constant angle: a fixed step wastes most of its
/// samples in the far half where a kilometre is a pixel.
fn ridgeMarch(camPos: vec3f, dir: vec3f, amp: f32) -> RidgeHit {
    var out: RidgeHit;
    out.hit = false;
    out.dist = 0.0;
    out.height = 0.0;
    out.normal = vec3f(0.0, 1.0, 0.0);
    out.pos = vec2f(0.0);

    let hl = length(dir.xz);
    if (hl < 1e-4) { return out; }

    let step = dir.xz / hl;
    let slope = dir.y / hl;          // metres of rise per metre of ground

    // Where the march starts: just past the clipmap's own edge, so the
    // mid-field takes over the frame exactly where the real terrain hands it
    // off. The *massifs* still start at 7 km — their distance is the bowl's,
    // not this constant's.
    const D_NEAR: f32 = 820.0;
    const D_FAR: f32 = 45000.0;
    const STEPS: i32 = 18;

    // A ray already above the tallest possible peak and still climbing can never
    // hit. This is the branch the sky above the range takes, and it is why the
    // whole effect costs a few per cent of the frame.
    let ceiling = ridgeCeiling(amp);
    if (camPos.y + slope * D_NEAR > ceiling && slope >= 0.0) { return out; }

    let growth = pow(D_FAR / D_NEAR, 1.0 / f32(STEPS));

    // Prime the crossing state from a real sample rather than a constant.
    //
    // A ray at the horizon meets the near face of a massif on the *first* step,
    // and with `prevGap` initialised to a made-up 1.0 the interpolation below
    // returned a distance somewhere between the near plane and nothing in
    // particular. It showed up as vertical striping down the whole range, which
    // looks like a shading bug and is arithmetic.
    var prevD = D_NEAR;
    var prevGap = camPos.y + slope * D_NEAR
                - (ridgeField(camPos.xz + step * D_NEAR, amp).x - ridgeDrop(D_NEAR));

    if (prevGap < 0.0) {
        // Started at or under the field — for a downward ray over the
        // mid-ground that is the common case, and painting it at D_NEAR puts
        // the fill directly behind the clipmap's far edge, which is the seam
        // it exists to close.
        out.dist = D_NEAR;
        out.pos = camPos.xz + step * D_NEAR;
        let f = ridgeField(out.pos, amp);
        out.height = f.x - ridgeDrop(D_NEAR);
        out.normal = normalize(vec3f(-f.y, 1.0, -f.z));
        out.hit = true;
        return out;
    }

    var d = D_NEAR * growth;

    for (var i = 1; i < STEPS; i++) {
        let rayY = camPos.y + slope * d;
        // A climbing ray that has passed the ceiling can never come back down
        // to the field. Without this, every sky pixel between the tallest peak
        // and the top of the march window paid all eighteen field evaluations
        // to find nothing — which, once the window grew for the taller range,
        // was a real slice of the frame doing pure waste.
        if (rayY > ceiling && slope >= 0.0) { break; }
        let p = camPos.xz + step * d;
        let h = ridgeField(p, amp).x - ridgeDrop(d);
        let gap = rayY - h;

        if (gap < 0.0) {
            // Interpolate the crossing rather than accepting the step. At 12%
            // growth a step is hundreds of metres wide out here, and taking its
            // far end would quantise every silhouette into visible terraces.
            var t = 0.5;
            if (prevGap - gap > 1e-5) { t = prevGap / (prevGap - gap); }
            out.dist = mix(prevD, d, clamp(t, 0.0, 1.0));
            out.pos = camPos.xz + step * out.dist;

            let f = ridgeField(out.pos, amp);
            out.height = f.x - ridgeDrop(out.dist);
            out.normal = normalize(vec3f(-f.y, 1.0, -f.z));
            out.hit = true;
            return out;
        }

        // Climbed clear of the tallest possible peak: nothing ahead can be hit.
        // This is what stops rays that pass over the range from paying for the
        // whole march.
        if (rayY > ceiling && slope > 0.0) { return out; }

        prevGap = gap;
        prevD = d;
        d *= growth;
    }

    return out;
}

/// Fraction of the sun reaching a point on the range, 0 or 1, marched along the
/// sun direction.
///
/// Four steps and a hard result. A soft edge would cost four times the samples to
/// describe a penumbra that, at twenty kilometres, is a fraction of a pixel — and
/// what this term is actually for is the large-scale read of which flank of a
/// massif is in the shade of the one in front of it.
fn ridgeShadow(pos: vec2f, height: f32, sunDir: vec3f, amp: f32) -> f32 {
    let hl = length(sunDir.xz);
    if (hl < 1e-3 || sunDir.y <= 0.0) { return 1.0; }

    let step = sunDir.xz / hl;
    let slope = sunDir.y / hl;

    var d = 420.0;
    for (var i = 0; i < 4; i++) {
        let h = ridgeField(pos + step * d, amp).x;
        if (h > height + slope * d) { return 0.0; }
        d *= 2.6;
    }
    return 1.0;
}
