"""Bowling-alley style celebration animations for the LED ticker.

Each animation is a generator of (PIL image, seconds to hold it). bhticker.py plays one before the
regular text flash when a leg hits, a leg loses, or a slip cashes.

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


def anim_touchdown(w, text):
    """TDs: ball sails through the uprights, then fireworks."""
    n = int(1.2 * FPS)
    px = w // 2
    fw = Particles()
    for i in range(n + int(1.6 * FPS)):
        img, d = canvas(w)
        d.line((px, 31, px, 22), fill=GOLD, width=2)       # post
        d.line((px - 14, 22, px + 14, 22), fill=GOLD, width=2)  # crossbar
        d.line((px - 14, 22, px - 14, 0), fill=GOLD, width=2)   # uprights
        d.line((px + 14, 22, px + 14, 0), fill=GOLD, width=2)
        if i < n:
            t = i / n
            x = 8 + (px - 8) * t
            y = 28 - 22 * math.sin(math.pi * t * 0.62)
            football(d, x, y, i // 2, 1.0 - 0.35 * t)
        if i >= n and (i - n) % 7 == 0:
            fw.burst(random.randint(10, w - 10), random.randint(5, 16), 34, speed=(1.2, 3.2),
                     cols=[random.choice(CONFETTI)], life=(16, 26))
        fw.step(d, gravity=0.05, drag=0.93)
        if i >= n + 10:
            outline_text(d, w, 'TOUCHDOWN!', [GOLD, WHITE, GREEN][((i - n) // 4) % 3])
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


# ---------------------------------------------------------------- bowling: strike / gutter
PIN_SPOTS = [(0, 0), (6, -1), (6, 1), (12, -2), (12, 0), (12, 2), (18, -3), (18, -1), (18, 1), (18, 3)]


def _lane(d, w):
    d.rectangle((0, 6, w, 27), fill=LANE)
    for k in range(0, w, 16):
        d.line((k, 6, k + 8, 27), fill=LANE_LINE)
    d.rectangle((0, 3, w, 5), fill=(20, 20, 24))     # top gutter
    d.rectangle((0, 28, w, 31), fill=(20, 20, 24))   # bottom gutter
    for k in range(20, 120, 14):                      # lane arrows
        d.polygon([(k, 16), (k + 4, 14), (k + 4, 18)], fill=dim(GOLD, 0.45))


def _pin(d, x, y, ang=0.0):
    """Pin standing at base (x, y), tilted by ang radians."""
    ca, sa = math.cos(ang), math.sin(ang)

    def p(dx, dy):
        return (x + dx * ca - dy * sa, y + dx * sa + dy * ca)
    body = [p(-2, 0), p(2, 0), p(2, -5), p(1, -7), p(2, -9), p(1, -11), p(-1, -11), p(-2, -9), p(-1, -7), p(-2, -5)]
    d.polygon(body, fill=WHITE)
    d.line((p(-2, -7), p(2, -7)), fill=RED)


def _ball(d, x, y, roll, col=(40, 70, 210)):
    r = 5
    d.ellipse((x - r, y - r, x + r, y + r), fill=col)
    d.point((x - 2, y - 2), fill=(170, 190, 255))
    for k in range(3):  # finger holes rolling around
        a = roll + k * 0.5
        hx, hy = x + math.cos(a) * 2.5, y + math.sin(a) * 2.5
        if math.cos(a) > -0.3:
            d.point((hx, hy), fill=(5, 5, 20))


def anim_strike(w, text):
    """Slip cashed: STRIKE, then money rains with the payout."""
    px = w - 40
    pins = [[px + dx, 24 + dy, 0.0, 0.0, 0.0, 0.0] for dx, dy in PIN_SPOTS]  # x y vx vy ang spin
    n = int(1.2 * FPS)
    hit_at = None
    boom = Particles()
    for i in range(n + int(1.0 * FPS)):
        img, d = canvas(w)
        _lane(d, w)
        bx = -6 + (px + 2 + 6) * min(1.0, i / n)
        if hit_at is None and bx >= px - 2:
            hit_at = i
            for q in pins:
                q[2] = random.uniform(-1.0, 3.5)
                q[3] = random.uniform(-4.5, -1.5)
                q[5] = random.uniform(-0.5, 0.5)
            boom.burst(px + 6, 18, 30, cols=[GOLD, WHITE], up=1)
        for q in pins:
            if hit_at is not None:
                q[0] += q[2]
                q[1] += q[3]
                q[3] += 0.25
                q[4] += q[5]
            _pin(d, q[0], q[1], q[4])
        if hit_at is None or i - hit_at < 6:
            _ball(d, min(bx, px + 4), 21, i * 0.6)
        boom.step(d)
        if hit_at is not None and i - hit_at > 4:
            outline_text(d, w, 'STRIKE!', [GOLD, WHITE, RED][((i - hit_at) // 3) % 3])
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


def anim_gutter(w, text):
    """A leg lost: gutter ball, pins don't move."""
    px = w - 40
    n = int(1.4 * FPS)
    for i in range(n + int(1.1 * FPS)):
        img, d = canvas(w)
        _lane(d, w)
        for dx, dy in PIN_SPOTS:
            _pin(d, px + dx, 24 + dy)
        t = min(1.0, i / n)
        bx = -6 + (px - 10) * t
        by = 20 + 10 * max(0.0, (t - 0.35) / 0.65) ** 2
        if by < 30 or i % 2:
            _ball(d, bx, min(by, 29.5), i * 0.5, (120, 30, 30))
        if i >= n - 4:
            outline_text(d, w, 'GUTTER BALL', [RED, (255, 140, 140)][(i // 5) % 2])
        yield img, DT


ANIMS = {
    'breakaway': anim_breakaway, 'catch': anim_catch, 'dime': anim_dime, 'touchdown': anim_touchdown,
    'winner': anim_winner, 'covered': anim_covered, 'over': anim_over, 'under': anim_under, 'hit': anim_hit,
    'strike': anim_strike, 'gutter': anim_gutter,
}


def play(name, width, text=''):
    fn = ANIMS.get(name)
    if not fn:
        return iter(())
    return fn(width, text)
