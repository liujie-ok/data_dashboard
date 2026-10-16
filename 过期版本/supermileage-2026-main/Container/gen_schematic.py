"""
Generates: schematic.pdf  (17" x 11" tabloid landscape)
Run with:  python gen_schematic.py
"""

from reportlab.lib.units import inch
from reportlab.pdfgen import canvas
from reportlab.lib import colors

OUTPUT = "schematic.pdf"   # written next to this script

W, H = 17 * inch, 11 * inch

# ── Palette ───────────────────────────────────────────────────────────────────
BG       = colors.HexColor('#f4f2ec')
TX_PANEL = colors.HexColor('#dae8f5')
RX_PANEL = colors.HexColor('#d8f0d8')
TX_BDR   = colors.HexColor('#6688aa')
RX_BDR   = colors.HexColor('#668866')
C_ESP    = colors.HexColor('#0b2545')
C_GPS    = colors.HexColor('#0b3d1a')
C_NRF    = colors.HexColor('#4a0d0d')
C_BUCK   = colors.HexColor('#3a1555')
C_BATT   = colors.HexColor('#2a2800')
C_NANO   = colors.HexColor('#0b2545')
C_LAPT   = colors.HexColor('#1a1a2e')
BORDER   = colors.HexColor('#223344')
WHITE    = colors.white
DGRAY    = colors.HexColor('#555555')
MGRAY    = colors.HexColor('#999999')
PWR      = colors.HexColor('#cc2200')
GND      = colors.HexColor('#111111')
SIG      = colors.HexColor('#0044cc')
RF       = colors.HexColor('#e07010')
USB_COL  = colors.HexColor('#009944')

# ── Low-level draw helpers ────────────────────────────────────────────────────
def rbox(cv, cx, cy, bw, bh, line1, line2=None, bg=C_ESP, lw=1.5, r=6):
    x, y = cx - bw/2, cy - bh/2
    cv.setFillColor(bg)
    cv.setStrokeColor(BORDER)
    cv.setLineWidth(lw)
    cv.roundRect(x, y, bw, bh, r, fill=1, stroke=1)
    cv.setFillColor(WHITE)
    fs = 10 if len(line1) <= 16 else 8
    cv.setFont('Helvetica-Bold', fs)
    cv.drawCentredString(cx, cy + (6 if line2 else 0), line1)
    if line2:
        cv.setFont('Helvetica', 7.5)
        cv.setFillColor(colors.HexColor('#aaccee'))
        cv.drawCentredString(cx, cy - 8, line2)

def hline(cv, x1, y, x2, col, lw=1.0, dash=None):
    cv.setStrokeColor(col)
    cv.setLineWidth(lw)
    if dash: cv.setDash(*dash)
    cv.line(x1, y, x2, y)
    cv.setDash()

def vline(cv, x, y1, y2, col, lw=1.0):
    cv.setStrokeColor(col)
    cv.setLineWidth(lw)
    cv.line(x, y1, x, y2)

def elbow_hv(cv, x1, y1, x2, y2, col, lw=1.2):
    """Horizontal segment then vertical."""
    cv.setStrokeColor(col); cv.setLineWidth(lw)
    cv.line(x1, y1, x2, y1)
    cv.line(x2, y1, x2, y2)

def dot(cv, x, y, col, r=2.5):
    cv.setFillColor(col)
    cv.circle(x, y, r, fill=1, stroke=0)

def txt(cv, x, y, s, align='l', col=DGRAY, fs=6.5, bold=False):
    cv.setFillColor(col)
    cv.setFont('Helvetica-Bold' if bold else 'Helvetica', fs)
    dy = -fs * 0.35
    if   align == 'l': cv.drawString(x, y + dy, s)
    elif align == 'r': cv.drawRightString(x, y + dy, s)
    else:              cv.drawCentredString(x, y + dy, s)

def conn(cv, x1, y, x2, lbl_l, lbl_r, col=SIG):
    """Connection wire with pin labels at both ends."""
    hline(cv, x1, y, x2, col, lw=1.1)
    dot(cv, x1, y, col)
    dot(cv, x2, y, col)
    txt(cv, x1 - 3, y, lbl_l, align='r', col=col, fs=5.8)
    txt(cv, x2 + 3, y, lbl_r, align='l', col=col, fs=5.8)

def arrow_r(cv, x, y, col, size=7):
    """Right-pointing filled arrowhead."""
    cv.setFillColor(col)
    cv.setStrokeColor(col)
    cv.setLineWidth(0)
    p = cv.beginPath()
    p.moveTo(x, y)
    p.lineTo(x - size, y + size/2)
    p.lineTo(x - size, y - size/2)
    p.close()
    cv.drawPath(p, fill=1, stroke=0)

# ═════════════════════════════════════════════════════════════════════════════
cv = canvas.Canvas(OUTPUT, pagesize=(W, H))
cv.setTitle("Supermileage Telemetry — Hardware Schematic")

# ── Full-page background ──────────────────────────────────────────────────────
cv.setFillColor(BG)
cv.rect(0, 0, W, H, fill=1, stroke=0)

PAD = 0.32 * inch
MID = W / 2

# ── Panel backgrounds ─────────────────────────────────────────────────────────
cv.setFillColor(TX_PANEL); cv.setStrokeColor(TX_BDR); cv.setLineWidth(1.5)
cv.roundRect(PAD, PAD, MID - PAD - 0.12*inch, H - 2*PAD, 12, fill=1, stroke=1)

cv.setFillColor(RX_PANEL); cv.setStrokeColor(RX_BDR)
cv.roundRect(MID + 0.12*inch, PAD, MID - PAD - 0.12*inch, H - 2*PAD, 12, fill=1, stroke=1)

# ── Main title ────────────────────────────────────────────────────────────────
cv.setFillColor(colors.HexColor('#0d1f33'))
cv.setFont('Helvetica-Bold', 19)
cv.drawCentredString(W/2, H - 0.50*inch, "SUPERMILEAGE TELEMETRY — HARDWARE SCHEMATIC")
cv.setFont('Helvetica', 10); cv.setFillColor(DGRAY)
cv.drawCentredString(W/2, H - 0.72*inch,
    "GPS Speed & Position  •  2.4 GHz nRF24L01+ Wireless  •  Rev 2.0")

# Panel headings
cv.setFont('Helvetica-Bold', 13); cv.setFillColor(colors.HexColor('#0d2244'))
cv.drawCentredString(MID/2,       H - 1.05*inch, "TRANSMITTER  —  ON VEHICLE")
cv.setFont('Helvetica-Bold', 13); cv.setFillColor(colors.HexColor('#0d3311'))
cv.drawCentredString(MID + MID/2, H - 1.05*inch, "RECEIVER  —  PITLANE / LAPTOP")

# ── Component positions ───────────────────────────────────────────────────────
# format: (cx, cy, w, h)
BATT_CX, BATT_CY, BATT_W, BATT_H = 1.50*inch, 9.10*inch, 1.10*inch, 0.65*inch
BUCK_CX, BUCK_CY, BUCK_W, BUCK_H = 3.50*inch, 9.10*inch, 1.50*inch, 0.65*inch
ESP_CX,  ESP_CY,  ESP_W,  ESP_H  = 4.60*inch, 5.45*inch, 2.40*inch, 2.80*inch
GPS_CX,  GPS_CY,  GPS_W,  GPS_H  = 1.60*inch, 5.45*inch, 1.50*inch, 2.20*inch
NTX_CX,  NTX_CY,  NTX_W,  NTX_H = 7.55*inch, 5.45*inch, 1.60*inch, 2.20*inch
NRX_CX,  NRX_CY,  NRX_W,  NRX_H = 9.80*inch, 5.45*inch, 1.60*inch, 2.20*inch
NANO_CX, NANO_CY, NANO_W, NANO_H = 12.75*inch, 5.45*inch, 2.00*inch, 2.80*inch
LAPT_CX, LAPT_CY, LAPT_W, LAPT_H = 15.55*inch, 5.45*inch, 1.30*inch, 0.80*inch

def L(cx,w): return cx - w/2
def R(cx,w): return cx + w/2
def T(cy,h): return cy + h/2
def B(cy,h): return cy - h/2

# ── Draw component boxes ──────────────────────────────────────────────────────
rbox(cv, BATT_CX, BATT_CY, BATT_W, BATT_H, "9V BATTERY",       bg=C_BATT, lw=2.0)
rbox(cv, BUCK_CX, BUCK_CY, BUCK_W, BUCK_H, "BUCK CONVERTER",   "9V → 5V / 3.3V", bg=C_BUCK)
rbox(cv, ESP_CX,  ESP_CY,  ESP_W,  ESP_H,  "LilyGo T-Display S3", "ESP32-S3", bg=C_ESP, lw=2.5, r=8)
rbox(cv, GPS_CX,  GPS_CY,  GPS_W,  GPS_H,  "NEO-6M GPS",        bg=C_GPS, lw=2.0)
rbox(cv, NTX_CX,  NTX_CY,  NTX_W,  NTX_H,  "nRF24L01+",        "TX Module", bg=C_NRF, lw=2.0)
rbox(cv, NRX_CX,  NRX_CY,  NRX_W,  NRX_H,  "nRF24L01+",        "RX Module", bg=C_NRF, lw=2.0)
rbox(cv, NANO_CX, NANO_CY, NANO_W, NANO_H, "ARDUINO NANO",      bg=C_NANO, lw=2.5, r=8)
rbox(cv, LAPT_CX, LAPT_CY, LAPT_W, LAPT_H, "LAPTOP",            "USB Serial", bg=C_LAPT)

# ── POWER: Battery → Buck Converter ──────────────────────────────────────────
# + wire (top)
y_plus = BATT_CY + 0.12*inch
hline(cv, R(BATT_CX,BATT_W), y_plus, L(BUCK_CX,BUCK_W), PWR, lw=1.5)
dot(cv,   R(BATT_CX,BATT_W), y_plus, PWR)
dot(cv,   L(BUCK_CX,BUCK_W), y_plus, PWR)
txt(cv, R(BATT_CX,BATT_W) + 4,  y_plus, "9V+", col=PWR, fs=6, bold=True)
txt(cv, L(BUCK_CX,BUCK_W) - 4,  y_plus, "IN+", align='r', col=PWR, fs=6)

# − wire (bottom)
y_minus = BATT_CY - 0.12*inch
hline(cv, R(BATT_CX,BATT_W), y_minus, L(BUCK_CX,BUCK_W), GND, lw=1.5)
dot(cv,   R(BATT_CX,BATT_W), y_minus, GND)
dot(cv,   L(BUCK_CX,BUCK_W), y_minus, GND)
txt(cv, R(BATT_CX,BATT_W) + 4,  y_minus, "GND", col=GND, fs=6, bold=True)
txt(cv, L(BUCK_CX,BUCK_W) - 4,  y_minus, "IN-", align='r', col=GND, fs=6)

# ── POWER: Buck → ESP32 (vertical drop) ──────────────────────────────────────
esp_top = T(ESP_CY, ESP_H)
pin5v_x  = ESP_CX + 0.22*inch
pingnd_x = ESP_CX - 0.22*inch

# 5V line
elbow_hv(cv, BUCK_CX + 0.05*inch, B(BUCK_CY,BUCK_H), pin5v_x, esp_top, PWR, lw=1.5)
dot(cv, pin5v_x, esp_top, PWR)
txt(cv, BUCK_CX + 0.05*inch, B(BUCK_CY,BUCK_H) - 6, "OUT+", align='c', col=PWR, fs=6)
txt(cv, pin5v_x, esp_top + 10, "5V", align='c', col=PWR, fs=7, bold=True)

# GND line
elbow_hv(cv, BUCK_CX - 0.05*inch, B(BUCK_CY,BUCK_H), pingnd_x, esp_top, GND, lw=1.2)
dot(cv, pingnd_x, esp_top, GND)
txt(cv, BUCK_CX - 0.05*inch, B(BUCK_CY,BUCK_H) - 6, "OUT-", align='c', col=GND, fs=6)
txt(cv, pingnd_x, esp_top + 10, "GND", align='c', col=GND, fs=7, bold=True)

# ── GPS ↔ ESP32 ───────────────────────────────────────────────────────────────
GPS_R = R(GPS_CX, GPS_W)
ESP_L = L(ESP_CX, ESP_W)
CY    = GPS_CY     # same centre Y for both

GPS_ESP_CONNS = [
    (+0.33*inch, "VCC",     "3V3",      PWR),
    (+0.11*inch, "TX",      "GPIO 44",  SIG),
    (-0.11*inch, "RX",      "GPIO 43",  SIG),
    (-0.33*inch, "GND",     "GND",      GND),
]
for dy, lbl_l, lbl_r, col in GPS_ESP_CONNS:
    conn(cv, GPS_R, CY + dy, ESP_L, lbl_l, lbl_r, col)

# ── ESP32 ↔ nRF24 TX ─────────────────────────────────────────────────────────
ESP_R = R(ESP_CX, ESP_W)
NTX_L = L(NTX_CX, NTX_W)
CY    = ESP_CY

ESP_NRF_CONNS = [
    (+0.44*inch, "GPIO 21",  "CE",    SIG),
    (+0.28*inch, "GPIO 10",  "CSN",   SIG),
    (+0.12*inch, "GPIO 12",  "SCK",   SIG),
    ( 0.00*inch, "GPIO 11",  "MOSI",  SIG),
    (-0.12*inch, "GPIO 13",  "MISO",  SIG),
    (-0.28*inch, "3V3",      "VCC",   PWR),
    (-0.44*inch, "GND",      "GND",   GND),
]
for dy, lbl_l, lbl_r, col in ESP_NRF_CONNS:
    conn(cv, ESP_R, CY + dy, NTX_L, lbl_l, lbl_r, col)

# ── RF Wireless Link ──────────────────────────────────────────────────────────
NTX_R = R(NTX_CX, NTX_W)
NRX_L = L(NRX_CX, NRX_W)
RF_Y  = NTX_CY

hline(cv, NTX_R, RF_Y, NRX_L, RF, lw=2.5, dash=[9, 6])
arrow_r(cv, NRX_L + 2, RF_Y, RF, size=8)
txt(cv, (NTX_R + NRX_L)/2, RF_Y + 11, "2.4 GHz RF LINK", align='c', col=RF, fs=8.5, bold=True)

# ── nRF24 RX ↔ Arduino Nano ──────────────────────────────────────────────────
NRX_R  = R(NRX_CX, NRX_W)
NANO_L = L(NANO_CX, NANO_W)
CY     = NRX_CY

NRF_NANO_CONNS = [
    (+0.44*inch, "CE",    "D9",     SIG),
    (+0.28*inch, "CSN",   "D10",    SIG),
    (+0.12*inch, "SCK",   "D13",    SIG),
    ( 0.00*inch, "MOSI",  "D11",    SIG),
    (-0.12*inch, "MISO",  "D12",    SIG),
    (-0.28*inch, "VCC",   "3.3V",   PWR),
    (-0.44*inch, "GND",   "GND",    GND),
]
for dy, lbl_l, lbl_r, col in NRF_NANO_CONNS:
    conn(cv, NRX_R, CY + dy, NANO_L, lbl_l, lbl_r, col)

# ── Arduino Nano → Laptop USB ─────────────────────────────────────────────────
NANO_R = R(NANO_CX, NANO_W)
LAPT_L = L(LAPT_CX, LAPT_W)
USB_Y  = NANO_CY
hline(cv, NANO_R, USB_Y, LAPT_L, USB_COL, lw=2.2)
dot(cv, NANO_R, USB_Y, USB_COL)
dot(cv, LAPT_L, USB_Y, USB_COL)
txt(cv, (NANO_R + LAPT_L)/2, USB_Y + 10, "USB Mini-B", align='c', col=USB_COL, fs=8, bold=True)

# ── 10 µF cap note on nRF24 TX ───────────────────────────────────────────────
for cx, cy, w, h in [(NTX_CX, NTX_CY, NTX_W, NTX_H),
                      (NRX_CX, NRX_CY, NRX_W, NRX_H)]:
    txt(cv, cx, B(cy,h) - 8, "! 10-100uF cap on VCC/GND",
        align='c', col=colors.HexColor('#aa4400'), fs=6.0)

# ── Legend ────────────────────────────────────────────────────────────────────
LX, LY = PAD + 0.1*inch, PAD + 0.42*inch
txt(cv, LX, LY, "LEGEND:", bold=True, fs=8, col=DGRAY)

legend_items = [
    (PWR,     "Power (VCC / 5V / 3.3V)"),
    (GND,     "Ground (GND)"),
    (SIG,     "Signal (SPI / UART)"),
    (RF,      "2.4 GHz Wireless Link (dashed)"),
    (USB_COL, "USB Serial"),
]
for i, (col, label) in enumerate(legend_items):
    ex = LX + 0.7*inch + i * 2.9*inch
    hline(cv, ex, LY, ex + 0.45*inch, col, lw=2.5,
          dash=([9,5] if col is RF else None))
    txt(cv, ex + 0.50*inch, LY, label, col=DGRAY, fs=7.5)

# ── Notes ─────────────────────────────────────────────────────────────────────
NX = MID + 0.22*inch
NY = PAD + 1.05*inch
txt(cv, NX, NY, "NOTES:", bold=True, fs=8, col=DGRAY)
notes = [
    "• nRF24L01+: STRICTLY 3.3V on VCC — never connect to 5V",
    "• Solder 10–100 µF electrolytic cap across VCC/GND on each nRF24 module",
    "• Verify buck converter output is 5V before connecting to ESP32",
    "• GPS cold-start fix may take 30–60 s outdoors; indoors may not fix at all",
    "• Arduino Nano serial baud: 19200 (must match telemetry_rx.ino)",
    "• nRF24 SPI on Arduino Nano uses hardware SPI pins (D11/D12/D13)",
]
for i, note in enumerate(notes):
    txt(cv, NX, NY - (i + 1) * 0.145*inch, note, col=DGRAY, fs=7.5)

# ── Border & save ─────────────────────────────────────────────────────────────
cv.setStrokeColor(colors.HexColor('#223344'))
cv.setLineWidth(1.5)
cv.rect(0.18*inch, 0.18*inch, W - 0.36*inch, H - 0.36*inch, stroke=1, fill=0)

cv.save()
print(f"Saved: {OUTPUT}")
