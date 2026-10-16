import './style.css';

const MAX_POINTS = 200;

// Client-side history arrays (speed from buffer, accel derived server-side)
const speedHistory = { labels: [], values: [] };
const accelHistory = { labels: [], values: [] };

// ── Chart defaults ────────────────────────────────────────────────────────────
Chart.defaults.color = '#7ab8d4';
Chart.defaults.borderColor = 'rgba(0,212,255,0.08)';
Chart.defaults.font.family = "'Share Tech Mono', monospace";

const gridStyle = { color: 'rgba(0,212,255,0.07)', drawTicks: false };
const tickStyle = { color: '#4a7a94', maxTicksLimit: 6, padding: 8 };

// ── Speed chart (fed from /data buffer) ──────────────────────────────────────
const speedChart = new Chart(
  document.getElementById('speedChart').getContext('2d'),
  {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Speed',
        data: [],
        borderColor: '#00d4ff',
        backgroundColor: 'rgba(0,212,255,0.06)',
        borderWidth: 2,
        fill: true,
        tension: 0.4,
        pointRadius: 0,
      }],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: true,
      aspectRatio: 2.5,
      scales: {
        x: { type: 'category', ticks: { ...tickStyle, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 }, grid: gridStyle },
        y: { min: 0, title: { display: true, text: 'mph', color: '#4a7a94' }, ticks: tickStyle, grid: gridStyle },
      },
      plugins: { legend: { display: false } },
    },
  }
);

// ── Derived acceleration chart (fed from /api/current poll) ──────────────────
const accelChart = new Chart(
  document.getElementById('accelChart').getContext('2d'),
  {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Accel',
        data: [],
        borderColor: '#ff5577',
        backgroundColor: 'rgba(255,85,119,0.05)',
        borderWidth: 1.5,
        fill: true,
        tension: 0.3,
        pointRadius: 0,
      }],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: true,
      aspectRatio: 2.5,
      scales: {
        x: { type: 'category', ticks: { ...tickStyle, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 }, grid: gridStyle },
        y: { title: { display: true, text: 'g', color: '#4a7a94' }, ticks: tickStyle, grid: gridStyle },
      },
      plugins: { legend: { display: false } },
    },
  }
);

// ── Clock ─────────────────────────────────────────────────────────────────────
function updateClock() {
  const now  = new Date();
  const h24  = now.getHours();
  const h12  = h24 % 12 || 12;
  const ampm = h24 < 12 ? 'AM' : 'PM';
  const mm   = String(now.getMinutes()).padStart(2, '0');
  const ss   = String(now.getSeconds()).padStart(2, '0');
  document.getElementById('clock').textContent = `${h12}:${mm}:${ss} ${ampm}`;
}
setInterval(updateClock, 1000);
updateClock();

// ── Fetch buffer → speed chart ────────────────────────────────────────────────
async function fetchData() {
  try {
    const res = await fetch('/data');
    const buf = await res.json();
    if (!buf.length) return;

    const labels = buf.map(d => d.human_ts.slice(11, 19)).slice(-MAX_POINTS);
    speedChart.data.labels           = labels;
    speedChart.data.datasets[0].data = buf.map(d => d.speed_mph).slice(-MAX_POINTS);
    speedChart.update('none');
  } catch (err) {
    console.error('fetchData:', err);
  }
}

// ── Fetch stats + current → update all HUD elements ─────────────────────────
const MAX_SPEED_SCALE = 80;   // mph — top of speed bar
const MAX_ACCEL_G     = 1.0;  // g   — top of accel bar

async function updateStats() {
  try {
    const [statsRes, currentRes] = await Promise.all([
      fetch('/api/stats'),
      fetch('/api/current'),
    ]);
    const stats   = await statsRes.json();
    const current = await currentRes.json();

    // ── Primary: velocity ─────────────────────────────────────────────────
    const mph = stats.speed_mph;
    document.getElementById('velocity').textContent = mph.toFixed(1);
    document.getElementById('speedBar').style.width =
      Math.min(100, (mph / MAX_SPEED_SCALE) * 100).toFixed(1) + '%';

    // ── Primary: derived acceleration ────────────────────────────────────
    const ag = current.accel_g;
    document.getElementById('currentAccel').textContent = ag.toFixed(3);
    document.getElementById('accelBar').style.width =
      Math.min(100, (Math.abs(ag) / MAX_ACCEL_G) * 100).toFixed(1) + '%';

    // Highlight card while braking
    document.getElementById('currentAccelCard')
      .classList.toggle('highlight', stats.in_braking);

    // ── Secondary stats ───────────────────────────────────────────────────
    document.getElementById('maxSpeed').innerHTML =
      `${stats.max_speed_mph.toFixed(1)}<span class="stat-unit">mph</span>`;
    document.getElementById('maxAccel').innerHTML =
      `${stats.max_accel_g.toFixed(3)}<span class="stat-unit">g</span>`;
    document.getElementById('maxBrake').innerHTML =
      `${stats.max_decel_g.toFixed(3)}<span class="stat-unit">g</span>`;
    document.getElementById('distanceMiles').innerHTML =
      `${stats.distance_miles.toFixed(2)}<span class="stat-unit">mi</span>`;
    document.getElementById('currentHeading').innerHTML =
      `${stats.heading.toFixed(0)}<span class="stat-unit">°</span>`;

    // ── Accel history chart ───────────────────────────────────────────────
    const now = new Date().toTimeString().slice(0, 8);
    accelHistory.labels.push(now);
    accelHistory.values.push(ag);
    if (accelHistory.labels.length > MAX_POINTS) {
      accelHistory.labels.shift();
      accelHistory.values.shift();
    }
    accelChart.data.labels           = accelHistory.labels;
    accelChart.data.datasets[0].data = accelHistory.values;
    accelChart.update('none');

  } catch (err) {
    console.error('updateStats:', err);
  }
}

// ── Status indicator ──────────────────────────────────────────────────────────
async function updateStatus() {
  try {
    const res  = await fetch('/api/status');
    const data = await res.json();
    const dot  = document.getElementById('statusDot');
    const txt  = document.getElementById('statusText');
    if (data.running) {
      dot.classList.add('online');
      txt.textContent = data.has_fix ? 'ONLINE // FIX' : 'ONLINE // NO FIX';
    } else {
      dot.classList.remove('online');
      txt.textContent = 'OFFLINE';
    }
  } catch {
    document.getElementById('statusDot').classList.remove('online');
    document.getElementById('statusText').textContent = 'NO SIGNAL';
  }
}

// ── Poll ──────────────────────────────────────────────────────────────────────
setInterval(fetchData,    100);
setInterval(updateStats,  100);
setInterval(updateStatus, 1000);

// ── Controls ──────────────────────────────────────────────────────────────────
document.getElementById('btnStart').addEventListener('click', async () => {
  await fetch('/api/start', { method: 'POST' });
  updateStatus();
});

document.getElementById('btnStop').addEventListener('click', async () => {
  await fetch('/api/stop', { method: 'POST' });
  updateStatus();
});

document.getElementById('btnNewLog').addEventListener('click', async () => {
  try {
    const res  = await fetch('/api/start_log', { method: 'POST' });
    const data = await res.json();
    document.getElementById('currentFile').textContent = 'LOG: ' + data.file;
    alert('New log started: ' + data.file);
  } catch (err) { console.error(err); }
});

document.getElementById('btnStopLog').addEventListener('click', async () => {
  try {
    await fetch('/api/stop_log', { method: 'POST' });
    document.getElementById('currentFile').textContent = 'LOG: none';
    alert('Logging stopped.');
  } catch (err) { console.error(err); }
});

document.getElementById('btnResetStats').addEventListener('click', async () => {
  if (!confirm('Reset all performance statistics?')) return;
  speedHistory.labels.length  = 0;
  speedHistory.values.length  = 0;
  accelHistory.labels.length  = 0;
  accelHistory.values.length  = 0;
  try {
    await fetch('/api/reset_stats', { method: 'POST' });
  } catch (err) { console.error(err); }
});

document.getElementById('btnDeleteLogs').addEventListener('click', async () => {
  if (!confirm('Delete all CSV logs?')) return;
  try {
    const res  = await fetch('/api/delete_logs', { method: 'POST' });
    const data = await res.json();
    document.getElementById('currentFile').textContent = 'LOG: none';
    alert(`Purged ${data.files.length} log files.`);
    updateStatus();
  } catch (err) { console.error(err); }
});
