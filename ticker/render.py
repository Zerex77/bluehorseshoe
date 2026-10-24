"""Draws ticker items (PIL images, 32px tall) for the LED strip."""
import io
import os
import re
import threading

from PIL import Image, ImageDraw, ImageFont

H = 32
COL = {
    'win': (43, 214, 123), 'good': (43, 214, 123), 'close': (255, 176, 32), 'bad': (255, 70, 75),
    'lost': (255, 70, 75), 'push': (150, 160, 180), 'pre': (130, 140, 165), 'unk': (130, 140, 165),
}
WHITE = (235, 240, 250)
DIM = (120, 130, 155)
GOLD = (255, 200, 60)
BLUE = (60, 130, 246)
RED = (255, 70, 75)
SEP = (40, 52, 80)

FONT_DIRS = ['/usr/share/fonts/truetype/dejavu', '/usr/share/fonts/dejavu', os.path.dirname(__file__)]


def _font(name, size):
    for d in FONT_DIRS:
        p = os.path.join(d, name)
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


F_BIG = _font('DejaVuSansCondensed-Bold.ttf', 14)
F_SMALL = _font('DejaVuSansCondensed-Bold.ttf', 10)
F_SCORE = _font('DejaVuSansCondensed-Bold.ttf', 12)
F_FLASH = _font('DejaVuSansCondensed-Bold.ttf', 20)


def _draw(img):
    d = ImageDraw.Draw(img)
    d.fontmode = '1'  # crisp pixels, no blur on LEDs
    return d


def text_w(font, s):
    return int(math_ceil(font.getlength(s)))


def math_ceil(x):
    i = int(x)
    return i if i == x else i + 1


def ascii_safe(s):
    return (str(s).replace('—', '-').replace('–', '-').replace('−', '-').replace('·', '-')
            .replace('✓', '').replace('’', "'"))


# ---------------------------------------------------------------- logos
class Logos:
    def __init__(self, fetch_bytes, cache_dir):
        self.fetch = fetch_bytes
        self.dir = cache_dir
        os.makedirs(cache_dir, exist_ok=True)
        self.mem = {}
        self.pending = set()
        self.lock = threading.Lock()

    @staticmethod
    def url(team, sport):
        if not team:
            return None
        if team.get('logo'):
            return team['logo']
        if team.get('logos'):
            return team['logos'][0].get('href')
        if sport == 'nfl' and team.get('abbreviation'):
            return 'https://a.espncdn.com/i/teamlogos/nfl/500/%s.png' % team['abbreviation'].lower()
        if team.get('id'):
            return 'https://a.espncdn.com/i/teamlogos/ncaa/500/%s.png' % team['id']
        return None

    def get(self, team, sport, size):
        """Logo image or None. Downloads in the background the first time."""
        u = self.url(team, sport)
        if not u:
            return None
        key = (u, size)
        if key in self.mem:
            return self.mem[key]
        fn = os.path.join(self.dir, 'v2_' + re.sub(r'[^a-zA-Z0-9]+', '_', u)[-80:])
        if os.path.exists(fn):
            try:
                im = Image.open(fn).convert('RGBA')
                im.thumbnail((size * 2, size * 2), Image.LANCZOS)   # shrink first: lifting is per pixel
                im = lift_dark(im)
                im.thumbnail((size, size), Image.LANCZOS)
                self.mem[key] = im
                return im
            except Exception:
                pass
        with self.lock:
            if u in self.pending:
                return None
            self.pending.add(u)

        def work():
            try:
                data = None
                dark = dark_url(u)
                if dark:   # ESPN's version made for dark screens, when the team has one
                    try:
                        data = self.fetch(dark)
                        Image.open(io.BytesIO(data)).verify()
                    except Exception:
                        data = None
                if data is None:
                    data = self.fetch(u)
                Image.open(io.BytesIO(data)).verify()
                with open(fn, 'wb') as f:
                    f.write(data)
            except Exception:
                pass
            finally:
                with self.lock:
                    self.pending.discard(u)
        threading.Thread(target=work, daemon=True).start()
        return None


def dark_url(u):
    """ESPN keeps a dark-background version of most logos at .../500-dark/... ."""
    if 'espncdn.com/i/teamlogos/' not in u or '/500-dark/' in u:
        return None
    return u.replace('/500/scoreboard/', '/500-dark/').replace('/500/', '/500-dark/')


def lift_dark(im):
    """Black LEDs are off, so black parts of a logo disappear. Raise near-black (visible) pixels to
    a gray that keeps a hint of their color, so outlines and details still show."""
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a > 60 and max(r, g, b) < 70:
                px[x, y] = (r + 110, g + 110, b + 115, a)
    return im


def _paste_logo(img, logo, x, y, size):
    if logo is None:
        return
    ox = x + (size - logo.width) // 2
    oy = y + (size - logo.height) // 2
    img.paste(logo, (ox, oy), logo)


# ---------------------------------------------------------------- items
def item_slip(slip):
    """Slip header: horseshoe + name on top, progress / payout under it."""
    name = ascii_safe(slip['name']).upper()
    st = slip['status']
    tag = {'live': 'LIVE', 'busted': 'BUSTED', 'cashed': 'CASHED', 'pre': 'UPCOMING'}[st]
    bits = ['%d/%d IN' % (slip['won'], slip['n'])]
    if slip.get('pay'):
        bits.append('$' + format(slip['pay'], ',.0f') if slip['pay'] >= 100 else '$%.2f' % slip['pay'])
    elif slip.get('price'):
        bits.append(slip['price'])
    line2 = '  '.join(bits)
    tag_col = {'live': COL['win'], 'busted': RED, 'cashed': GOLD, 'pre': DIM}[st]
    w = 26 + max(text_w(F_BIG, name), text_w(F_SMALL, tag) + 6 + text_w(F_SMALL, line2)) + 14
    img = Image.new('RGB', (w, H))
    d = _draw(img)
    # horseshoe mark
    d.arc((3, 2, 21, 26), 0, 180, fill=BLUE, width=4)
    d.line((4, 2, 4, 14), fill=BLUE, width=4)
    d.line((20, 2, 20, 14), fill=BLUE, width=4)
    d.text((26, 1), name, font=F_BIG, fill=GOLD)
    d.text((26, 19), tag, font=F_SMALL, fill=tag_col)
    d.text((26 + text_w(F_SMALL, tag) + 6, 19), line2, font=F_SMALL, fill=WHITE)
    d.line((w - 4, 4, w - 4, H - 5), fill=SEP)
    return img


TAB_MAX = 64   # widest a slip header gets
TAB_MIN = 30


def _clip(font, s, maxw):
    while s and text_w(font, s) > maxw:
        s = s[:-1]
    return s


def _money(v):
    if v >= 1000:
        k = v / 1000.0 + 1e-9   # round halves up ($1,450 -> $1.5K)
        return '$%sK' % (('%.1f' % k).rstrip('0').rstrip('.') if k < 100 else '%.0f' % k)
    return '$' + format(v, ',.0f') if v >= 100 else '$%.2f' % v


def item_slip_tab(slip):
    """Compact slip header. It scrolls in and then stays pinned at the left edge in the same
    form while the slip's legs scroll behind it: name in small type (up to two lines), the
    count (or WON / BUST) and the payout, with a status-colored stripe."""
    st = slip['status']
    col = {'live': COL['win'], 'busted': RED, 'cashed': GOLD, 'pre': DIM}[st]
    inner = TAB_MAX - 8
    words = ascii_safe(slip['name']).upper().split() or ['SLIP']
    lines = []
    for wd in words:
        if lines and text_w(F_SMALL, lines[-1] + ' ' + wd) <= inner:
            lines[-1] += ' ' + wd
        else:
            lines.append(wd)
    if len(lines) > 2:
        lines = [lines[0], ' '.join(lines[1:])]
    lines = [_clip(F_SMALL, ln, inner) for ln in lines]
    count = {'cashed': 'WON', 'busted': 'BUST'}.get(st, '%d/%d' % (slip['won'], slip['n']))
    pay = _money(slip['pay']) if slip.get('pay') else (slip.get('price') or '')
    rows = [(ln, GOLD) for ln in lines]
    if len(lines) == 1:
        rows += [(count, col), (pay, WHITE)] if pay else [(count, col)]
    else:
        both = count + ' ' + pay if pay else count
        rows.append((both if text_w(F_SMALL, both) <= inner else count, col))
    rows = [(_clip(F_SMALL, t, inner), c) for t, c in rows if t]
    tab_w = max(TAB_MIN, min(TAB_MAX, max(text_w(F_SMALL, t) for t, _ in rows) + 8))
    img = Image.new('RGB', (tab_w, H))
    d = _draw(img)
    d.rectangle((0, 2, 1, H - 3), fill=col)                        # status stripe
    y0 = 1 if len(rows) == 3 else 6
    for k, (t, c) in enumerate(rows):
        if len(lines) == 2 and k == 2 and ' ' in t:   # count + payout share the last row
            cnt, rest = t.split(' ', 1)
            d.text((4, y0 + k * 10), cnt, font=F_SMALL, fill=col)
            d.text((4 + text_w(F_SMALL, cnt + ' '), y0 + k * 10), rest, font=F_SMALL, fill=WHITE)
        else:
            d.text((4, y0 + k * 10), t, font=F_SMALL, fill=c)
    d.line((tab_w - 3, 3, tab_w - 3, H - 4), fill=SEP)
    return img


def item_game(g, logos):
    """Score bug: two rows (away / home) with logos, then the clock."""
    clock = ascii_safe(_clock(g))
    rows = [(g['a'], g['as']), (g['h'], g['hs'])]
    pre = g['state'] == 'pre'
    ab_w = max(text_w(F_SCORE, _ab(t)) for t, _ in rows)
    sc_w = 0 if pre else max(text_w(F_SCORE, str(s)) for _, s in rows)
    c1, c2 = _clock_lines(g, clock)
    cw = max(text_w(F_SMALL, c1), text_w(F_SMALL, c2))
    w = 2 + 14 + 3 + ab_w + (5 + sc_w if not pre else 0) + 8 + cw + 12
    img = Image.new('RGB', (w, H))
    d = _draw(img)
    lead = None if pre or g['as'] == g['hs'] else (0 if g['as'] > g['hs'] else 1)
    for i, (t, s) in enumerate(rows):
        y = 1 + i * 16
        _paste_logo(img, logos.get(t, g['sport'], 14), 2, y, 14)
        d.text((19, y), _ab(t), font=F_SCORE, fill=WHITE if lead in (None, i) else DIM)
        if not pre:
            d.text((19 + ab_w + 5 + sc_w - text_w(F_SCORE, str(s)), y), str(s), font=F_SCORE, fill=WHITE if lead in (None, i) else DIM)
        if g['state'] == 'in' and g.get('poss') and str(t.get('id')) == g['poss']:
            d.rectangle((19 + ab_w + 1, y + 6, 19 + ab_w + 2, y + 7), fill=GOLD)
    cx = 19 + ab_w + (5 + sc_w if not pre else 0) + 8
    ccol = RED if g['state'] == 'in' else DIM
    d.text((cx, 4), c1, font=F_SMALL, fill=ccol)
    d.text((cx, 18), c2, font=F_SMALL, fill=RED if g.get('rz') and g['state'] == 'in' else DIM)
    d.line((w - 4, 4, w - 4, H - 5), fill=SEP)
    return img


def item_leg(row, game, logos):
    """Leg: team logo, label on top, status + detail underneath."""
    col = COL.get(row['cls'], DIM)
    label = ascii_safe(row['label'])
    if row.get('odds'):
        label_odds = ' %+d' % row['odds']
    else:
        label_odds = ''
    right = ascii_safe(row['right']).upper()
    sub = ascii_safe(row.get('sub') or '')
    if game:
        # the score bug already shows the score and clock
        sub = re.sub(r'^[A-Z0-9&.]+ \d+-\d+ [A-Z0-9&.]+ ?', '', sub)
        sub = sub.replace(_clock(game), '').strip(' -')
    inj = row.get('inj') or {}
    inj_tag = ascii_safe(inj.get('tag') or '')
    inj_col = {1: (255, 176, 32), 2: (255, 120, 30)}.get(inj.get('rank'), RED)
    inj_w = text_w(F_SMALL, inj_tag) + 4 if inj_tag else 0
    lw = text_w(F_BIG, label) + (text_w(F_SMALL, label_odds) + 2 if label_odds else 0) + (inj_w + 4 if inj_tag else 0)
    if inj.get('text') and inj.get('rank', 0) >= 3:
        sub = (sub + '  ' if sub else '') + ascii_safe(inj['text'])
    l2 = right + ('  ' + sub if sub else '')
    has_bar = row.get('prog') is not None and row['cls'] not in ('win', 'lost')
    w2 = text_w(F_SMALL, l2) + (34 if has_bar else 0)
    x0 = 4 + 22 + 4
    w = x0 + max(lw, w2) + 14
    img = Image.new('RGB', (w, H))
    d = _draw(img)
    # status pip down the left edge
    d.rectangle((0, 3, 1, H - 4), fill=col)
    logo = None
    if row.get('team') and game:
        logo = logos.get(row['team'], game['sport'], 22)
    if logo is not None:
        _paste_logo(img, logo, 4, 5, 22)
    elif row.get('market') == 'total' and game:
        a = logos.get(game['a'], game['sport'], 14)
        h = logos.get(game['h'], game['sport'], 14)
        _paste_logo(img, a, 4, 3, 14)
        _paste_logo(img, h, 12, 14, 14)
    else:
        d.ellipse((7, 8, 22, 23), outline=SEP)
    d.text((x0, 1), label, font=F_BIG, fill=WHITE)
    if label_odds:
        d.text((x0 + text_w(F_BIG, label) + 2, 4), label_odds, font=F_SMALL, fill=DIM)
    if inj_tag:  # injury badge: Q / D / OUT / IR / INJ
        bx = x0 + text_w(F_BIG, label) + (text_w(F_SMALL, label_odds) + 2 if label_odds else 0) + 4
        d.rectangle((bx, 3, bx + inj_w, 13), fill=inj_col)
        d.text((bx + 2, 3), inj_tag, font=F_SMALL, fill=(0, 0, 0))
    y2 = 19
    x = x0
    if has_bar:
        p = max(0.0, min(1.0, row['prog']))
        d.rectangle((x, y2 + 4, x + 29, y2 + 6), fill=SEP)
        if p > 0:
            d.rectangle((x, y2 + 4, x + max(1, int(29 * p)), y2 + 6), fill=col)
        x += 34
    d.text((x, y2), right, font=F_SMALL, fill=col)
    if sub:
        d.text((x + text_w(F_SMALL, right + '  '), y2), sub, font=F_SMALL, fill=DIM)
    d.line((w - 4, 4, w - 4, H - 5), fill=SEP)
    return img


def item_idle(text='BLUE HORSESHOE'):
    s = ascii_safe(text)
    w = 26 + text_w(F_BIG, s) + 40
    img = Image.new('RGB', (w, H))
    d = _draw(img)
    d.arc((3, 4, 21, 28), 0, 180, fill=BLUE, width=4)
    d.line((4, 4, 4, 16), fill=BLUE, width=4)
    d.line((20, 4, 20, 16), fill=BLUE, width=4)
    d.text((26, 8), s, font=F_BIG, fill=DIM)
    return img


def item_pair(code):
    """Shown when the ticker has no slips: the code to pair the Horseshoe Ticker app."""
    code = ascii_safe(code).upper()
    top, bot = 'PAIR THE APP', 'CODE'
    code_w = text_w(F_FLASH, code)
    w = 26 + max(text_w(F_SMALL, top), text_w(F_SMALL, bot)) + 8 + code_w + 40
    img = Image.new('RGB', (w, H))
    d = _draw(img)
    d.arc((3, 4, 21, 28), 0, 180, fill=BLUE, width=4)
    d.line((4, 4, 4, 16), fill=BLUE, width=4)
    d.line((20, 4, 20, 16), fill=BLUE, width=4)
    d.text((26, 4), top, font=F_SMALL, fill=DIM)
    d.text((26, 17), bot, font=F_SMALL, fill=DIM)
    x = 26 + max(text_w(F_SMALL, top), text_w(F_SMALL, bot)) + 8
    asc, desc = F_FLASH.getmetrics()
    d.text((x, (H - asc - desc) // 2 + 1), code, font=F_FLASH, fill=GOLD)
    return img


def flash_frame(width, text, kind, on):
    """Full-width alert. kind: win / lost / cashed. on toggles the blink."""
    text = ascii_safe(text).upper()
    if kind == 'cashed':
        bg, fg = (GOLD, (10, 10, 10)) if on else ((10, 10, 10), GOLD)
    elif kind == 'win':
        bg, fg = ((0, 0, 0), COL['win']) if on else (COL['win'], (0, 0, 0))
    else:
        bg, fg = ((0, 0, 0), RED) if on else ((40, 0, 0), RED)
    img = Image.new('RGB', (width, H), bg)
    d = _draw(img)
    for line, font, y in fit_lines(width - 8, text):
        d.text(((width - text_w(font, line)) // 2, y), line, font=font, fill=fg)
    d.rectangle((0, 0, width - 1, H - 1), outline=fg)
    return img


def _font_size(size):
    return _font('DejaVuSansCondensed-Bold.ttf', size)


def fit_lines(maxw, text):
    """Lay out alert text in the 32px strip -> [(line, font, y)].
    One big line if it fits (down to 14px); otherwise two lines, split at a newline in the text
    or at the word break that balances them best, as large as both lines allow."""
    text = text.strip()
    if '\n' not in text:
        for size in range(F_FLASH.size, 13, -1):
            f = _font_size(size)
            if text_w(f, text) <= maxw:
                top = f.getbbox(text)[1]
                bot = f.getbbox('A')[3]
                return [(text, f, (H - (bot - top)) // 2 - top)]
        words = text.split()
        best = None
        for i in range(1, len(words)):
            a, b = ' '.join(words[:i]), ' '.join(words[i:])
            w = max(text_w(F_BIG, a), text_w(F_BIG, b))
            if best is None or w < best[0]:
                best = (w, a, b)
        lines = [best[1], best[2]] if best else [text, '']
    else:
        lines = [x.strip() for x in text.split('\n', 1)]
    for size in (14, 13, 12, 11, 10):
        f = _font_size(size)
        if all(text_w(f, ln) <= maxw for ln in lines):
            break
    cap = f.getbbox('A')
    ch = cap[3] - cap[1]                       # capital height
    gap = max(2, (H - 2 * ch) // 3)
    out = []
    for k, ln in enumerate(lines):
        y = gap + k * (ch + gap) - cap[1]
        out.append((ln, f, y))
    return out


def _ab(t):
    return ascii_safe(t.get('abbreviation') or t.get('shortDisplayName') or '?')


def _clock(g):
    from legs import clock_str
    return clock_str(g)


def _clock_lines(g, clock):
    if g['state'] == 'in':
        m = re.match(r'^(\d+:\d+)\s*-\s*(.+)$', clock)
        if m:
            q = m.group(2).replace('1st', 'Q1').replace('2nd', 'Q2').replace('3rd', 'Q3').replace('4th', 'Q4')
            return q, m.group(1) if not (g.get('rz')) else m.group(1) + ' RZ'
        return clock[:10], ('RZ' if g.get('rz') else '')
    if g['state'] == 'post':
        return 'FINAL', ''
    parts = clock.split(' ')
    return parts[0], parts[1] if len(parts) > 1 else ''
