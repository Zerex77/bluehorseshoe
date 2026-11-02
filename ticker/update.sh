#!/bin/bash
# Blue Horseshoe ticker self-update. Runs hourly from bhticker-update.timer (set up by install.sh).
# Pulls the ticker's files from GitHub; if anything changed, checks the new code loads, swaps it in
# and restarts the ticker. Nothing changes on a failed download or a file that won't load.
# Turn off with "auto_update": false in /var/lib/bhticker/config.json.  Run by hand:  sudo /opt/bhticker/update.sh
set -u
SRC="https://raw.githubusercontent.com/Zerex77/bluehorseshoe/main/ticker"
APP=/opt/bhticker
DATA=/var/lib/bhticker
FILES="bhticker.py legs.py render.py anim.py cloud.py wifisetup.py teamshow.py lofi.py city.py web.html demo.py update.sh"
FONTS="ter-u12b ter-u14b ter-u16b ter-u18b ter-u20b"

if python3 -c "import json,sys; sys.exit(0 if json.load(open('$DATA/config.json')).get('auto_update', True) is False else 1)" 2>/dev/null; then
  echo "auto_update is off"; exit 0
fi

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/fonts"
for f in $FILES; do
  curl -fsSL --retry 2 -m 60 "$SRC/$f?$(date +%s)" -o "$TMP/$f" || { echo "download failed: $f"; exit 1; }
done
for f in $FONTS; do for ext in pil pbm; do
  curl -fsSL --retry 2 -m 60 "$SRC/fonts/$f.$ext" -o "$TMP/fonts/$f.$ext" || { echo "download failed: fonts/$f.$ext"; exit 1; }
done; done

CHANGED=0
for f in $FILES; do cmp -s "$TMP/$f" "$APP/$f" || CHANGED=1; done
for f in $FONTS; do for ext in pil pbm; do cmp -s "$TMP/fonts/$f.$ext" "$APP/fonts/$f.$ext" || CHANGED=1; done; done
[ "$CHANGED" = "0" ] && { echo "up to date"; exit 0; }

# the new code has to at least load before it goes live
( cd "$TMP" && python3 -m py_compile bhticker.py legs.py render.py anim.py cloud.py wifisetup.py teamshow.py lofi.py city.py demo.py ) \
  || { echo "new code doesn't load; keeping the current version"; exit 1; }
bash -n "$TMP/update.sh" || { echo "new updater is broken; keeping the current version"; exit 1; }

# don't swap files under a running demo; the next hourly run will catch it
if [ -f "$DATA/demo.pid" ] && kill -0 "$(cat "$DATA/demo.pid" 2>/dev/null)" 2>/dev/null; then
  echo "demo running; trying again next hour"; exit 0
fi

mkdir -p "$APP/fonts"
for f in $FILES; do cp "$TMP/$f" "$APP/$f"; done
cp "$TMP"/fonts/* "$APP/fonts/"
chmod +x "$APP/bhticker.py" "$APP/update.sh"
date -u +%Y-%m-%dT%H:%M:%SZ > "$DATA/updated_at"
systemctl restart bhticker.service
echo "updated and restarted"
