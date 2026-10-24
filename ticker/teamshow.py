"""Team display mode: an idle show for one NFL team (Jacksonville Jaguars by default).

Loops three scenes in the team's colors: a stripe sweep with the logo and name, this week's game
(kickoff time, or the live score), and the team's hometown chant with paw prints walking across.
bhticker.py plays it when the display mode is "team"; score trains and leg alerts still interrupt.
"""
import math
import random

from PIL import Image, ImageDraw

import render as R

H = 32
FPS = 30
DT = 1.0 / FPS

# name, colors (main, accent), hometown word for the last scene
TEAMS = {
    'ARI': ('CARDINALS', '97233F', 'FFB612', 'RED SEA'), 'ATL': ('FALCONS', 'A71930', 'A5ACAF', 'RISE UP'),
    'BAL': ('RAVENS', '241773', '9E7C0C', 'BALTIMORE'), 'BUF': ('BILLS', '00338D', 'C60C30', 'BILLS MAFIA'),
    'CAR': ('PANTHERS', '0085CA', 'BFC0BF', 'KEEP POUNDING'), 'CHI': ('BEARS', 'C83803', '0B162A', 'BEAR DOWN'),
    'CIN': ('BENGALS', 'FB4F14', 'FFFFFF', 'WHO DEY'), 'CLE': ('BROWNS', 'FF3C00', '311D00', 'DAWG POUND'),
    'DAL': ('COWBOYS', '003594', '869397', 'DALLAS'), 'DEN': ('BRONCOS', 'FB4F14', '002244', 'BRONCOS COUNTRY'),
    'DET': ('LIONS', '0076B6', 'B0B7BC', 'ONE PRIDE'), 'GB': ('PACKERS', '203731', 'FFB612', 'GO PACK GO'),
    'HOU': ('TEXANS', 'A71930', '03202F', 'H-TOWN'), 'IND': ('COLTS', '002C5F', 'A2AAAD', 'FOR THE SHOE'),
    'JAX': ('JAGUARS', '006778', 'D7A22A', 'DUVAL'), 'KC': ('CHIEFS', 'E31837', 'FFB81C', 'CHIEFS KINGDOM'),
    'LV': ('RAIDERS', 'A5ACAF', '000000', 'RAIDER NATION'), 'LAC': ('CHARGERS', '0080C6', 'FFC20E', 'BOLT UP'),
    'LAR': ('RAMS', '003594', 'FFA300', 'RAMS HOUSE'), 'MIA': ('DOLPHINS', '008E97', 'FC4C02', 'FINS UP'),
    'MIN': ('VIKINGS', '4F2683', 'FFC62F', 'SKOL'), 'NE': ('PATRIOTS', '002244', 'C60C30', 'NEW ENGLAND'),
    'NO': ('SAINTS', 'D3BC8D', '101820', 'WHO DAT'), 'NYG': ('GIANTS', '0B2265', 'A71930', 'BIG BLUE'),
    'NYJ': ('JETS', '125740', 'FFFFFF', 'J-E-T-S'), 'PHI': ('EAGLES', '004C54', 'A5ACAF', 'FLY EAGLES FLY'),
    'PIT': ('STEELERS', 'FFB612', '101820', 'HERE WE GO'), 'SF': ('49ERS', 'AA0000', 'B3995D', 'FAITHFUL'),
    'SEA': ('SEAHAWKS', '002244', '69BE28', '12S'), 'TB': ('BUCCANEERS', 'D50A0A', 'FF7900', 'FIRE THE CANNONS'),
    'TEN': ('TITANS', '4B92DB', 'C8102E', 'TITAN UP'), 'WSH': ('COMMANDERS', '5A1414', 'FFB612', 'HTTC'),
}


def _hex(c):
    c = c.lstrip('#')
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))


def _vis(c, fallback):
    """LED-visible version of a color (very dark colors are invisible on black panels)."""
    return fallback if sum(c) < 110 else c


def _canvas(w):
    img = Image.new('RGB', (w, H))
    d = ImageDraw.Draw(img)
    d.fontmode = '1'
    return img, d


def _paw(d, x, y, col):
    """A simple paw print (generic, not any team's logo)."""
    d.ellipse((x - 3, y - 2, x + 3, y + 3), fill=col)
    for dx, dy in ((-4, -5), (-1, -7), (2, -7), (5, -5)):
        d.ellipse((x + dx - 1, y + dy - 1, x + dx + 1, y + dy + 1), fill=col)


def _center_y(font):
    top, bot = R.caps(font)
    return (H - (bot - top)) // 2 - top


def scene_intro(w, team, abbr, logos, c1, c2):
    name = TEAMS.get(abbr, (abbr,))[0]
    font = R.smaller(R.F_FLASH, name, w - 60)
    logo = logos.get(team, 'nfl', 28) if logos else None
    n = int(5.5 * FPS)
    for i in range(n):
        img, d = _canvas(w)
        sweep = int((i * 9) % (w + 120)) - 60
        for k in range(-2, w // 12 + 4):          # diagonal stripes drifting by
            x = k * 12 + (i * 2) % 24
            col = c1 if k % 2 == 0 else tuple(int(v * 0.35) for v in c1)
            d.polygon([(x, H), (x + 6, H), (x + 18, 0), (x + 12, 0)], fill=col)
        d.rectangle((0, 3, w, H - 4), fill=(0, 0, 0))
        d.line((0, 3, w, 3), fill=c2)
        d.line((0, H - 4, w, H - 4), fill=c2)
        t = min(1.0, i / 18.0)
        lx = int(-30 + 34 * (1 - (1 - t) ** 3))
        if logo is not None:
            R._paste_logo(img, logo, lx, 2, 28)
        tw = R.text_w(font, name)
        tx = int(w - (w - (w - tw) // 2 - 14) * (1 - (1 - min(1.0, max(0.0, (i - 6) / 18.0))) ** 3))
        d.text((tx, _center_y(font)), name, font=font, fill=c2)
        for gx in range(max(0, sweep - 8), min(w, sweep + 8)):   # a shine passing over the name
            for gy in range(4, H - 4):
                px = img.getpixel((gx, gy))
                if px != (0, 0, 0) and abs(gx - sweep) < 4:
                    img.putpixel((gx, gy), tuple(min(255, v + 90) for v in px))
        yield img


def scene_game(w, team, abbr, game, logos, c1, c2):
    n = int(6 * FPS)
    if not game:
        for img in _message(w, 'BYE WEEK', c2, n):
            yield img
        return
    a, h = game['a'], game['h']
    la = logos.get(a, 'nfl', 24) if logos else None
    lh = logos.get(h, 'nfl', 24) if logos else None
    if game['state'] == 'pre':
        try:   # the day too, since this shows all week: "SUN 1:00 PM"
            from datetime import datetime
            import legs
            dt = datetime.fromisoformat(game['date'].replace('Z', '+00:00')).astimezone(legs.ET)
            when = dt.strftime('%a ').upper() + R.ascii_safe(R._clock(game)).upper()
        except Exception:
            when = R.ascii_safe(R._clock(game)).upper()
    else:
        when = R.ascii_safe(R._clock(game)).upper()
    for i in range(n):
        img, d = _canvas(w)
        d.rectangle((0, 0, w, H), fill=tuple(int(v * 0.18) for v in c1))
        x = 6
        for t, logo, score in ((a, la, game['as']), (h, lh, game['hs'])):
            if logo is not None:
                R._paste_logo(img, logo, x, 4, 24)
            else:
                d.text((x, _center_y(R.F_BIG)), R._ab(t), font=R.F_BIG, fill=R.WHITE)
            x += 28
            if game['state'] != 'pre':
                s = str(score)
                mine = t.get('abbreviation') == abbr
                d.text((x, _center_y(R.F_FLASH)), s, font=R.F_FLASH, fill=c2 if mine else R.WHITE)
                x += R.text_w(R.F_FLASH, s) + 6
            if t is a:
                d.text((x, _center_y(R.F_BIG)), '@', font=R.F_BIG, fill=R.DIM)
                x += R.text_w(R.F_BIG, '@') + 8
        live = game['state'] == 'in'
        col = (255, 70, 75) if live and (i // 15) % 2 == 0 else (c2 if not live else R.WHITE)
        tw = R.text_w(R.F_BIG, when)
        d.text((max(x + 8, w - tw - 8), _center_y(R.F_BIG)), when, font=R.F_BIG, fill=col)
        yield img


def scene_chant(w, abbr, c1, c2):
    word = TEAMS.get(abbr, ('', '', '', abbr))[3]
    font = R.smaller(R.F_FLASH, word, w - 20)
    n = int(6 * FPS)
    paws = []
    for i in range(n):
        img, d = _canvas(w)
        if i % 9 == 0:                              # paw prints walking left to right, alternating feet
            paws.append([-6 + (len(paws) % 2) * 3, 8 + (len(paws) % 2) * 16, 0])
        for p in paws:
            p[0] += 1.6
            p[2] += 1
        paws[:] = [p for p in paws if p[0] < w + 10]
        for p in paws:
            fade = max(0.25, 1 - p[2] / 140.0)
            _paw(d, int(p[0]), p[1], tuple(min(255, int(v * fade * 1.1)) for v in c1))
        tw = R.text_w(font, word)
        x0 = (w - tw) // 2
        y = _center_y(font)
        for ox, oy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            d.text((x0 + ox, y + oy), word, font=font, fill=(0, 0, 0))
        d.text((x0, y), word, font=font, fill=c2)
        shine = x0 - 20 + (i * 4) % (tw + 60)
        for gx in range(max(0, shine - 3), min(w, shine + 3)):
            for gy in range(0, H):
                px = img.getpixel((gx, gy))
                if px[0] > 120 and px[1] > 90:      # only lights up the gold letters
                    img.putpixel((gx, gy), (255, 245, 200))
        yield img


def _message(w, text, col, n):
    font = R.smaller(R.F_BIG, text, w - 10)
    for i in range(n):
        img, d = _canvas(w)
        d.text(((w - R.text_w(font, text)) // 2, _center_y(font)), text, font=font, fill=col)
        yield img


def frames(w, abbr, find_game, logos):
    """Endless frames for the team display. find_game(abbr) -> this week's game dict or None."""
    abbr = (abbr or 'JAX').upper()
    _, m, a, _w = TEAMS.get(abbr, (abbr, '3B82F6', 'FFD166', abbr))
    c1 = _vis(_hex(m), (60, 90, 140))
    c2 = _vis(_hex(a), (255, 255, 255))
    while True:
        game = find_game(abbr)
        team = None
        if game:
            team = game['a'] if game['a'].get('abbreviation') == abbr else game['h']
        team = team or {'abbreviation': abbr}
        for img in scene_intro(w, team, abbr, logos, c1, c2):
            yield img
        for img in scene_game(w, team, abbr, find_game(abbr), logos, c1, c2):
            yield img
        for img in scene_chant(w, abbr, c1, c2):
            yield img
