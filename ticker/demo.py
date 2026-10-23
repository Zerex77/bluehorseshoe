#!/usr/bin/env python3
"""Blue Horseshoe ticker demo: plays a scripted game so every feature shows on the panels.

Two fake slips go from upcoming -> live -> legs hitting -> a leg losing -> one slip BUSTED
-> the other CASHED, then it starts over. Every leg type has its own celebration animation
(see anim.py), so the demo shows all of them. No real scores are used.

Run on the Pi (stop the real ticker first so they don't fight over the panels):
    sudo systemctl stop bhticker
    sudo python3 /opt/bhticker/demo.py
    (Ctrl+C to quit)
    sudo systemctl start bhticker

Anywhere without panels:  python3 demo.py --preview frames
"""
import argparse
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bhticker as B  # noqa: E402

STAGE_SECONDS = 35

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
    r = {'label': label, 'market': market, 'g': g, 'team': T[team], 'odds': None, 'cls': cls, 'right': right, 'sub': sub}
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

    def bust(odunze, total, pats):
        return slip('b', 'Demo Bust', 5, '+500', 30, [
            leg('Rome Odunze 24.5 rec. yds', 'prop', 'g1', 'CHI', *odunze),
            leg('Over 33.5', 'total', 'g1', 'CHI', *total),
            leg('Patriots ML', 'ml', 'g1', 'NE', *pats)])

    out = []
    # 1: everything upcoming
    g1, g2 = game('g1', 'NE', 'CHI', 'pre'), game('g2', 'GB', 'DET', 'pre')
    out.append(({'g1': g1, 'g2': g2}, [parlay(P1, P1, P2, P2, P2, P2), bust(P1, P1, P1)]))
    # 2: Bears game live in the 2nd quarter, progress bars filling
    g1 = game('g1', 'NE', 'CHI', 'in', 7, 10, '6:12 - 2nd', 2, '6:12', poss='CHI', rz=True)
    out.append(({'g1': g1, 'g2': g2}, [
        parlay(('close', 'Up 3'), ('close', '112/200', 'pace 214', 0.56), P2, P2, P2, P2),
        bust(('good', '18/25', 'pace 33', 0.72), ('close', '17/33.5', 'pace 36', 0.5), ('close', 'Down 3'))]))
    # 3: 3rd quarter -> pass yds (DIME) and rec yds (CAUGHT IT) hit, Lions game kicks off
    g1 = game('g1', 'NE', 'CHI', 'in', 10, 17, '9:40 - 3rd', 3, '9:40', poss='NE')
    g2 = game('g2', 'GB', 'DET', 'in', 3, 0, '11:05 - 1st', 1, '11:05', poss='DET')
    out.append(({'g1': g1, 'g2': g2}, [
        parlay(('good', 'Up 7'), ('win', 'HIT 214', '', 1), ('close', '0/1', ''), ('close', '14/70', 'pace 68', 0.2),
               ('close', 'Down 3'), ('bad', 'Short 6.5')),
        bust(('win', 'HIT 41', '', 1), ('close', '27/33.5', 'pace 38', 0.8), ('bad', 'Down 7'))]))
    # 4: Bears final -> ML hits (WINNER), total goes over (scoreboard), Gibbs scores (TOUCHDOWN),
    #    Patriots ML loses (GUTTER BALL) and Demo Bust busts
    g1 = game('g1', 'NE', 'CHI', 'post', 13, 24, 'Final', 4, '0:00')
    g2 = game('g2', 'GB', 'DET', 'in', 20, 27, '4:51 - 4th', 4, '4:51', poss='DET')
    out.append(({'g1': g1, 'g2': g2}, [
        parlay(('win', 'WON', 'NE 13-24 CHI Final'), ('win', 'HIT 248', '', 1), ('win', 'HIT 1', '', 1),
               ('close', '64/70', 'pace 71', 0.91), ('good', 'Up 7'), ('good', 'Covering +3.5')),
        bust(('win', 'HIT 57', '', 1), ('win', 'HIT 37', '', 1), ('lost', 'LOST', 'NE 13-24 CHI Final'))]))
    # 5: Lions final -> rush yds (BREAKAWAY), ML (WINNER), spread (COVERED), then STRIKE + cash
    g2 = game('g2', 'GB', 'DET', 'post', 20, 30, 'Final', 4, '0:00')
    out.append(({'g1': g1, 'g2': g2}, [
        parlay(('win', 'WON', 'NE 13-24 CHI Final'), ('win', 'HIT 248', '', 1), ('win', 'HIT 1', '', 1),
               ('win', 'HIT 88', '', 1), ('win', 'WON', 'GB 20-30 DET Final'), ('win', 'WON', 'GB 20-30 DET Final')),
        bust(('win', 'HIT 57', '', 1), ('win', 'HIT 37', '', 1), ('lost', 'LOST', 'NE 13-24 CHI Final'))]))
    return out


class Demo(B.Ticker):
    def __init__(self, preview=None):
        super().__init__(preview)
        self.cfg['alerts'] = True
        self.script = stages()
        self.stage = 0

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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--preview', help='no LED hardware: write frames to this folder')
    args = ap.parse_args()
    app = Demo(args.preview)
    threading.Thread(target=app.data_loop, daemon=True).start()
    print('Blue Horseshoe demo running. Ctrl+C to stop.', flush=True)
    try:
        app.scroll_loop()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
