"""Blue Horseshoe ticker: read slips, match legs to ESPN games, and grade them live.

A straight port of the Live page logic (live.html) so the panel and the website agree.
"""
import math
import re
import time
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo

ET = ZoneInfo('America/New_York')

ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/'


# ---------------------------------------------------------------- helpers
def norm_name(x):
    x = str(x or '').lower()
    x = re.sub(r'\b(jr|sr|ii|iii|iv|v)\b\.?', '', x)
    x = re.sub(r'[^a-z ]', '', x)
    return re.sub(r'\s+', ' ', x).strip()


def squash(x):
    return norm_name(x).replace(' ', '')


def dec(am):
    try:
        am = float(am)
    except (TypeError, ValueError):
        return None
    if not am:
        return None
    return 1 + am / 100 if am > 0 else 1 + 100 / -am


def amer(d):
    if not d or d <= 1:
        return '—'
    return '+%d' % round((d - 1) * 100) if d >= 2 else str(round(-100 / (d - 1)))


def money(n):
    return '${:,.2f}'.format(n)


def fmt(n):
    v = round(n * 10) / 10
    return str(int(v)) if v == int(v) else str(v)


def sgn(n):
    v = round(n * 10) / 10
    s = fmt(v)
    return ('+' + s) if v > 0 else s


def lev(a, b):
    if abs(len(a) - len(b)) > 2:
        return 9
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] != b[j - 1]))
        prev = cur
    return prev[len(b)]


# ---------------------------------------------------------------- ESPN records
def read_game(ev, sport):
    comps = ev.get('competitions') or []
    if not comps:
        return None
    c = comps[0]
    cs = c.get('competitors') or []
    h = next((x for x in cs if x.get('homeAway') == 'home'), None)
    a = next((x for x in cs if x.get('homeAway') == 'away'), None)
    if not h or not a:
        return None
    stt = c.get('status') or ev.get('status') or {}
    typ = stt.get('type') or {}
    sit = c.get('situation') or {}

    def num(v):
        try:
            return int(float(v))
        except (TypeError, ValueError):
            return 0
    return {
        'id': str(ev.get('id')), 'sport': sport, 'date': ev.get('date') or c.get('date'),
        'state': typ.get('state') or 'pre', 'detail': typ.get('shortDetail') or typ.get('detail') or '',
        'period': stt.get('period') or 0, 'clock': stt.get('displayClock') or '0:00',
        'a': a.get('team') or {}, 'h': h.get('team') or {}, 'as': num(a.get('score')), 'hs': num(h.get('score')),
        'poss': str(sit['possession']) if sit.get('possession') else None, 'rz': bool(sit.get('isRedZone')),
        'dd': sit.get('shortDownDistanceText') or sit.get('downDistanceText') or '',
    }


def aliases(t):
    out = [str(x).lower() for x in [t.get('displayName'), t.get('shortDisplayName'), t.get('location'), t.get('name'),
                                       t.get('nickname'), t.get('abbreviation')] if x]
    for x in list(out):
        if x.endswith('state') and len(x.split(' ')) > 2:
            out.append(x.split(' ')[0] + ' state')
        if x == 'appalachian state':
            out += ['app state', 'app st']
        if x == 'app state':
            out += ['appalachian state', 'appalachian st']
        if re.search(r' st\.?$', x):
            out.append(re.sub(r' st\.?$', ' state', x))
    seen, res = set(), []
    for x in out:
        if len(x) >= 2 and x not in seen:
            seen.add(x)
            res.append(x)
    return res


def abbr(t):
    return t.get('abbreviation') or t.get('shortDisplayName') or '?'


def team_name(t):
    loc = t.get('location')
    return loc if loc and len(loc) <= 16 else (t.get('shortDisplayName') or abbr(t))


def find_teams(text, games):
    low = ' ' + re.sub(r"[^a-z0-9&'. ]", ' ', text.lower()) + ' '
    hits = []
    for gid, g in games.items():
        for side in ('a', 'h'):
            for al in aliases(g[side]):
                short = len(al) <= 4 and al == str(g[side].get('abbreviation') or '').lower()
                m = re.search(r'(^|[^a-z])' + re.escape(al) + r'(?=$|[^a-z])', low)
                if not m:
                    continue
                if short and not re.search(r'\b' + re.escape(al) + r'\b', text, re.I):
                    continue
                hits.append({'g': gid, 'side': side, 'len': len(al), 'at': m.start(), 'al': al})
    if not hits:
        words = low.split()
        for gid, g in games.items():
            for side in ('a', 'h'):
                for al in aliases(g[side]):
                    if len(al) < 6:
                        continue
                    n = len(al.split(' '))
                    tol = 2 if len(al) >= 10 else 1
                    for i in range(0, len(words) - n + 1):
                        if lev(' '.join(words[i:i + n]), al) <= tol:
                            hits.append({'g': gid, 'side': side, 'len': len(al), 'at': low.find(words[i]), 'al': al})
                            break
    hits.sort(key=lambda h: -h['len'])
    keep = []
    for h in hits:
        if any(h['at'] >= k['at'] and h['at'] + h['len'] <= k['at'] + k['len'] + 1 and k['al'] != h['al'] for k in keep):
            continue
        if any(k['g'] == h['g'] and k['side'] == h['side'] for k in keep):
            continue
        keep.append(h)
    return keep


# ---------------------------------------------------------------- leg text
STATS = [
    (r'\b(pass(ing)?\s*\+\s*rush(ing)?)\b', 'pass + rush yds'),
    (r'\b(rush(ing)?\s*\+\s*rec(eiving)?|scrimmage)\b', 'rush + rec yds'),
    (r'\b(pass(ing)?\s*(td|tds|touchdowns?))\b', 'pass TDs'),
    (r'\b(pass(ing)?\s*(yds|yards)?|py)\b', 'pass yds'),
    (r'\b(completions?|comp)\b', 'completions'),
    (r'\b(pass(ing)?\s*att(empt)?s?|attempts)\b', 'pass attempts'),
    (r'\b(longest\s*rush|long\s*rush)\b', 'longest rush'),
    (r'\b(longest\s*(rec|reception|catch)|long\s*rec)\b', 'longest reception'),
    (r'\b(rush(ing)?\s*att(empt)?s?|carries)\b', 'rush attempts'),
    (r'\b(rush(ing)?\s*(yds|yards)?|ry)\b', 'rush yds'),
    (r'\b(receptions?|catches|recs)\b', 'receptions'),
    (r'\b(rec(eiving)?\s*(yds|yards)?)\b', 'rec yds'),
    (r'\b(ints?|interceptions?)\b', 'interceptions thrown'),
]
SHORT = {'rec yds': 'rec. yds', 'rush yds': 'rush yds', 'pass yds': 'pass yds', 'receptions': 'receptions',
         'rush + rec yds': 'rush+rec yds', 'pass + rush yds': 'pass+rush yds', 'pass TDs': 'pass TDs',
         'completions': 'comp.', 'pass attempts': 'pass att.', 'rush attempts': 'carries', 'longest rush': 'long rush',
         'longest reception': 'long rec.', 'interceptions thrown': 'INTs', 'TDs': 'TDs'}


def stat_of(s):
    s = s.lower()
    for rx, what in STATS:
        if re.search(rx, s):
            return what
    return None


def title_name(x):
    x = str(x).lower()
    x = re.sub(r"(^|[\s\-.])([a-z])", lambda m: m.group(1) + m.group(2).upper(), x)
    x = re.sub(r"\b([a-z]{1,2})'([a-z])", lambda m: m.group(1)[0].upper() + m.group(1)[1:] + "'" + m.group(2).upper(), x, flags=re.I)
    return re.sub(r'\b(Ii|Iii|Iv)\b', lambda m: m.group(0).upper(), x)


def clean_player(x):
    x = re.sub(r'\s+[-–—]\s+.*$', '', str(x))
    x = re.sub(r"\b(to (record|score|have|throw)|alt(ernate)?|player|over|under|o/u|receptions?|receiving|rushing|passing|pass|rush|"
               r"yards|yds|touchdowns?|completions?|attempts|carries|longest|interceptions?|anytime)\b.*$", '', x, flags=re.I)
    x = re.sub(r'[\d+]+.*$', '', x)
    return title_name(re.sub(r'\s+', ' ', x).strip())


def parse_leg(raw, games, hint=None, player_game=None):
    hint = hint or {}
    text = re.sub(r'\s+', ' ', str(raw).strip())
    odds = None
    m = re.search(r'\s*(?:@|odds)?\s*\(?\s*([+\-−]\d{3,5})\s*\)?\s*$', text, re.I)
    if m and text[:m.start()].strip():
        pv = int(m.group(1).replace('−', '-'))
        if abs(pv) >= 100:
            odds = pv
            text = text[:m.start()].strip()
    leg = {'raw': str(raw).strip(), 'text': text, 'odds': odds if odds is not None else hint.get('odds'), 'market': None}
    low = text.lower()

    thr = re.match(r'^(.*?)\s+(to throw( a)? (td|touchdown)|1\+ pass(ing)? td)$', text, re.I)
    yes = re.match(r'^(.*?)\s+(anytime\s*(td|touchdown)|atd|to score( a)?( td| touchdown)?|any time td|td scorer)$', text, re.I)
    over = re.match(r'^(.*?)\s+(?:over|o)\s*([\d.]+)\s+(.+)$', text, re.I)
    plus = re.match(r'^(.*?)\s+(\d+(?:\.\d+)?)\+\s*(.+)$', text, re.I)
    if thr:
        leg.update(market='prop', player=thr.group(1), what='pass TDs', line=0.5, side='yes')
    elif yes:
        leg.update(market='prop', player=yes.group(1), what='TDs', line=0.5, side='yes')
    elif over and stat_of(over.group(3)):
        leg.update(market='prop', player=over.group(1), line=float(over.group(2)), what=stat_of(over.group(3)), side='over')
    elif plus and stat_of(plus.group(3)):
        leg.update(market='prop', player=plus.group(1), line=float(plus.group(2)) - 0.5, what=stat_of(plus.group(3)), side='over')
    if leg['market'] == 'prop':
        p = re.sub(r'\s*[\(\[].*?[\)\]]\s*', ' ', leg['player'])
        p = re.sub(r'^.*?:\s*', '', p).strip()
        leg['player'] = clean_player(p) or title_name(p)
        if hint.get('g'):
            leg['g'] = str(hint['g'])
        else:
            ht = find_teams(text.replace(leg['player'], ' '), games)
            leg['g'] = ht[0]['g'] if ht else (player_game or {}).get(squash(leg['player']))
        return leg

    if hint.get('g') and str(hint['g']) not in games:
        leg.update(g=str(hint['g']), market='pending')
        return leg
    if hint.get('g'):
        teams = [t for t in find_teams(text, games) if t['g'] == str(hint['g'])] or [{'g': str(hint['g']), 'side': None}]
    else:
        teams = find_teams(text, games)
    m = re.search(r'(?:^|\s)(over|under|o|u)\s*([\d.]+)(?=\s|$)', low, re.I)
    if m:
        leg.update(market='total', dir='over' if m.group(1).lower().startswith('o') else 'under', line=float(m.group(2)))
        if teams:
            leg['g'] = teams[0]['g']
        return leg
    if not teams:
        return leg
    t = teams[0]
    leg['g'], leg['side'] = t['g'], t['side']
    m = re.search(r"(^|\s)([+-]\s*\d+(?:\.\d+)?|pk|pick'?em|pick)(\s|$)", text, re.I)
    if m and not re.search(r'\b(ml|moneyline)\b', low):
        v = 0.0 if m.group(2).lower().startswith('p') else float(m.group(2).replace(' ', ''))
        if abs(v) < 70 and t['side']:
            leg.update(market='spread', line=v)
            return leg
    leg.update(market='ml', line=0)
    return leg


def short_label(p):
    if p.get('market') != 'prop':
        return p['text']
    if p.get('side') == 'yes':
        return p['player'] + (' to throw a TD' if p['what'] == 'pass TDs' else ' anytime TD')
    return '%s %s %s' % (p['player'], fmt(p['line']), SHORT.get(p['what'], p['what']))


# ---------------------------------------------------------------- box scores
def _matcher(player):
    want = norm_name(player)
    want_sq = want.replace(' ', '')
    parts_w = want.split(' ')

    def is_him(name):
        n = norm_name(name)
        if not n:
            return False
        sq = n.replace(' ', '')
        if sq == want_sq or sq.startswith(want_sq) or want_sq.startswith(sq):
            return True
        parts = n.split(' ')
        if parts[-1] != parts_w[-1]:
            return False
        return len(parts_w) == 1 or parts[0][0] == parts_w[0][0]
    return is_him


def player_stat(summ, player, what):
    groups = ((summ or {}).get('boxscore') or {}).get('players')
    if not isinstance(groups, list):
        return None
    is_him = _matcher(player)
    seen = [False]

    def get(cat, keys_wanted, part=None):
        for team in groups:
            for st in team.get('statistics') or []:
                if st.get('name') != cat:
                    continue
                keys = [str(k).lower() for k in (st.get('keys') or st.get('labels') or [])]
                for a in st.get('athletes') or []:
                    if not is_him((a.get('athlete') or {}).get('displayName')):
                        continue
                    seen[0] = True
                    for kw in keys_wanted:
                        ix = keys.index(kw) if kw in keys else next((i for i, k in enumerate(keys) if k.startswith(kw)), -1)
                        if ix != -1:
                            raw = str((a.get('stats') or [])[ix] if ix < len(a.get('stats') or []) else '0')
                            if '/' in raw:
                                pr = raw.split('/')
                                try:
                                    return float(pr[1] if part == 'att' else pr[0])
                                except ValueError:
                                    return 0
                            try:
                                return float(re.sub(r'[^\d.-]', '', raw) or 0)
                            except ValueError:
                                return 0
                    return 0
        return None

    n = lambda v: 0 if v is None else v
    if what == 'pass yds': v = get('passing', ['passingyards', 'yds'])
    elif what == 'pass TDs': v = get('passing', ['passingtouchdowns', 'td'])
    elif what == 'interceptions thrown': v = get('passing', ['interceptions', 'int'])
    elif what == 'completions': v = get('passing', ['completions/passingattempts', 'c/att', 'completions'])
    elif what == 'pass attempts': v = get('passing', ['completions/passingattempts', 'c/att'], 'att')
    elif what == 'rush yds': v = get('rushing', ['rushingyards', 'yds'])
    elif what == 'rush attempts': v = get('rushing', ['rushingattempts', 'car'])
    elif what == 'longest rush': v = get('rushing', ['longrushing', 'long'])
    elif what == 'rec yds': v = get('receiving', ['receivingyards', 'yds'])
    elif what == 'receptions': v = get('receiving', ['receptions', 'rec'])
    elif what == 'longest reception': v = get('receiving', ['longreception', 'long'])
    elif what == 'rush + rec yds':
        r, c = get('rushing', ['rushingyards', 'yds']), get('receiving', ['receivingyards', 'yds'])
        v = None if r is None and c is None else n(r) + n(c)
    elif what == 'pass + rush yds':
        r, c = get('passing', ['passingyards', 'yds']), get('rushing', ['rushingyards', 'yds'])
        v = None if r is None and c is None else n(r) + n(c)
    elif what == 'TDs':
        r, c = get('rushing', ['rushingtouchdowns', 'td']), get('receiving', ['receivingtouchdowns', 'td'])
        v = None if r is None and c is None else n(r) + n(c)
    else:
        v = None
    if v is None and seen[0]:
        v = 0
    if v is not None and v == int(v):
        v = int(v)
    return v


def player_team(summ, player):
    groups = ((summ or {}).get('boxscore') or {}).get('players')
    if not isinstance(groups, list):
        return None
    is_him = _matcher(player)
    for team in groups:
        for st in team.get('statistics') or []:
            for a in st.get('athletes') or []:
                if is_him((a.get('athlete') or {}).get('displayName')):
                    return team.get('team')
    return None


def in_box(summ, player):
    return any(player_stat(summ, player, w) is not None for w in ('pass yds', 'rush yds', 'rec yds'))


# ---------------------------------------------------------------- grading
def frac(g):
    if g['state'] == 'post':
        return 1.0
    if g['state'] != 'in':
        return 0.0
    if re.search(r'half', g['detail'], re.I):
        return 0.5
    p = min(g['period'] or 1, 5)
    if p > 4:
        return 1.0
    m = re.search(r'(\d+):(\d+)', g['clock'] or '')
    left = int(m.group(1)) + int(m.group(2)) / 60 if m else 0
    if re.search(r'end', g['detail'], re.I):
        left = 0
    return max(0.0, min(1.0, ((p - 1) * 15 + (15 - left)) / 60))


def proj(cur, line, f):
    if f <= 0:
        return line
    if f >= 1:
        return cur
    pace = cur / f
    w = min(1, f * 1.4)
    rate = w * pace + (1 - w) * max(line, cur)
    return cur + (1 - f) * rate


def clock_str(g):
    if g['state'] == 'pre':
        try:
            dt = datetime.fromisoformat(g['date'].replace('Z', '+00:00'))
            et = dt.astimezone(ET)
            return et.strftime('%-I:%M %p')
        except Exception:
            return 'Soon'
    if g['state'] == 'post':
        return 'Final'
    return g['detail'] or ('Q%s %s' % (g['period'], g['clock']))


def score_line(g):
    return '%s %d-%d %s' % (abbr(g['a']), g['as'], g['hs'], abbr(g['h']))


def eval_leg(leg, games, summaries):
    """-> dict(cls, right, sub, prog). cls: win good close bad lost push pre unk"""
    g = games.get(leg.get('g')) if leg.get('g') else None
    mk = leg.get('market')
    if not mk:
        return dict(cls='unk', right='?', sub="Can't match this leg")
    if mk == 'pending' or (not g and leg.get('g')):
        return dict(cls='pre', right='...', sub='Loading game')
    if not g:
        if mk == 'prop':
            return dict(cls='pre', right='Waiting', sub='Looking for ' + leg['player'])
        return dict(cls='unk', right='?', sub='Game not found')
    f = frac(g)
    done = g['state'] == 'post'
    base = score_line(g) + ' ' + clock_str(g)
    if g['state'] == 'pre' and mk != 'prop':
        return dict(cls='pre', right=clock_str(g), sub='%s @ %s' % (abbr(g['a']), abbr(g['h'])))
    if mk in ('ml', 'spread'):
        mine, opp = (g['as'], g['hs']) if leg['side'] == 'a' else (g['hs'], g['as'])
        mm = mine - opp + (leg['line'] if mk == 'spread' else 0)
        if done:
            return dict(cls='win' if mm > 0 else 'lost' if mm < 0 else 'push', right='WON' if mm > 0 else 'LOST' if mm < 0 else 'PUSH', sub=base)
        safe = 3 + 7 * (1 - f)
        cls = 'good' if mm >= safe else 'close' if mm > -safe else 'bad'
        if mk == 'ml':
            right = 'Up %s' % fmt(mm) if mm > 0 else 'Down %s' % fmt(-mm) if mm < 0 else 'Tied'
        else:
            right = 'Covering %s' % sgn(mm) if mm > 0 else 'Short %s' % fmt(-mm) if mm < 0 else 'On the number'
        return dict(cls=cls, right=right, sub=base)
    if mk == 'total':
        pts = g['as'] + g['hs']
        pj = proj(pts, leg['line'], f)
        if leg['dir'] == 'over':
            if pts > leg['line']:
                return dict(cls='win', right='HIT %d' % pts, sub=base, prog=1)
            if done:
                return dict(cls='push' if pts == leg['line'] else 'lost', right='PUSH' if pts == leg['line'] else 'LOST %d' % pts, sub=base)
            d = pj - leg['line']
        else:
            if pts > leg['line']:
                return dict(cls='lost', right='LOST %d' % pts, sub=base, prog=1)
            if done:
                return dict(cls='push' if pts == leg['line'] else 'win', right='PUSH' if pts == leg['line'] else 'WON %d' % pts, sub=base)
            d = leg['line'] - pj
        return dict(cls='good' if d > 4 else 'close' if d > -4 else 'bad', right='%d/%s' % (pts, fmt(leg['line'])),
                    sub='pace %d' % round(pj), prog=pts / leg['line'])
    if mk == 'prop':
        if g['state'] == 'pre':
            return dict(cls='pre', right=clock_str(g), sub='%s @ %s' % (abbr(g['a']), abbr(g['h'])))
        summ = (summaries.get(g['id']) or {}).get('json')
        cur = player_stat(summ, leg['player'], leg['what']) if summ else None
        tgt = '1' if leg['side'] == 'yes' else fmt(leg['line'] + 0.5)
        if cur is None:
            if done:
                return dict(cls='unk', right='No stats', sub='not in box score')
            return dict(cls='close', right='0/' + tgt, sub='no stats yet', prog=0)
        if cur > leg['line']:
            return dict(cls='win', right='HIT %s' % fmt(cur), sub='', prog=1)
        if done:
            return dict(cls='lost', right='LOST %s' % fmt(cur), sub='', prog=cur / (leg['line'] + 0.5))
        pj = proj(cur, leg['line'], f)
        ratio = pj / (leg['line'] + 0.5)
        if leg['side'] == 'yes':
            cls = 'bad' if f > 0.85 else 'close'
        else:
            cls = 'good' if ratio >= 1.08 else 'close' if ratio >= 0.85 else 'bad'
        return dict(cls=cls, right='%s/%s' % (fmt(cur), tgt), sub='' if leg['side'] == 'yes' else 'pace %d' % round(pj),
                    prog=cur / (leg['line'] + 0.5))
    return dict(cls='unk', right='?', sub='')


def slip_status(legs, evs, games):
    if any(e['cls'] == 'lost' for e in evs):
        return 'busted'
    won = sum(1 for e in evs if e['cls'] in ('win', 'push'))
    if legs and won == len(legs):
        return 'cashed'
    if won or any(games.get(l.get('g'), {}).get('state') == 'in' for l in legs):
        return 'live'
    return 'pre'


def payout(slip, legs):
    stake = float(slip.get('stake') or 0)
    d = dec(slip.get('odds')) if slip.get('odds') else None
    if not d and legs and all(l.get('odds') for l in legs):
        d = 1
        for l in legs:
            d *= dec(l['odds'])
    return {'d': d, 'stake': stake, 'pay': stake * d if d and stake else None}


# ---------------------------------------------------------------- live data
class Board:
    """Holds ESPN games + box scores and refreshes them."""

    def __init__(self, get_json):
        self.get_json = get_json  # function(url) -> dict (raises on error)
        self.games = {}
        self.summaries = {}
        self.player_game = {}
        self.last_scan = {}
        self.ok_at = 0

    def fetch_boards(self):
        now = datetime.now(ET)
        days = [now.strftime('%Y%m%d')]
        if now.hour < 6:
            days.append((now - timedelta(days=1)).strftime('%Y%m%d'))
        urls = [('nfl', ESPN + 'nfl/scoreboard')]
        for d in days:
            urls.append(('cfb', ESPN + 'college-football/scoreboard?groups=80&limit=300&dates=' + d))
            urls.append(('cfb', ESPN + 'college-football/scoreboard?groups=81&limit=300&dates=' + d))
        ok = 0
        for sport, u in urls:
            try:
                j = self.get_json(u)
            except Exception:
                continue
            ok += 1
            for ev in j.get('events') or []:
                g = read_game(ev, sport)
                if g:
                    off = self.games.get(g['id'], {}).get('offBoard')
                    if off:
                        g['offBoard'] = False
                    self.games[g['id']] = g
        if ok:
            self.ok_at = time.time()
        return ok

    def fetch_summary(self, gid, sport, off_board=False):
        path = ('nfl' if sport == 'nfl' else 'college-football') + '/summary?event=' + gid
        j = self.get_json(ESPN + path)
        self.summaries[gid] = {'t': time.time(), 'json': j}
        comp = ((j.get('header') or {}).get('competitions') or [None])[0]
        if comp and (off_board or gid not in self.games):
            rec = read_game({'id': gid, 'date': comp.get('date'), 'competitions': [comp]}, sport)
            if rec:
                rec['offBoard'] = off_board
                self.games[gid] = rec

    def legs_of(self, slip):
        out = []
        for l in slip.get('legs') or []:
            p = parse_leg(l.get('text', ''), self.games, l, self.player_game)
            if p.get('market') == 'prop' and not p.get('g') and self.player_game.get(squash(p['player'])):
                p['g'] = self.player_game[squash(p['player'])]
            p['label'] = short_label(p)
            p['sport'] = l.get('sport')
            out.append(p)
        return out

    def refresh(self, slips):
        self.fetch_boards()
        now = time.time()
        want = {}
        for s in slips:
            for l in self.legs_of(s):
                if l.get('g'):
                    g = self.games.get(l['g'])
                    if not g:
                        want[l['g']] = (l.get('sport') or 'nfl', True)
                    elif l['market'] == 'prop' and g['state'] != 'pre':
                        want[l['g']] = (g['sport'], bool(g.get('offBoard')))
                    continue
                if l.get('market') != 'prop':
                    continue
                for gid, g in self.games.items():
                    if g['state'] == 'pre' or gid in want:
                        continue
                    if now - self.last_scan.get(gid, 0) < 120:
                        continue
                    want[gid] = (g['sport'], False)
                    self.last_scan[gid] = now
        for gid, (sport, off) in list(want.items())[:40]:
            sm = self.summaries.get(gid)
            g = self.games.get(gid)
            if sm:
                age = now - sm['t']
                if g and g['state'] == 'post' and not off and age < 600:
                    continue
                if age < (60 if off else 15):
                    continue
            try:
                self.fetch_summary(gid, sport, off)
            except Exception:
                pass
        # place players we found in a box score
        for s in slips:
            for l in self.legs_of(s):
                if l.get('market') != 'prop' or l.get('g'):
                    continue
                key = squash(l['player'])
                if key in self.player_game:
                    continue
                for gid, sm in self.summaries.items():
                    if in_box(sm['json'], l['player']):
                        self.player_game[key] = gid
                        break

    def snapshot(self, slips):
        """Evaluate every slip -> list of dicts the renderer and web page use."""
        out = []
        for s in slips:
            legs = self.legs_of(s)
            evs = [eval_leg(l, self.games, self.summaries) for l in legs]
            st = slip_status(legs, evs, self.games)
            po = payout(s, legs)
            rows = []
            for l, e in zip(legs, evs):
                g = self.games.get(l.get('g')) if l.get('g') else None
                team = None
                if g and l.get('market') in ('ml', 'spread') and l.get('side'):
                    team = g[l['side']]
                elif g and l.get('market') == 'prop':
                    sm = self.summaries.get(g['id'])
                    tm = player_team(sm['json'], l['player']) if sm else None
                    if tm:
                        team = g['a'] if str(tm.get('id')) == str(g['a'].get('id')) else g['h'] if str(tm.get('id')) == str(g['h'].get('id')) else tm
                rows.append({'label': l['label'], 'market': l.get('market'), 'g': l.get('g') if g else None,
                             'team': team, 'odds': l.get('odds'), **e})
            won = sum(1 for e in evs if e['cls'] in ('win', 'push'))
            out.append({'id': s.get('id'), 'name': s.get('name') or 'Slip', 'status': st, 'won': won, 'n': len(legs),
                        'pay': po['pay'], 'price': amer(po['d']) if po['d'] else None, 'stake': po['stake'], 'legs': rows})
        return out
