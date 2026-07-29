#include<starNoise>
#include<starAtmosphere>
#include<starShading>
#include<starRidge>

varying vDir: vec3f;

var skyLUT: texture_2d<f32>;
var skyLUTSampler: sampler;

uniform sunDir: vec3f;
uniform sunColor: vec3f;
uniform sunIntensity: f32;
uniform time: f32;
/// Occupancy and brightness of the point-star field.
uniform starDensity: f32;
uniform starBrightness: f32;
uniform cameraPosition: vec3f;
/// Direct starlight reaching the ground, on the same scale the LUT stores
/// radiance in — so the range is lit by the identical number the dust is.
uniform sunRadiance: vec3f;
uniform shR: array<vec4f, 9>;
uniform ambientIntensity: f32;
/// Peak height of the far range, metres. Zero switches it off entirely.
uniform ridgeAmp: f32;
/// The dust field's own emission. The range is covered in the same dust and has
/// to glow by the same amount, or it draws as a black cut-out in front of the
/// galaxy while the ground in front of it shines.
uniform dustEmission: vec3f;

// The field's own aerial perspective, so the range is hazed by the same nebula
// the dust in front of it is. See `shadeRidge`.
uniform fogDensity: f32;
uniform fogHeightFalloff: f32;
uniform fogStart: f32;
uniform aerialStrength: f32;

/// Shade a point on the far range — a ridge of crystalline debris standing out
/// of the dust sea, drawn on the skybox rather than as geometry.
///
/// Deliberately the *dust field's* material logic, not a separate one: the same
/// wrapped diffuse, the same SH ambient, the same dark violet albedo, the same
/// emission. A distant massif rendered with its own ad-hoc lighting is the
/// classic way a matte painting announces itself — it does not sit in the same
/// light as the ground in front of it.
fn shadeRidge(hit: RidgeHit, dir: vec3f) -> vec3f {
    let N = hit.normal;
    let L = uniforms.sunDir;

    // Settled dust almost everywhere, bare shard only on the faces too steep to
    // hold it. Nothing sweeps this range clear, so there is no line to speak of;
    // the bare rock is here for the *break* it gives the silhouette, not as a
    // ground cover.
    let steep = 1.0 - N.y;
    let dustMask = clamp(1.0 - smoothstep(0.46, 0.80, steep), 0.0, 1.0);

    let shard = vec3f(0.026, 0.024, 0.038);
    let dust  = vec3f(0.085, 0.062, 0.155);
    let albedo = mix(shard, dust, dustMask);

    let shadow = ridgeShadow(hit.pos, hit.height, L, uniforms.ridgeAmp);

    const INV_PI: f32 = 0.31830988618;
    let diff = wrapDiffuse(dot(N, L), mix(0.15, 0.62, dustMask));
    var col = albedo * INV_PI * uniforms.sunRadiance * diff * shadow;

    // --- subsurface ---------------------------------------------------------
    // Without this the range reads as a different material from the field it
    // stands behind.
    //
    // The dust is translucent — it is a loose aggregate of ice and silicate
    // grains, and light entering one side of a drift leaves the other. A ridge of
    // it with the star behind *glows* along its edge rather than going to a flat
    // silhouette, and that rim is most of what separates it from the void it is
    // drawn against.
    //
    // The identical term the ground runs, so the two cannot disagree about what
    // back-lit dust does.
    let V = -dir;
    col += dustSubsurface(N, L, V, uniforms.sunRadiance, 0.45, dustMask, 1.0)
         * albedo * mix(0.5, 1.0, shadow);

    // Ambient fill. At this distance it is most of what is left after
    // extinction, and out here it is the reason a distant ridge reads violet
    // rather than black: the nebula above and the dust sea below are the only
    // things illuminating the faces the star cannot reach.
    col += albedo * INV_PI * shIrradiance(N, uniforms.shR) * uniforms.ambientIntensity;

    // Near-field bounce off the range's own dust — the same small correction the
    // ground makes, for the same reason. The sky LUT's lower hemisphere already
    // carries the dust sea's solved radiance, so the sphere integral above has
    // most of this; what is added here is the part a distant uniform sea cannot
    // account for, weighted onto the downward-facing slopes it reaches.
    col += albedo * INV_PI * shIrradiance(vec3f(0.0, -1.0, 0.0), uniforms.shR)
         * uniforms.ambientIntensity * 0.25 * clamp(-N.y * 0.5 + 0.5, 0.0, 1.0)
         * dustMask;

    // The same emission the near field carries, weighted by how much dust the
    // face is actually holding. See `DUST_EMISSION` in sky.js — the two are one
    // number, published from there, so they cannot drift apart.
    col += uniforms.dustEmission * dustMask * 0.55;

    // ---- aerial perspective ------------------------------------------------
    //
    // The scene's own, not a second atmosphere of the range's own — and that
    // change is most of what makes the range sit *in* the landscape rather than
    // behind it.
    //
    // Deliberately *not* a second, physically-real atmosphere integrated over
    // the true kilometres. That gives the frame two different atmospheres and
    // the seam lands exactly where the eye is looking: the scene's haze is
    // roughly a hundred times thicker than real air, so an 800 m dune is hazed
    // as though it were eighty kilometres away while a 20 km massif gets a
    // genuine 20 km of it — and the range comes out sharper and more contrasty
    // than the ground in front of it, which reads as a matte painting hung
    // behind the set.
    //
    // What makes one atmosphere work at these distances is the height falloff
    // the field's fog already has: at 0.045 per metre the haze has a 22 m scale
    // height, so a summit at two kilometres sits almost entirely clear of it
    // while its own feet are buried. On the current settings a 2 km peak keeps
    // about two thirds of its contrast at 9 km and a fifth at 35 km, and
    // anything below ~300 m is gone by 8 km — peaks emerging from a sea of
    // haze, on the same curve the dunes 600 m away are already on.
    let hitPos = vec3f(hit.pos.x, hit.height, hit.pos.y);
    let t = aerialTransmittance(
        uniforms.cameraPosition, hitPos,
        uniforms.fogDensity, uniforms.fogHeightFalloff, uniforms.fogStart
    );
    let ext = clamp(1.0 - pow(t, uniforms.aerialStrength), 0.0, 1.0);

    // The identical inscatter the ground converges to. This is the part that has
    // to match exactly: the clipmap's far edge and the range's feet are adjacent
    // pixels in the frame, and if they resolve to two different "fully hazed"
    // colours there is a visible line between them whatever else is right. At
    // full extinction it is the plain sky lookup, which is what this shader draws
    // where the march missed — so a fully hazed massif and the sky beside it are
    // literally the same value.
    let inscatter = aerialInscatterSky(
        skyLUT, skyLUTSampler, dir, L, uniforms.sunRadiance, ext
    );

    return mix(col, inscatter, ext);
}

/// The point-star field.
///
/// Screen-only, and deliberately so: this never enters the bake. At the 64x32
/// the spherical-harmonic readback runs at, a star is far smaller than a texel,
/// and what the projection returns is not a star field but a randomly-tinted
/// ambient that jumps every time the star moves. Stars light nothing here. They
/// cost one hash and they are drawn over the top.
///
/// Cells are laid out on the six faces of a cube rather than in lat-long UV.
/// Lat-long is shorter by two lines and puts a visible pinch of crowded stars at
/// the zenith — which is exactly where the camera looks when you drop into a
/// trough and pitch up out of it.
fn starField(dir: vec3f, density: f32, t: f32) -> vec3f {
    let a = abs(dir);
    var uv: vec2f;
    var face: f32;
    if (a.x >= a.y && a.x >= a.z) {
        uv = dir.yz / a.x;
        face = select(0.0, 1.0, dir.x < 0.0);
    } else if (a.y >= a.z) {
        uv = dir.xz / a.y;
        face = select(2.0, 3.0, dir.y < 0.0);
    } else {
        uv = dir.xy / a.z;
        face = select(4.0, 5.0, dir.z < 0.0);
    }

    // One candidate star per cell, and only the containing cell is tested — so
    // the whole field is a single hash regardless of how many stars are in it.
    const N: f32 = 96.0;
    let g = uv * N;
    let cell = floor(g);
    let f = g - cell;

    let h = hash33(vec3f(cell, face * 37.0));
    if (h.z > 0.42 * density) { return vec3f(0.0); }

    // Held off the cell edges, because only one cell is sampled: a star centred
    // on a boundary would be sliced in half by the cell it does not belong to.
    let centre = clamp(h.xy, vec2f(0.25), vec2f(0.75));
    let d = length(f - centre);

    // Apparent magnitude, cubed. A real field is overwhelmingly faint stars with
    // a handful of bright ones; a uniform distribution reads as static.
    let m = hash21(cell + vec2f(face * 11.0, 3.7));
    let mag = m * m * m;

    // Twinkle. There is no air to scintillate out here, so this is small and
    // slow — the eye's own adaptation rather than the atmosphere's turbulence —
    // and every star gets its own rate and phase so the field never pulses.
    let tw = 0.80 + 0.20 * sin(t * (0.6 + m * 2.4) + h.x * 62.8);

    // ~2 px across at 1440p. Smaller than that and TAA treats each star as
    // sub-pixel noise and dissolves the field into a faint grey haze.
    let core = exp(-d * d * 420.0) * (0.35 + 3.4 * mag);

    // Colour by spectral class, roughly: hot blue-white through to cool amber,
    // with the bright end of the population running warm to sit with the gold.
    let col = mix(vec3f(0.74, 0.82, 1.0), vec3f(1.0, 0.80, 0.56), h.y * 0.7 + mag * 0.3);
    return col * core * tw;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let dir = normalize(input.vDir);
    let uv = dirToLatLong(dir);

    var col = textureSampleLevel(skyLUT, skyLUTSampler, uv, 0.0).rgb;

    // ------------------------------------------------------- far-field range
    // Above the band the march's ceiling test rejects immediately, so the upper
    // bound is only there to skip the call.
    //
    // The lower bound reaches well *below* the horizon on purpose, and an earlier
    // version's did not. Fading the range out at a fixed elevation angle drew a
    // dead straight horizontal line under the whole massif — a ruler across the
    // frame, which is the one thing a landscape never has. A real range's feet are
    // hidden by the land in front of it, and here that happens for free: the
    // clipmap is drawn *after* the sky and covers everything below its own
    // silhouette, so letting the range paint down past the horizon lets the near
    // dunes occlude it exactly where they actually stand. A ray at -0.05 from eye
    // height meets the ground inside eighty metres, so there is nowhere it can
    // escape the terrain and show a base.
    if (uniforms.ridgeAmp > 1.0 && dir.y < 0.230 && dir.y > -0.050) {
        let hit = ridgeMarch(uniforms.cameraPosition, dir, uniforms.ridgeAmp);
        if (hit.hit) {
            col = shadeRidge(hit, dir);
        }
    }

    // ------------------------------------------------------------- the star
    // A third of a degree across, with limb darkening — smaller and harder than
    // the sun seen from Earth, because this one is further away and there is no
    // air to soften its edge.
    //
    // What is left of the aureole is not atmospheric. In vacuum a bright point
    // source has no halo *in the scene*; the halo is in the instrument, and this
    // scene is being watched through one. So the wide lobe is gone and the tight
    // one stays, at a fraction of its old strength: glare in the optics, which
    // is also what the bloom pass downstream is modelling.
    let mu = dot(dir, uniforms.sunDir);
    let discCos = cos(0.0029);
    if (mu > discCos) {
        let r = sqrt(max(0.0, 1.0 - mu * mu)) / 0.0029;
        let limb = pow(max(0.0, 1.0 - r * r * 0.72), 0.42);
        col += uniforms.sunColor * uniforms.sunIntensity * 42.0 * limb;
    }
    let aureole = pow(max(0.0, mu), 2600.0) * 3.2 + pow(max(0.0, mu), 220.0) * 0.06;
    col += uniforms.sunColor * uniforms.sunIntensity * aureole * 0.5;

    // --------------------------------------------------------------- stars
    // Added last and additively, over everything except the star's own disc.
    // Stars sit *in front of* the nebula from here, and a nebula that occludes
    // its own foreground stars is the single most common tell in a painted
    // space background.
    col += starField(dir, uniforms.starDensity, uniforms.time)
         * uniforms.starBrightness * uniforms.sunIntensity * 0.010;

    fragmentOutputs.color = vec4f(col, 1.0);
}
