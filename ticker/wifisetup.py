#!/usr/bin/env python3
"""Wi-Fi setup without a computer.

If the ticker isn't online about a minute after it starts, it opens its own Wi-Fi network,
"Horseshoe Ticker Setup". Join it from a phone and a page pops up listing nearby networks.
Pick one, type the password, and the ticker joins it (and remembers it for next time).
While setup is open the panels scroll the instructions (bhticker.py watches SETUP_FLAG).

Runs as its own service (bhticker-wifi). Uses NetworkManager (Raspberry Pi OS Bookworm and newer).
"""
import html
import os
import subprocess
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

AP_NAME = 'Horseshoe Ticker Setup'
AP_CON = 'bhticker-setup'
SETUP_FLAG = '/run/bhticker-setup'
WAIT = 60          # seconds after boot before opening setup
CHECK = 30         # seconds between "still online?" checks


def nm(*args, timeout=30):
    r = subprocess.run(['nmcli'] + list(args), capture_output=True, text=True, timeout=timeout)
    return r.returncode, (r.stdout + r.stderr).strip()


def online():
    """Connected to some Wi-Fi other than our own setup network."""
    code, out = nm('-t', '-f', 'NAME,TYPE,DEVICE', 'connection', 'show', '--active')
    # names can contain ':' (nmcli escapes them), so look for the type field rather than splitting
    return any(':802-11-wireless:' in l and not l.startswith(AP_CON + ':') for l in out.splitlines())


def scan():
    nm('device', 'wifi', 'rescan', timeout=15)
    time.sleep(3)
    code, out = nm('-t', '-f', 'SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list')
    best = {}
    for line in out.splitlines():
        parts = line.rsplit(':', 2)
        if len(parts) != 3 or not parts[0] or parts[0] == AP_NAME:
            continue
        ssid, sig, sec = parts[0].replace('\\:', ':'), int(parts[1] or 0), parts[2]
        if ssid not in best or sig > best[ssid][0]:
            best[ssid] = (sig, sec)
    return sorted(((s, v[0], v[1]) for s, v in best.items()), key=lambda x: -x[1])


def start_ap():
    nm('connection', 'delete', AP_CON)
    nm('connection', 'add', 'type', 'wifi', 'ifname', 'wlan0', 'con-name', AP_CON, 'autoconnect', 'no', 'ssid', AP_NAME,
       '802-11-wireless.mode', 'ap', '802-11-wireless.band', 'bg', 'ipv4.method', 'shared', 'ipv6.method', 'disabled')
    nm('connection', 'up', AP_CON)
    open(SETUP_FLAG, 'w').write(AP_NAME)


def stop_ap():
    nm('connection', 'down', AP_CON)
    try:
        os.remove(SETUP_FLAG)
    except OSError:
        pass


class State:
    networks = []
    message = ''
    busy = False


def try_join(ssid, password):
    """Drop the setup network, try the chosen one; if it fails, reopen setup with the reason."""
    State.busy = True
    stop_ap()
    time.sleep(2)
    args = ['device', 'wifi', 'connect', ssid] + (['password', password] if password else [])
    code, out = nm(*args, timeout=60)
    if code == 0 and online():
        State.message = ''
        print('Joined %s' % ssid, flush=True)
    else:
        nm('connection', 'delete', ssid)   # don't keep a network saved with a wrong password
        State.message = "Couldn't join %s. Check the password and try again." % ssid
        print('Failed to join %s: %s' % (ssid, out), flush=True)
        State.networks = scan() or State.networks
        start_ap()
    State.busy = False


PAGE = '''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Horseshoe Ticker Wi-Fi</title><style>
body{margin:0;background:#070D1A;color:#E8EEF9;font:16px system-ui,sans-serif;padding:20px}h1{font-size:22px;margin:0 0 6px}
p{color:#8A97B0;line-height:1.45}.n{display:block;width:100%%;text-align:left;padding:14px;margin:0 0 8px;border-radius:12px;border:1px solid #22304D;background:#0F182B;color:inherit;font:inherit}
.n small{float:right;color:#8A97B0}input{width:100%%;box-sizing:border-box;padding:13px;border-radius:10px;border:1px solid #22304D;background:#0F182B;color:inherit;font:inherit;margin:6px 0 12px}
button.go{width:100%%;padding:14px;border:0;border-radius:12px;background:#FFD166;color:#1a1405;font:700 17px system-ui}.err{color:#FF5A5F}
</style></head><body><h1>Connect your ticker</h1><p>Pick the Wi-Fi this ticker should use. Choose the 2.4 GHz one if there are two (not "5G").</p>
%s<form method="post" action="/join"><input name="ssid" id="ssid" placeholder="Network name" required autocapitalize="none" autocorrect="off">
<input name="pw" type="password" placeholder="Password (leave blank if none)" autocapitalize="none" autocorrect="off">
<button class="go" type="submit">Connect</button></form><p>%s</p>
<script>document.querySelectorAll('.n').forEach(function(b){b.onclick=function(){document.getElementById('ssid').value=b.dataset.s;document.querySelector('[name=pw]').focus();};});</script>
</body></html>'''


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _page(self, body, code=200):
        data = body.encode()
        self.send_response(code)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):   # every address shows the setup page, so phones pop it up on their own
        nets = ''.join('<button type="button" class="n" data-s="%s">%s<small>%s%s</small></button>' % (
            html.escape(s, True), html.escape(s), '🔒 ' if sec and sec != '--' else '', '▂▄▆█'[:max(1, sig // 25)])
            for s, sig, sec in State.networks[:20]) or '<p>No networks found. Type the name below.</p>'
        msg = '<span class="err">%s</span>' % html.escape(State.message) if State.message else ''
        self._page(PAGE % (nets, msg))

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        form = urllib.parse.parse_qs(self.rfile.read(n).decode())
        ssid = (form.get('ssid') or [''])[0].strip()
        pw = (form.get('pw') or [''])[0]
        if not ssid or State.busy:
            return self.do_GET()
        threading.Thread(target=try_join, args=(ssid, pw), daemon=True).start()
        self._page('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><body style="background:#070D1A;color:#E8EEF9;font:17px system-ui;padding:24px">'
                   '<h2>Connecting to %s…</h2><p style="color:#8A97B0">Your phone will drop off this setup network. In about a minute the ticker '
                   'should be online. If the password was wrong, "%s" comes back. Join it again and retry.</p>' % (html.escape(ssid), AP_NAME))


def main():
    time.sleep(WAIT)
    server = None
    while True:
        if not online() and not State.busy and not os.path.exists(SETUP_FLAG):
            print('Not online: opening "%s"' % AP_NAME, flush=True)
            State.networks = scan()
            start_ap()
            if not server:
                server = ThreadingHTTPServer(('0.0.0.0', 80), Handler)
                threading.Thread(target=server.serve_forever, daemon=True).start()
        elif online() and os.path.exists(SETUP_FLAG):
            stop_ap()
        time.sleep(CHECK)


if __name__ == '__main__':
    main()
