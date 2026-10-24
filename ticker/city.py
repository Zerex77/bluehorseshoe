"""Duval City: a lively scrolling scene with lots to look at (like a city screensaver).

A loop of neighborhoods slides by over a far skyline: the river with a blue lift bridge, a teal-and-gold
stadium with a Jaguars billboard, a busy construction site (tower crane swinging a beam, excavator
digging, a building going up), a neon arcade, the beach boardwalk, a guitar-shaped hotel with a
night light show, and a birthday party in the park. A train rolls through every so often. Cars drive both ways on the
street, a plane tows a GO JAGS! banner now and then, birds fly over, and the sky follows the time of
day. Everything is original pixel art; team logos come from ESPN like the rest of the ticker.
"""
import math
import random
import time

from PIL import Image, ImageDraw

import lofi
import render as R

H = 32
FPS = 30
DT = 1.0 / FPS
# Smooth motion on LEDs: every layer moves exactly one whole pixel every N frames (never fractions,
# which make things stutter), counted in frames rather than wall-clock time.
NEAR_N, MID_N, FAR_N = 2, 3, 8   # street 15 px/s, neighborhoods 10 px/s, far skyline ~4 px/s
SPEED = FPS / NEAR_N
SKY_LOOP = 7 * 160     # the far skyline repeats every 160 buildings
GROUND = 25            # where buildings stand; the street is below
LOOP = 1150            # length of one loop of neighborhoods

TEAL, GOLD, BLACK = (0, 120, 140), (215, 162, 42), (0, 0, 0)
LANES = [(27, 1), (30, -1)]   # (y, direction): top lane goes with the scroll, bottom lane against


def _mix(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


# ---------------------------------------------------------------- neighborhoods (x0 = left edge on screen)
def bridge(d, x0, t, P):
    """River with a blue lift bridge (two towers and a raised center span)."""
    water = _mix(P['water'], (40, 90, 160), 0.3)
    d.rectangle((x0 - 10, GROUND - 4, x0 + 170, GROUND), fill=water)
    for i in range(12):
        sx = x0 + (i * 17 + int(t * 6)) % 180 - 10
        d.line((sx, GROUND - 2 + i % 3, sx + 3, GROUND - 2 + i % 3), fill=_mix(water, (220, 230, 255), 0.4))
    blue = (40, 110, 220) if not P['night'] else (60, 140, 255)
    for tx in (x0 + 40, x0 + 110):                       # towers
        d.rectangle((tx, GROUND - 19, tx + 6, GROUND - 1), fill=blue)
        d.rectangle((tx - 1, GROUND - 20, tx + 7, GROUND - 19), fill=_mix(blue, (255, 255, 255), 0.3))
        if P['night']:
            d.point((tx + 3, GROUND - 21), fill=(255, 60, 60))
    lift = 2 + 2 * math.sin(t * 0.3)                    # the center span slowly rising and settling
    for xa, xb, y in ((x0, x0 + 40, 14), (x0 + 47, x0 + 109, int(14 - lift)), (x0 + 117, x0 + 160, 14)):
        d.line((xa, y, xb, y), fill=blue, width=2)
        for k in range(xa, xb, 6):                        # truss
            d.line((k, y - 3, k + 3, y), fill=blue)
            d.line((k + 3, y, k + 6, y - 3), fill=blue)
        d.line((xa, y - 3, xb, y - 3), fill=blue)


def stadium(d, img, x0, t, P, logos):
    """Teal-and-gold stadium with light towers and a Jaguars billboard."""
    d.polygon([(x0, GROUND), (x0 + 8, GROUND - 13), (x0 + 112, GROUND - 13), (x0 + 120, GROUND)], fill=TEAL)
    d.line((x0 + 4, GROUND - 7, x0 + 116, GROUND - 7), fill=GOLD, width=2)
    for k in range(x0 + 14, x0 + 108, 7):                 # arches
        d.rectangle((k, GROUND - 4, k + 3, GROUND - 1), fill=(0, 60, 75))
    for lx in (x0 + 2, x0 + 118):                         # light towers
        d.line((lx, GROUND - 1, lx, GROUND - 22), fill=(120, 120, 130))
        on = P['night'] or P['win'] > 0
        lamp = (255, 255, 220) if on and int(t * 3 + lx) % 7 else (150, 150, 150)
        d.rectangle((lx - 3, GROUND - 24, lx + 3, GROUND - 22), fill=lamp)
    # billboard on top: logo + DUVAL
    bx = x0 + 34
    d.rectangle((bx, GROUND - 25, bx + 52, GROUND - 13), fill=BLACK, outline=GOLD)
    logo = logos.get({'abbreviation': 'JAX'}, 'nfl', 11) if logos else None
    if logo is not None:
        R._paste_logo(img, logo, bx + 2, GROUND - 24, 11)
    word = 'DUVAL'
    col = GOLD if int(t * 2) % 4 else TEAL
    d.text((bx + 15, GROUND - 25 + 2 - R.caps(R.F_SMALL)[0] + 0), word, font=R.F_SMALL, fill=col)


def construction(d, x0, t, P):
    """Tower crane swinging a beam, excavator digging, dump truck, a building going up, cones, a worker."""
    yellow, orange, steel = (250, 190, 30), (255, 120, 20), (150, 155, 165)
    # building under construction (steel frame + scaffolding)
    bx = x0 + 120
    for fy in range(GROUND - 15, GROUND, 5):
        d.line((bx, fy, bx + 34, fy), fill=steel)
    for fx in range(bx, bx + 35, 7):
        d.line((fx, GROUND - 15, fx, GROUND - 1), fill=steel)
    d.line((bx + 36, GROUND - 13, bx + 36, GROUND - 1), fill=orange)
    d.line((bx + 36, GROUND - 13, bx + 40, GROUND - 13), fill=orange)
    # tower crane
    mx = x0 + 95
    for y in range(GROUND - 1, 3, -3):                    # lattice mast
        d.line((mx, y, mx + 3, y - 3), fill=yellow)
        d.line((mx + 3, y, mx, y - 3), fill=yellow)
    d.line((mx, GROUND - 1, mx, 3), fill=yellow)
    d.line((mx + 3, GROUND - 1, mx + 3, 3), fill=yellow)
    d.line((mx - 26, 3, mx + 46, 3), fill=yellow, width=2)  # jib
    d.line((mx + 1, 0, mx + 46, 3), fill=yellow)
    d.rectangle((mx - 26, 4, mx - 19, 7), fill=(110, 110, 120))   # counterweight
    d.rectangle((mx - 1, 4, mx + 4, 7), fill=(60, 70, 90))        # cab
    trolley = mx + 12 + int(16 * (0.5 + 0.5 * math.sin(t * 0.35)))
    drop = 9 + int(4 * (0.5 + 0.5 * math.sin(t * 0.5)))
    sway = math.sin(t * 1.3) * 1.5
    d.line((trolley, 4, trolley + sway, 4 + drop), fill=(200, 200, 200))
    d.rectangle((trolley + sway - 6, 4 + drop, trolley + sway + 6, 5 + drop), fill=orange)   # steel beam
    if P['night']:
        d.point((mx + 46, 2), fill=(255, 60, 60) if int(t * 2) % 2 else (90, 20, 20))
    # excavator digging
    ex = x0 + 20
    d.polygon([(ex + 18, GROUND), (ex + 22, GROUND - 3), (ex + 32, GROUND - 3), (ex + 34, GROUND)], fill=(120, 75, 40))   # dirt pile
    d.rectangle((ex, GROUND - 3, ex + 16, GROUND - 1), fill=(40, 40, 45))      # tracks
    d.rectangle((ex + 1, GROUND - 8, ex + 13, GROUND - 4), fill=yellow)         # body
    d.rectangle((ex + 9, GROUND - 12, ex + 14, GROUND - 8), fill=yellow)        # cab
    d.rectangle((ex + 10, GROUND - 11, ex + 13, GROUND - 9), fill=(40, 60, 90))
    a1 = -0.9 + 0.35 * math.sin(t * 1.1)                  # boom
    a2 = 1.1 + 0.6 * math.sin(t * 1.1 + 1.2)              # stick
    p0 = (ex + 14, GROUND - 9)
    p1 = (p0[0] + math.cos(a1) * 9, p0[1] + math.sin(a1) * 9)
    p2 = (p1[0] + math.cos(a2) * 8, p1[1] + math.sin(a2) * 8)
    d.line((p0, p1), fill=yellow, width=2)
    d.line((p1, p2), fill=yellow, width=2)
    d.polygon([p2, (p2[0] + 3, p2[1] - 1), (p2[0] + 2, p2[1] + 2)], fill=(70, 70, 75))
    # dump truck
    tx = x0 + 52
    d.rectangle((tx, GROUND - 7, tx + 14, GROUND - 3), fill=yellow)
    d.polygon([(tx, GROUND - 7), (tx + 2, GROUND - 10), (tx + 13, GROUND - 10), (tx + 14, GROUND - 7)], fill=(120, 75, 40))
    d.rectangle((tx + 15, GROUND - 7, tx + 19, GROUND - 3), fill=(220, 160, 20))
    d.rectangle((tx + 16, GROUND - 6, tx + 18, GROUND - 5), fill=(40, 60, 90))
    for wx in (tx + 3, tx + 16):
        d.ellipse((wx - 2, GROUND - 4, wx + 2, GROUND), fill=(30, 30, 30))
    # cones and a hard-hat worker walking back and forth with a hammer
    for cx in (x0 + 5, x0 + 44, x0 + 82, x0 + 165):
        d.polygon([(cx - 2, GROUND), (cx, GROUND - 4), (cx + 2, GROUND)], fill=orange)
        d.line((cx - 1, GROUND - 2, cx + 1, GROUND - 2), fill=(255, 255, 255))
    wx = x0 + 160 - int(abs(((t * 6) % 40) - 20))
    swing = math.sin(t * 6)
    d.rectangle((wx - 1, GROUND - 9, wx + 1, GROUND - 8), fill=yellow)        # hard hat
    d.point((wx, GROUND - 7), fill=(210, 165, 130))
    d.line((wx, GROUND - 6, wx, GROUND - 3), fill=orange, width=2)            # safety vest
    d.line((wx, GROUND - 3, wx + int(swing * 2), GROUND - 1), fill=(50, 60, 90))
    d.line((wx, GROUND - 3, wx - int(swing * 2), GROUND - 1), fill=(50, 60, 90))
    d.line((wx, GROUND - 5, wx + 2, GROUND - 7 + int(swing * 2)), fill=(150, 150, 150))   # hammer


def arcade(d, x0, t, P):
    """Neon arcade: cycling ARCADE marquee, glowing screens, a controller sign, a gamer on a bench."""
    d.rectangle((x0, GROUND - 16, x0 + 70, GROUND - 1), fill=(45, 20, 70))
    neon = [(255, 60, 200), (60, 230, 255), (255, 230, 60), (120, 255, 120)]
    col = neon[int(t * 1.5) % len(neon)]
    d.rectangle((x0 + 4, GROUND - 15, x0 + 66, GROUND - 7), fill=(20, 5, 35), outline=col)
    word = 'ARCADE'
    tw = R.text_w(R.F_SMALL, word)
    top, bot = R.caps(R.F_SMALL)
    d.text((x0 + 35 - tw // 2, GROUND - 11 - (top + bot) // 2), word, font=R.F_SMALL, fill=col)
    for k in range(4):                                   # game screens glowing in the windows
        sx = x0 + 6 + k * 16
        sc = neon[(k + int(t * 2.3 + k)) % len(neon)]
        d.rectangle((sx, GROUND - 5, sx + 9, GROUND - 2), fill=_mix(sc, (0, 0, 0), 0.45))
        d.point((sx + 2 + int(t * 5 + k) % 6, GROUND - 4), fill=(255, 255, 255))
    # neon controller sign on the roof
    cx, cy = x0 + 35, GROUND - 21
    d.rounded_rectangle((cx - 9, cy - 3, cx + 9, cy + 3), radius=3, outline=neon[(int(t) + 1) % 4])
    d.line((cx - 6, cy, cx - 2, cy), fill=neon[(int(t) + 1) % 4])
    d.line((cx - 4, cy - 2, cx - 4, cy + 2), fill=neon[(int(t) + 1) % 4])
    d.point((cx + 4, cy - 1), fill=neon[(int(t) + 2) % 4])
    d.point((cx + 6, cy + 1), fill=neon[(int(t) + 3) % 4])
    d.line((cx, GROUND - 18, cx, GROUND - 16), fill=(120, 120, 130))
    # bench + gamer with a glowing handheld
    gx = x0 + 82
    d.line((gx - 4, GROUND - 3, gx + 8, GROUND - 3), fill=(110, 80, 50), width=2)
    d.ellipse((gx, GROUND - 11, gx + 3, GROUND - 8), fill=(210, 165, 130))
    d.line((gx + 1, GROUND - 7, gx + 1, GROUND - 4), fill=(60, 180, 120), width=2)
    d.line((gx + 1, GROUND - 3, gx + 4, GROUND - 3), fill=(50, 60, 90))
    d.line((gx + 4, GROUND - 3, gx + 4, GROUND), fill=(50, 60, 90))
    d.rectangle((gx + 3, GROUND - 7, gx + 5, GROUND - 6), fill=neon[int(t * 4) % 4])


def beach(d, x0, t, P):
    """Sand, lapping water, palms and a lamp (from the calm beach scene)."""
    d.rectangle((x0, GROUND - 3, x0 + 160, GROUND), fill=P['sand'])
    d.rectangle((x0, GROUND - 6, x0 + 160, GROUND - 4), fill=P['water'])
    for x in range(x0, x0 + 160):
        if math.sin((x + t * 6) * 0.25) + math.sin(t * 1.5) > 1.2:
            d.point((x, GROUND - 4), fill=(235, 240, 255))
    for k, px in enumerate((x0 + 20, x0 + 75, x0 + 130)):
        lofi._palm(d, px, GROUND, t + k, P['night'])
    lofi._lamp(d, x0 + 102, GROUND, P['night'])


def guitar_hotel(d, x0, t, P):
    """A guitar-shaped glass hotel tower standing on a podium, with a light show at night."""
    cx = x0 + 26
    night = P['night'] or P['win'] > 0
    glass = (70, 110, 150) if not P['night'] else (14, 18, 40)
    show = [(170, 60, 255), (60, 140, 255), (255, 60, 180), (60, 230, 255), (255, 210, 80)]
    rim = show[int(t * 1.2) % len(show)] if night else (200, 215, 230)
    d.rectangle((x0, GROUND - 4, x0 + 52, GROUND - 1), fill=_mix(glass, (60, 60, 70), 0.5))      # podium
    if night:
        for k in range(x0 + 2, x0 + 52, 4):
            d.point((k, GROUND - 3), fill=(230, 190, 110))
    shapes = [('e', (cx - 13, 15, cx + 13, 25)), ('e', (cx - 9, 7, cx + 9, 17)), ('r', (cx - 1, 1, cx + 1, 8))]
    for kind, (a, b, c, e) in shapes:                     # outline first, then glass inside
        (d.ellipse if kind == 'e' else d.rectangle)((a - 1, b - 1, c + 1, e + 1), fill=rim)
    for kind, box in shapes:
        (d.ellipse if kind == 'e' else d.rectangle)(box, fill=glass)
    d.rectangle((cx - 3, 0, cx + 3, 2), fill=rim)         # headstock
    
    for dx, y, lit in _GUITAR_WINDOWS:                     # floors
        if night:
            if lit:
                d.point((cx + dx, y), fill=(230, 200, 140))
        else:
            d.point((cx + dx, y), fill=_mix(glass, (200, 225, 245), 0.45))
    if night:                                              # glowing strings running up the neck
        col = show[int(t * 3) % len(show)]
        d.line((cx, 2, cx, 21), fill=col)
        for k in range(3):                                 # light beams sweeping the sky
            a = -1.57 + math.sin(t * 0.7 + k * 2.1) * 0.6
            d.line((cx, 0, cx + math.cos(a) * 30, math.sin(a) * 30), fill=_mix(show[k], (0, 0, 0), 0.6))


def img_inside(x, y, cx):
    """Is (x, y) inside the guitar body (two stacked ellipses)?"""
    return (((x - cx) / 12.0) ** 2 + ((y - 20) / 4.5) ** 2 < 1) or (((x - cx) / 8.0) ** 2 + ((y - 12) / 4.0) ** 2 < 1)


_GUITAR_WINDOWS = [(dx, y, random.Random(dx * 31 + y).random() < 0.35)
                   for y in range(9, 24, 2) for dx in range(-12, 13, 2) if img_inside(dx, y, 0)]


def _person(d, x, base, shirt, t, hat=None, jump=0.0):
    y = base - int(max(0.0, jump))
    d.ellipse((x - 1, y - 9, x + 1, y - 7), fill=(210, 165, 130))
    if hat:
        d.polygon([(x - 1, y - 9), (x, y - 12), (x + 1, y - 9)], fill=hat)
    d.line((x, y - 6, x, y - 3), fill=shirt, width=2)
    sw = math.sin(t * 6 + x)
    d.line((x, y - 3, x + int(sw), y), fill=(50, 60, 90))
    d.line((x, y - 3, x - int(sw), y), fill=(50, 60, 90))


def park(d, x0, t, P):
    """A birthday party in the park: bunting, balloons, a cake with candles, kids in party hats."""
    night = P['night']
    grass = (50, 150, 60) if not night else (18, 50, 25)
    d.rectangle((x0, GROUND - 2, x0 + 130, GROUND - 1), fill=grass)
    for tx in (x0 + 8, x0 + 122):                          # trees
        d.line((tx, GROUND - 1, tx, GROUND - 10), fill=(90, 60, 35), width=2)
        d.ellipse((tx - 7, GROUND - 22, tx + 7, GROUND - 9), fill=(40, 130, 55) if not night else (15, 45, 25))
    party = [(255, 70, 90), (255, 210, 60), (70, 170, 255), (120, 230, 120), (220, 110, 255)]
    for x in range(x0 + 12, x0 + 119, 3):                  # bunting / string lights between the trees
        sag = int(4 * math.sin(math.pi * (x - x0 - 12) / 107.0))
        y = GROUND - 15 + sag
        col = party[(x // 3) % len(party)]
        if night:
            col = col if int(t * 2 + x // 3) % 3 else _mix(col, (0, 0, 0), 0.6)
            d.point((x, y), fill=col)
        else:
            d.polygon([(x, y), (x + 2, y), (x + 1, y + 2)], fill=col)
    # picnic table with the cake
    tx = x0 + 58
    d.rectangle((tx, GROUND - 7, tx + 22, GROUND - 6), fill=(150, 100, 60))
    d.line((tx + 3, GROUND - 5, tx + 3, GROUND - 1), fill=(120, 80, 50))
    d.line((tx + 19, GROUND - 5, tx + 19, GROUND - 1), fill=(120, 80, 50))
    d.rectangle((tx + 8, GROUND - 10, tx + 14, GROUND - 8), fill=(255, 150, 190))
    d.line((tx + 8, GROUND - 10, tx + 14, GROUND - 10), fill=(255, 255, 255))
    for k, cx in enumerate((tx + 9, tx + 11, tx + 13)):
        d.point((cx, GROUND - 11), fill=(200, 200, 255))
        d.point((cx, GROUND - 12), fill=(255, 220, 80) if int(t * 8 + k) % 3 else (255, 140, 40))
    # balloons tied to the table, bobbing
    for k in range(3):
        bx = tx + 21 + k * 3
        by = GROUND - 19 - k * 2 + int(math.sin(t * 1.5 + k) * 1.5)
        d.line((tx + 21, GROUND - 7, bx + 1, by + 4), fill=(200, 200, 200))
        d.ellipse((bx - 1, by, bx + 3, by + 4), fill=party[k])
    # kids in party hats hopping around, a grown-up by the cake
    _person(d, tx - 4, GROUND - 1, (90, 140, 230), t)
    for k, (kx, shirt) in enumerate(((x0 + 30, (255, 120, 80)), (x0 + 42, (120, 220, 140)), (x0 + 95, (230, 200, 60)))):
        hop = abs(math.sin(t * 3 + k * 1.7)) * 3
        _person(d, kx + int(math.sin(t * 0.8 + k) * 3), GROUND - 1, shirt, t + k, hat=party[k + 1], jump=hop)
    # confetti burst every few seconds
    ph = (t + x0 * 0.01) % 6
    if ph < 1.8:
        r = random.Random(int((t + x0 * 0.01) // 6))
        for i in range(14):
            vx, vy = r.uniform(-12, 12), r.uniform(-18, -8)
            px, py = tx + 11 + vx * ph, GROUND - 12 + vy * ph + 10 * ph * ph
            if py < GROUND - 1:
                d.point((px, py), fill=party[i % len(party)])


HOODS = [(0, 170, 'bridge'), (200, 125, 'stadium'), (360, 180, 'construction'), (580, 100, 'arcade'), (720, 160, 'beach'), (905, 55, 'guitar'), (990, 130, 'park')]


# ---------------------------------------------------------------- moving things
class Traffic:
    COLORS = [(220, 60, 60), (60, 120, 230), (240, 240, 240), (250, 200, 40), (60, 200, 120), (0, 120, 140)]

    def __init__(self, w):
        self.w = w
        self.cars = [self._new(lane, random.uniform(0, w)) for lane in LANES for _ in range(3)]

    def _new(self, lane, x=None):
        y, dirn = lane
        # whole-pixel moves on a fixed beat: top lane drifts slowly either way, bottom lane rushes past
        if dirn > 0:
            step, every = random.choice([(1, 4), (1, 6), (-1, 5), (-1, 3)])
        else:
            step, every = -1, 1
        if x is None:
            x = (self.w + 12) if step < 0 else -14
        return {'x': int(x), 'y': y, 'dir': dirn, 'step': step, 'every': every,
                'col': random.choice(self.COLORS), 'truck': random.random() < 0.2}

    def step(self, d, f, night):
        for c in self.cars:
            if f % c['every'] == 0:
                c['x'] += c['step']
            if c['x'] < -30 or c['x'] > self.w + 30:
                c.update(self._new((c['y'], c['dir'])))
            x, y = c['x'], c['y']
            ln = 12 if c['truck'] else 8
            d.rectangle((x, y - 2, x + ln, y), fill=c['col'])
            d.rectangle((x + (2 if c['dir'] > 0 else ln - 5), y - 3, x + (5 if c['dir'] > 0 else ln - 2), y - 2), fill=c['col'])
            front = x + ln if c['dir'] > 0 else x
            back = x if c['dir'] > 0 else x + ln
            if night:
                d.point((front, y - 1), fill=(255, 250, 200))
                d.point((front + c['dir'], y - 1), fill=(160, 150, 110))
                d.point((back, y - 1), fill=(220, 30, 30))


_BG = {}


def _background(w, P):
    """Sky gradient + far skyline drawn once per time of day, as a strip we just slide a window over."""
    key = (w, P['top'], P['bot'])
    if key not in _BG:
        _BG.clear()
        strip = Image.new('RGB', (SKY_LOOP + w + 14, H))
        d = ImageDraw.Draw(strip)
        for y in range(GROUND):
            d.line((0, y, strip.width, y), fill=_mix(P['top'], P['bot'], y / (GROUND - 1)))
        for k in range(strip.width // 7 + 1):
            r = random.Random((k % 160) * 7919 + 1)
            bw, bh = r.randint(5, 9), r.randint(3, 11)
            x = k * 7
            d.rectangle((x, GROUND - bh, x + bw, GROUND - 1), fill=_mix(P['bld'], P['bot'], 0.35))
            if P['win']:
                for wy in range(GROUND - bh + 2, GROUND - 1, 2):
                    for wx in range(x + 1, x + bw, 2):
                        if random.Random((k % 160) * 131 + wy * 7 + wx).random() < P['win'] * 0.7:
                            d.point((wx, wy), fill=(230, 190, 110))
        _BG[key] = strip
    return _BG[key]


def _train(d, w, f, near, P):
    """A train rolls through about once a minute, two pixels a frame."""
    tf = f % (70 * FPS) - 20 * FPS
    if not 0 <= tf < (w + 230) // 2:
        return
    tx = w + 10 - tf * 2
    d.line((0, GROUND - 1, w, GROUND - 1), fill=(90, 85, 80))
    for x in range(-near % 4, w, 4):
        d.point((x, GROUND), fill=(110, 80, 50))
    silver = (190, 195, 205) if not P['night'] else (90, 95, 110)
    for car in range(7):
        cx = tx + car * 30
        if cx > w or cx + 30 < 0:
            continue
        if car == 0:
            d.polygon([(cx, GROUND - 3), (cx + 4, GROUND - 10), (cx + 28, GROUND - 10), (cx + 28, GROUND - 3)], fill=TEAL)
            d.rectangle((cx + 6, GROUND - 9, cx + 10, GROUND - 7), fill=(40, 60, 90))
            d.line((cx + 2, GROUND - 4, cx + 28, GROUND - 4), fill=GOLD)
            d.point((cx + 1, GROUND - 4), fill=(255, 250, 200) if P['night'] or (f // 8) % 2 else (200, 200, 160))
        else:
            d.rectangle((cx, GROUND - 10, cx + 28, GROUND - 3), fill=silver)
            d.line((cx, GROUND - 5, cx + 28, GROUND - 5), fill=TEAL)
            for wx in range(cx + 3, cx + 26, 5):
                d.rectangle((wx, GROUND - 9, wx + 2, GROUND - 7), fill=(255, 220, 140) if P['night'] else (60, 90, 130))
        for wx in (cx + 4, cx + 24):
            d.ellipse((wx - 2, GROUND - 4, wx + 2, GROUND), fill=(30, 30, 35))
        d.line((cx + 28, GROUND - 5, cx + 30, GROUND - 5), fill=(80, 80, 80))


DRAW = {'bridge': bridge, 'construction': construction, 'arcade': arcade, 'beach': beach,
        'guitar': guitar_hotel, 'park': park}


def frames(w, logos=None):
    traffic = Traffic(w)
    stars = [(random.randrange(w), random.randrange(0, 12), random.random() * 6.28) for _ in range(35)]
    birds = []
    f = 0
    while True:
        f += 1
        t = f * DT
        P = lofi.palette(lofi._now_et().hour)
        far, mid, near = f // FAR_N, f // MID_N, f // NEAR_N
        img = Image.new('RGB', (w, H))
        bg = _background(w, P)
        o = far % SKY_LOOP
        img.paste(bg.crop((o, 0, o + w, H)), (0, 0))
        d = ImageDraw.Draw(img)
        d.fontmode = '1'
        if P['night']:
            for sx, sy, ph in stars:
                if math.sin(t * 1.3 + ph) > -0.2 and img.getpixel(((sx - f // 50) % w, sy)) == bg.getpixel((0, sy)):
                    d.point(((sx - f // 50) % w, sy), fill=(200, 200, 230))
        # birds, one pixel every other frame
        if random.random() < 0.007 and not P['night']:
            birds.append([w + 5, random.randint(3, 12)])
        for b in birds:
            if f % 2 == 0:
                b[0] -= 1
            flap = (f // 5 + b[1]) % 2
            d.line((b[0] - 2, b[1] - flap, b[0], b[1]), fill=(40, 40, 50))
            d.line((b[0], b[1], b[0] + 2, b[1] - flap), fill=(40, 40, 50))
        birds[:] = [b for b in birds if b[0] > -5]
        # neighborhoods
        base = (mid // LOOP) * LOOP
        for loop in (base - LOOP, base, base + LOOP):
            for x, width, name in HOODS:
                sx = loop + x - mid
                if sx + width + 30 < 0 or sx - 30 > w:
                    continue
                if name == 'stadium':
                    stadium(d, img, sx, t, P, logos)
                else:
                    DRAW[name](d, sx, t, P)
        # plane towing a banner: one pixel a frame, every 45 seconds
        pf = f % (45 * FPS)
        if pf < w + 200:
            px = w + 60 - pf
            d.polygon([(px, 5), (px + 9, 4), (px + 9, 6)], fill=(230, 230, 235))
            d.line((px + 5, 2, px + 5, 8), fill=(200, 200, 210))
            d.line((px + 9, 5, px + 13, 5), fill=(180, 180, 180))
            word = 'GO JAGS!'
            bw = R.text_w(R.F_SMALL, word) + 6
            d.rectangle((px + 13, 1, px + 13 + bw, 9), fill=GOLD)
            top, bot = R.caps(R.F_SMALL)
            d.text((px + 16, 5 - (top + bot) // 2), word, font=R.F_SMALL, fill=(0, 70, 85))
        # street
        d.rectangle((0, GROUND, w, H), fill=(40, 40, 46) if not P['night'] else (22, 22, 28))
        d.line((0, GROUND, w, GROUND), fill=(110, 110, 115))
        for x in range(-near % 10, w, 10):
            d.line((x, 28, x + 4, 28), fill=(200, 180, 80))
        traffic.step(d, f, P['night'])
        _train(d, w, f, near, P)
        yield img
