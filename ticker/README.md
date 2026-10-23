# Blue Horseshoe LED ticker

Scrolls your bet slips across a row of LED panels on a Raspberry Pi, graded live from ESPN.

## Parts
- Raspberry Pi 4 (2GB is plenty) + its USB-C power supply + 16GB+ microSD card. A Pi 5 also works.
- Adafruit RGB Matrix Bonnet (product 3211)
- 4 × 64x32 RGB LED panels, 4mm pitch (HUB75), chained in a row = 256×32 pixels
- 5V 10A power supply (Adafruit 658) for the panels

## Setup
1. Flash **Raspberry Pi OS Lite (64-bit)** with Raspberry Pi Imager. In its settings, turn on SSH, set your Wi-Fi, and set a username/password.
2. Push the bonnet onto the Pi. Ribbon from the bonnet's output to panel 1's input; panel 1 output → panel 2 input, and so on (arrows on the back of each panel point the way the data flows).
3. Power: 5V 10A supply into the bonnet's barrel jack. Run the panels' power cables from the bonnet's screw terminal to each panel.
4. SSH in (`ssh you@raspberrypi.local`) and run:
   ```
   curl -sSL https://bluehorseshoebet.com/ticker/install.sh | sudo bash
   ```
   It installs everything, names the Pi `bhticker`, starts the ticker on every boot, and reboots once.
   Using a Seengreat / WatangTech "RGB Matrix Adapter Board" instead of the Adafruit bonnet? Run it as
   `curl -sSL https://bluehorseshoebet.com/ticker/install.sh | sudo BOARD=regular bash`
5. On the website's Live page: **More → Send to LED ticker**. Or open http://bhticker.local:8080 on any phone or computer on your Wi-Fi.

## Settings
Brightness, scroll speed and alerts are on the control page. Hardware settings live in `/var/lib/bhticker/config.json`:
`panels`, `gpio_slowdown` (4 for Pi 4), `hardware_mapping` (`adafruit-hat`, or `adafruit-hat-pwm` after the bonnet's PWM solder mod), `panel_type` (`FM6126A` if panels stay dark).
Then `sudo systemctl restart bhticker`.

## Celebrations
When a leg hits, the ticker plays a short animation picked by what the leg is, then flashes the leg:
- Rushing yds / carries: **BREAKAWAY!** (runner sprints across the field)
- Receiving yds / receptions: **CAUGHT IT!** (ball arcs into waiting hands)
- Passing yds / attempts / completions: **DIME!** (spiral into a bullseye)
- Touchdowns: **TOUCHDOWN!** (QB drops back and throws, the camera follows the ball downfield to the receiver in the end zone, then fireworks)
- Moneyline: **WINNER!** / Spread: **COVERED!** (Blue Horseshoes drop in)
- Totals: **OVER!** / **UNDER!** (scoreboard counts past the line)
- A leg loses: **GUTTER BALL**.
- A slip cashes: the game-winning field goal, **IT'S GOOD!**, then money rain with the payout.

Turn them off with `"animations": false` in `/var/lib/bhticker/config.json`. They live in `anim.py`.

## Demo
Plays a scripted game with two fake slips so you can see every feature in about 3 minutes: upcoming, live progress bars, legs hitting, a leg losing, a slip busting and a slip cashing.
```
sudo systemctl stop bhticker
sudo python3 /opt/bhticker/demo.py      # Ctrl+C to quit
sudo python3 /opt/bhticker/demo.py --reel   # just the animations, back to back (~30s)
sudo python3 /opt/bhticker/demo.py --stage 3   # start the full demo partway (stages 1-5)
sudo systemctl start bhticker
```

## Troubleshooting
- Logs: `journalctl -u bhticker -f`
- Flicker: raise `gpio_slowdown` by 1.
- Garbled/shifted image: check `panels` and the ribbon direction.
- Try it without hardware on any computer: `python3 bhticker.py --preview frames` (writes PNGs).
