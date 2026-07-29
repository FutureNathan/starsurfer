// -----------------------------------------------------------------------------
// snowAtmosphere — sky model and aerial perspective.
//
// (The include keeps its old name. It is `#include`d by nine shaders and read by
// the shader registry under that key; renaming it buys nothing and costs a
// silent unresolved-symbol failure if any one of the nine is missed.)
//
// The sky is deep space: a fixed backdrop of unresolved starlight, a galactic
// band and emission nebulae, evaluated analytically rather than sampled from an
// HDRI. Same argument as the atmospheric model this replaced — with a model, the
// galaxy's orientation and the star's bearing are sliders that correctly drag
// the ambient tint and the horizon colour along with them.
//
// It bakes into an equirectangular LUT at load and again only when the star
// moves. Everything downstream reads that one texture: skybox pixels, ambient
// spherical harmonics, specular reflections, and the inscatter half of aerial
// perspective.
//
// Aerial perspective at runtime is the cheap analytic half: height-falloff
// extinction plus an inscatter colour looked up from that same LUT, which keeps
// the far field tied to the sky it sits under. There is no air out here, so what
// it models is the nebula the dust sea is drifting through — thin, and much
// less coloured than an atmosphere, but the same integral.
// -----------------------------------------------------------------------------

/// Mie asymmetry. The medium is gone, but the phase function outlived it: the
/// airborne dust in `spray.fragment.wgsl` scatters forward through the same
/// lobe, which is what puts the bright edge on a plume with the star behind it.
const MIE_G: f32 = 0.76;

fn phaseMie(mu: f32, g: f32) -> f32 {
    let g2 = g * g;
    let n = (1.0 - g2) * (1.0 + mu * mu);
    let d = (2.0 + g2) * pow(1.0 + g2 - 2.0 * g * mu, 1.5);
    return (3.0 / (8.0 * PI)) * n / d;
}

// ------------------------------------------------------------------- the void

/// Value-noise fBm over a direction. Deliberately low-octave and low-frequency:
/// this function's output is baked at 64x32 for the spherical-harmonic
/// projection, where one texel subtends about five and a half degrees. Anything
/// finer than that does not survive the projection as structure — it survives as
/// a randomly-tinted ambient that jitters every time the star moves.
fn spaceFbm(p0: vec3f, octaves: i32) -> f32 {
    var p = p0;
    var a = 0.5;
    var s = 0.0;
    for (var i = 0; i < octaves; i++) {
        s += a * noise3(p);
        p = p * 2.07 + vec3f(11.3, 5.7, 19.1);
        a *= 0.52;
    }
    return s;
}

/// Radiance of deep space in a view direction. Replaces the Nishita integral
/// this file used to carry, and keeps its contract exactly:
///
///   - it returns linear, unnormalised radiance on the same scale as the star;
///   - it is smooth enough to bake into a 64x32 LUT and project to SH;
///   - it hands over to `groundBounce` below the horizon.
///
/// It is much cheaper than what it replaces — there is no medium to integrate
/// through, so the whole thing is a handful of noise evaluations — but the
/// reason it exists is not cost. In vacuum the sky is not a function of the
/// star at all. It is a fixed backdrop of unresolved starlight and emission
/// nebulae that happens to be *behind* the star, and modelling it as scattering
/// would tie the two together in exactly the way that would be wrong: move the
/// star and the galaxy would swing with it.
///
/// `galaxyPole` is the unit normal of the galactic plane and `coreDir` points at
/// the core. Both come from JS so the band can be aimed with a slider without
/// touching this file.
fn spaceSky(
    rayDir: vec3f,
    sunDir: vec3f,
    sunIntensity: f32,
    groundBounce: vec3f,
    galaxyPole: vec3f,
    coreDir: vec3f,
    bandAmt: f32,
    nebulaAmt: f32
) -> vec3f {
    // Everything here is a fraction of the star's own radiance. Tying the
    // backdrop to `sunIntensity` is not physics — it is what keeps one exposure
    // calibration valid when the intensity slider moves, which matters more.
    const SKY_SCALE: f32 = 0.05;

    // Near-black indigo. Not zero: a literal black sky reads as a rendering
    // failure, and there is always *some* unresolved light out there.
    const VOID_COL: vec3f = vec3f(0.035, 0.030, 0.085);
    // Integrated light of stars too faint to resolve. Warm-white, because it is
    // dominated by the old cool population toward the core rather than by the
    // handful of hot blue giants that resolve individually.
    const BAND_COL: vec3f = vec3f(0.62, 0.50, 0.44);
    // Emission nebulae. Warm toward the core, violet away from it.
    const NEB_WARM: vec3f = vec3f(0.88, 0.44, 0.20);
    const NEB_COOL: vec3f = vec3f(0.34, 0.17, 0.74);

    // Signed distance from the galactic plane, and how close to the core we are
    // looking. `coreBoost` is cubed so the brightening is confined to genuinely
    // core-ward directions instead of washing across half the sky.
    let planeD = abs(dot(rayDir, galaxyPole));
    let core = clamp(dot(rayDir, coreDir) * 0.5 + 0.5, 0.0, 1.0);
    let coreBoost = core * core * core;

    // --- the galactic band --------------------------------------------------
    // A Gaussian across the plane. It is narrow and bright toward the core and
    // broad and faint away from it, which is the single most recognisable thing
    // about a spiral galaxy seen from inside its own disc.
    let width = mix(0.20, 0.085, coreBoost);
    var band = exp(-(planeD * planeD) / (width * width));
    band *= mix(0.30, 1.0, coreBoost);

    // Dust lanes. The sample point is stretched hard along the pole axis, so the
    // noise varies quickly *across* the plane and slowly *along* it — which
    // makes its features run as long threads parallel to the band rather than as
    // blobs scattered over it. That anisotropy is the whole trick; an isotropic
    // noise here reads as dirt on the lens.
    let laneQ = rayDir * 3.0 + galaxyPole * (dot(rayDir, galaxyPole) * 26.0);
    let lanes = spaceFbm(laneQ, 3) * 0.5 + 0.5;
    band *= mix(0.28, 1.0, smoothstep(0.30, 0.72, lanes));

    // --- emission nebulae ---------------------------------------------------
    // Two scales of cloud, the second used only to break up the first's
    // silhouette. Thresholded so most of the sky stays empty: nebulae that cover
    // everything stop reading as objects and start reading as fog.
    let n1 = spaceFbm(rayDir * 1.6 + vec3f(4.1, 0.0, 2.7), 4) * 0.5 + 0.5;
    let n2 = spaceFbm(rayDir * 2.9 + vec3f(19.3, 7.2, 3.4), 3) * 0.5 + 0.5;
    let cloud = smoothstep(0.38, 0.92, n1) * (0.40 + 0.60 * n2);
    // Concentrated toward the plane, where the gas actually is, but not confined
    // to it — a hard cutoff at the band edge looks like a mask.
    let nebGate = mix(0.22, 1.0, exp(-(planeD * planeD) / 0.130));
    let nebCol = mix(NEB_COOL, NEB_WARM, coreBoost * 0.75);

    var col = VOID_COL * 0.06;
    col += BAND_COL * band * bandAmt * 0.9;
    col += nebCol * cloud * nebGate * nebulaAmt * 0.90;
    col *= sunIntensity * SKY_SCALE;

    // --- the dust sea -------------------------------------------------------
    // Below the horizon the "sky" is the field being surfed. `groundBounce` is
    // the radiance leaving it — reflected starlight plus its own emission —
    // solved on the CPU by iterating against this very LUT until it converges.
    //
    // This is load-bearing, and for a reason that survives the move to space
    // unchanged. Aerial perspective converges every distant surface onto the sky
    // in its own direction; if the lower hemisphere of the LUT does not hold the
    // dust sea's own colour, the far edge of the clipmap resolves to something
    // else and draws as a hard ring at a fixed radius from the player.
    //
    // The handover stays fast — a degree and a half either side of the horizon.
    // What is down there is a hundred kilometres of the same dust, and at that
    // path length it is indistinguishable from the haze above it.
    let downT = 1.0 - smoothstep(-0.030, -0.005, rayDir.y);
    col = mix(col, groundBounce, downT);

    // --- the grazing band ---------------------------------------------------
    // Kept from the atmospheric model, at roughly a quarter of its old strength.
    //
    // Its original job — killing the saturated olive stripe single scattering
    // produces along a hundred-kilometre horizontal path — is gone with the
    // integral. What it still does is give the far field one consistent colour
    // to dissolve into, because whatever sits in this band *is* the fog colour
    // of everything on the horizon. At the old 0.82 it flattened the galactic
    // band to grey wherever the two crossed, which is the most interesting
    // twenty degrees in the frame; at 0.22 it only takes the edge off.
    let grazing = 1.0 - smoothstep(0.0, 0.26, abs(rayDir.y));
    let pale = dot(col, vec3f(0.30, 0.42, 0.28));
    col = mix(col, vec3f(pale) * vec3f(1.02, 0.98, 1.06), grazing * 0.22);

    return col;
}

// ------------------------------------------------------- lat-long projection

// The sky is stored as an equirectangular 2D LUT rather than a cubemap. A cube
// would be six render targets, six readbacks and seam handling, to buy accuracy
// at the poles that a sky gradient does not have and cannot use.

fn dirToLatLong(d: vec3f) -> vec2f {
    let u = atan2(d.x, d.z) / (2.0 * PI) + 0.5;
    let v = acos(clamp(d.y, -1.0, 1.0)) / PI;
    return vec2f(u, v);
}

fn latLongToDir(uv: vec2f) -> vec3f {
    let phi = (uv.x - 0.5) * 2.0 * PI;
    let theta = uv.y * PI;
    let st = sin(theta);
    return vec3f(st * sin(phi), cos(theta), st * cos(phi));
}

// ------------------------------------------------------------------- runtime

/// Height-falloff extinction. Returns transmittance 0..1.
/// Integrates exp(-k*y) analytically along the segment, so fog thins with
/// altitude the way real haze does instead of sitting in a flat slab.
fn aerialTransmittance(
    camPos: vec3f,
    worldPos: vec3f,
    density: f32,
    heightFalloff: f32,
    fogStart: f32
) -> f32 {
    let d = worldPos - camPos;
    let dist = max(0.0, length(d) - fogStart);
    if (dist <= 0.0) { return 1.0; }

    let dy = d.y;
    var integral: f32;
    if (abs(dy) < 0.01) {
        integral = exp(-heightFalloff * camPos.y) * dist;
    } else {
        // ∫ exp(-k*y(t)) dt along the ray, closed form.
        let k = heightFalloff;
        integral = (exp(-k * camPos.y) - exp(-k * worldPos.y)) / (k * dy) * length(d);
        integral = integral * (dist / max(1e-4, length(d)));
    }

    return exp(-density * max(0.0, integral));
}

/// The colour that fills a *short*, ground-level path.
///
/// Not the sky's radiance in the view direction. The horizon band of this sky is
/// the colour of a hundred-kilometre path — by the time light has travelled that
/// far the blue end is gone entirely. Borrowing it as the inscatter colour for
/// three hundred metres of haze paints the middle distance with a sunset it is
/// three orders of magnitude too short to have earned, and the whole far field
/// goes yellow.
///
/// What actually fills a short path is the whole sky hemisphere, and that is
/// dominated by the bright cool dome overhead rather than by the band at eye
/// level. So the lookup is tilted upward and read from a blurred mip. The sun's
/// forward lobe is added separately by `applyAerial`, which is what keeps haze
/// warm where you are looking toward the sun — the one place it should be.
fn aerialNearSky(tex: texture_2d<f32>, samp: sampler, viewDir: vec3f) -> vec3f {
    let d = normalize(viewDir + vec3f(0.0, 0.42, 0.0));
    return textureSampleLevel(tex, samp, dirToLatLong(d), 3.0).rgb;
}

/// The inscatter colour for a path of a given total extinction.
///
/// This is the whole of the horizon, and both halves of it were wrong in turn.
///
/// The short-path answer above is right up close and wrong in the limit. A
/// surface at total extinction is *invisible*: by definition what reaches the eye
/// from it is the sky in that exact direction — the sky that would be there if
/// the surface were not. Converge on anything else and the ground never dissolves
/// however much haze is piled on it; it bottoms out at a colour the sky above it
/// does not share, and the far edge of the clipmap draws as a hard silhouette at
/// a fixed radius from the player, with the mountain range apparently standing on
/// it. No fog density removes that, because the two ends of the ramp are
/// different colours.
///
/// The first attempt at this crossfaded the two *lookups* and left the
/// forward-scatter lobe added on top at full strength, and that turned the shelf
/// into a wall: a saturated bank of haze, hard-topped, brighter and warmer than
/// the sky above it and the ground below it, with the mountains sticking out of
/// it like rocks out of surf. The lobe is the reason. It is a short-path
/// correction — it stands in for sunlight scattered into the first few hundred
/// metres, which the LUT's directional radiance cannot describe at that range —
/// but over kilometres the LUT *is* that integral, aureole and all, so adding the
/// lobe as well double-counts it. Away from the sun that is worth a fifth of the
/// sky's own radiance; toward it, at a Mie `g` of 0.62, the phase function is
/// nearly two orders of magnitude larger and the band goes to flat white.
///
/// So the whole inscatter — lobe included — is crossfaded onto the exact sky
/// sample, at the exact mip the sky material itself draws with. At full
/// extinction a hazed surface and the sky pixel beside it are then the same
/// number, and there is nothing left to draw an edge.
fn aerialInscatterSky(
    tex: texture_2d<f32>, samp: sampler, viewDir: vec3f,
    sunDir: vec3f, sunColor: vec3f, ext: f32
) -> vec3f {
    // Mip 0 and no tilt: this has to match `sky.fragment.wgsl`'s own lookup
    // exactly, or "fully hazed" and "sky" are two different colours again.
    let exact = textureSampleLevel(tex, samp, dirToLatLong(normalize(viewDir)), 0.0).rgb;

    let mu = dot(viewDir, sunDir);
    let fwd = phaseMie(mu, 0.62) * 5.5;
    let near = aerialNearSky(tex, samp, viewDir) + sunColor * fwd * 0.16;

    // Ramps across roughly 100 m to 700 m on the current fog settings: the near
    // field keeps the cool dome and the warm sun-facing haze it is tuned for, and
    // everything past the middle distance is already on its way to the sky.
    return mix(near, exact, smoothstep(0.55, 0.995, ext));
}

/// Fold aerial perspective into a shaded colour.
///
/// Distance does three things at once in the references, and all three matter:
/// contrast compresses, hue pulls toward the sky, and the sun direction picks up
/// a forward-scatter bloom. Extinction alone only does the first.
///
/// The sky LUT is passed in rather than a pre-sampled colour, because the right
/// inscatter colour depends on the extinction this function computes — see
/// `aerialInscatterSky`. Seven materials call this, and the previous signature
/// let every one of them decide for itself what "the sky here" meant.
fn applyAerial(
    color: vec3f,
    camPos: vec3f,
    worldPos: vec3f,
    viewDir: vec3f,
    sunDir: vec3f,
    skyTex: texture_2d<f32>,
    skySamp: sampler,
    sunColor: vec3f,
    density: f32,
    heightFalloff: f32,
    fogStart: f32,
    strength: f32
) -> vec3f {
    let t = aerialTransmittance(camPos, worldPos, density, heightFalloff, fogStart);
    let ext = clamp(1.0 - pow(t, strength), 0.0, 1.0);
    let inscatter = aerialInscatterSky(skyTex, skySamp, viewDir, sunDir, sunColor, ext);
    return mix(color, inscatter, ext);
}
