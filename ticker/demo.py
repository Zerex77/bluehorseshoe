#!/usr/bin/env python3
"""Blue Horseshoe ticker demo: plays a scripted game so every feature shows on the panels.

Two fake slips go from upcoming -> live -> legs hitting -> a leg losing -> one slip BUSTED
-> the other CASHED, then it starts over. Every leg type has its own celebration animation
(see anim.py), so the demo shows all of them. No real scores are used.

Run on the Pi. It pauses the real ticker while it runs and starts it again when you quit:
    sudo python3 /opt/bhticker/demo.py           (full demo, loops until Ctrl+C)
    sudo python3 /opt/bhticker/demo.py --reel    (just the animations, ~30 seconds)
    sudo python3 /opt/bhticker/demo.py --stage 3 (start the full demo at stage 3)

Anywhere without panels:  python3 demo.py --preview frames
"""
import argparse
import os
import re
import signal
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bhticker as B  # noqa: E402

STAGE_SECONDS = 40

T = {
    'NE': {'id': '17', 'abbreviation': 'NE', 'displayName': 'New England Patriots', 'shortDisplayName': 'Patriots', 'name': 'Patriots'},
    'CHI': {'id': '3', 'abbreviation': 'CHI', 'displayName': 'Chicago Bears', 'shortDisplayName': 'Bears', 'name': 'Bears'},
    'GB': {'id': '9', 'abbreviation': 'GB', 'displayName': 'Green Bay Packers', 'shortDisplayName': 'Packers', 'name': 'Packers'},
    'DET': {'id': '8', 'abbreviation': 'DET', 'displayName': 'Detroit Lions', 'shortDisplayName': 'Lions', 'name': 'Lions'},
}


def game(gid, a, h, state, a_s=0, h_s=0, detail='', period=0, clock='0:00', poss=None, rz=False):
    return {'id': gid, 'sport': 'nfl', 'date': '2026-10-25T17:00Z', 'state': state, 'detail': detail,
            'period': period, 'clock': clock, 'a': T[a], 'h': T[h], 'as': a_s, 'hs': h_s,
            'poss': T[poss]['id'] if poss else None, 'rz': rz, 'dd': ''}


def leg(label, market, g, team, cls, right, sub='', prog=None):
    player = re.split(r'\s+(?=\d)|\s+anytime', label)[0] if market == 'prop' else None
    r = {'label': label, 'market': market, 'g': g, 'team': T[team], 'odds': None, 'cls': cls, 'right': right, 'sub': sub,
         'player': player, 'inj': None}
    if prog is not None:
        r['prog'] = prog
    return r


def slip(sid, name, stake, price, pay, rows):
    lost = any(r['cls'] == 'lost' for r in rows)
    won = sum(1 for r in rows if r['cls'] == 'win')
    live = any(r['cls'] not in ('pre',) for r in rows)
    st = 'busted' if lost else 'cashed' if won == len(rows) else 'live' if live else 'pre'
    return {'id': sid, 'name': name, 'status': st, 'won': won, 'n': len(rows), 'pay': pay,
            'price': price, 'stake': stake, 'legs': rows}


def stages():
    """Each stage -> (games dict, snapshot list)."""
    P1, P2 = ('pre', '1:00 PM', 'NE @ CHI'), ('pre', '4:25 PM', 'GB @ DET')

    def parlay(bears, caleb, gibbs_td, gibbs, lions, lions_spread):
        return slip('a', 'Demo Parlay', 10, '+1450', 155, [
            leg('Bears ML', 'ml', 'g1', 'CHI', *bears),
            leg('Caleb Williams 199.5 pass yds', 'prop', 'g1', 'CHI', *caleb),
            leg('Jahmyr Gibbs anytime TD', 'prop', 'g2', 'DET', *gibbs_td),
            leg('Jahmyr Gibbs 69.5 rush yds', 'prop', 'g2', 'DET', *gibbs),
            leg('Lions ML', 'ml', 'g2', 'DET', *lions),
            leg('Lions -3.5', 'spread', 'g2', 'DET', *lions_spread)])

    def bust(odunze, total, pats, swift=None):
        swift = swift or P1
        return slip('b', 'Demo Bust', 5, '+650', 37.5, [
            leg('Rome Odunze 24.5 rec. yds', 'prop', 'g1', 'CHI', *odunze),
            leg('Over 33.5', 'total', 'g1', 'CHI', *total),
            leg('Patriots ML', 'ml', 'g1', 'NE', *pats),
            leg("D'Andre Swift 49.5 rush yds", 'prop', 'g1', 'CHI', *swift)])

    out = []
    # 1: everything upcoming
    g1, g2 = game('g1', 'NE', 'CHI', 'pre'), game('g2', 'GB', 'DET', 'pre')
    out.append(({'g1': g1, 'g2': g2}, [parlay(P1, P1, P2, P2, P2, P2), bust(P1, P1, P1)]))
    # 2: Bears game live in the 2nd quarter, progress bars filling
    g1 = game('g1', 'NE', 'CHI', 'in', 7, 10, '6:12 - 2nd', 2, '6:12', poss='CHI', rz=True)
    out.append(({'g1': g1, 'g2': g2}, [
        parlay(('close', 'Up 3'), ('close', '112/200', 'pace 214', 0.56), P2, P2, P2, P2),
        bust(('good', '18/25', 'pace 33', 0.72), ('close', '17/33.5', 'pace 36', 0.5), ('close', 'Down 3'),
             ('close', '24/50', 'pace 51', 0.48))]))
    # 3: 3rd quarter -> pass yds (DIME) and rec yds (CAUGHT IT) hit, Lions game kicks off
    g1 = game('g1', 'NE', 'CHI', 'in', 10, 17, '9:40 - 3rd', 3, '9:40', poss='NE')
    g2 = game('g2', 'GB', 'DET', 'in', 3, 0, '11:05 - 1st', 1, '11:05', poss='DET')
    out.append(({'g1': g1, 'g2': g2}, [
        parlay(('good', 'Up 7'), ('win', 'HIT 214', '', 1), ('close', '0/1', ''), ('close', '14/70', 'pace 68', 0.2),
               ('close', 'Down 3'), ('bad', 'Short 6.5')),
        bust(('win', 'HIT 41', '', 1), ('close', '27/33.5', 'pace 38', 0.8), ('bad', 'Down 7'),
             ('close', '38/50', 'pace 50', 0.76))]))
    # 4: Bears final -> ML hits (WINNER), total goes over (scoreboard), Gibbs scores (TOUCHDOWN),
    #    Patriots ML loses (NO GOOD), Swift falls just short (JUST SHORT) and Demo Bust busts
    g1 = game('g1', 'NE', 'CHI', 'post', 13, 24, 'Final', 4, '0:00')
    g2 = game('g2', 'GB', 'DET', 'in', 20, 27, '4:51 - 4th', 4, '4:51', poss='DET')
    out.append(({'g1': g1, 'g2': g2}, [
        parlay(('win', 'WON', 'NE 13-24 CHI Final'), ('win', 'HIT 248', '', 1), ('win', 'HIT 1', '', 1),
               ('close', '64/70', 'pace 71', 0.91), ('good', 'Up 7'), ('good', 'Covering +3.5')),
        bust(('win', 'HIT 57', '', 1), ('win', 'HIT 37', '', 1), ('lost', 'LOST', 'NE 13-24 CHI Final'),
             ('lost', 'LOST 46', '', 0.92))]))
    # 5: Lions final -> rush yds (BREAKAWAY), ML (WINNER), spread (COVERED), then the field goal + cash
    g2 = game('g2', 'GB', 'DET', 'post', 20, 30, 'Final', 4, '0:00')
    out.append(({'g1': g1, 'g2': g2}, [
        parlay(('win', 'WON', 'NE 13-24 CHI Final'), ('win', 'HIT 248', '', 1), ('win', 'HIT 1', '', 1),
               ('win', 'HIT 88', '', 1), ('win', 'WON', 'GB 20-30 DET Final'), ('win', 'WON', 'GB 20-30 DET Final')),
        bust(('win', 'HIT 57', '', 1), ('win', 'HIT 37', '', 1), ('lost', 'LOST', 'NE 13-24 CHI Final'),
             ('lost', 'LOST 46', '', 0.92))]))
    # injuries: Gibbs is questionable on the report before his game; Swift gets hurt in the 3rd quarter
    q = {'tag': 'Q', 'rank': 1, 'text': 'QUESTIONABLE - ANKLE'}
    hurt = {'tag': 'INJ', 'rank': 3, 'text': 'INJURED - RETURN QUESTIONABLE'}
    for n, (_, snap) in enumerate(out):
        for sl in snap:
            for r in sl['legs']:
                if r['player'] == 'Jahmyr Gibbs' and n < 2:
                    r['inj'] = q
                if r['player'] == "D'Andre Swift" and n >= 2:
                    r['inj'] = hurt
    return out


class Demo(B.Ticker):
    def __init__(self, preview=None, start=1):
        super().__init__(preview)
        self.cfg['alerts'] = True
        self.script = stages()
        self.stage = max(0, min(len(self.script), start) - 1)
        if self.stage > 0:
            # load the stage before quietly, so this stage's hits still flash
            self.queue_alerts(self.script[self.stage - 1][1])
            self.alerts = []

    def update(self):
        games, snap = self.script[self.stage]
        self.board.games = games
        if self.stage == 0:
            self.prev = {}  # restart quietly
        before = len(self.alerts)
        self.queue_alerts(snap)
        # show leg alerts first, then the slip busting / cashing
        new = self.alerts[before:]
        slip_alerts = [a for a in new if a[1] == 'cashed' or a[0].endswith(' busted')]
        self.alerts[before:] = [a for a in new if a not in slip_alerts] + slip_alerts
        with self.lock:
            self.snap = snap
            self.items = self.build_items(snap)
        self.status = 'Demo stage %d/%d' % (self.stage + 1, len(self.script))
        print(self.status, flush=True)

    def data_loop(self):
        while True:
            self.update()
            wait = STAGE_SECONDS * (2 if self.stage == len(self.script) - 1 else 1)
            time.sleep(wait)
            self.stage = (self.stage + 1) % len(self.script)


REEL = [
    ('dime', 'Caleb Williams 199.5 pass yds'), ('catch', 'Rome Odunze 24.5 rec. yds'),
    ('breakaway', 'Jahmyr Gibbs 69.5 rush yds'), ('touchdown', 'Jahmyr Gibbs anytime TD'),
    ('winner', 'Bears ML'), ('covered', 'Lions -3.5'), ('over', 'Over 44.5'), ('under', 'Under 44.5'),
    ('injury', "D'Andre Swift"), ('nogood', 'Patriots ML'), ('short:46:49.5', "D'Andre Swift 49.5 rush yds"),
    ('fieldgoal', 'CASHED $155'),
]


def reel(app, loops=1):
    """Every celebration back to back (about 30 seconds), no slips or text flashes in between."""
    import anim as A
    W = app.panel.width
    for _ in range(loops):
        for name, text in REEL:
            print('Playing', name, flush=True)
            for img, hold in A.play(name, W, text):
                t0 = time.time()
                app.panel.show(img)
                time.sleep(max(0.0, hold - (time.time() - t0)))
    app.panel.show(B.Image.new('RGB', (W, app.panel.height)))


PIDFILE = os.path.join(B.DATA, 'demo.pid')


def demo_pid():
    """pid of a demo that is still running (from its lock file), else None."""
    try:
        pid = int(open(PIDFILE).read().strip())
        with open('/proc/%d/cmdline' % pid, 'rb') as f:
            return pid if b'demo.py' in f.read() else None
    except (OSError, ValueError):
        return None


def take_panels():
    """Make sure nothing else is driving the panels (two programs at once = garbage lines).
    Pauses the real ticker if it's running and stops any other demo. Returns True if the
    ticker was running, so it can be started again when the demo ends."""
    other = demo_pid()
    if other and other != os.getpid():
        print('Stopping the other demo that was using the panels...', flush=True)
        try:
            os.kill(other, signal.SIGTERM)
        except OSError:
            pass
        for _ in range(30):
            if not demo_pid():
                break
            time.sleep(0.1)
    os.makedirs(B.DATA, exist_ok=True)
    with open(PIDFILE, 'w') as f:
        f.write(str(os.getpid()))
    was_running = subprocess.run(['systemctl', 'is-active', '--quiet', 'bhticker']).returncode == 0
    if was_running:
        print('Pausing the real ticker while the demo runs...', flush=True)
        subprocess.run(['systemctl', 'stop', 'bhticker'])
    return was_running


def give_back_panels(was_running):
    try:
        if demo_pid() == os.getpid():
            os.remove(PIDFILE)
    except OSError:
        pass
    if was_running:
        print('Starting the real ticker again.', flush=True)
        subprocess.run(['systemctl', 'start', 'bhticker'])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--preview', help='no LED hardware: write frames to this folder')
    ap.add_argument('--reel', action='store_true', help='just play every animation back to back (~30s) and quit')
    ap.add_argument('--loops', type=int, default=1, help='with --reel: how many times to play it')
    ap.add_argument('--stage', type=int, default=1, help='start the full demo at this stage (1-5)')
    args = ap.parse_args()
    was_running = False if args.preview else take_panels()

    def stop(*_):  # closing the SSH window or a kill still hands the panels back
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGHUP, stop)
    try:
        app = Demo(args.preview, args.stage)
        if args.reel:
            reel(app, args.loops)
            return
        threading.Thread(target=app.data_loop, daemon=True).start()
        print('Blue Horseshoe demo running. Ctrl+C to stop.', flush=True)
        app.scroll_loop()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            app.panel.show(B.Image.new('RGB', (app.panel.width, app.panel.height)))
        except Exception:
            pass
        give_back_panels(was_running)


if __name__ == '__main__':
    main()
