// -----------------------------------------------------------------------------
// charSkin — the character's shared vertex-side transform library.
//
// Everything the character needs to place a vertex comes out of one small
// RGBA32F texture, uploaded once per frame:
//
//   rows 0-3   bone skinning matrices. Column = bone index, row = matrix column,
//              so texel (b, c) is column c of bone b's `world * inverseBind`.
//
// That is the whole texture now. It used to carry simulated cloth node grids
// from row 4 down, and a Catmull-Rom reconstruction of them lived at the bottom
// of this file, but there are no garments left to simulate: a pressure suit is a
// laminate over hard bearings, and every panel that was in here read as loose
// fabric on a figure that should not have any.
//
// A texture rather than uniform arrays, for the same reason the deformation
// brushes are a texture: it sidesteps uniform-array packing entirely, it has no
// awkward size ceiling, and it is one small upload per frame either way.
//
// The beauty pass and both shadow cascades include this file, so the surface
// they place is the same surface by construction — the mistake the terrain
// already paid for once.
// -----------------------------------------------------------------------------

/// Skin a point by one bone.
fn skinPoint1(tex: texture_2d<f32>, b: i32, p: vec3f) -> vec3f {
    let c0 = textureLoad(tex, vec2i(b, 0), 0);
    let c1 = textureLoad(tex, vec2i(b, 1), 0);
    let c2 = textureLoad(tex, vec2i(b, 2), 0);
    let c3 = textureLoad(tex, vec2i(b, 3), 0);
    return c0.xyz * p.x + c1.xyz * p.y + c2.xyz * p.z + c3.xyz;
}

/// Skin a direction by one bone (no translation).
fn skinDir1(tex: texture_2d<f32>, b: i32, d: vec3f) -> vec3f {
    let c0 = textureLoad(tex, vec2i(b, 0), 0);
    let c1 = textureLoad(tex, vec2i(b, 1), 0);
    let c2 = textureLoad(tex, vec2i(b, 2), 0);
    return c0.xyz * d.x + c1.xyz * d.y + c2.xyz * d.z;
}

/// Two-influence linear blend skinning. Two is enough for a figure built out of
/// bulky pressurised cylinders with a hard bearing at every joint: the bearings
/// are where a third influence would have earned its keep, and a bearing does not
/// deform.
fn skinPoint(tex: texture_2d<f32>, idx: vec4f, wt: vec4f, p: vec3f) -> vec3f {
    var r = skinPoint1(tex, i32(idx.x), p) * wt.x;
    if (wt.y > 0.0001) { r += skinPoint1(tex, i32(idx.y), p) * wt.y; }
    return r / max(1e-4, wt.x + wt.y);
}

fn skinNormal(tex: texture_2d<f32>, idx: vec4f, wt: vec4f, n: vec3f) -> vec3f {
    var r = skinDir1(tex, i32(idx.x), n) * wt.x;
    if (wt.y > 0.0001) { r += skinDir1(tex, i32(idx.y), n) * wt.y; }
    return normalize(r);
}
