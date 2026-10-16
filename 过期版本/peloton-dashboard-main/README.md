# Peloton Live Dashboard

A standalone browser-based dashboard that reads live ride data
(cadence, resistance, power) from an **original Peloton Bike** by
tapping its sensor cable — independent of the Peloton tablet and app.

> **Status:** dashboard code complete. Hardware on order.
> Pinout verification + first live read happens in the next commit.

---

## How it works

The Peloton's sensor wire is a 3.5mm TRRS cable carrying 3.3V TTL UART
serial data at 19200 baud. With a small adapter, that data can be read
on any laptop, no Peloton app required.

```
Peloton bike  ──►  3.5mm TRRS  ──►  USB-TTL adapter  ──►  Laptop (Chrome / Edge)
                                                            └─ Web Serial API
                                                            └─ Dashboard parses
                                                               and displays
```

## Hardware

| Part | Purpose | ~Cost |
|---|---|---|
| DSD TECH SH-U09C2 (USB to TTL UART, 3.3V) | USB ↔ serial bridge | $13 |
| 3.5mm TRRS male plug, screw-terminal | Mates to coupler | $5 |
| 3.5mm TRRS 4-pole female-to-female coupler | Bridges bike's male plug | $5 |
| Female-to-female jumper wires | Connect plug to adapter board | $3 |

**Total: ~$26**

Alternative: replace the SH-U09C2 with a Raspberry Pi (any model, Pi
Zero W+) and use its built-in UART on GPIO pins 8/10/6. Skip the USB
adapter, host the dashboard locally on the Pi.

## Wiring

```
Bike's male TRRS plug
     │
     ▼
TRRS female↔female coupler  (4-pole)
     │
     ▼
TRRS male plug w/ screw terminals
     │
     ▼
4 jumper wires  (TX, RX, VCC, GND — order TBD by multimeter)
     │
     ▼
USB-TTL adapter  →  USB  →  Laptop
```

**Important:**
- Use a TRRS (4-pole) coupler, not TRS (3-pole), or one signal gets
  shorted to ground.
- Set the USB-TTL adapter to 3.3V before plugging in. Never 5V.
- Leave VCC disconnected on the Pi side — the bike powers itself.

## Pinout verification (multimeter, 5 min)

Before connecting the bike to the adapter, map its plug:

1. Multimeter to DC voltage, 20V range.
2. Power the bike on; do not pedal.
3. Black probe on **Sleeve** (the metal section closest to the plastic body).
4. Red probe on **Tip**, then **Ring 1**, then **Ring 2**. Record voltages.

| Reading | Likely signal |
|---|---|
| ~3.3V steady | VCC |
| 0V | GND or idle data |
| 2.5–3.3V flickering | TX (bike's data out) |
| Floating / 0V | RX (bike's data in) |

Wire accordingly into the screw-terminal plug.

## Dashboard

Open `index.html` in **Chrome** or **Edge** (Web Serial API isn't
available in Firefox or Safari).

1. Click **Connect Bike** → pick your USB-TTL adapter from the popup.
2. Live metrics appear: cadence, resistance, power, speed.
3. Session totals roll up: time, distance, calories, average power.
4. **Export CSV** dumps every sample.
5. **Serial Log** shows raw activity, useful for debugging the parser.

## Protocol parser

The original Peloton Bike's sensor board speaks a simple frame format:

```
0xF1  <type>  <length>  <ASCII digits, reversed>  <checksum>  0xF6
```

- `type 0x41` (`'A'`) → cadence (RPM)
- `type 0x44` (`'D'`) → resistance (raw 0–100)
- `type 0x4A` (`'J'`) → power (watts × 10)
- Checksum = sum of digit bytes & 0xFF
- Baud rate: 19200, 8N1

The frame parser lives inline in `index.html` (see `parseFrame()`).
Expect to adjust for firmware revisions once real data is captured.

## Roadmap

- [x] Browser dashboard, Web Serial API connect
- [x] Frame parser (cadence / resistance / power)
- [x] Session totals + CSV export
- [ ] Multimeter pinout verification *(next, when parts arrive)*
- [ ] Live capture from real bike, verify parser frames
- [ ] Raw hex byte view for debugging
- [ ] Bluetooth FTMS broadcast (so Zwift, etc. can see the bike)
- [ ] Raspberry Pi self-hosted variant
- [ ] Optional: heart-rate sensor pairing
