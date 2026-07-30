// -----------------------------------------------------------------------------
// Stardust grains.
//
// Airborne dust is not a fogged sprite. It is a cloud of grains torn out of a
// field that glows, and three things make it read — none of which a plain alpha
// billboard has:
//
//   forward scatter   Looking toward the star through a veil, it is *brighter*
//                     than the ground behind it and it is warm. Looking the other
//                     way it is a dim cold grey. That swing is enormous — several
//                     stops — and it is the entire difference between "grains
//                     catching the light" and "grey smoke".
//   shadowing         Grains thrown inside the figure's own shadow must go dark,
//                     or every footfall looks self-illuminated. It reads the
//                     same cascades everything else does.
//   its own charge    Each grain carries a share of the discharge that freshly
//                     broken ground sheds, and they do not all carry the same
//                     share. A few per cent are hot enough to cross the bloom
//                     threshold alone and the rest are nowhere near it, which is
//                     what turns a plume into a spray of sparks inside a haze
//                     rather than one evenly glowing cloud.
//
// The billboard is shaded as a sphere: the normal is reconstructed from the
// quad's own coordinates, so a grain has a lit side and a dark side instead of
// being a flat disc.
// -----------------------------------------------------------------------------

#include<starNoise>
#include<starShading>
#include<starSpellLights>
#include<starAtmosphere>

varying vWorld: vec3f;
varying vCorner: vec2f;
varying vState: vec4f;
varying vViewDist: f32;

var skyLUT: texture_2d<f32>;
var skyLUTSampler: sampler;
var cascade0: texture_2d<f32>;
var cascade0Sampler: sampler;
var cascade1: texture_2d<f32>;
var cascade1Sampler: sampler;
var cascade2: texture_2d<f32>;
var cascade2Sampler: sampler;

uniform cameraPos: vec3f;
uniform camRight: vec3f;
uniform camUp: vec3f;
uniform sunDir: vec3f;
uniform sunRadiance: vec3f;
uniform shR: array<vec4f, 9>;

uniform cascadeMatrices: array<mat4x4f, 3>;
uniform cascadeSplits: vec4f;
uniform cascadeParams: array<vec4f, 3>;
/// Frame index, 0-63, for the shadow filter's rotation. The rotation used to be
/// a *static* hash of the pixel coordinate, on the theory that TAA resolves
/// noise — but TAA can only average out something that changes, and a static
/// pattern is signal: the resolve faithfully converged to the hash itself, and
/// since interleaved gradient noise is constant along near-vertical diagonals,
/// every penumbra in the frame carried faint crawling diagonal lines. The moon
/// rework made most of the ground penumbra, which is what promoted a subtlety
/// into a defect. Advancing the pattern per frame gives the resolve sixty-four
/// different rotations to integrate, and a penumbra comes out smooth.
uniform shadowDither: f32;
uniform shadowTexel: f32;
uniform shadowSoftness: f32;
uniform shadowBias: f32;

uniform fogDensity: f32;
uniform fogHeightFalloff: f32;
uniform fogStart: f32;
uniform aerialStrength: f32;
uniform ambientIntensity: f32;

/// The grain discharge ramp, off the brand palette with its gains folded in.
/// `grainGlowColor` is what a white-hot freshly thrown grain burns at,
/// `grainCoolColor` the warm pale grey of settling regolith it falls back to as
/// it cools — the same pair the wake's own wall runs.
uniform grainGlowColor: vec3f;
uniform grainCoolColor: vec3f;
/// Global emission scale, shared with the dust field and the wake.
uniform grainGlow: f32;

uniform spellLightPos: array<vec4f, 4>;
uniform spellLightCol: array<vec4f, 4>;
uniform spellLightCount: f32;

#include<starShadowLookup>

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let r2 = dot(input.vCorner, input.vCorner);
    if (r2 > 1.0) { discard; }

    let state = input.vState;
    let kind = state.z;

    // Break the disc's edge. A perfectly circular grain is the tell that gives
    // billboards away; a hashed radial wobble costs one noise fetch.
    let ang = atan2(input.vCorner.y, input.vCorner.x);
    let wob = 1.0 + 0.34 * noise2(vec2f(cos(ang), sin(ang)) * 2.4 + state.y * 37.0);
    let r = sqrt(r2) / wob;
    if (r > 1.0) { discard; }

    // Soft-edged for a loose veil grain, harder for a dense shard.
    let edge = mix(
        pow(clamp(1.0 - r * r, 0.0, 1.0), 1.6),
        smoothstep(1.0, 0.65, r),
        kind
    );
    // A loose grain is close to transparent on its own; density has to come from
    // many of them overlapping, or a single one turns into a decal. Below about a
    // third even fifteen hundred live grains read as haze rather than as a plume.
    var alpha = state.w * edge * mix(0.36, 0.55, kind);
    if (alpha < 0.004) { discard; }

    // Spherical normal from the billboard's own coordinates.
    let world = input.vWorld;
    let V = normalize(uniforms.cameraPos - world);
    let L = uniforms.sunDir;
    let nz = sqrt(max(0.0, 1.0 - r2));
    let N = normalize(
        uniforms.camRight * input.vCorner.x + uniforms.camUp * input.vCorner.y + V * nz
    );

    let noiseRot = ign(input.position.xy + 5.588238 * uniforms.shadowDither) * 6.28318530718;
    let shadow = sunShadow(world, N, input.vViewDist, noiseRot);

    let sun = uniforms.sunRadiance;
    const INV_PI: f32 = 0.31830988618;

    // Dust grains in vacuum scatter almost isotropically at the surface and very
    // strongly forward through the volume, so both terms are needed.
    //
    // The albedo is the ground's *loose* endpoint rather than the value the wake
    // wall carries. A grain in flight has no packing at all — it is the loosest
    // this material ever gets — and that is the honest end of the same ramp the
    // terrain and the wake read off.
    let albedo = vec3f(0.170, 0.158, 0.146);
    let diff = wrapDiffuse(dot(N, L), 0.75);
    var color = albedo * INV_PI * sun * diff * shadow;

    // Forward scatter through the grain. `mu` is 1 looking straight into the star.
    //
    // The coefficient is small and has to be. A phase function is normalised over
    // the sphere, so using it as a direct multiplier on radiance — without the
    // optical depth and scattering albedo that belong in front of it — overstates
    // the peak by more than an order of magnitude. At 0.55 a fully backlit grain
    // lands a little over the bloom knee once its own coverage is applied — so it
    // flares, which is the whole point of carrying the term — while the same grain
    // with the star behind the camera is more than five stops down and does not.
    let mu = dot(-V, L);
    let fwd = phaseMie(mu, 0.55) * 0.55;
    color += sun * albedo * fwd * mix(0.25, 1.0, shadow) * (1.0 - kind * 0.5);

    // Sky, which is what fills the shadowed side and keeps it cool.
    color += albedo * INV_PI * shIrradiance(N, uniforms.shR) * uniforms.ambientIntensity;

    // Spell light. Airborne dust inside a spell is the most legible thing the
    // dynamic lights do — a mist of grains a metre from a bright emitter picks up
    // far more of it than the ground does, which is why a fallout curtain reads as
    // lit from within rather than as grey dust over a glow.
    if (uniforms.spellLightCount > 0.5) {
        color += spellLightingParticle(
            world, N, albedo,
            uniforms.spellLightPos, uniforms.spellLightCol, uniforms.spellLightCount
        );
    }

    // ---- the grain's own charge --------------------------------------------
    //
    // Every grain left the field carrying a share of the discharge that freshly
    // broken dust sheds, and the shares are deliberately not equal. A sixth power
    // on a uniform hash leaves the great majority an order of magnitude under the
    // bloom knee and lifts roughly one in six clear over it at the instant it is
    // thrown — and the cooling curve takes even those back under inside the first
    // half of their life. A plume in which every grain blooms is a cloud of light
    // with no grain left in it; a plume in which none do is grey smoke. What
    // sells it is the handful that do, seen against the many that do not.
    //
    // Shards run at twice the charge, and not arbitrarily: they are the dense
    // fragments, so the same charge leaves through a smaller surface and the
    // radiance off that surface goes up in proportion.
    let h = fract(sin(state.y * 217.3 + 11.7) * 43758.5453);
    let flare = (0.05 + 0.95 * pow(h, 6.0)) * mix(1.0, 2.0, kind);

    // Cooling, on the same square law the alpha envelope fades on, so a grain can
    // never outlive its own glow. White-hot at separation, falling back through
    // the ramp to the pale grey of the ground it came out of.
    let cool = (1.0 - state.x) * (1.0 - state.x);
    let heat = flare * cool;
    // Tight radial core: the emission comes from the body of the grain rather
    // than from its dispersed edge. A flat disc of light is a sprite again.
    let core = pow(clamp(1.0 - r * r, 0.0, 1.0), 3.0);

    // The billboard is composited with an over operator, so what actually reaches
    // the framebuffer is `color * alpha`. Emission is not scattering: it does not
    // get weaker because the grain is thin, it simply adds. Stating the radiance
    // at the level it should *arrive* at and dividing back out by the coverage it
    // is about to be multiplied by is how that is written through an over
    // operator. The floor keeps the quotient finite at the edge of the disc, and
    // doubles as the fade-in — under it the grain has not developed enough
    // coverage to be glowing at full strength yet.
    let coverage = max(alpha, 0.12);
    let emitCol = mix(uniforms.grainCoolColor, uniforms.grainGlowColor, clamp(heat, 0.0, 1.0));
    color += emitCol * (heat * core * uniforms.grainGlow / coverage);

    color = applyAerial(
        color, uniforms.cameraPos, world, -V, L,
        skyLUT, skyLUTSampler, sun,
        uniforms.fogDensity, uniforms.fogHeightFalloff, uniforms.fogStart,
        uniforms.aerialStrength
    );

    fragmentOutputs.color = vec4f(color, alpha);
}
