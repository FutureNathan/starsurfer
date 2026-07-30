// -----------------------------------------------------------------------------
// Screen-space reflections, on the mirrors only.
//
// Very little in this scene is a mirror, so the pass is gated on the prepass's
// reflectivity channel and the channel is non-zero on precisely those pixels. The
// regolith is a rough dielectric — there is nothing to reflect off it that the
// sky lookup in its own material does not already give exactly. What is left is
// the astronaut's gold faceplate, which is a mirror all the time, and the impact
// glass a power or the board's own rail fuses into the ground. On a frame with
// neither in view this costs a texture fetch and a branch, which is why it can
// afford to march at full resolution when it fires.
//
// What it buys: both mirrors already reflect the *galaxy* correctly and cheaply,
// from their own material's sky lookup. What neither can know analytically is
// that there is a swell, a trench, a wake or an astronaut standing in the
// direction it is reflecting. That is the entire content of this pass — replace
// the sky estimate with what is actually there, where the march can find it.
//
// Which is also why a miss here writes the source pixel back untouched rather
// than black. A ray that leaves the frustum, runs out of screen, or finds only
// background has not discovered that the reflection is dark; it has discovered
// that the reflection is the sky, and the sky is what the material already put
// there. In a scene where the brightest thing in most reflection directions *is*
// the galaxy, getting that fallback wrong would put a black hole in the visor.
//
// One pass, two materials, and no branch between them: the reflection it finds
// is untinted scene radiance, and a gold mirror's reflection is only untinted
// near grazing incidence. The Fresnel term below is what confines the
// contribution to those angles — see the note on it.
// -----------------------------------------------------------------------------

#include<starPostCommon>

varying vUV: vec2f;

var textureSampler: texture_2d<f32>;
var textureSamplerSampler: sampler;
var depthTex: texture_2d<f32>;
var depthTexSampler: sampler;

uniform projInfo: vec2f;
uniform invRes: vec2f;
uniform enabled: f32;
uniform strength: f32;

/// Coarse steps along the ray, then a short binary refine on the hit.
const STEPS: i32 = 28;
const REFINE: i32 = 5;
/// Thickness the depth buffer is assumed to have, in metres. A screen-space ray
/// can only see the front surface of anything, so a hit is accepted when it lands
/// behind the buffer by less than this — too small and reflections dropped by
/// grazing rays flicker, too large and the ray "hits" the void behind a crest.
const THICKNESS: f32 = 0.55;

/// Depth difference between a neighbouring tap and this pixel, or a number
/// nothing can beat where that neighbour is background. Used to pick which side
/// of each axis the surface tangent is taken from.
fn depthGap(zs: f32, z: f32) -> f32 {
    return select(abs(zs - z), 1e9, isBackground(zs));
}

/// The reflection, or a negative weight when the march found nothing.
///
/// A helper rather than the body of `main` because Babylon rewrites a fragment
/// entry point to return its `FragmentOutputs` struct, so a bare `return` inside
/// one does not compile — and a march like this is all early-outs.
fn reflectionAt(uv: vec2f, pix: vec2f, z: f32, mask: f32) -> vec4f {
    let miss = vec4f(0.0, 0.0, 0.0, -1.0);

    let P = viewFromDepth(uv, z, uniforms.projInfo);

    // Surface normal from the depth buffer, taking the nearer neighbour on each
    // axis rather than always the forward one.
    //
    // One-sided differences were enough when the only mirror was a patch of
    // glaze: that is a heightfield, locally near-flat, and either side gives
    // effectively the same answer. The faceplate is not flat. It is a curved dome
    // a few dozen pixels across at
    // surfing distance, with the helmet shell right behind its rim, so a forward
    // difference taken near that rim straddles the silhouette and returns a
    // tangent belonging to neither surface — and a normal built from that points
    // somewhere arbitrary, which sends the march off across the frame and comes
    // back with a reflection of something nowhere near the visor. Choosing the
    // side whose depth is closer keeps both differences on the surface actually
    // being shaded, and costs two taps on the few pixels that reach this far.
    let e = uniforms.invRes;
    let uxp = uv + vec2f(e.x, 0.0);
    let uxm = uv - vec2f(e.x, 0.0);
    let uyp = uv + vec2f(0.0, e.y);
    let uym = uv - vec2f(0.0, e.y);

    let zxp = textureSampleLevel(depthTex, depthTexSampler, uxp, 0.0).r;
    let zxm = textureSampleLevel(depthTex, depthTexSampler, uxm, 0.0).r;
    let zyp = textureSampleLevel(depthTex, depthTexSampler, uyp, 0.0).r;
    let zym = textureSampleLevel(depthTex, depthTexSampler, uym, 0.0).r;

    let gxp = depthGap(zxp, z);
    let gxm = depthGap(zxm, z);
    let gyp = depthGap(zyp, z);
    let gym = depthGap(zym, z);
    // A pixel with background on both sides of an axis is a one-pixel sliver of
    // surface. There is no tangent to be had and no reflection worth the march.
    if (min(gxp, gxm) > 1e8 || min(gyp, gym) > 1e8) { return miss; }

    // Both branches are tangents in the +u (+v) direction, so the cross product
    // below keeps its handedness whichever side is chosen.
    let dx = select(
        P - viewFromDepth(uxm, zxm, uniforms.projInfo),
        viewFromDepth(uxp, zxp, uniforms.projInfo) - P,
        gxp <= gxm
    );
    let dy = select(
        P - viewFromDepth(uym, zym, uniforms.projInfo),
        viewFromDepth(uyp, zyp, uniforms.projInfo) - P,
        gyp <= gym
    );

    let V = normalize(P);            // the camera sits at the view-space origin

    // Crossing the two tangents gives the surface's axis, but its *sign* comes
    // from the screen's handedness rather than from the geometry: vUV runs
    // bottom-up and view space is left-handed with +z forward, so cross(+u, +v)
    // comes out pointing away from the eye, into the surface. Most of the pass
    // cannot tell — `reflect` returns the same ray for N and -N, and so the
    // march, the thickness test and the edge fade are all unaffected. The
    // Fresnel term at the bottom can: it reads the cosine of the incidence
    // angle, and against an inward normal that cosine is never positive, which
    // pins the term at one everywhere and quietly turns a grazing-angle gate
    // into a full-strength replacement of whatever the material had underneath.
    // Face it toward the eye, the same way the character material does with its
    // own two-sided shells.
    var N = normalize(cross(dx, dy));
    if (dot(N, V) > 0.0) { N = -N; }

    let R = reflect(V, N);
    // A ray heading back toward the eye has nothing on screen to find.
    if (R.z < 0.02) { return miss; }

    // Step length set so the ray crosses roughly one pixel per step near the
    // surface, jittered to break the banding a fixed step leaves on a flat facet.
    let stride = max(0.06, z * 0.035);
    var t = stride * (0.5 + ignPost(pix));
    var prevT = 0.0;
    var hitT = -1.0;

    for (var i = 0; i < STEPS; i++) {
        let Q = P + R * t;
        let sUV = uvFromView(Q, uniforms.projInfo);
        if (any(sUV < vec2f(0.0)) || any(sUV > vec2f(1.0))) { break; }

        let sz = textureSampleLevel(depthTex, depthTexSampler, sUV, 0.0).r;
        let diff = Q.z - sz;
        if (diff > 0.0 && diff < THICKNESS) {
            // Binary refine between the last miss and this hit.
            var lo = prevT;
            var hi = t;
            for (var k = 0; k < REFINE; k++) {
                let mid = (lo + hi) * 0.5;
                let M = P + R * mid;
                let mz = textureSampleLevel(
                    depthTex, depthTexSampler, uvFromView(M, uniforms.projInfo), 0.0
                ).r;
                if (M.z - mz > 0.0) { hi = mid; } else { lo = mid; }
            }
            hitT = hi;
            break;
        }
        prevT = t;
        // Geometric growth: the near field needs fine steps, and the far field is
        // where the ray runs out of screen anyway.
        t += stride * (1.0 + f32(i) * 0.16);
    }

    if (hitT < 0.0) { return miss; }

    let hitUV = uvFromView(P + R * hitT, uniforms.projInfo);

    // Fade at the screen edge, or the reflection ends in a hard line wherever the
    // ray ran out of buffer.
    let edge = min(min(hitUV.x, 1.0 - hitUV.x), min(hitUV.y, 1.0 - hitUV.y));
    let edgeFade = smoothstep(0.0, 0.10, edge);

    // Schlick, on a dielectric base — and that base is not an attempt to model
    // the faceplate's coating, which is gold and nothing like 0.045. It is the
    // gate that makes one untinted pass correct for both mirrors.
    //
    // What the march returns is scene radiance with no idea what surface is
    // reflecting it. A gold mirror's reflection is gold near normal incidence,
    // where an untinted answer would be wrong — and there this term is 4.5% and
    // the material's own tinted sky lookup carries the pixel. Push toward
    // grazing and every material on the chart, metal and dielectric alike,
    // climbs to a reflectance of one and loses its tint; that is where this term
    // goes to one too, and where an untinted reflection of the real geometry is
    // exactly the right answer. The gate and the physics are the same curve.
    //
    // It is also where the effect is worth having: a flat glaze under a
    // thirteen-degree star is seen almost edge-on, and so is the curve of a
    // faceplate away from its centre.
    let f = 0.045 + 0.955 * pow(1.0 - clamp(dot(-V, N), 0.0, 1.0), 5.0);

    let refl = textureSampleLevel(textureSampler, textureSamplerSampler, hitUV, 0.0).rgb;
    return vec4f(refl, clamp(mask * f * edgeFade * uniforms.strength, 0.0, 1.0));
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let uv = input.vUV;
    let src = textureSampleLevel(textureSampler, textureSamplerSampler, uv, 0.0);
    let g = textureSampleLevel(depthTex, depthTexSampler, uv, 0.0);

    var outCol = src.rgb;
    if (uniforms.enabled > 0.5 && g.g >= 0.02 && !isBackground(g.r)) {
        let r = reflectionAt(uv, input.position.xy, g.r, g.g);
        if (r.w > 0.0) { outCol = mix(src.rgb, r.rgb, r.w); }
    }

    fragmentOutputs.color = vec4f(outCol, src.a);
}
