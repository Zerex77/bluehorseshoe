"""Lofi idle scene: an endless, slow-scrolling city skyline over the ocean, seen from a boardwalk.

Layers move at different speeds for depth (skyline, water, sand, boardwalk with palms and lamps), a
person strolls along, and the sky follows the real time of day: day, sunset, night (moon, stars,
lit windows, glowing lamps). Generated as it goes, so it never repeats.
"""
import math
import random
import time
from datetime import datetime

from PIL import Image, ImageDraw

H = 32
FPS = 24
DT = 1.0 / FPS
# Smooth motion: each layer moves one whole pixel every N frames (fractions make LEDs stutter).
NEAR_N, FAR_N = 1, 6   # boardwalk 24 px/s, skyline 4 px/s
SPEED = FPS / NEAR_N
SKY_LOOP = 7 * 160

HORIZON = 19         # skyline base / top of the water
SAND = 25
WALK = 28            # boardwalk top


def _now_et():
    try:
        import legs
        return datetime.now(legs.ET)
    except Exception:
        return datetime.now()


def palette(hour):
    """Sky top, sky bottom, water, building, window chance, sun/moon, night?"""
    if 7 <= hour < 17:
        return dict(top=(40, 110, 200), bot=(140, 195, 235), water=(25, 95, 150), bld=(70, 85, 110),
                    win=0.0, orb=(255, 235, 150), night=False, sand=(190, 160, 110), walk=(120, 80, 50))
    if 17 <= hour < 20 or 6 <= hour < 7:
        return dict(top=(60, 30, 90), bot=(250, 120, 60), water=(70, 40, 80), bld=(35, 25, 50),
                    win=0.25, orb=(255, 170, 70), night=False, sand=(120, 80, 70), walk=(80, 50, 40))
    return dict(top=(4, 6, 20), bot=(20, 25, 60), water=(8, 14, 40), bld=(18, 20, 35),
                win=0.45, orb=(230, 230, 210), night=True, sand=(45, 40, 50), walk=(45, 32, 30))


def _rng(k, salt):
    return random.Random(k * 7919 + salt * 104729)


def _mix(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


_BG = {}
_clock = [time.time()]


def _background(w, P):
    """Sky + far skyline (with lit windows) drawn once per time of day; antenna lights listed to blink."""
    key = (w, P['top'], P['bot'])
    if key not in _BG:
        _BG.clear()
        strip = Image.new('RGB', (SKY_LOOP + w + 14, H))
        d = ImageDraw.Draw(strip)
        for y in range(HORIZON):
            d.line((0, y, strip.width, y), fill=_mix(P['top'], P['bot'], y / (HORIZON - 1)))
        antennas = []
        for k in range(strip.width // 7 + 1):
            r = _rng(k % 160, 1)
            bw, bh = r.randint(5, 9), r.randint(4, 14) if r.random() > 0.15 else 0
            if not bh:
                continue
            x = k * 7
            d.rectangle((x, HORIZON - bh, x + bw, HORIZON - 1), fill=P['bld'])
            if r.random() < 0.2:
                d.line((x + bw // 2, HORIZON - bh - 3, x + bw // 2, HORIZON - bh - 1), fill=P['bld'])
                antennas.append((x + bw // 2, HORIZON - bh - 3, k))
            if P['win']:
                for wy in range(HORIZON - bh + 2, HORIZON - 1, 2):
                    for wx in range(x + 1, x + bw, 2):
                        wr = _rng((k % 160) * 131 + wy * 7 + wx, 2)
                        if wr.random() < P['win']:
                            d.point((wx, wy), fill=(255, 210, 120) if wr.random() < 0.8 else (160, 220, 255))
        _BG[key] = (strip, antennas)
    return _BG[key]


def frames(w):
    stars = [(random.randrange(w), random.randrange(0, HORIZON - 8), random.random() * 6.28) for _ in range(40)]
    sparkles = [(random.randrange(w * 3), random.randint(HORIZON, SAND - 1), random.randint(3, 6),
                 random.randint(1, 3), i) for i in range(70)]
    f = 0
    _clock[0] = time.time()
    while True:
        f += 1
        now = f * DT
        hour = _now_et().hour
        P = palette(hour)
        far, near = f // FAR_N, f // NEAR_N
        img = Image.new('RGB', (w, H))
        strip, antennas = _background(w, P)
        o = far % SKY_LOOP
        img.paste(strip.crop((o, 0, o + w, H)), (0, 0))
        d = ImageDraw.Draw(img)
        if P['night']:
            for ax, ay, k in antennas:
                if o - 2 <= ax < o + w + 2 and (f // 15 + k) % 3 == 0:
                    d.point((ax - o, ay), fill=(255, 60, 60))
            for sx, sy, ph in stars:
                b = 0.5 + 0.5 * math.sin(now * 1.3 + ph)
                x = (sx - f // 75) % w
                if b > 0.35 and img.getpixel((x, sy)) == strip.getpixel((0, sy)):
                    d.point((x, sy), fill=_mix((40, 40, 60), (230, 230, 255), b))
        # sun / moon, far away so it barely moves (behind the skyline is fine: it's low)
        ox = int(w * 0.72 - (f // 200)) % (w + 40) - 20
        oy = 5 if P['night'] or 7 <= hour < 17 else 11
        sky_at = _mix(P['top'], P['bot'], oy / HORIZON)
        d.ellipse((ox - 4, oy - 4, ox + 4, oy + 4), fill=P['orb'])
        if P['night']:
            d.ellipse((ox - 2, oy - 5, ox + 5, oy + 2), fill=sky_at)   # crescent
        # water, sparkles drifting one pixel at a time
        for y in range(HORIZON, SAND):
            d.line((0, y, w, y), fill=_mix(P['water'], P['bot'], 0.15 * (SAND - y) / 6))
        for x0, y, n, ln, i in sparkles:
            if math.sin(now * 2 + i) > 0.2:
                x = (x0 - f // n) % w
                d.line((x, y, x + ln, y), fill=_mix(P['water'], (220, 230, 255), 0.45))
        for y in range(HORIZON, SAND):
            if math.sin(now * 5 + y * 1.7) > -0.2:
                wob = int(math.sin(now * 3 + y) * 2)
                d.line((ox - 2 + wob, y, ox + 2 + wob, y), fill=_mix(P['water'], P['orb'], 0.55))
        # sand with a gentle wave line
        d.rectangle((0, SAND, w, WALK - 1), fill=P['sand'])
        for x in range(w):
            if math.sin((x + f // 5) * 0.25) + math.sin(now * 1.5) > 1.2:
                d.point((x, SAND), fill=(235, 240, 255))
        # boardwalk: planks, palms and lamps, one pixel every other frame
        d.rectangle((0, WALK, w, H), fill=P['walk'])
        for x in range(-near % 6, w, 6):
            d.line((x, WALK, x, H), fill=_mix(P['walk'], (0, 0, 0), 0.35))
        d.line((0, WALK, w, WALK), fill=_mix(P['walk'], (255, 255, 255), 0.25))
        k0 = near // 40 - 1
        for k in range(k0, k0 + w // 40 + 3):
            r = _rng(k, 4)
            x = k * 40 + r.randint(0, 20) - near
            if r.random() < 0.55:
                _palm(d, x, WALK, now + k, P['night'])
            else:
                _lamp(d, x, WALK, P['night'])
        _walker(d, int(w * 0.38), WALK, now)
        if f % (60 * FPS) == 0:
            print('scene: %.1f fps (target %d)' % (60 * FPS / max(0.001, time.time() - _clock[0]), FPS), flush=True)
            _clock[0] = time.time()
        yield img


def _palm(d, x, base, t, night):
    trunk = (70, 50, 35) if not night else (35, 28, 22)
    leaf = (40, 140, 70) if not night else (20, 55, 35)
    sway = math.sin(t * 0.8) * 1.2
    pts = [(x + int(math.sin(i / 3.0) * 2 + sway * i / 14), base - i) for i in range(0, 18)]
    for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
        d.line((x1, y1, x2, y2), fill=trunk, width=2)
    tx, ty = pts[-1]
    for ang in (-2.6, -2.0, -1.2, -0.5, 0.1):
        a = ang + math.sin(t * 0.8) * 0.08
        ex, ey = tx + math.cos(a) * 8, ty + math.sin(a) * 5 + 3
        d.line((tx, ty, (tx + ex) / 2, ty - 2), fill=leaf, width=2)
        d.line(((tx + ex) / 2, ty - 2, ex, ey), fill=leaf, width=1)


def _lamp(d, x, base, night):
    pole = (60, 60, 70) if not night else (40, 40, 48)
    d.line((x, base, x, base - 15), fill=pole)
    d.line((x, base - 15, x + 3, base - 15), fill=pole)
    if night:
        d.line((x - 3, base, x + 9, base), fill=(150, 110, 60))          # pool of light on the boards
        d.line((x - 1, base + 1, x + 7, base + 1), fill=(95, 70, 40))
        for px, py in ((x + 1, base - 15), (x + 5, base - 15), (x + 3, base - 17), (x + 3, base - 12)):
            d.point((px, py), fill=(120, 95, 50))                        # faint halo
        d.rectangle((x + 2, base - 15, x + 4, base - 14), fill=(255, 225, 150))
    else:
        d.rectangle((x + 2, base - 15, x + 4, base - 14), fill=(200, 200, 190))


def _walker(d, x, base, t):
    step = math.sin(t * 5.5)   # stride keeps pace with the scroll
    skin, shirt, pants = (210, 165, 130), (230, 120, 90), (50, 60, 90)
    d.ellipse((x - 2, base - 14, x + 1, base - 11), fill=skin)                 # head
    d.line((x, base - 10, x, base - 5), fill=shirt, width=2)                     # body
    d.line((x, base - 9, x + int(step * 2), base - 6), fill=skin)                # arm swing
    d.line((x, base - 5, x + int(step * 2.5), base - 1), fill=pants)             # legs
    d.line((x, base - 5, x - int(step * 2.5), base - 1), fill=pants)
