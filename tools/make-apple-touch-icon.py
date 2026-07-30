"""Raster twin of public/favicon.svg, for the iOS home-screen icon.

    python3 tools/make-apple-touch-icon.py        # needs Pillow

iOS will not take an SVG for a home-screen icon, so public/apple-touch-icon.png
is the one binary in this repository. It exists as a *build product* rather than
an asset: this script is the source, the bezier control points below are copied
from the SVG verbatim, and if one moves both move.

There is no SVG rasteriser in the toolchain and adding one to a Vite project for
a single 180-pixel icon is not a trade worth making, so the geometry is drawn
directly. Supersampled 8x and box-filtered down, which is cheaper to write than a
scanline antialiaser and indistinguishable at this size.
"""
import math
import os
from PIL import Image, ImageDraw

SIZE = 180
SS = 8
W = SIZE * SS
K = W / 64.0            # SVG user units -> supersampled pixels

VOID = (5, 6, 15, 255)
SUIT = (196, 191, 210, 255)
GOLD = (255, 196, 107, 255)

def bez(p0, p1, p2, p3, n=48):
    out = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        out.append((u*u*u*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t*t*t*p3[0],
                    u*u*u*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t*t*t*p3[1]))
    return out

def path(start, segs):
    pts, cur = [start], start
    for c1, c2, end in segs:
        pts += bez(cur, c1, c2, end)[1:]
        cur = end
    return pts

def xf(pts, tx, ty, deg=0.0):
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return [((x*c - y*s + tx) * K, (x*s + y*c + ty) * K) for x, y in pts]

img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([0, 0, W - 1, W - 1], radius=14 * K, fill=VOID)

board = path((0, -19), [
    ((4.9, -11.9), (9.2, -4.2), (9.2, 1.7)),
    ((9.2, 8.6), (4.9, 15.5), (1.8, 19.0)),
    ((0.6, 19.8), (-0.6, 19.8), (-1.8, 19.0)),
    ((-4.9, 15.5), (-9.2, 8.6), (-9.2, 1.7)),
    ((-9.2, -4.2), (-4.9, -11.9), (0, -19)),
])
d.polygon(xf(board, 29.5, 37, 41), fill=SUIT)
d.line(xf([(0, -14), (0, 16)], 29.5, 37, 41), fill=VOID, width=int(1.3 * K), joint="curve")

for r, a in ((12, 0.14), (6, 0.20)):
    glow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse(
        [(42.0 - r) * K, (22.7 - r) * K, (42.0 + r) * K, (22.7 + r) * K],
        fill=GOLD[:3] + (int(255 * a),))
    img = Image.alpha_composite(img, glow)
d = ImageDraw.Draw(img)

star = path((0, -12.5), [
    ((2.2, -3.9), (3.9, -2.2), (12.5, 0)),
    ((3.9, 2.2), (2.2, 3.9), (0, 12.5)),
    ((-2.2, 3.9), (-3.9, 2.2), (-12.5, 0)),
    ((-3.9, -2.2), (-2.2, -3.9), (0, -12.5)),
])
d.polygon(xf(star, 42.0, 22.7), fill=GOLD)

out = os.path.join(os.path.dirname(__file__), "..", "public", "apple-touch-icon.png")
img.resize((SIZE, SIZE), Image.LANCZOS).convert("RGB").save(out)
print("wrote", os.path.normpath(out))

