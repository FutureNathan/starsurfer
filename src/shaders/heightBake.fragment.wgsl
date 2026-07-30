// Bakes the macro landform (swells, the crater field, highland massifs) into a
// single-channel float texture covering the whole playable field.
//
// Baked rather than evaluated live for one reason: the CPU needs the same
// heights for character grounding, footfall placement and spell hit points, and
// reading back a GPU bake is the only way to guarantee the two never disagree.
// Re-implementing the noise in JS would drift the moment f32 and f64 rounding
// diverged, and the character would float or sink by centimetres.

#include<starNoise>
#include<starTerrain>

varying vUV: vec2f;

uniform worldOrigin: vec2f;
uniform worldSize: f32;
uniform windAngle: f32;
uniform heightAmp: f32;
/// The world seed, 0-999. Slides the noise domain tens of kilometres, so every
/// seed is a different stretch of the same moon — different swells, different
/// craters, different massifs — while the material, physics and readback
/// pipelines never know anything changed. The CPU mirrors this bake, so the
/// seed lives here and nowhere else.
uniform worldSeed: f32;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let pw = uniforms.worldOrigin + input.vUV * uniforms.worldSize;

    // The seed's domain slide. Bounded to ~±20 km: far enough that no two
    // seeds share ground, small enough that f32 noise arithmetic keeps
    // millimetre precision.
    let p = pw + vec2f(
        fract(uniforms.worldSeed * 0.754877) - 0.5,
        fract(uniforms.worldSeed * 0.569840) - 0.5
    ) * 39000.0;

    var h = terrainMacro(p, uniforms.windAngle, uniforms.heightAmp);

    // A massif pushes the regolith up with it; the fines then creep back onto
    // the shallow faces, which the material resolves from the mask in the aux
    // bake.
    let rock = rockField(p, uniforms.windAngle);
    h += rock.x;

    // The landmark ring, placed in unoffset space — see `ringStructure`.
    h += ringStructure(pw, uniforms.worldSeed);

    fragmentOutputs.color = vec4f(h, rock.y, 0.0, 1.0);
}
