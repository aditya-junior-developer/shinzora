#!/usr/bin/env python3
"""Generates the eight original P10 wallpapers in public/assets/themes/.

Every shape is simple geometry (circles, ellipses, rectangles, curves and
gradients) drawn from a fixed seed, so the output is reproducible. Nothing here
traces or copies an existing film, show, character or artwork.
Run: python3 scripts/gen-theme-wallpapers.py
"""
import math, os, random

W, H = 1600, 900
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "assets", "themes")


def svg(body, defs=""):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" '
        f'preserveAspectRatio="xMidYMid slice" role="img" aria-label="Wallpaper">'
        f"<defs>{defs}</defs>{body}</svg>\n"
    )


def lin(id_, stops, x1=0, y1=0, x2=0, y2=1):
    s = "".join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in stops)
    return f'<linearGradient id="{id_}" x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}">{s}</linearGradient>'


def rad(id_, stops, cx=0.5, cy=0.5, r=0.5):
    s = "".join(f'<stop offset="{o}" stop-color="{c}" stop-opacity="{a}"/>' for o, c, a in stops)
    return f'<radialGradient id="{id_}" cx="{cx}" cy="{cy}" r="{r}">{s}</radialGradient>'


def petal_sky():
    rnd = random.Random(11)
    d = lin("sky", [(0, "#ffe3ef"), (0.55, "#ffd0e4"), (1, "#a9dcff")])
    d += rad("sun", [(0, "#fff7d6", 1), (1, "#fff7d6", 0)])
    body = [f'<rect width="{W}" height="{H}" fill="url(#sky)"/>',
            f'<circle cx="1180" cy="300" r="260" fill="url(#sun)"/>']
    for cx, cy, s in [(260, 610, 1.0), (760, 700, 0.8), (1380, 640, 1.2)]:
        body.append(
            f'<g fill="#ffffff" fill-opacity="0.75">'
            f'<ellipse cx="{cx}" cy="{cy}" rx="{170*s}" ry="{46*s}"/>'
            f'<ellipse cx="{cx+90*s}" cy="{cy-30*s}" rx="{120*s}" ry="{50*s}"/>'
            f'<ellipse cx="{cx-100*s}" cy="{cy-18*s}" rx="{100*s}" ry="{40*s}"/></g>')
    for _ in range(70):
        x, y = rnd.uniform(0, W), rnd.uniform(0, H * 0.85)
        r = rnd.uniform(7, 15)
        rot = rnd.uniform(0, 360)
        op = rnd.uniform(0.35, 0.8)
        body.append(f'<ellipse cx="{x:.0f}" cy="{y:.0f}" rx="{r*1.9:.1f}" ry="{r:.1f}" '
                    f'transform="rotate({rot:.0f} {x:.0f} {y:.0f})" fill="#ff8fbf" fill-opacity="{op:.2f}"/>')
    return svg("".join(body), d)


def speed_lines():
    rnd = random.Random(22)
    d = lin("night", [(0, "#241a57"), (1, "#0d0a24")])
    d += rad("core", [(0, "#fff3b0", 1), (0.35, "#ffd65a", 0.85), (1, "#ffd65a", 0)], r=0.5)
    body = [f'<rect width="{W}" height="{H}" fill="url(#night)"/>']
    cx, cy = W * 0.62, H * 0.42
    for i in range(140):
        a = rnd.uniform(0, 2 * math.pi)
        r0 = rnd.uniform(120, 360)
        r1 = r0 + rnd.uniform(200, 900)
        x0, y0 = cx + r0 * math.cos(a), cy + r0 * math.sin(a)
        x1, y1 = cx + r1 * math.cos(a), cy + r1 * math.sin(a)
        w = rnd.uniform(0.8, 3.2)
        op = rnd.uniform(0.15, 0.7)
        col = "#ffffff" if i % 4 else "#ffd65a"
        body.append(f'<line x1="{x0:.1f}" y1="{y0:.1f}" x2="{x1:.1f}" y2="{y1:.1f}" '
                    f'stroke="{col}" stroke-width="{w:.2f}" stroke-opacity="{op:.2f}" stroke-linecap="round"/>')
    body.append(f'<circle cx="{cx:.0f}" cy="{cy:.0f}" r="210" fill="url(#core)"/>')
    return svg("".join(body), d)


def meadow_wind():
    d = lin("sky", [(0, "#cdeee2"), (0.6, "#fff4d8"), (1, "#fff9ea")])
    body = [f'<rect width="{W}" height="{H}" fill="url(#sky)"/>']
    layers = [("#bfe3b2", 520, 60, 1.0), ("#98cf9a", 610, 80, 1.6), ("#6fb88a", 720, 70, 2.3), ("#4f9a74", 820, 50, 3.1)]
    for col, base, amp, f in layers:
        pts = []
        for x in range(0, W + 40, 40):
            y = base + amp * math.sin(x / (W / (2 * math.pi)) * f + f) * 0.6 + amp * 0.3 * math.sin(x / 140.0 + f)
            pts.append(f"{x},{y:.0f}")
        body.append(f'<path d="M0,{H} L{" L".join(pts)} L{W},{H} Z" fill="{col}"/>')
    for k, (y, op) in enumerate([(300, 0.55), (360, 0.4), (250, 0.35)]):
        body.append(
            f'<path d="M-40,{y} C 300,{y-120} 600,{y+120} 900,{y-30} S 1400,{y-150} 1660,{y-40}" '
            f'fill="none" stroke="#ffffff" stroke-width="{10 - 2*k}" stroke-linecap="round" stroke-opacity="{op}"/>')
    body.append(f'<circle cx="1260" cy="200" r="90" fill="#fff8e0" fill-opacity="0.9"/>')
    return svg("".join(body), d)


def lantern_hills():
    rnd = random.Random(33)
    d = lin("dusk", [(0, "#f7d9bd"), (0.5, "#e9c6cf"), (1, "#b8c9ea")])
    d += rad("glow", [(0, "#ffd27a", 0.9), (1, "#ffd27a", 0)])
    body = [f'<rect width="{W}" height="{H}" fill="url(#dusk)"/>']
    for col, base, amp, ph in [("#c7a6c4", 560, 70, 0.4), ("#9d8ab8", 650, 90, 1.7), ("#6c6a98", 760, 60, 2.6)]:
        pts = []
        for x in range(0, W + 40, 40):
            y = base + amp * math.sin(x / 260.0 + ph) + amp * 0.35 * math.sin(x / 90.0 + ph * 2)
            pts.append(f"{x},{y:.0f}")
        body.append(f'<path d="M0,{H} L{" L".join(pts)} L{W},{H} Z" fill="{col}"/>')
    for _ in range(18):
        x = rnd.uniform(120, W - 120)
        y = rnd.uniform(640, 760)
        r = rnd.uniform(5, 9)
        body.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{r*5:.0f}" fill="url(#glow)"/>')
        body.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{r:.1f}" fill="#fff0c2"/>')
    return svg("".join(body), d)


def neon_grid():
    d = lin("night", [(0, "#07040f"), (0.6, "#1a0b33"), (1, "#2a0d3f")])
    d += rad("horizon", [(0, "#ff2e9a", 0.55), (1, "#ff2e9a", 0)], cx=0.5, cy=1, r=0.6)
    body = [f'<rect width="{W}" height="{H}" fill="url(#night)"/>',
            f'<ellipse cx="{W/2}" cy="{H*0.62}" rx="{W*0.6}" ry="{H*0.5}" fill="url(#horizon)"/>']
    hy = 560
    body.append(f'<rect x="0" y="{hy}" width="{W}" height="{H-hy}" fill="#0b0618"/>')
    body.append(f'<line x1="0" y1="{hy}" x2="{W}" y2="{hy}" stroke="#ff2e9a" stroke-width="3" stroke-opacity="0.9"/>')
    for i in range(-24, 25):
        x_bottom = W / 2 + i * 160
        body.append(f'<line x1="{W/2}" y1="{hy}" x2="{x_bottom:.0f}" y2="{H}" stroke="#39e6ff" stroke-width="1.6" stroke-opacity="0.55"/>')
    for k in range(1, 12):
        y = hy + (H - hy) * (k / 12) ** 1.9
        body.append(f'<line x1="0" y1="{y:.1f}" x2="{W}" y2="{y:.1f}" stroke="#39e6ff" stroke-width="1.4" stroke-opacity="{0.2 + k*0.05:.2f}"/>')
    body.append(f'<circle cx="{W/2}" cy="{hy-80}" r="120" fill="#ff2e9a" fill-opacity="0.18"/>')
    body.append(f'<circle cx="{W/2}" cy="{hy-80}" r="70" fill="#ffb3d9" fill-opacity="0.35"/>')
    return svg("".join(body), d)


def rain_towers():
    rnd = random.Random(44)
    d = lin("night", [(0, "#0a0716"), (1, "#1c0f2e")])
    body = [f'<rect width="{W}" height="{H}" fill="url(#night)"/>']
    x = -20
    while x < W:
        w = rnd.uniform(70, 150)
        h = rnd.uniform(300, 720)
        shade = rnd.choice(["#15102a", "#1b1338", "#120d24"])
        body.append(f'<rect x="{x:.0f}" y="{H-h:.0f}" width="{w:.0f}" height="{h:.0f}" fill="{shade}"/>')
        for wy in range(int(H - h + 24), H - 30, 34):
            for wx in range(int(x + 12), int(x + w - 12), 22):
                if rnd.random() < 0.22:
                    col = rnd.choice(["#39e6ff", "#ff2e9a", "#ffd65a"])
                    body.append(f'<rect x="{wx}" y="{wy}" width="6" height="10" fill="{col}" fill-opacity="{rnd.uniform(0.5,0.95):.2f}"/>')
        x += w + rnd.uniform(4, 24)
    for _ in range(260):
        x0 = rnd.uniform(0, W)
        y0 = rnd.uniform(0, H)
        L = rnd.uniform(18, 46)
        body.append(f'<line x1="{x0:.0f}" y1="{y0:.0f}" x2="{x0-L*0.25:.1f}" y2="{y0+L:.1f}" '
                    f'stroke="#9fd8ff" stroke-width="1" stroke-opacity="{rnd.uniform(0.06,0.22):.2f}"/>')
    return svg("".join(body), d)


def glass_mesh():
    d = lin("base", [(0, "#101426"), (1, "#1b1036")])
    d += rad("a", [(0, "#7cf0ff", 0.85), (1, "#7cf0ff", 0)])
    d += rad("b", [(0, "#ff8ad8", 0.8), (1, "#ff8ad8", 0)])
    d += rad("c", [(0, "#b7a4ff", 0.8), (1, "#b7a4ff", 0)])
    d += '<filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="22"/></filter>'
    body = [f'<rect width="{W}" height="{H}" fill="url(#base)"/>',
            f'<circle cx="300" cy="260" r="420" fill="url(#a)"/>',
            f'<circle cx="1300" cy="250" r="380" fill="url(#b)"/>',
            f'<circle cx="900" cy="760" r="460" fill="url(#c)"/>']
    for x, y, w, h, rot in [(420, 230, 760, 420, -8), (980, 470, 520, 300, 6)]:
        body.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="56" fill="#ffffff" fill-opacity="0.12" '
                    f'stroke="#ffffff" stroke-opacity="0.35" stroke-width="2" transform="rotate({rot} {x+w/2} {y+h/2})"/>')
    return svg("".join(body), d)


def quiet_gradient():
    d = lin("base", [(0, "#f2eefb"), (0.5, "#e6ecfb"), (1, "#f8eef4")])
    d += rad("warm", [(0, "#ffd9ec", 0.9), (1, "#ffd9ec", 0)])
    d += rad("cool", [(0, "#cfe3ff", 0.9), (1, "#cfe3ff", 0)])
    body = [f'<rect width="{W}" height="{H}" fill="url(#base)"/>',
            f'<circle cx="1200" cy="260" r="460" fill="url(#warm)"/>',
            f'<circle cx="360" cy="720" r="500" fill="url(#cool)"/>',
            f'<path d="M140,160 C 520,80 980,240 1460,140" fill="none" stroke="#7c6fd6" stroke-opacity="0.25" stroke-width="2"/>',
            f'<path d="M160,190 C 540,110 1000,270 1480,170" fill="none" stroke="#7c6fd6" stroke-opacity="0.15" stroke-width="2"/>']
    return svg("".join(body), d)


FILES = {
    "anime-petal-sky.svg": petal_sky,
    "anime-speed-lines.svg": speed_lines,
    "ghibli-meadow-wind.svg": meadow_wind,
    "ghibli-lantern-hills.svg": lantern_hills,
    "cyber-neon-grid.svg": neon_grid,
    "cyber-rain-towers.svg": rain_towers,
    "trend-glass-mesh.svg": glass_mesh,
    "trend-quiet-gradient.svg": quiet_gradient,
}

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for name, make in FILES.items():
        path = os.path.join(OUT, name)
        with open(path, "w", encoding="utf8") as fh:
            fh.write(make())
        print(f"wrote {name} {os.path.getsize(path)} bytes")
