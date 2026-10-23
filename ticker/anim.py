"""Football celebration animations for the LED ticker.

Each animation is a generator of (PIL image, seconds to hold it). bhticker.py plays one before the
regular text flash when a leg hits, a leg loses (ref waves it off, or just short of the marker on a near miss), or a slip cashes (game-winning field goal).

    pick(row)  -> animation name for a leg that hit, based on what the leg is
    play(name, width, text) -> frames
"""
import math
import random
import re

from PIL import Image, ImageDraw

import render as R

H = 32
FPS = 30
DT = 1.0 / FPS

GREEN = (43, 214, 123)
GOLD = R.GOLD
RED = R.RED
BLUE = R.BLUE
WHITE = R.WHITE
LEATHER = (150, 72, 24)
TURF = (0, 46, 16)
TURF_LINE = (40, 110, 60)
LANE = (58, 34, 12)
LANE_LINE = (95, 60, 25)
CONFETTI = [GOLD, BLUE, GREEN, RED, (255, 120, 200), WHITE]


# ---------------------------------------------------------------- picking
def pick_loss(row):
    """Which animation fits a leg that just lost: JUST SHORT for a near miss, NO GOOD otherwise."""
    lab = (row.get('label') or '')
    m_cur = re.search(r'(\d+(?:\.\d+)?)', row.get('right') or '')
    m_line = re.search(r'(\d+(?:\.\d+)?)', lab)
    if (row.get('market') in ('prop', 'total') and m_cur and m_line
            and not re.search(r'\bunder\b', lab, re.I)):
        cur, line = float(m_cur.group(1)), float(m_line.group(1))
        if line > 0 and 0.85 <= cur / line < 1.0:
            return 'short:%g:%g' % (cur, line)
    return 'nogood'


def pick(row):
    """Which celebration fits a leg that just hit."""
    m = row.get('market')
    lab = ' ' + (row.get('label') or '').lower()
    if m == 'ml':
        return 'winner'
    if m == 'spread':
        return 'covered'
    if m == 'total':
        return 'under' if ' under' in lab or re.search(r'\bu\s*\d', lab) else 'over'
    if re.search(r'\btds?\b|touchdown', lab):
        return 'touchdown'
    if re.search(r'pass|comp\.|completion', lab):
        return 'dime'
    if re.search(r'rec\.?\b|receptions|catch', lab):
        return 'catch'
    if re.search(r'rush|carries', lab):
        return 'breakaway'
    return 'hit'


# ---------------------------------------------------------------- drawing helpers
def canvas(w, bg=(0, 0, 0)):
    img = Image.new('RGB', (w, H), bg)
    d = ImageDraw.Draw(img)
    d.fontmode = '1'
    return img, d


def dim(c, k):
    return tuple(max(0, min(255, int(v * k))) for v in c)


def ease_out(t):
    return 1 - (1 - t) ** 3


def bounce(t):
    if t < 1 / 2.75:
        return 7.5625 * t * t
    if t < 2 / 2.75:
        t -= 1.5 / 2.75
        return 7.5625 * t * t + 0.75
    if t < 2.5 / 2.75:
        t -= 2.25 / 2.75
        return 7.5625 * t * t + 0.9375
    t -= 2.625 / 2.75
    return 7.5625 * t * t + 0.984375


def football(d, cx, cy, spin=0, size=1.0):
    rx, ry = 6 * size, 3.5 * size
    if spin % 4 in (1, 3):  # mid-spiral: looks rounder
        rx, ry = 5 * size, 4 * size
    d.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill=LEATHER)
    if spin % 4 != 2:
        d.line((cx - 2 * size, cy, cx + 2 * size, cy), fill=WHITE)
        d.point((cx, cy - 1), fill=WHITE)
        d.point((cx, cy + 1), fill=WHITE)


def horseshoe(d, x, y, col=BLUE, s=1.0):
    w, h = 18 * s, 24 * s
    d.arc((x, y, x + w, y + h), 0, 180, fill=col, width=max(2, int(4 * s)))
    d.line((x + 1, y, x + 1, y + h / 2), fill=col, width=max(2, int(4 * s)))
    d.line((x + w - 1, y, x + w - 1, y + h / 2), fill=col, width=max(2, int(4 * s)))
    for k in (0.25, 0.5):  # nail holes
        d.point((x + 1, y + h * k), fill=(0, 0, 0))
        d.point((x + w - 1, y + h * k), fill=(0, 0, 0))


def big_text(d, w, text, col, x=None, y=None, font=None):
    font = font or R.F_FLASH
    tw = R.text_w(font, text)
    asc, desc = font.getmetrics()
    x = (w - tw) // 2 if x is None else x
    y = (H - asc - desc) // 2 + 1 if y is None else y
    d.text((x, y), text, font=font, fill=col)
    return tw


def outline_text(d, w, text, col, edge=(0, 0, 0), x=None):
    font = R.F_FLASH
    tw = R.text_w(font, text)
    asc, desc = font.getmetrics()
    x = (w - tw) // 2 if x is None else x
    y = (H - asc - desc) // 2 + 1
    for ox, oy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
        d.text((x + ox, y + oy), text, font=font, fill=edge)
    d.text((x, y), text, font=font, fill=col)


def slam(w, word, cols, seconds=1.3, bg=(0, 0, 0), under=None):
    """Big word that pops in and blinks between colors."""
    n = int(seconds * FPS)
    for i in range(n):
        img, d = canvas(w, bg)
        if under:
            under(img, d, i)
        col = cols[(i // 4) % len(cols)]
        outline_text(d, w, word, col)
        yield img, DT


class Particles:
    def __init__(self):
        self.p = []

    def burst(self, x, y, n, speed=(1.5, 4.0), cols=CONFETTI, up=0.0, life=(18, 32)):
        for _ in range(n):
            a = random.uniform(0, 2 * math.pi)
            v = random.uniform(*speed)
            self.p.append([x, y, math.cos(a) * v, math.sin(a) * v - up, random.choice(cols), random.randint(*life)])

    def step(self, d, gravity=0.12, drag=0.96):
        alive = []
        for q in self.p:
            q[0] += q[2]
            q[1] += q[3]
            q[2] *= drag
            q[3] = q[3] * drag + gravity
            q[5] -= 1
            if q[5] > 0:
                k = min(1.0, q[5] / 10)
                d.point((q[0], q[1]), fill=dim(q[4], k))
                alive.append(q)
        self.p = alive


# ---------------------------------------------------------------- leg animations
def anim_breakaway(w, text):
    """Rushing: a runner breaks loose and sprints across a scrolling field."""
    n = int(1.6 * FPS)
    dust = Particles()
    for i in range(n):
        t = i / n
        img, d = canvas(w, TURF)
        off = i * 9
        for k in range(-1, w // 24 + 2):
            x = k * 24 - off % 24
            d.line((x, 0, x, H), fill=TURF_LINE)
            d.line((x + 12, 14, x + 12, 17), fill=TURF_LINE)
        x = -14 + ease_out(t) * (w * 0.55)
        if i % 2 == 0:
            dust.p.append([x - 6, 27, -random.uniform(1, 3), -random.uniform(0, 0.8), (110, 140, 90), 12])
        dust.step(d, gravity=0.02)
        for s in range(3):  # speed lines
            d.line((x - 22 - s * 6, 9 + s * 6, x - 12 - s * 6, 9 + s * 6), fill=dim(WHITE, 0.5))
        _runner(d, x, 29, i)
        yield img, DT
    for f in slam(w, 'BREAKAWAY!', [GOLD, WHITE], bg=TURF, under=lambda im, d, i: _field_static(d, w)):
        yield f


def _field_static(d, w):
    for k in range(w // 24 + 1):
        d.line((k * 24, 0, k * 24, H), fill=TURF_LINE)


def _runner(d, x, ground, i):
    stride = (i // 3) % 2
    hip = (x, ground - 10)
    d.ellipse((x - 3, ground - 26, x + 3, ground - 20), fill=GOLD)          # helmet
    d.line((x + 2, ground - 23, x + 4, ground - 23), fill=WHITE)            # facemask
    d.line((x, ground - 20, x - 1, ground - 10), fill=BLUE, width=3)        # body
    football(d, x + 3, ground - 16, 0, 0.6)                                 # tucked ball
    if stride:
        d.line((hip[0], hip[1], x + 5, ground), fill=WHITE, width=2)
        d.line((hip[0], hip[1], x - 6, ground - 3), fill=WHITE, width=2)
    else:
        d.line((hip[0], hip[1], x + 2, ground), fill=WHITE, width=2)
        d.line((hip[0], hip[1], x - 3, ground - 1), fill=WHITE, width=2)
    d.line((x, ground - 17, x - 5, ground - 13 + stride * 2), fill=BLUE, width=2)  # arm


def anim_catch(w, text):
    """Receiving: the ball arcs across the strip and gets snagged with a burst."""
    n = int(1.3 * FPS)
    x0, x1 = 10, w - 34
    trail = []
    sparks = Particles()
    for i in range(n + 14):
        img, d = canvas(w)
        t = min(1.0, i / n)
        x = x0 + (x1 - x0) * t
        y = 26 - 22 * math.sin(math.pi * t)
        if i < n:
            trail.append((x, y))
        for k, (tx, ty) in enumerate(trail[-14::2]):
            d.point((tx, ty), fill=dim(WHITE, 0.25 + k * 0.08))
        # hands waiting at the catch point
        hx = x1 + 6
        d.ellipse((hx - 2, 19, hx + 4, 25), fill=(200, 150, 110))
        d.ellipse((hx + 2, 21, hx + 8, 27), fill=(200, 150, 110))
        if i == n:
            sparks.burst(x1, 26, 40, speed=(1, 3.5), cols=[GOLD, WHITE, GREEN], up=1)
        sparks.step(d)
        football(d, x, y, i // 2)
        yield img, DT
    for f in slam(w, 'CAUGHT IT!', [GREEN, WHITE]):
        yield f


def anim_dime(w, text):
    """Passing: a tight spiral rockets downfield into a bullseye."""
    n = int(1.1 * FPS)
    tx = w - 24
    trail = []
    for i in range(n + 16):
        img, d = canvas(w)
        t = min(1.0, i / n)
        hit = i >= n
        ring_cols = [RED, WHITE, RED, GOLD] if not hit or (i // 3) % 2 else [GOLD, GOLD, WHITE, GOLD]
        for k, r in enumerate((12, 9, 6, 3)):
            d.ellipse((tx - r, 16 - r, tx + r, 16 + r), outline=ring_cols[k])
        x = 6 + (tx - 6) * ease_out(t) if not hit else tx
        y = 22 - 14 * math.sin(math.pi * t * 0.9) if not hit else 16
        trail.append((x, y))
        for k, (px, py) in enumerate(trail[-10:]):
            d.point((px, py), fill=dim(GOLD, 0.2 + k * 0.08))
        football(d, x, y, i)
        if hit:
            r = (i - n) * 2
            d.ellipse((tx - r, 16 - r, tx + r, 16 + r), outline=dim(GOLD, max(0.2, 1 - (i - n) / 16)))
        yield img, DT
    for f in slam(w, 'DIME!', [GOLD, WHITE]):
        yield f


PX_PER_YD = 6
GOAL_X = 75 * PX_PER_YD          # world x of the goal line (ball snapped at our own 25)
ENDZONE = (16, 40, 100)


def _field_world(d, w, cam):
    """Football field in world coordinates, drawn from camera position cam."""
    d.rectangle((0, 0, w, H), fill=TURF)
    ez0 = GOAL_X - cam
    ez1 = GOAL_X + 10 * PX_PER_YD - cam
    if ez0 < w:
        d.rectangle((ez0, 0, ez1, H), fill=ENDZONE)
        for k in range(int(ez0) - 40, int(ez1), 8):  # end zone hash
            d.line((k, H, k + 20, 0), fill=dim(ENDZONE, 1.35))
        horseshoe(d, ez0 + 4, 4, dim(GOLD, 0.8), 0.9)
        if ez1 < w:
            d.rectangle((ez1, 0, w, H), fill=(6, 18, 8))
    first = int(cam // (5 * PX_PER_YD))
    for k in range(first, first + w // (5 * PX_PER_YD) + 2):
        wx = k * 5 * PX_PER_YD
        yd = 25 + k * 5
        if yd > 100:
            break
        x = wx - cam
        d.line((x, 0, x, H), fill=WHITE if yd == 100 else TURF_LINE)
        if yd % 10 == 0 and yd < 100:
            n = str(min(yd, 100 - yd))
            d.text((x - R.text_w(R.F_SMALL, n) // 2, 0), n, font=R.F_SMALL, fill=dim(WHITE, 0.55))
        for hx in range(1, 5):  # hash marks
            xx = x + hx * PX_PER_YD
            d.point((xx, 13), fill=TURF_LINE)
            d.point((xx, 19), fill=TURF_LINE)


def _player(d, x, ground, pose, i=0, jersey=BLUE):
    """Little football player. pose: run / throw_back / throw / arms_up / catch."""
    d.ellipse((x - 3, ground - 26, x + 3, ground - 20), fill=GOLD)
    d.line((x + 2, ground - 23, x + 4, ground - 23), fill=WHITE)
    d.line((x, ground - 20, x, ground - 10), fill=jersey, width=3)
    hip = (x, ground - 10)
    if pose == 'run':
        st = (i // 3) % 2
        d.line((hip, (x + (5 if st else 2), ground)), fill=WHITE, width=2)
        d.line((hip, (x - (6 if st else 3), ground - (3 if st else 1))), fill=WHITE, width=2)
    else:
        d.line((hip, (x + 3, ground)), fill=WHITE, width=2)
        d.line((hip, (x - 3, ground)), fill=WHITE, width=2)
    sh = (x, ground - 18)
    if pose == 'throw_back':
        d.line((sh, (x - 5, ground - 24)), fill=jersey, width=2)
        d.line((sh, (x + 4, ground - 15)), fill=jersey, width=2)
    elif pose == 'throw':
        d.line((sh, (x + 6, ground - 25)), fill=jersey, width=2)
        d.line((sh, (x - 3, ground - 14)), fill=jersey, width=2)
    elif pose in ('arms_up', 'catch'):
        d.line((sh, (x - 4, ground - 28)), fill=jersey, width=2)
        d.line((sh, (x + 4, ground - 28)), fill=jersey, width=2)
    else:
        d.line((sh, (x - 5, ground - 13 + (i // 3) % 2 * 2)), fill=jersey, width=2)


def anim_touchdown(w, text):
    """TDs: the QB drops back and lets it fly, the camera rides with the ball downfield,
    and the receiver hauls it in in the end zone. Then fireworks."""
    qb_x = 46
    rec_x = GOAL_X + 40
    cam_max = GOAL_X + 10 * PX_PER_YD + 20 - w
    drop, flight = int(0.7 * FPS), int(1.9 * FPS)
    fw = Particles()
    trail = []
    for i in range(drop + flight + int(1.8 * FPS)):
        if i < drop:  # dropback + throw
            img, d = canvas(w)
            _field_world(d, w, 0)
            pose = 'throw' if i > drop - 5 else 'throw_back'
            _player(d, qb_x - min(i, 12) * 0.6, 30, pose)
            if pose == 'throw_back':
                football(d, qb_x - min(i, 12) * 0.6 - 6, 6, 0, 0.6)
            yield img, DT
            continue
        f = min(1.0, (i - drop) / flight)
        t = f * f * (3 - 2 * f) * 0.35 + f * 0.65            # quick release, slight settle at the end
        bx = qb_x + 6 + (rec_x - qb_x - 6) * t
        by = 6 - 3 * t + 7 * math.sin(math.pi * t)            # leaves the QB's hand, rides mid-screen, drops into the hands
        size = 0.8 + 0.35 * math.sin(math.pi * t)              # 3rd person: ball looms bigger mid-flight
        cam = max(0.0, min(cam_max, bx - 110))
        img, d = canvas(w)
        _field_world(d, w, cam)
        if qb_x - cam > -10:
            _player(d, qb_x - 7 - cam, 30, 'throw')
        rx = rec_x - cam
        caught = f >= 1
        if rx < w + 10:
            run_in = 0 if t > 0.85 else (0.85 - t) * 60
            _player(d, rx - run_in, 30, 'catch' if t > 0.8 else 'run', i)
        trail.append((bx, by))
        for k, (tx, ty) in enumerate(trail[-12::2]):
            d.point((tx - cam, ty), fill=dim(WHITE, 0.2 + k * 0.1))
        if caught:
            football(d, rx, 3, 0, 0.8)
        else:
            football(d, bx - cam, by, i, size)
        if caught:
            k = i - drop - flight
            if k % 6 == 0:
                fw.burst(random.randint(20, w - 20), random.randint(4, 14), 30, speed=(1.2, 3.0),
                         cols=[random.choice(CONFETTI)], life=(14, 24))
            fw.step(d, gravity=0.05, drag=0.93)
            if k >= 6:
                outline_text(d, w, 'TOUCHDOWN!', [GOLD, WHITE, GREEN][(k // 4) % 3], x=12)
        yield img, DT


def anim_winner(w, text, word='WINNER!'):
    """Moneyline / spread: the Blue Horseshoe drops in, bounces, and sparkles."""
    n = int(1.0 * FPS)
    hx = 8
    sp = Particles()
    for i in range(n + int(1.5 * FPS)):
        img, d = canvas(w)
        t = min(1.0, i / n)
        y = -28 + 32 * bounce(t)
        horseshoe(d, hx, y)
        horseshoe(d, w - 26, y)
        if i == n:
            sp.burst(hx + 9, 16, 24, cols=[GOLD, WHITE, BLUE])
            sp.burst(w - 17, 16, 24, cols=[GOLD, WHITE, BLUE])
        if i > n and i % 5 == 0:
            sp.burst(random.randint(30, w - 30), random.randint(3, 28), 6, speed=(0.3, 1.2), cols=[GOLD, WHITE], life=(8, 14))
        sp.step(d, gravity=0.04)
        if i >= n - 6:
            slide = max(0.0, 1 - (i - (n - 6)) / 8)
            tw = R.text_w(R.F_FLASH, word)
            x = (w - tw) // 2 + int(slide * w)
            outline_text(d, w, word, [GOLD, WHITE][(i // 5) % 2], x=x)
        yield img, DT


def anim_covered(w, text):
    return anim_winner(w, text, 'COVERED!')


def anim_total(w, text, over=True):
    """Totals: a scoreboard counter spins up past the line."""
    m = re.search(r'(\d+(?:\.\d+)?)', text or '')
    line = float(m.group(1)) if m else 45.5
    target = int(math.floor(line)) + 1 if over else int(math.floor(line))
    n = int(1.4 * FPS)
    font = R.F_FLASH
    word = 'OVER!' if over else 'UNDER!'
    for i in range(n + int(1.3 * FPS)):
        img, d = canvas(w)
        t = min(1.0, i / n)
        val = int(round(target * ease_out(t)))
        s = '%d' % val
        # scoreboard box
        bw = R.text_w(font, '888') + 10
        bx = 6
        d.rectangle((bx, 2, bx + bw, 29), outline=GOLD)
        d.text((bx + bw - 5 - R.text_w(font, s), 6), s, font=font,
               fill=GREEN if t >= 1 and (i // 4) % 2 else (255, 140, 30))
        lt = 'LINE %s' % R.ascii_safe(('%g' % line))
        d.text((bx + bw + 8, 3), lt, font=R.F_SMALL, fill=R.DIM)
        bar_x0, bar_x1 = bx + bw + 8, w - R.text_w(font, 'UNDER!') - 18
        d.rectangle((bar_x0, 18, bar_x1, 22), outline=R.SEP)
        fill = min(1.0, val / max(1.0, line))
        d.rectangle((bar_x0 + 1, 19, bar_x0 + 1 + int((bar_x1 - bar_x0 - 2) * fill), 21), fill=GREEN if over else BLUE)
        lx = bar_x0 + int((bar_x1 - bar_x0) * min(1.0, line / max(line, target)))
        d.line((lx, 15, lx, 25), fill=WHITE)
        if t >= 1:
            tw = R.text_w(font, word)
            d.text((w - tw - 10, 6), word, font=font, fill=[GOLD, WHITE][(i // 5) % 2])
        yield img, DT


def anim_over(w, text):
    return anim_total(w, text, True)


def anim_under(w, text):
    return anim_total(w, text, False)


def anim_hit(w, text):
    """Anything else: confetti cannon from both ends."""
    c = Particles()
    for i in range(int(1.8 * FPS)):
        img, d = canvas(w)
        if i in (0, 8, 16):
            c.burst(4, 30, 30, speed=(2, 5), up=2)
            c.burst(w - 4, 30, 30, speed=(2, 5), up=2)
        c.step(d, gravity=0.15)
        if i > 6:
            outline_text(d, w, 'HIT!', [GREEN, WHITE][(i // 4) % 2])
        yield img, DT


# ---------------------------------------------------------------- injury
def _cart(d, x, i):
    """Medical cart driving left: white body, red cross, blinking light."""
    d.rectangle((x, 14, x + 30, 25), fill=WHITE)                 # body
    d.rectangle((x + 4, 8, x + 16, 14), outline=(150, 160, 180))  # windshield frame / roof
    d.line((x + 4, 8, x + 22, 8), fill=(150, 160, 180))
    d.rectangle((x + 19, 16, x + 27, 18), fill=RED)              # red cross
    d.rectangle((x + 22, 13, x + 24, 21), fill=RED)
    d.ellipse((x + 3, 23, x + 9, 29), fill=(30, 30, 30))         # wheels
    d.ellipse((x + 21, 23, x + 27, 29), fill=(30, 30, 30))
    d.rectangle((x + 9, 5, x + 11, 7), fill=(255, 176, 32) if (i // 4) % 2 else (90, 60, 10))  # light


def anim_injury(w, text):
    """A player on a slip got hurt: he's down, the medical cart drives out. INJURY."""
    drive, hold = int(1.2 * FPS), int(1.3 * FPS)
    px = w // 2 - 30
    for i in range(drive + hold):
        img, d = canvas(w, TURF)
        for k in range(0, w, 30):
            d.line((k, 0, k, H), fill=TURF_LINE)
        # player down on the field, a trainer kneeling next to him
        d.ellipse((px - 22, 23, px - 16, 29), fill=GOLD)
        d.line((px - 16, 26, px - 2, 27), fill=BLUE, width=3)
        d.line((px - 2, 27, px + 6, 29), fill=WHITE, width=2)
        d.ellipse((px + 2, 13, px + 7, 18), fill=(225, 190, 150))
        d.line((px + 4, 18, px + 4, 24), fill=(200, 40, 40), width=2)
        d.line((px + 4, 24, px + 9, 29), fill=(30, 30, 30), width=2)
        t = min(1.0, i / drive)
        _cart(d, w + 4 - (w + 4 - (px + 16)) * ease_out(t), i)
        if i > drive - 6:
            k = i - (drive - 6)
            word = 'INJURY'
            tw = R.text_w(R.F_FLASH, word)
            outline_text(d, w, word, [(255, 176, 32), WHITE][(k // 6) % 2], x=px + 60 + max(0, 30 - k * 5) if px + 60 + tw < w else 4)
        yield img, DT


# ---------------------------------------------------------------- field goal (a slip cashed)
def anim_fieldgoal(w, text):
    """Slip cashed: the game-winning field goal. Snap, kick, it splits the uprights,
    IT'S GOOD! and then money rains with the payout."""
    post_x = w - 46
    hold_x = 36
    approach, flight = int(0.6 * FPS), int(1.3 * FPS)
    sp = Particles()
    for i in range(approach + flight + int(1.0 * FPS)):
        img, d = canvas(w, TURF)
        for k in range(0, w, 30):
            d.line((k, 0, k, H), fill=TURF_LINE)
        # goal post (side view, the ball flies away from us through it)
        good = i >= approach + int(flight * 0.62)
        pc = GOLD if not good or (i // 3) % 2 else WHITE
        d.line((post_x, 31, post_x, 20), fill=pc, width=2)
        d.line((post_x - 12, 20, post_x + 12, 20), fill=pc, width=2)
        d.line((post_x - 12, 20, post_x - 12, 0), fill=pc, width=2)
        d.line((post_x + 12, 20, post_x + 12, 0), fill=pc, width=2)
        # holder kneeling
        d.ellipse((hold_x + 3, 16, hold_x + 9, 22), fill=GOLD)
        d.line((hold_x + 6, 22, hold_x + 6, 27), fill=BLUE, width=3)
        d.line((hold_x + 6, 27, hold_x + 11, 30), fill=WHITE, width=2)
        if i < approach:  # kicker's run-up and swing
            kx = hold_x - 30 + i * (24 / approach)
            _player(d, kx, 30, 'run', i, jersey=(220, 220, 230))
            football(d, hold_x + 1, 27, 0, 0.7)
            if i > approach - 4:
                d.line((kx, 20, kx + 8, 24), fill=WHITE, width=2)  # leg swing
        else:
            _player(d, hold_x - 4, 30, 'arms_up' if good else 'stand', i, jersey=(220, 220, 230))
            t = (i - approach) / flight
            if t <= 1:
                bx = hold_x + 1 + (post_x - hold_x + 6) * t
                by = 27 - 30 * math.sin(math.pi * t * 0.62)
                football(d, bx, by, i, max(0.35, 0.9 - 0.55 * t))
            if good and i == approach + int(flight * 0.62):
                sp.burst(post_x, 6, 40, cols=[GOLD, WHITE], up=1)
                sp.burst(post_x, 6, 20, cols=[GREEN], up=1)
        sp.step(d)
        if good:
            k = i - (approach + int(flight * 0.62))
            if k > 3:
                outline_text(d, w, "IT'S GOOD!", [GOLD, WHITE][(k // 4) % 2], x=hold_x + 30)
        yield img, DT
    for f in _money_rain(w, text):
        yield f


def _money_rain(w, text):
    bills = [[random.uniform(0, w), random.uniform(-40, 0), random.uniform(0.5, 1.4)] for _ in range(26)]
    msg = R.ascii_safe(text or 'CASHED').upper()
    font = R.F_FLASH
    while R.text_w(font, msg) > w - 50 and font.size > 11:
        font = R._font('DejaVuSansCondensed-Bold.ttf', font.size - 1)
    for i in range(int(2.4 * FPS)):
        img, d = canvas(w, (0, 18, 6))
        for b in bills:
            b[1] += b[2]
            if b[1] > H + 6:
                b[1] = -8
                b[0] = random.uniform(0, w)
            d.text((b[0], b[1]), '$', font=R.F_SMALL, fill=dim(GREEN, 0.6 + 0.4 * (b[2] > 1)))
        horseshoe(d, 4, 4, GOLD, 0.95)
        horseshoe(d, w - 22, 4, GOLD, 0.95)
        tw = R.text_w(font, msg)
        asc, desc = font.getmetrics()
        x, y = (w - tw) // 2, (H - asc - desc) // 2 + 1
        for ox, oy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            d.text((x + ox, y + oy), msg, font=font, fill=(0, 0, 0))
        d.text((x, y), msg, font=font, fill=[GOLD, WHITE][(i // 6) % 2])
        yield img, DT


# ---------------------------------------------------------------- losses
STRIPE = (20, 20, 20)


def _ref(d, x, ground, arms):
    """Referee in stripes. arms: 0..1 sweep for the wave-off (arms crossing in front)."""
    d.ellipse((x - 3, ground - 26, x + 3, ground - 20), fill=(225, 190, 150))   # face
    d.rectangle((x - 3, ground - 27, x + 3, ground - 25), fill=WHITE)           # cap
    d.line((x + 3, ground - 25, x + 5, ground - 25), fill=WHITE)                # bill
    for k in range(5):                                                          # striped shirt
        d.line((x - 2, ground - 19 + k * 2, x + 2, ground - 19 + k * 2), fill=WHITE if k % 2 == 0 else STRIPE, width=1)
        d.line((x - 2, ground - 18 + k * 2, x + 2, ground - 18 + k * 2), fill=STRIPE if k % 2 == 0 else WHITE, width=1)
    d.line((x - 1, ground - 9, x - 3, ground), fill=STRIPE, width=2)            # legs
    d.line((x + 1, ground - 9, x + 3, ground), fill=STRIPE, width=2)
    sw = math.sin(arms * math.pi * 2) * 13                                      # arms sweep across, waist high
    sh = ground - 18
    skin = (225, 190, 150)
    for side in (-1, 1):
        hx, hy = x + side * 3 + side * sw, sh + 4
        d.line((x + side * 3, sh, hx, hy), fill=STRIPE, width=2)
        d.rectangle((hx - 1, hy - 1, hx + 1, hy + 1), fill=skin)


def anim_nogood(w, text):
    """A leg lost: the referee waves it off. NO GOOD."""
    n = int(2.4 * FPS)
    rx = 44
    for i in range(n):
        img, d = canvas(w, TURF)
        for k in range(0, w, 30):
            d.line((k, 0, k, H), fill=TURF_LINE)
        _ref(d, rx, 30, i / 14.0)
        if i > 8:
            outline_text(d, w, 'NO GOOD', [RED, WHITE][(i // 6) % 2], x=rx + 40)
        yield img, DT


def anim_short(w, text):
    """A near miss: the runner dives for the marker and the ball is spotted just short.
    text is 'cur:line' (e.g. '64:69.5')."""
    try:
        cur, line = [float(v) for v in (text or '').split(':')[:2]]
    except ValueError:
        cur, line = 0.0, 0.0
    marker_x = int(w * 0.62)
    spot_x = marker_x - 4                       # the ball's nose stops just shy of the line
    dash, dive = int(0.8 * FPS), int(0.5 * FPS)
    for i in range(dash + dive + int(1.6 * FPS)):
        img, d = canvas(w, TURF)
        for k in range(0, w, 30):
            d.line((k, 0, k, H), fill=TURF_LINE)
        d.line((marker_x, 0, marker_x, H), fill=(255, 215, 0), width=2)        # TV first-down line
        d.rectangle((marker_x - 1, 0, marker_x + 1, 4), fill=(255, 120, 0))   # chain stick on the sideline
        if i < dash:
            t = i / dash
            x = 10 + (spot_x - 34 - 10) * t
            _player(d, x, 30, 'run', i)
            football(d, x + 3, 14, 0, 0.6)
        else:
            k = i - dash
            t = min(1.0, k / dive)
            bx = spot_x - 34 + 28 * ease_out(t)   # body slides forward on the dive
            # diving runner, stretched out flat with the ball out in front
            d.ellipse((bx - 30, 20, bx - 24, 26), fill=GOLD)
            d.line((bx - 24, 24, bx - 8, 25), fill=BLUE, width=3)
            d.line((bx - 8, 25, bx + 2, 25), fill=BLUE, width=2)
            d.line((bx - 36, 25, bx - 30, 27), fill=WHITE, width=2)
            football(d, bx + 1, 25, 0, 0.8)
            if t >= 1:
                gap_l, gap_r = bx + 6, marker_x - 1
                if (k // 4) % 2:
                    d.line((gap_l, 29, gap_r, 29), fill=RED)     # the measurement: this much short
                    d.line((gap_l, 27, gap_l, 31), fill=RED)
                    d.line((gap_r, 27, gap_r, 31), fill=RED)
                if k > dive + 6:
                    if line:
                        stat = '%s / %s' % (('%g' % cur), ('%g' % line))
                        d.text((marker_x + 8, 1), stat, font=R.F_SMALL, fill=WHITE)
                    d.text((marker_x + 8, 13), 'JUST SHORT', font=R.F_SCORE, fill=[RED, WHITE][(k // 6) % 2])
        yield img, DT


ANIMS = {
    'breakaway': anim_breakaway, 'catch': anim_catch, 'dime': anim_dime, 'touchdown': anim_touchdown,
    'winner': anim_winner, 'covered': anim_covered, 'over': anim_over, 'under': anim_under, 'hit': anim_hit,
    'fieldgoal': anim_fieldgoal, 'nogood': anim_nogood, 'short': anim_short, 'injury': anim_injury,
}


def play(name, width, text=''):
    name, _, arg = (name or '').partition(':')   # e.g. 'short:64:69.5'
    fn = ANIMS.get(name)
    if not fn:
        return iter(())
    return fn(width, arg or text)
