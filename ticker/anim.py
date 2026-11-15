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
            and row.get('side') != 'under' and not re.search(r'\bunder\b', lab, re.I)):
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
        return 'under' if row.get('side') == 'under' or ' under' in lab or re.search(r'\bu\s*\d', lab) else 'over'
    if row.get('side') == 'under':   # an under prop held: the scoreboard stops under the line
        return 'under'
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
    font = R.smaller(font, msg, w - 56)   # clear of both horseshoes, even on a 3-panel strip
    for i in range(int(2.4 * FPS)):
        img, d = canvas(w, (0, 18, 6))
        for b in bills:
            b[1] += b[2]
            if b[1] > H + 6:
                b[1] = -8
                b[0] = random.uniform(0, w)
            d.text((b[0], b[1]), '$', font=R.F_SMALL, fill=dim(GREEN, 0.6 + 0.4 * (b[2] > 1)))
        tw = R.text_w(font, msg)
        if tw <= w - 56:   # a long leg name on a short strip gets the room instead of the horseshoes
            horseshoe(d, 4, 4, GOLD, 0.95)
            horseshoe(d, w - 22, 4, GOLD, 0.95)
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
    # Keep 'JUST SHORT' on the panels: on a narrow strip (3 panels) the marker moves left to make room,
    # and if it still won't fit the smaller font is used.
    f_short = R.F_SCORE
    room = lambda f: w - 10 - max(R.text_w(f, 'JUST SHORT'), R.text_w(R.F_SMALL, '%g / %g' % (cur, line)) if line else 0)
    if room(f_short) < 80:
        f_short = R.F_SMALL
    marker_x = max(76, min(int(w * 0.62), room(f_short)))
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
                    d.text((marker_x + 8, 13), 'JUST SHORT', font=f_short, fill=[RED, WHITE][(k // 6) % 2])
        yield img, DT


# ---------------------------------------------------------------- scoring update
def _hex(c, default):
    try:
        c = str(c).lstrip('#')
        return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))
    except (ValueError, IndexError):
        return default


# logos and team info for the score train; bhticker.py fills these in
CONTEXT = {'logos': None, 'teams': {}}


def _team_col(t):
    col = _hex(t.get('color'), BLUE)
    if sum(col) < 120:                      # near-black team colors vanish on LEDs: use the alternate
        col = _hex(t.get('alternateColor'), WHITE)
    return col


def _wheel(d, cx, cy, r, turn, col=(150, 150, 160)):
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(30, 30, 34), outline=col)
    for k in range(2):                       # two spokes that spin as the train rolls
        a = turn + k * math.pi / 2
        dx, dy = math.cos(a) * (r - 1), math.sin(a) * (r - 1)
        d.line((cx - dx, cy - dy, cx + dx, cy + dy), fill=col)


def _engine(img, d, x, col, alt, turn, pump, moving, logo=None):
    """Locomotive facing left, 46px long, with an engineer pumping his arms out of the cab."""
    body = col
    trim = alt if sum(alt) > 150 else WHITE
    # cowcatcher, boiler, cab
    d.polygon([(x, 27), (x + 6, 20), (x + 6, 27)], fill=(120, 120, 130))
    d.rectangle((x + 6, 14, x + 30, 26), fill=body)
    d.line((x + 6, 14, x + 30, 14), fill=trim)
    d.rectangle((x + 29, 6, x + 45, 26), fill=body)
    d.rectangle((x + 28, 4, x + 46, 6), fill=trim)                 # cab roof
    d.rectangle((x + 32, 9, x + 42, 17), fill=(15, 20, 35))         # window
    d.rectangle((x + 10, 8, x + 14, 14), fill=(60, 60, 70))         # smokestack
    d.rectangle((x + 9, 7, x + 15, 8), fill=(90, 90, 100))
    d.ellipse((x + 3, 17, x + 7, 21), fill=(255, 230, 120))         # headlight
    if logo is not None:                                             # team logo on a plate on the boiler
        d.ellipse((x + 15, 13, x + 28, 26), fill=(12, 16, 30), outline=trim)
        R._paste_logo(img, logo, x + 16, 14, 12)
    # engineer: head in the window, arms pumping up out of it
    skin = (225, 185, 145)
    d.ellipse((x + 35, 10, x + 40, 15), fill=skin)
    d.rectangle((x + 34, 9, x + 41, 10), fill=trim)                 # cap
    up = pump if not moving else 0.35
    for side, ax in ((-1, x + 33), (1, x + 42)):
        hy = 9 - int(7 * up)                                         # hands go up and down
        hx = ax + side * (2 + int(2 * up))
        d.line((ax, 14, hx, hy), fill=skin, width=2)
        d.rectangle((hx - 1, hy - 1, hx + 1, hy + 1), fill=skin)
    for k, wx in enumerate((x + 12, x + 22, x + 37)):
        _wheel(d, wx, 27, 4, turn + k)
    d.line((x + 12, 27, x + 37, 27), fill=(170, 170, 180))          # side rod


def _car(d, x, width, edge, turn, top=5):
    d.rectangle((x, top, x + width, 25), fill=(22, 26, 40), outline=edge)
    for wx in (x + 7, x + width - 7):
        _wheel(d, wx, 27, 3, turn)


def anim_score(w, text):
    """A game on a ticket scored: a train pulls the update in. The engine wears the scoring team's
    colors and the engineer pumps his arms; the cars carry the play and both teams' logos and scores.
    It eases in to a stop in the middle, celebrates, then pulls away.
    text: 'GAMEID|side|PLAY|away score|home score'."""
    try:
        gid, side, play, as_, hs = text.split('|')
    except ValueError:
        return
    teams = CONTEXT['teams'].get(gid)
    if not teams:
        return
    away, home, sport = teams
    logos = CONTEXT.get('logos')
    me = away if side == 'a' else home
    col = _team_col(me)
    alt = _hex(me.get('alternateColor'), WHITE)
    word = {'TOUCHDOWN': 'TD', 'FIELD GOAL': 'FG'}.get(play, play)
    gap = 4

    def layout(compact):
        # compact (3 panels): smaller play logo, both scores on one scoreboard car, so it all fits
        f_sc = R.F_BIG if compact else (R.F_FLASH if R.text_w(R.F_FLASH, '88') < 30 else R.F_BIG)
        L = 20 if compact else 24
        big = logos.get(me, sport, L) if logos else None
        txt = word if big is not None else R.ascii_safe(R._ab(me)) + ' ' + word
        pad = 3 if compact else 4
        c1 = (pad + L + pad + 1 if big is not None else 6) + R.text_w(R.F_BIG, txt) + (4 if compact else 6)
        if compact:
            cars = [('board', None, None, None, 3 + 18 + 3 + R.text_w(f_sc, as_) + 5 + R.text_w(f_sc, hs) + 3 + 18 + 3)]
        else:
            cars = [('team', t, sc, mine, 4 + 20 + 4 + R.text_w(f_sc, sc) + 6)
                    for t, sc, mine in ((away, as_, side == 'a'), (home, hs, side == 'h'))]
        total = 46 + gap + c1 + sum(gap + c[4] for c in cars)
        return dict(f_sc=f_sc, L=L, big=big, txt=txt, pad=pad, c1=c1, cars=cars, total=total)

    lay = layout(False)
    if lay['total'] > w - 4:
        lay = layout(True)
    f_big, LOGO, big_logo, play_txt, pad, c1, cars, total = (lay[k] for k in ('f_sc', 'L', 'big', 'txt', 'pad', 'c1', 'cars', 'total'))
    stop = max(2, (w - total) // 2)
    t_in, t_hold, t_out = int(1.6 * FPS), int(3.0 * FPS), int(1.4 * FPS)   # an unhurried roll in and out
    smoke = Particles()
    top, bot = R.caps(f_big)
    for i in range(t_in + t_hold + t_out):
        if i < t_in:
            p = ease_out(i / t_in)
            x = int(w + (stop - w) * p)
            moving = True
        elif i < t_in + t_hold:
            x, moving = stop, False
        else:
            p = ((i - t_in - t_hold) / t_out) ** 2          # ease in: gets going, then gone
            x = int(stop + (-total - 10 - stop) * p)
            moving = True
        img, d = canvas(w)
        d.line((0, 31, w, 31), fill=(70, 70, 80))            # the track
        for k in range(-(x % 8), w, 8):
            d.point((k, 31), fill=(110, 90, 60))
        turn = -x / 4.0
        pump = abs(math.sin(i * 0.55))
        # cars, drawn behind the engine's couplers
        cx = x + 46 + gap
        _car(d, cx, c1, col, turn, top=1)
        tx = cx + 6
        if big_logo is not None:
            R._paste_logo(img, big_logo, cx + pad, 2 + (24 - LOGO) // 2, LOGO)
            tx = cx + pad + LOGO + pad + 1
        d.text((tx, 14 - (R.caps(R.F_BIG)[0] + R.caps(R.F_BIG)[1]) // 2), play_txt, font=R.F_BIG, fill=col)
        cx += c1
        flash = not moving and (i // 5) % 2 == 0
        for kind, t, sc, mine, cw in cars:
            d.line((cx, 22, cx + gap, 22), fill=(120, 120, 130))     # coupler
            cx += gap
            if kind == 'board':
                # away logo, away score - home score, home logo
                _car(d, cx, cw, col, turn)
                bx = cx + 3
                for t2, sc2, mine2, first in ((away, as_, side == 'a', True), (home, hs, side == 'h', False)):
                    lg = logos.get(t2, sport, 18) if logos else None
                    sw = R.text_w(f_big, sc2)
                    fill = (GOLD if flash else WHITE) if mine2 else R.DIM
                    if first:
                        if lg is not None:
                            R._paste_logo(img, lg, bx, 6, 18)
                        else:
                            d.text((bx, 9), R.ascii_safe(R._ab(t2))[:3], font=R.F_SMALL, fill=WHITE)
                        bx += 18 + 3
                        d.text((bx, 15 - (top + bot) // 2), sc2, font=f_big, fill=fill)
                        bx += sw + 1
                        d.line((bx, 15, bx + 2, 15), fill=R.DIM)   # dash between the scores
                        bx += 4
                    else:
                        d.text((bx, 15 - (top + bot) // 2), sc2, font=f_big, fill=fill)
                        bx += sw + 3
                        if lg is not None:
                            R._paste_logo(img, lg, bx, 6, 18)
                        else:
                            d.text((bx, 9), R.ascii_safe(R._ab(t2))[:3], font=R.F_SMALL, fill=WHITE)
            else:
                _car(d, cx, cw, _team_col(t) if mine else (60, 70, 95), turn)
                logo = logos.get(t, sport, 18) if logos else None
                if logo is not None:
                    R._paste_logo(img, logo, cx + 4, 6, 18)
                else:
                    d.text((cx + 4, 9), R.ascii_safe(R._ab(t))[:3], font=R.F_SMALL, fill=WHITE)
                d.text((cx + 28, 15 - (top + bot) // 2), sc, font=f_big,
                       fill=(GOLD if flash else WHITE) if mine else R.DIM)
            cx += cw
        d.line((x + 46, 22, x + 46 + gap, 22), fill=(120, 120, 130))
        _engine(img, d, x, col, alt, turn, pump, moving)
        if i % (3 if moving else 6) == 0 and -10 < x + 12 < w:   # smoke from the stack
            smoke.p.append([x + 12, 5, random.uniform(0.3, 1.2), -random.uniform(0.4, 0.9), (170, 170, 180), 20])
            smoke.p.append([x + 13, 5, random.uniform(0.3, 1.2), -random.uniform(0.2, 0.7), (130, 130, 140), 16])
        smoke.step(d, gravity=-0.01, drag=0.97)
        yield img, DT

STEEL = (230, 170, 20)       # crane yellow
HAZARD = ((240, 190, 0), (25, 25, 25))


def _hazard_bar(d, x0, y, x1, h=2):
    """Yellow and black construction stripes."""
    for k in range(x0, x1 + 1):
        d.line((k, y, k, y + h - 1), fill=HAZARD[((k - x0) // 3) % 2])


def anim_score_crane(w, text):
    """A game on a ticket scored, construction style: a tower crane swings in a steel sign with the play
    and the score, sets it down, the crew welds it in place (sparks, flashing beacon), then lifts it away.
    text: 'GAMEID|side|PLAY|away score|home score'."""
    try:
        gid, side, play, as_, hs = text.split('|')
    except ValueError:
        return
    teams = CONTEXT['teams'].get(gid)
    if not teams:
        return
    away, home, sport = teams
    logos = CONTEXT.get('logos')
    me = away if side == 'a' else home
    col = _team_col(me)
    word = {'TOUCHDOWN': 'TD', 'FIELD GOAL': 'FG'}.get(play, play)
    F = R.F_BIG
    top_c, bot_c = R.caps(F)
    LG = 16

    def mark_w(t):
        lg = logos.get(t, sport, LG) if logos else None
        return LG if lg is not None else R.text_w(R.F_SMALL, R.ascii_safe(R._ab(t))[:3])

    show_me = True
    sw = 4 + mark_w(me) + 3 + R.text_w(F, word) + 11 + mark_w(away) + 3 + R.text_w(F, as_) + 7 + R.text_w(F, hs) + 3 + mark_w(home) + 4
    if sw > w - 22:                       # long play name on a narrow ticker: drop the first logo
        show_me = False
        sw -= mark_w(me) + 3
    SH = 21                               # sign height
    MAST = 12                             # the crane's tower takes the left edge
    sx_stop = MAST + max(2, (w - MAST - sw) // 2)
    y_fly, y_land = 6, 10                 # sign top while flying / set down (bottom on the ground at 30)
    t_in, t_drop, t_hold, t_out = int(1.6 * FPS), int(0.5 * FPS), int(2.6 * FPS), int(1.2 * FPS)
    sparks, dust = Particles(), Particles()

    def mark(img, d, t, x, cy):
        lg = logos.get(t, sport, LG) if logos else None
        if lg is not None:
            R._paste_logo(img, lg, x, cy - LG // 2, LG)
            return LG
        ab = R.ascii_safe(R._ab(t))[:3]
        d.text((x, cy - 5), ab, font=R.F_SMALL, fill=WHITE)
        return R.text_w(R.F_SMALL, ab)

    for i in range(t_in + t_drop + t_hold + t_out):
        sway = 0.0
        if i < t_in:
            p = ease_out(i / t_in)
            sx = int(w + 4 + (sx_stop - w - 4) * p)
            sy = y_fly
            sway = math.sin(i * 0.3) * 2.5 * (1 - p)          # swings as it travels, settles at the stop
            phase = 'in'
        elif i < t_in + t_drop:
            q = (i - t_in) / t_drop
            sx = sx_stop
            sy = y_fly + (y_land - y_fly) * min(1.0, q * 1.4) - (1 if 0.7 < q < 0.85 else 0)   # little bounce
            phase = 'drop'
            if i == t_in + t_drop - 1:
                dust.burst(sx + 2, 30, 10, speed=(0.3, 1.2), cols=[(140, 110, 70), (110, 90, 60)], up=0.4, life=(8, 16))
                dust.burst(sx + sw - 2, 30, 10, speed=(0.3, 1.2), cols=[(140, 110, 70), (110, 90, 60)], up=0.4, life=(8, 16))
        elif i < t_in + t_drop + t_hold:
            sx, sy, phase = sx_stop, y_land, 'hold'
        else:
            q = ((i - t_in - t_drop - t_hold) / t_out) ** 2
            sx, sy, phase = sx_stop, y_land + (-SH - 6 - y_land) * q, 'out'
        sy = int(round(sy))
        img, d = canvas(w)
        # ground
        d.line((0, 31, w, 31), fill=(95, 75, 45))
        for k in range(3, w, 11):
            d.point((k, 31), fill=(130, 105, 65))
        # tower crane: lattice mast on the left, jib across the top
        for yy in range(3, 31, 4):
            d.line((3, yy, 8, yy + 4), fill=STEEL)
            d.line((8, yy, 3, yy + 4), fill=STEEL)
        d.line((3, 3, 3, 31), fill=STEEL)
        d.line((8, 3, 8, 31), fill=STEEL)
        d.line((0, 1, w, 1), fill=STEEL)
        for k in range(10, w, 6):                             # jib lattice
            d.line((k, 1, k + 3, 3), fill=(170, 125, 15))
            d.line((k + 3, 3, k + 6, 1), fill=(170, 125, 15))
        d.line((10, 3, w, 3), fill=(170, 125, 15))
        d.rectangle((1, 4, 10, 8), fill=(200, 205, 215))     # operator cab
        d.rectangle((6, 5, 9, 7), fill=(30, 60, 100))
        beacon_on = phase in ('drop', 'hold') and (i // 4) % 2 == 0
        d.rectangle((4, 0, 6, 0), fill=(255, 140, 0) if beacon_on else (90, 50, 0))
        # trolley and cables
        hx = sx + sw // 2
        cx = int(hx + sway)
        d.rectangle((hx - 3, 2, hx + 3, 4), fill=(80, 80, 90))
        if sy > 4:
            d.line((hx - 1, 4, cx - sw // 2 + 6, sy), fill=(150, 150, 160))
            d.line((hx + 1, 4, cx + sw // 2 - 6, sy), fill=(150, 150, 160))
        # the steel sign
        x0 = cx - sw // 2
        d.rectangle((x0, sy, x0 + sw, sy + SH - 1), fill=(22, 26, 40), outline=(120, 125, 140))
        _hazard_bar(d, x0 + 1, sy + 1, x0 + sw - 1)
        _hazard_bar(d, x0 + 1, sy + SH - 3, x0 + sw - 1)
        for bx in (x0 + 2, x0 + sw - 2):                      # rivets
            d.point((bx, sy + 4), fill=(180, 180, 190))
            d.point((bx, sy + SH - 5), fill=(180, 180, 190))
        cy = sy + SH // 2
        ty = cy - (top_c + bot_c) // 2
        x = x0 + 4
        if show_me:
            x += mark(img, d, me, x, cy) + 3
        d.text((x, ty), word, font=F, fill=col)
        x += R.text_w(F, word) + 5
        d.line((x, sy + 4, x, sy + SH - 5), fill=(70, 75, 95))
        x += 6
        flash = phase == 'hold' and (i // 5) % 2 == 0
        x += mark(img, d, away, x, cy) + 3
        d.text((x, ty), as_, font=F, fill=(GOLD if flash else WHITE) if side == 'a' else R.DIM)
        x += R.text_w(F, as_) + 2
        d.line((x, cy, x + 2, cy), fill=R.DIM)
        x += 5
        d.text((x, ty), hs, font=F, fill=(GOLD if flash else WHITE) if side == 'h' else R.DIM)
        x += R.text_w(F, hs) + 3
        mark(img, d, home, x, cy)
        # welding sparks at the corners while it's set
        if phase == 'hold' and i % 7 == 0:
            for ex in (x0 + 1, x0 + sw - 1):
                if random.random() < 0.8:
                    sparks.burst(ex, sy + SH - 1, 7, speed=(0.6, 1.8), cols=[(255, 230, 120), WHITE, (255, 150, 30)], up=1.0, life=(6, 12))
        sparks.step(d, gravity=0.15, drag=0.94)
        dust.step(d, gravity=-0.02, drag=0.93)
        yield img, DT


def _score_sign(w_max, me, away, home, sport, word, as_, hs, side, col, flash, H=19):
    """The play + score strip used on the rocket's banner -> RGB image (or None if it can't fit)."""
    logos = CONTEXT.get('logos')
    F = R.F_BIG
    LG = 14
    top_c, bot_c = R.caps(F)

    def mk(t):
        lg = logos.get(t, sport, LG) if logos else None
        ab = R.ascii_safe(R._ab(t))[:3]
        return lg, (LG if lg is not None else R.text_w(R.F_SMALL, ab)), ab

    parts_me, parts_a, parts_h = mk(me), mk(away), mk(home)
    show_me = True
    sw = 4 + parts_me[1] + 3 + R.text_w(F, word) + 11 + parts_a[1] + 3 + R.text_w(F, as_) + 7 + R.text_w(F, hs) + 3 + parts_h[1] + 4
    if sw > w_max:
        show_me = False
        sw -= parts_me[1] + 3
    img = Image.new('RGB', (sw, H), (235, 232, 220))           # a cloth banner
    d = ImageDraw.Draw(img)
    d.fontmode = '1'
    d.rectangle((0, 0, sw - 1, H - 1), outline=col)
    cy = H // 2
    ty = cy - (top_c + bot_c) // 2

    def put(pt, x):
        lg, wd, ab = pt
        if lg is not None:
            R._paste_logo(img, lg, x, cy - LG // 2, LG)
        else:
            d.text((x, cy - 5), ab, font=R.F_SMALL, fill=(20, 24, 40))
        return wd

    ink, dimink = (20, 24, 40), (120, 120, 130)
    x = 4
    if show_me:
        x += put(parts_me, x) + 3
    d.text((x, ty), word, font=F, fill=col if sum(col) < 600 else ink)
    x += R.text_w(F, word) + 5
    d.line((x, 3, x, H - 4), fill=dimink)
    x += 6
    x += put(parts_a, x) + 3
    hot = (210, 140, 0) if flash else ink
    d.text((x, ty), as_, font=F, fill=hot if side == 'a' else dimink)
    x += R.text_w(F, as_) + 2
    d.line((x, cy, x + 2, cy), fill=dimink)
    x += 5
    d.text((x, ty), hs, font=F, fill=hot if side == 'h' else dimink)
    x += R.text_w(F, hs) + 3
    put(parts_h, x)
    return img


def _rocket_up(d, x, y, col):
    """Standing rocket, 9px wide, nose at y, 25px tall."""
    d.polygon([(x + 4, y), (x + 8, y + 6), (x, y + 6)], fill=(220, 60, 50))           # nose cone
    d.rectangle((x, y + 6, x + 8, y + 21), fill=(225, 228, 235))
    d.rectangle((x, y + 13, x + 8, y + 14), fill=col)                                 # team stripe
    d.ellipse((x + 2, y + 8, x + 6, y + 12), fill=(40, 90, 160), outline=(120, 125, 140))
    d.polygon([(x, y + 16), (x - 3, y + 24), (x, y + 21)], fill=(220, 60, 50))         # fins
    d.polygon([(x + 8, y + 16), (x + 11, y + 24), (x + 8, y + 21)], fill=(220, 60, 50))
    d.rectangle((x + 2, y + 22, x + 6, y + 24), fill=(90, 90, 100))                   # nozzle


def _flame_down(d, x, y, n, k):
    """Exhaust under a standing rocket; n = length, k = frame for flicker."""
    for j in range(n):
        half = max(0, 3 - j // 3) + (1 if (j + k) % 3 == 0 else 0)
        c = (255, 245, 200) if j < 2 else (255, 190, 40) if j < n * 0.6 else (230, 80, 20)
        d.line((x + 4 - half, y + j, x + 4 + half, y + j), fill=c)


def _rocket_side(d, x, y, col, k, flame=True):
    """Rocket flying right: tail at x, nose at x+29, centered on y."""
    d.rectangle((x + 4, y - 4, x + 22, y + 4), fill=(225, 228, 235))
    d.polygon([(x + 22, y - 4), (x + 29, y), (x + 22, y + 4)], fill=(220, 60, 50))
    d.rectangle((x + 10, y - 4, x + 11, y + 4), fill=col)
    d.ellipse((x + 15, y - 2, x + 19, y + 2), fill=(40, 90, 160), outline=(120, 125, 140))
    d.polygon([(x + 4, y - 4), (x, y - 9), (x + 9, y - 4)], fill=(220, 60, 50))
    d.polygon([(x + 4, y + 4), (x, y + 9), (x + 9, y + 4)], fill=(220, 60, 50))
    d.rectangle((x + 1, y - 2, x + 3, y + 2), fill=(90, 90, 100))
    if flame:
        n = 5 + (k % 3)
        for j in range(n):
            half = max(0, 2 - j // 2)
            c = (255, 245, 200) if j < 2 else (255, 190, 40) if j < 4 else (230, 80, 20)
            d.line((x - j, y - half, x - j, y + half), fill=c)


def anim_score_rocket(w, text):
    """A game on a ticket scored, launchpad style: countdown, ignition, liftoff, then the rocket
    comes back across the night sky towing a banner with the play and the score.
    text: 'GAMEID|side|PLAY|away score|home score'."""
    try:
        gid, side, play, as_, hs = text.split('|')
    except ValueError:
        return
    teams = CONTEXT['teams'].get(gid)
    if not teams:
        return
    away, home, sport = teams
    me = away if side == 'a' else home
    col = _team_col(me)
    word = {'TOUCHDOWN': 'TD', 'FIELD GOAL': 'FG'}.get(play, play)
    rng = random.Random(gid + play + as_ + hs)
    stars = [(rng.randrange(w), rng.randrange(0, 27), rng.random() * 6) for _ in range(w // 6)]
    banner = [_score_sign(w - 44, me, away, home, sport, word, as_, hs, side, col, f) for f in (False, True)]
    bw, bh = banner[0].size
    ROPE, RK = 6, 30
    total = bw + ROPE + RK
    stop = max(2, (w - total) // 2)
    pad_x = max(14, w // 5)
    n_count, n_ign, n_lift, n_gap = int(1.05 * FPS), int(0.5 * FPS), int(0.7 * FPS), int(0.25 * FPS)
    n_in, n_hold, n_out = int(1.2 * FPS), int(2.3 * FPS), int(0.9 * FPS)
    smoke, trail = Particles(), Particles()
    marks = [n_count, n_count + n_ign, n_count + n_ign + n_lift, n_count + n_ign + n_lift + n_gap]
    end = marks[3] + n_in + n_hold + n_out
    for i in range(end):
        img, d = canvas(w, (2, 3, 14))
        for sxp, syp, ph in stars:                                    # twinkling stars
            b = 0.35 + 0.65 * abs(math.sin(i * 0.12 + ph))
            d.point((sxp, syp), fill=dim(WHITE, b))
        d.line((0, 31, w, 31), fill=(60, 60, 70))
        if i < marks[2] + n_gap:                                      # the launchpad scene
            # gantry tower and pad
            gx = pad_x - 9
            for yy in range(6, 30, 4):
                d.line((gx, yy, gx + 4, yy + 4), fill=(150, 150, 160))
                d.line((gx + 4, yy, gx, yy + 4), fill=(150, 150, 160))
            d.line((gx, 6, gx, 30), fill=(150, 150, 160))
            d.line((gx + 4, 6, gx + 4, 30), fill=(150, 150, 160))
            d.rectangle((pad_x - 12, 30, pad_x + 20, 31), fill=(110, 110, 120))
            if (i // 6) % 2 == 0:
                d.point((gx + 2, 5), fill=(255, 40, 40))             # red light on the tower
            ry, shake = 4, 0
            if i < marks[0]:
                num = 3 - i * 3 // n_count
                t = str(num)
                tw = R.text_w(R.F_FLASH, t)
                cx = pad_x + 20 + (w - pad_x - 20 - tw) // 2
                top, bot = R.caps(R.F_FLASH)
                d.text((cx, 15 - (top + bot) // 2), t, font=R.F_FLASH, fill=GOLD)
            elif i < marks[1]:
                q = (i - marks[0]) / n_ign
                shake = (i % 2) * 2 - 1
                lab = 'IGNITION'
                d.text((pad_x + 20 + (w - pad_x - 20 - R.text_w(R.F_BIG, lab)) // 2, 9), lab, font=R.F_BIG, fill=(255, 150, 30))
                if i % 2 == 0:
                    smoke.burst(pad_x + 4, 30, int(3 + 6 * q), speed=(0.4, 1.6), cols=[(170, 170, 180), (120, 120, 130), (210, 210, 215)], up=0.2, life=(18, 34))
            elif i < marks[2]:
                q = (i - marks[1]) / n_lift
                ry = 4 - int(48 * q * q)
                lab = 'LIFTOFF!'
                d.text((pad_x + 20 + (w - pad_x - 20 - R.text_w(R.F_BIG, lab)) // 2, 9), lab, font=R.F_BIG, fill=GOLD)
                if i % 2 == 0:
                    smoke.burst(pad_x + 4, 30, 4, speed=(0.5, 1.8), cols=[(170, 170, 180), (120, 120, 130)], up=0.2, life=(18, 34))
            if i < marks[2] and ry > -30:
                rx = pad_x + shake
                if i >= marks[0]:
                    _flame_down(d, rx, ry + 25, 4 if i < marks[1] else 9, i)
                _rocket_up(d, rx, ry, col)
        else:                                                         # flying back with the banner
            j = i - marks[3]
            if j < n_in:
                x = int(-total + (stop + total) * ease_out(j / n_in))
            elif j < n_in + n_hold:
                x = stop
            else:
                q = ((j - n_in - n_hold) / n_out) ** 2
                x = int(stop + (w + 10 - stop) * q)
            hold = n_in <= j < n_in + n_hold
            flash = hold and (j // 5) % 2 == 0
            bn = banner[1 if flash else 0]
            by = 15 - bh // 2
            for c in range(bw):                                       # the banner ripples
                off = int(round(1.4 * math.sin(i * 0.35 - c * 0.18)))
                col_img = bn.crop((c, 0, c + 1, bh))
                if 0 <= x + c < w:
                    img.paste(col_img, (x + c, by + off))
            rx = x + bw + ROPE
            d.line((x + bw, by + 2 + int(round(1.4 * math.sin(i * 0.35 - bw * 0.18))), rx + 1, 15), fill=(160, 160, 170))
            d.line((x + bw, by + bh - 3 + int(round(1.4 * math.sin(i * 0.35 - bw * 0.18))), rx + 1, 15), fill=(160, 160, 170))
            _rocket_side(d, rx, 15, col, i)
            if i % 2 == 0 and -5 < rx < w:
                trail.p.append([rx - 6, 15 + random.uniform(-1, 1), -random.uniform(0.2, 0.6), random.uniform(-0.15, 0.15), (130, 130, 145), 14])
        smoke.step(d, gravity=-0.015, drag=0.95)
        trail.step(d, gravity=0, drag=0.97)
        yield img, DT

_score_turn = [0]


def anim_score_any(w, text):
    """Scoring plays take turns, newest first: the rocket, then the train, then the crane, then the rocket..."""
    fn = (anim_score_rocket, anim_score, anim_score_crane)[_score_turn[0] % 3]
    _score_turn[0] += 1
    return fn(w, text)

ANIMS = {
    'breakaway': anim_breakaway, 'catch': anim_catch, 'dime': anim_dime, 'touchdown': anim_touchdown,
    'winner': anim_winner, 'covered': anim_covered, 'over': anim_over, 'under': anim_under, 'hit': anim_hit,
    'fieldgoal': anim_fieldgoal, 'nogood': anim_nogood, 'short': anim_short, 'injury': anim_injury, 'score': anim_score_any,
    'train': anim_score, 'crane': anim_score_crane, 'rocket': anim_score_rocket,
}


def play(name, width, text=''):
    name, _, arg = (name or '').partition(':')   # e.g. 'short:64:69.5'
    fn = ANIMS.get(name)
    if not fn:
        return iter(())
    return fn(width, arg or text)
