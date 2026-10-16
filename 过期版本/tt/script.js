// -------- DOM refs --------
  const $ = id => document.getElementById(id);
  const cadenceEl = $('cadence');
  const resistanceEl = $('resistance');
  const powerEl = $('power');
  const speedEl = $('speed');
  const elapsedEl = $('elapsed');
  const distanceEl = $('distance');
  const caloriesEl = $('calories');
  const avgPowerEl = $('avgPower');
  const logEl = $('log');
  const statusDot = $('statusDot');
  const statusText = $('statusText');
  const connectBtn = $('connectBtn');
  const disconnectBtn = $('disconnectBtn');
  const resetBtn = $('resetBtn');
  const exportBtn = $('exportBtn');

  // -------- Browser support check --------
  if (!('serial' in navigator)) {
    $('unsupported').style.display = 'block';
    connectBtn.disabled = true;
  }

  // -------- State --------
  let port = null;
  let reader = null;
  let keepReading = false;
  let buffer = new Uint8Array(0);
  let session = {
    startTime: null,
    samples: [],         // {t, cadence, resistance, power}
    powerSum: 0,
    powerCount: 0,
    distanceMi: 0,
    calories: 0,
    lastSampleTime: null,
  };

  // -------- Logging --------
  function log(msg, cls = '') {
    const line = document.createElement('div');
    if (cls) line.className = cls;
    const ts = new Date().toLocaleTimeString();
    line.textContent = `[${ts}] ${msg}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
    if (logEl.children.length > 200) logEl.removeChild(logEl.firstChild);
  }

  // -------- Connect / disconnect --------
  connectBtn.addEventListener('click', async () => {
    try {
      port = await navigator.serial.requestPort();
      await port.open({
        baudRate: 19200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
      });
      statusDot.classList.add('connected');
      statusText.textContent = 'Connected';
      connectBtn.disabled = true;
      disconnectBtn.disabled = false;
      log('Connected at 19200 baud', 'ok');
      session.startTime = Date.now();
      session.lastSampleTime = Date.now();
      keepReading = true;
      readLoop();
    } catch (e) {
      log('Connection error: ' + e.message, 'err');
    }
  });

  disconnectBtn.addEventListener('click', async () => {
    keepReading = false;
    if (reader) {
      try { await reader.cancel(); } catch (e) {}
    }
    if (port) {
      try { await port.close(); } catch (e) {}
    }
    port = null;
    reader = null;
    statusDot.classList.remove('connected');
    statusText.textContent = 'Disconnected';
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
    log('Disconnected');
  });

  resetBtn.addEventListener('click', () => {
    session = {
      startTime: Date.now(),
      samples: [],
      powerSum: 0,
      powerCount: 0,
      distanceMi: 0,
      calories: 0,
      lastSampleTime: Date.now(),
    };
    log('Totals reset');
    updateTotals();
  });

  exportBtn.addEventListener('click', () => {
    if (session.samples.length === 0) {
      log('No data to export', 'err');
      return;
    }
    const rows = [['time_s', 'cadence_rpm', 'resistance_pct', 'power_w']];
    session.samples.forEach(s => rows.push([s.t, s.cadence, s.resistance, s.power]));
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `peloton-ride-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    log(`Exported ${session.samples.length} samples`, 'ok');
  });

  // -------- Read loop --------
  async function readLoop() {
    while (port && port.readable && keepReading) {
      reader = port.readable.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) ingest(value);
        }
      } catch (e) {
        log('Read error: ' + e.message, 'err');
      } finally {
        reader.releaseLock();
        reader = null;
      }
    }
  }

  // -------- Peloton serial protocol parser --------
  // Reverse-engineered original Peloton Bike protocol:
  //   Frames are delimited by 0xF1 (start) ... 0xF6 (end).
  //   Between markers: [type][length][digits...][checksum]
  //     type 0x41 ('A') = cadence (RPM)
  //     type 0x44 ('D') = resistance (raw value, mapped to 0–100%)
  //     type 0x4A ('J') = power (watts * 10, e.g., 1234 → 123.4 W)
  //   Digits are ASCII, sent reversed (little-endian-ish), one byte per decimal digit.
  //   Checksum = sum of digit bytes & 0xFF.
  function ingest(chunk) {
    // append to rolling buffer
    const merged = new Uint8Array(buffer.length + chunk.length);
    merged.set(buffer, 0);
    merged.set(chunk, buffer.length);
    buffer = merged;

    // scan for full frames: F1 ... F6
    let start = -1;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] === 0xF1) start = i;
      else if (buffer[i] === 0xF6 && start !== -1) {
        const frame = buffer.slice(start + 1, i);
        parseFrame(frame);
        start = -1;
      }
    }

    // trim consumed bytes — keep tail from the last incomplete start (or last 64 bytes)
    if (start !== -1) {
      buffer = buffer.slice(start);
    } else if (buffer.length > 256) {
      buffer = buffer.slice(buffer.length - 64);
    }
  }

  function parseFrame(frame) {
    if (frame.length < 3) return;
    const type = frame[0];
    const len = frame[1];
    if (frame.length < 2 + len + 1) return;
    const digits = frame.slice(2, 2 + len);
    const checksum = frame[2 + len];

    let sum = 0;
    for (const b of digits) sum = (sum + b) & 0xFF;
    if (sum !== checksum) {
      log('Checksum mismatch — ignoring frame', 'err');
      return;
    }

    // digits are ASCII '0'..'9', reversed
    let n = 0;
    for (let i = digits.length - 1; i >= 0; i--) {
      const d = digits[i] - 0x30;
      if (d < 0 || d > 9) return;
      n = n * 10 + d;
    }

    if (type === 0x41) updateCadence(n);
    else if (type === 0x44) updateResistance(n);
    else if (type === 0x4A) updatePower(n / 10);
  }

  // -------- Metric updates --------
  let lastCadence = 0, lastResistance = 0, lastPower = 0;

  function updateCadence(rpm) {
    lastCadence = rpm;
    cadenceEl.textContent = rpm;
    updateSpeed();
    recordSample();
  }
  function updateResistance(raw) {
    // raw is 0–100 already on most original bikes; clamp just in case
    const pct = Math.max(0, Math.min(100, raw));
    lastResistance = pct;
    resistanceEl.textContent = pct;
    updateSpeed();
    recordSample();
  }
  function updatePower(watts) {
    lastPower = watts;
    powerEl.textContent = Math.round(watts);
    session.powerSum += watts;
    session.powerCount += 1;
    recordSample();
  }

  // Rough speed estimate: Peloton bikes don't transmit speed directly.
  // Approx: speed_mph = (cadence * gear_factor * resistance_factor)
  // Use a simple empirical formula — good enough for a personal display.
  function updateSpeed() {
    const mph = (lastCadence / 100) * (1 + lastResistance / 50) * 4;
    speedEl.textContent = mph.toFixed(1);
  }

  function recordSample() {
    if (!session.startTime) return;
    const now = Date.now();
    const t = (now - session.startTime) / 1000;

    // throttle samples to 1 per ~250ms
    const last = session.samples[session.samples.length - 1];
    if (last && (t - last.t) < 0.25) return;

    session.samples.push({
      t: +t.toFixed(2),
      cadence: lastCadence,
      resistance: lastResistance,
      power: +lastPower.toFixed(1),
    });

    // distance + calories integration
    const dt = (now - session.lastSampleTime) / 1000 / 3600; // hours
    session.lastSampleTime = now;
    const mph = parseFloat(speedEl.textContent);
    session.distanceMi += mph * dt;
    // ~3.6 kcal per Wh for cycling efficiency
    session.calories += (lastPower * (dt * 3600) / 3600) * 3.6;

    updateTotals();
  }

  function updateTotals() {
    const elapsed = session.startTime
      ? Math.floor((Date.now() - session.startTime) / 1000) : 0;
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    elapsedEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    distanceEl.textContent = session.distanceMi.toFixed(2) + ' mi';
    caloriesEl.textContent = Math.round(session.calories);
    const avg = session.powerCount > 0 ? session.powerSum / session.powerCount : 0;
    avgPowerEl.textContent = Math.round(avg) + ' W';
  }

  // tick the clock every second
  setInterval(() => { if (session.startTime) updateTotals(); }, 1000);