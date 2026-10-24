#!/bin/bash
# Blue Horseshoe LED ticker installer for Raspberry Pi OS (Bookworm or newer).
#   curl -sSL https://bluehorseshoebet.com/ticker/install.sh | sudo bash
# Re-run any time to update.
set -e
SRC="https://bluehorseshoebet.com/ticker"
APP=/opt/bhticker
DATA=/var/lib/bhticker

if [ "$(id -u)" != "0" ]; then echo "Run with sudo:  curl -sSL $SRC/install.sh | sudo bash"; exit 1; fi
MODEL=$(tr -d '\0' < /proc/device-tree/model 2>/dev/null || echo unknown)
echo "== Blue Horseshoe ticker =="
echo "Board: $MODEL"

echo "-- Installing packages"
apt-get update -y
apt-get install -y git python3-dev python3-pip python3-pil python3-numpy cython3 fonts-dejavu-core curl

echo "-- Getting the ticker"
mkdir -p "$APP" "$DATA"
for f in bhticker.py legs.py render.py anim.py cloud.py wifisetup.py web.html demo.py; do
  curl -fsSL "$SRC/$f?$(date +%s)" -o "$APP/$f"
done
mkdir -p "$APP/fonts"
for f in ter-u12b ter-u14b ter-u16b ter-u18b ter-u20b; do
  for ext in pil pbm; do curl -fsSL "$SRC/fonts/$f.$ext?$(date +%s)" -o "$APP/fonts/$f.$ext"; done
done
curl -fsSL "$SRC/fonts/README.md" -o "$APP/fonts/README.md" || true
chmod +x "$APP/bhticker.py"

CONFIG=/boot/firmware/config.txt; [ -f "$CONFIG" ] || CONFIG=/boot/config.txt

if echo "$MODEL" | grep -q "Raspberry Pi 5"; then
  echo "-- Pi 5: installing Adafruit Piomatter"
  pip3 install --break-system-packages Adafruit-Blinka-Raspberry-Pi5-Piomatter
  grep -q -- '-pio' /etc/udev/rules.d/99-com.rules 2>/dev/null || echo 'SUBSYSTEM=="*-pio", GROUP="gpio", MODE="0660"' >> /etc/udev/rules.d/99-com.rules
else
  if ! python3 -c "import rgbmatrix" 2>/dev/null; then
    echo "-- Building the LED matrix driver (takes a few minutes)"
    rm -rf /tmp/rpi-rgb-led-matrix
    git clone --depth 1 https://github.com/hzeller/rpi-rgb-led-matrix /tmp/rpi-rgb-led-matrix
    cd /tmp/rpi-rgb-led-matrix
    if [ -f pyproject.toml ]; then
      pip3 install --break-system-packages .
    else
      make build-python PYTHON=$(command -v python3)
      make install-python PYTHON=$(command -v python3)
    fi
    cd /
  fi
  # the Pi's sound chip fights the LED timing
  if grep -q '^dtparam=audio=on' "$CONFIG"; then sed -i 's/^dtparam=audio=on/dtparam=audio=off/' "$CONFIG"; REBOOT=1; fi
  echo "blacklist snd_bcm2835" > /etc/modprobe.d/bhticker-no-audio.conf
  # smoother scrolling: keep one CPU core for the panel
  if ! grep -q 'isolcpus=3' /boot/firmware/cmdline.txt 2>/dev/null && [ -f /boot/firmware/cmdline.txt ]; then
    sed -i '1 s/$/ isolcpus=3/' /boot/firmware/cmdline.txt; REBOOT=1
  fi
  if echo "$MODEL" | grep -q "Pi 3"; then SLOW=2; elif echo "$MODEL" | grep -q "Zero"; then SLOW=1; else SLOW=4; fi
  [ -f "$DATA/config.json" ] || echo "{\"gpio_slowdown\": $SLOW}" > "$DATA/config.json"
fi

# Which adapter board is on the Pi. Adafruit bonnet/HAT (default) or a board wired like hzeller's "regular" pinout
# (Seengreat / WatangTech RGB Matrix Adapter Board, Electrodragon, etc.):  curl ... | sudo BOARD=regular bash
if [ -n "$BOARD" ]; then
  case "$BOARD" in
    regular|seengreat|watangtech) MAP=regular ;;
    adafruit|adafruit-hat|bonnet) MAP=adafruit-hat ;;
    adafruit-pwm|adafruit-hat-pwm) MAP=adafruit-hat-pwm ;;
    *) MAP="$BOARD" ;;
  esac
  python3 - "$DATA/config.json" "$MAP" <<'PY'
import json, sys, os
p, m = sys.argv[1], sys.argv[2]
c = json.load(open(p)) if os.path.exists(p) else {}
c['hardware_mapping'] = m
json.dump(c, open(p, 'w'))
PY
  echo "-- Adapter board pinout: $MAP"
fi

# The phone app: the address of your relay (see relay/README.md).  curl ... | sudo CLOUD=https://... bash
if [ -n "$CLOUD" ]; then
  python3 - "$DATA/config.json" "$CLOUD" <<'PY'
import json, sys, os
p, u = sys.argv[1], sys.argv[2].rstrip('/')
c = json.load(open(p)) if os.path.exists(p) else {}
c['cloud_url'] = u
json.dump(c, open(p, 'w'))
PY
  echo "-- Phone app relay: $CLOUD"
fi

echo "-- Naming this Pi bhticker (http://bhticker.local:8080)"
if [ "$(hostname)" != "bhticker" ]; then
  OLD=$(hostname)
  hostnamectl set-hostname bhticker
  sed -i "s/127.0.1.1.*/127.0.1.1\tbhticker/" /etc/hosts
  REBOOT=1
fi

echo "-- Wi-Fi setup (opens 'Horseshoe Ticker Setup' when the ticker can't get online)"
if command -v nmcli >/dev/null; then
  mkdir -p /etc/NetworkManager/dnsmasq-shared.d
  # while setup is open, every web address goes to the setup page, so phones pop it up
  echo 'address=/#/10.42.0.1' > /etc/NetworkManager/dnsmasq-shared.d/bhticker-setup.conf
  cat > /etc/systemd/system/bhticker-wifi.service <<WIFI
[Unit]
Description=Blue Horseshoe ticker Wi-Fi setup
After=NetworkManager.service

[Service]
ExecStart=/usr/bin/python3 $APP/wifisetup.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
WIFI
  systemctl daemon-reload
  systemctl enable bhticker-wifi.service
  systemctl restart bhticker-wifi.service
fi

echo "-- Starting on boot"
cat > /etc/systemd/system/bhticker.service <<EOF
[Unit]
Description=Blue Horseshoe LED ticker
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/python3 $APP/bhticker.py
Environment=BHTICKER_DATA=$DATA
Restart=always
RestartSec=5
Nice=-10

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable bhticker.service

IP=$(hostname -I | awk '{print $1}')
echo
echo "Done."
echo "Control page:  http://bhticker.local:8080   (or http://$IP:8080)"
if [ "$REBOOT" = "1" ]; then
  echo "Rebooting in 10 seconds to finish setup..."
  sleep 10
  reboot
else
  systemctl restart bhticker.service
  echo "The ticker is running."
fi
