"""Connects the ticker to the Horseshoe Ticker phone app through the relay (relay/ in this repo).

On first start the ticker registers with the relay and gets a 6-character pairing code, which it
shows on the panels whenever it has no slips. Phones pair with that code in the app. After that the
ticker checks the relay every few seconds for slips, and sends back how each leg is doing so the
app can show it. Everything goes out from the ticker, so it works on any Wi-Fi or phone hotspot
with nothing to set up on the router.

Turned on by "cloud_url" in /var/lib/bhticker/config.json (the address of your relay).
"""
import json
import os
import threading
import time
import urllib.error
import urllib.request

POLL = 12         # seconds between checks for new slips (keeps a free Cloudflare plan free)
RETRY = 20        # seconds to wait after a failed check
STATUS_EVERY = 30 # send leg status to the app at most this often


class Cloud:
    def __init__(self, app, url, data_dir):
        self.app = app
        self.url = url.rstrip('/')
        self.path = os.path.join(data_dir, 'cloud.json')
        st = self._load()
        if st.get('url') != self.url:   # pointed at a different relay: register again
            st = {}
        self.id, self.secret, self.code = st.get('id'), st.get('secret'), st.get('code')
        self.v = None
        self.phones = 0
        self.ok_at = 0
        self.error = ''
        self._last_status = None
        self._status_at = 0

    # ---- storage
    def _load(self):
        try:
            with open(self.path) as f:
                return json.load(f)
        except Exception:
            return {}

    def _save(self):
        tmp = self.path + '.tmp'
        with open(tmp, 'w') as f:
            json.dump({'url': self.url, 'id': self.id, 'secret': self.secret, 'code': self.code}, f)
        os.replace(tmp, self.path)
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass

    # ---- talking to the relay
    def _req(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.url + '/api' + path, data=data, method=method, headers={
            'content-type': 'application/json', 'x-ticker-secret': self.secret or '', 'user-agent': 'bhticker/1.0'})
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read() or b'{}')

    def register(self):
        out = self._req('POST', '/ticker/register', {})
        self.id, self.secret, self.code = out['id'], out['secret'], out['code']
        self.v = None
        self._save()
        print('Registered with the app relay. Pairing code: %s' % self.code, flush=True)

    def new_code(self):
        out = self._req('POST', '/ticker/%s/code' % self.id)
        self.code = out['code']
        self._save()
        return self.code

    @property
    def connected(self):
        return time.time() - self.ok_at < 60

    def info(self):
        return {'url': self.url, 'code': self.code, 'phones': self.phones, 'connected': self.connected, 'error': self.error}

    # ---- main loop: pick up slips from the app
    def loop(self):
        while True:
            try:
                if not self.id:
                    self.register()
                    threading.Thread(target=self.app.update, daemon=True).start()   # show the code
                out = self._req('GET', '/ticker/%s/sync?v=%s' % (self.id, self.v or 0))
                self.ok_at = time.time()
                self.error = ''
                self.phones = out.get('phones', 0)
                if out.get('code') and out['code'] != self.code:
                    self.code = out['code']
                    self._save()
                st = out.get('settings') or {}
                show = {k: st[k] for k in ('mode', 'team') if k in st}
                if show and show != getattr(self, '_show', None):   # display mode from the app
                    self._show = show
                    self.app.set_config(show)
                on = st.get('on')
                if on is not None and on != getattr(self, '_on', None):   # power button in the app
                    self._on = on
                    self.app.set_power(on)
                if 'slips' in out:
                    self.v = out['v']
                    self.app.set_slips(out['slips'], 'replace', from_cloud=True)
                else:
                    self.v = out['v']
                time.sleep(POLL)
            except urllib.error.HTTPError as e:
                if e.code in (401, 404):   # the relay doesn't know this ticker any more: start over
                    self.id = None
                self.error = 'relay said %s' % e.code
                time.sleep(RETRY)
            except Exception as e:
                self.error = str(e)[:80] or 'offline'
                time.sleep(RETRY)

    # ---- slips changed on the ticker's own control page
    def push_slips(self, slips):
        if not self.id:
            return
        try:
            out = self._req('PUT', '/ticker/%s/slips' % self.id, {'slips': slips})
            self.v = out.get('v', self.v)
        except Exception:
            pass

    # ---- tell the app how every leg is doing
    def push_status(self, status, snap):
        if not self.id:
            return
        slim = [{
            'id': s.get('id'), 'name': s.get('name'), 'status': s.get('status'), 'won': s.get('won'), 'n': s.get('n'),
            'pay': s.get('pay'), 'price': s.get('price'), 'stake': s.get('stake'),
            'legs': [{k: r.get(k) for k in ('label', 'market', 'cls', 'right', 'sub', 'prog', 'inj')} for r in s.get('legs') or []],
        } for s in snap]
        key = json.dumps([status, slim], sort_keys=True, default=str)
        ids = [s['id'] for s in slim]
        since = time.time() - self._status_at
        new_slips = ids != getattr(self, '_last_ids', None)   # a ticket was added or removed: tell the app now
        if not new_slips and ((key == self._last_status and since < 300) or since < STATUS_EVERY):
            return
        try:
            self._req('POST', '/ticker/%s/status' % self.id, {'status': status, 'snap': slim})
            self._last_status, self._status_at, self._last_ids = key, time.time(), ids
        except Exception:
            pass
