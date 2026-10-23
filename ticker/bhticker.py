#!/usr/bin/env python3
"""Blue Horseshoe LED ticker.

Scrolls your bet slips across a row of HUB75 LED panels on a Raspberry Pi, graded live from ESPN.
Slips arrive from the website's Live page ("Send to LED ticker") or the ticker's own page at
http://bhticker.local:8080

Run:  sudo python3 bhticker.py            (on the Pi, drives the panels)
      python3 bhticker.py --preview out   (anywhere: writes PNG frames instead, for testing)
"""
import argparse
import json
import os
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import legs as L  # noqa: E402
import render as R  # noqa: E402
import anim as A  # noqa: E402
from PIL import Image  # noqa: E402

DATA = os.environ.get('BHTICKER_DATA', '/var/lib/bhticker')
DEFAULTS = {
    'panels': 4, 'cols': 64, 'rows': 32,         # 4 x 64x32 in a row = 256x32
    'hardware_mapping': 'adafruit-hat',          # 'adafruit-hat-pwm' if you did the bonnet's PWM solder mod
    'gpio_slowdown': 4,                          # 4 for Pi 4, 2 for Pi 3, 1 for Pi Zero 2
    'panel_type': '',                            # set to 'FM6126A' if the panels stay dark
    'brightness': 60,                            # percent
    'speed': 40,                                 # pixels per second
    'refresh': 15,                               # seconds between ESPN checks
    'alerts': True,                              # flash when a leg hits / busts / the slip cashes
    'animations': True,                          # play a celebration animation before each flash
    'port': 8080,
}


# ---------------------------------------------------------------- storage
def load_json(name, default):
    try:
        with open(os.path.join(DATA, name)) as f:
            return json.load(f)
    except Exception:
        return default


def save_json(name, obj):
    os.makedirs(DATA, exist_ok=True)
    tmp = os.path.join(DATA, name + '.tmp')
    with open(tmp, 'w') as f:
        json.dump(obj, f)
    os.replace(tmp, os.path.join(DATA, name))


def http_get(url, timeout=10):
    req = urllib.request.Request(url, headers={'User-Agent': 'bhticker/1.0'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def get_json(url):
    return json.loads(http_get(url).decode('utf-8'))


# ---------------------------------------------------------------- displays
class PanelRgbMatrix:
    """Pi 4 / 3 / Zero 2 with hzeller's rpi-rgb-led-matrix."""

    def __init__(self, cfg):
        from rgbmatrix import RGBMatrix, RGBMatrixOptions
        o = RGBMatrixOptions()
        o.rows, o.cols, o.chain_length, o.parallel = cfg['rows'], cfg['cols'], cfg['panels'], 1
        o.hardware_mapping = cfg['hardware_mapping']
        o.gpio_slowdown = cfg['gpio_slowdown']
        o.brightness = int(cfg['brightness'])
        o.drop_privileges = False
        o.disable_hardware_pulsing = False
        if cfg.get('panel_type'):
            o.panel_type = cfg['panel_type']
        self.m = RGBMatrix(options=o)
        self.canvas = self.m.CreateFrameCanvas()
        self.width, self.height = cfg['cols'] * cfg['panels'], cfg['rows']

    def show(self, img):
        self.canvas.SetImage(img, 0, 0)
        self.canvas = self.m.SwapOnVSync(self.canvas)

    def set_brightness(self, pct):
        self.m.brightness = int(pct)


class PanelPiomatter:
    """Pi 5 with Adafruit's Piomatter."""

    def __init__(self, cfg):
        import numpy as np
        try:
            import adafruit_blinka_raspberry_pi5_piomatter as pm
        except ImportError:
            import piomatter as pm
        self.np = np
        self.width, self.height = cfg['cols'] * cfg['panels'], cfg['rows']
        geo = pm.Geometry(width=self.width, height=self.height, n_addr_lines=4 if cfg['rows'] == 32 else 5,
                          rotation=pm.Orientation.Normal)
        self.fb = np.zeros((self.height, self.width, 3), dtype=np.uint8)
        self.m = pm.PioMatter(colorspace=pm.Colorspace.RGB888Packed, pinout=pm.Pinout.AdafruitMatrixBonnet,
                              framebuffer=self.fb, geometry=geo)
        self.bright = cfg['brightness'] / 100.0

    def show(self, img):
        arr = self.np.asarray(img, dtype=self.np.float32) * self.bright
        self.fb[:] = arr.astype(self.np.uint8)
        self.m.show()
        time.sleep(1 / 60)

    def set_brightness(self, pct):
        self.bright = pct / 100.0


class PanelPreview:
    """No hardware: saves a frame every second so you can see what the panel would show."""

    def __init__(self, cfg, out):
        self.width, self.height = cfg['cols'] * cfg['panels'], cfg['rows']
        self.out = out
        os.makedirs(out, exist_ok=True)
        self.last = 0
        self.n = 0

    def show(self, img):
        now = time.time()
        if now - self.last >= 1:
            self.last = now
            img.resize((img.width * 4, img.height * 4), Image.NEAREST).save(os.path.join(self.out, 'frame%03d.png' % (self.n % 1000)))
            self.n += 1
        time.sleep(1 / 60)

    def set_brightness(self, pct):
        pass


def open_panel(cfg, preview):
    if preview:
        return PanelPreview(cfg, preview)
    model = ''
    try:
        with open('/proc/device-tree/model') as f:
            model = f.read()
    except Exception:
        pass
    if 'Raspberry Pi 5' in model:
        return PanelPiomatter(cfg)
    return PanelRgbMatrix(cfg)


# ---------------------------------------------------------------- app
class Ticker:
    def __init__(self, preview=None):
        self.cfg = dict(DEFAULTS, **load_json('config.json', {}))
        self.slips = load_json('slips.json', [])
        self.board = L.Board(get_json)
        self.logos = R.Logos(lambda u: http_get(u, 8), os.path.join(DATA, 'logos'))
        self.snap = []
        self.items = []          # list of callables -> PIL image (rendered fresh as they enter)
        self.alerts = []         # queue of (text, kind)
        self.prev = {}           # leg key -> cls, for alerts
        self.lock = threading.RLock()
        self.panel = open_panel(self.cfg, preview)
        self.status = 'Starting'

    # -- slips
    def set_slips(self, slips, mode='replace'):
        with self.lock:
            if mode == 'merge':
                ids = {s.get('id') for s in self.slips}
                self.slips = self.slips + [s for s in slips if s.get('id') not in ids]
            else:
                self.slips = slips
            save_json('slips.json', self.slips)
        threading.Thread(target=self.update, daemon=True).start()

    def remove(self, sid):
        with self.lock:
            self.slips = [s for s in self.slips if s.get('id') != sid]
            save_json('slips.json', self.slips)
        threading.Thread(target=self.update, daemon=True).start()

    def set_config(self, patch):
        with self.lock:
            for k in ('brightness', 'speed', 'alerts', 'animations'):
                if k in patch:
                    self.cfg[k] = patch[k]
            save_json('config.json', {k: self.cfg[k] for k in self.cfg if self.cfg[k] != DEFAULTS.get(k)})
            self.panel.set_brightness(self.cfg['brightness'])

    # -- data
    def update(self):
        with self.lock:
            slips = list(self.slips)
        try:
            self.board.refresh(slips)
            snap = self.board.snapshot(slips)
            self.status = 'Live' if self.board.ok_at and time.time() - self.board.ok_at < 120 else 'Scores feed unavailable'
        except Exception as e:  # keep scrolling the last good data
            self.status = 'Error: %s' % e
            return
        self.queue_alerts(snap)
        with self.lock:
            self.snap = snap
            self.items = self.build_items(snap)

    def queue_alerts(self, snap):
        if not self.cfg.get('alerts'):
            return
        first = not self.prev
        for s in snap:
            key = 'slip:%s' % s['id']
            if not first and self.prev.get(key) not in (None, s['status']):
                if s['status'] == 'cashed':
                    self.alerts.append(('CASHED ' + ('$' + format(s['pay'], ',.0f') if s.get('pay') else s['name']), 'cashed', 'fieldgoal'))
                elif s['status'] == 'busted':
                    self.alerts.append((s['name'] + ' busted', 'lost', None))
            self.prev[key] = s['status']
            for i, r in enumerate(s['legs']):
                k = '%s:%d:%s' % (s['id'], i, r['label'])
                old = self.prev.get(k)
                if not first and old is not None and old != r['cls']:
                    if r['cls'] == 'win':
                        self.alerts.append((r['label'] + ' HIT', 'win', A.pick(r)))
                    elif r['cls'] == 'lost':
                        self.alerts.append((r['label'] + ' lost', 'lost', A.pick_loss(r)))
                self.prev[k] = r['cls']

    def build_items(self, snap):
        """Order: slip header, then each game's score bug followed by that game's legs (live games first)."""
        items = []
        games = self.board.games
        rank = {'in': 0, 'pre': 1, 'post': 2}
        for s in snap:
            items.append(('slip', s))
            groups, order = {}, []
            for r in s['legs']:
                k = r['g'] or '_'
                if k not in groups:
                    groups[k] = []
                    order.append(k)
                groups[k].append(r)
            order.sort(key=lambda k: (9, '') if k == '_' else (rank.get(games[k]['state'], 3), games[k].get('date') or ''))
            for k in order:
                if k != '_':
                    items.append(('game', games[k]))
                for r in groups[k]:
                    items.append(('leg', (r, games.get(r['g']) if r['g'] else None)))
        if not items:
            items.append(('idle', 'BLUE HORSESHOE  -  waiting for slips'))
        return items

    def draw_item(self, it):
        kind, val = it
        if kind == 'slip':
            return R.item_slip(val)
        if kind == 'game':
            g = self.board.games.get(val['id'], val)  # freshest score
            return R.item_game(g, self.logos)
        if kind == 'leg':
            return R.item_leg(val[0], val[1], self.logos)
        return R.item_idle(val)

    # -- loops
    def data_loop(self):
        while True:
            self.update()
            time.sleep(max(5, int(self.cfg['refresh'])))

    def scroll_loop(self):
        W, H = self.panel.width, self.panel.height
        tiles = []   # [x, image]
        idx = 0
        x_off = 0.0
        last = time.time()
        while True:
            now = time.time()
            dt = min(0.1, now - last)
            last = now
            if self.alerts:
                self.flash(*self.alerts.pop(0))
                last = time.time()
                continue
            x_off += self.cfg['speed'] * dt
            step = int(x_off)
            x_off -= step
            for t in tiles:
                t[0] -= step
            tiles = [t for t in tiles if t[0] + t[1].width > 0]
            right = tiles[-1][0] + tiles[-1][1].width if tiles else W
            while right < W + 2:
                with self.lock:
                    items = self.items
                if not items:
                    break
                it = items[idx % len(items)]
                idx = (idx + 1) % max(1, len(items))
                img = self.draw_item(it)
                tiles.append([right, img])
                right += img.width
            frame = Image.new('RGB', (W, H))
            for x, img in tiles:
                if x < W:
                    frame.paste(img, (x, 0))
            self.panel.show(frame)

    def flash(self, text, kind, anim=None):
        W = self.panel.width
        played = False
        if anim and self.cfg.get('animations', True):
            try:
                for img, hold in A.play(anim, W, text):
                    t0 = time.time()
                    self.panel.show(img)
                    time.sleep(max(0.0, hold - (time.time() - t0)))
                    played = True
            except Exception as e:  # never let an animation stop the ticker
                print('animation %s failed: %s' % (anim, e), flush=True)
        if played and kind == 'cashed':
            return  # the field goal animation already shows the payout
        end = time.time() + (2.5 if played else 5)
        on = True
        while time.time() < end:
            self.panel.show(R.flash_frame(W, text, kind, on))
            time.sleep(0.35 if kind != 'cashed' else 0.25)
            on = not on


# ---------------------------------------------------------------- web
def make_handler(app):
    page = open(os.path.join(HERE, 'web.html'), 'rb').read()

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body, ctype='application/json'):
            if isinstance(body, (dict, list)):
                body = json.dumps(body).encode()
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = self.path.split('?')[0]
            if path in ('/', '/import', '/index.html'):
                return self._send(200, page, 'text/html; charset=utf-8')
            if path == '/api/state':
                with app.lock:
                    return self._send(200, {'status': app.status, 'slips': app.slips, 'snap': app.snap,
                                            'config': {k: app.cfg[k] for k in ('brightness', 'speed', 'alerts', 'panels')}})
            self._send(404, {'error': 'not found'})

        def do_POST(self):
            n = int(self.headers.get('Content-Length') or 0)
            try:
                body = json.loads(self.rfile.read(n) or b'{}')
            except Exception:
                return self._send(400, {'error': 'bad json'})
            path = self.path.split('?')[0]
            if path == '/api/slips':
                slips = [s for s in body.get('slips') or [] if isinstance(s, dict) and s.get('legs')]
                app.set_slips(slips, body.get('mode') or 'replace')
                return self._send(200, {'ok': True, 'count': len(app.slips)})
            if path == '/api/remove':
                app.remove(body.get('id'))
                return self._send(200, {'ok': True})
            if path == '/api/config':
                app.set_config(body)
                return self._send(200, {'ok': True})
            self._send(404, {'error': 'not found'})
    return H


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--preview', help='no LED hardware: write frames to this folder')
    args = ap.parse_args()
    app = Ticker(args.preview)
    srv = ThreadingHTTPServer(('0.0.0.0', int(app.cfg['port'])), make_handler(app))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    threading.Thread(target=app.data_loop, daemon=True).start()
    print('Blue Horseshoe ticker running. Control page on port %s' % app.cfg['port'], flush=True)
    try:
        app.scroll_loop()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
