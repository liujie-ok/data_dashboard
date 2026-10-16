/* Dashboard UI orchestration. Protocol and serial lifecycle live in separate modules. */
document.addEventListener('DOMContentLoaded', () => {
  'use strict';
  const $ = id => document.getElementById(id);
  const serial = new window.SerialManager();
  const parser = new window.SerialProtocol.FrameParser(
    frame => handleFrame(frame),
    message => log(message, 'err')
  );

  const elements = {
    cadence: $('cadence'), resistance: $('resistance'), power: $('power'), speed: $('speed'),
    elapsed: $('elapsed'), distance: $('distance'), energy: $('calories'), avgPower: $('avgPower'),
    log: $('log'), log2: $('log2'), statusDot: $('statusDot'), statusDot2: $('statusDot2'),
    statusText: $('statusText'), statusText2: $('statusText2'), connect: $('connectBtn'), connect2: $('connectBtn2'),
    disconnect: $('disconnectBtn'), disconnect2: $('disconnectBtn2'), baud: $('baudRate'), baud2: $('baudRate2'),
    ride: $('toggleRideBtn'), export: $('exportBtn'), unsupported: $('unsupported'),
    fileTrigger: $('fileTriggerStatus'), fileDot: $('fileStatusDot'), fileText: $('fileStatusText'),
    fileInput: $('csvFileInput'), fileInfo: $('fileInfoText'), loadCsv: $('loadCsvBtn'),
    selects: [$('chart1Select'), $('chart2Select'), $('chart3Select')],
    params: [
      { id: 'maxCadence', type: 0x51, min: 0, integer: true },
      { id: 'maxResistance', type: 0x52, min: 0, max: 100 },
      { id: 'maxPower', type: 0x53, min: 0 },
      { id: 'maxSpeed', type: 0x54, min: 0 },
      { id: 'maxPhaseCurrent', type: 0x55, min: 0 },
      { id: 'maxBatteryCurrent', type: 0x56, min: 0 },
      { id: 'pwmFrequency', type: 0x57, min: 1, integer: true },
      { id: 'currentGain', type: 0x58, min: 0 }
    ]
  };

  const state = {
    telemetry: { cadence: 0, resistance: 0, power: 0, speed: 0 },
    lastTelemetryAt: 0,
    connectedAt: 0,
    riding: false,
    session: null,
    csv: null,
    analyticsCharts: [],
    speedChart: null
  };

  function log(message, cls = '') {
    const timestamp = new Date().toLocaleTimeString();
    [elements.log, elements.log2].forEach(node => {
      node.replaceChildren();
      const span = document.createElement('span');
      if (cls === 'ok' || cls === 'err') span.className = cls;
      span.textContent = `[${timestamp}] ${message}`;
      node.appendChild(span);
      node.scrollTop = node.scrollHeight;
    });
  }

  function hasActiveConnection() {
    return serial.state === 'connected' && serial.connected;
  }

  function setConnectionUI(status) {
    // Do not trust the UI event alone: both the manager state and the open port
    // streams must still be valid before enabling data actions.
    const connected = status === 'connected' && hasActiveConnection();
    const busy = status === 'connecting' || status === 'disconnecting';
    [elements.statusDot, elements.statusDot2].forEach(dot => dot.classList.toggle('connected', connected));
    [elements.statusText, elements.statusText2].forEach(text => {
      text.textContent = connected ? '已连接' : busy ? '连接处理中' : '未连接';
    });
    [elements.connect, elements.connect2].forEach(button => { button.disabled = connected || busy || !('serial' in navigator); });
    [elements.disconnect, elements.disconnect2].forEach(button => { button.disabled = !connected; });
    elements.baud.disabled = connected || busy;
    elements.baud2.disabled = connected || busy;

    // Recording and export are strictly gated by a successful serial connection.
    elements.ride.disabled = !connected;
    elements.export.disabled = !connected;
    elements.ride.title = connected ? '开始或停止记录' : '请先成功连接串口设备';
    elements.export.title = connected ? '导出当前记录 CSV' : '请先成功连接串口设备';
  }

  serial.addEventListener('statechange', event => {
    if (event.detail !== 'connected') stopRide(false);
    setConnectionUI(event.detail);
  });
  serial.addEventListener('data', event => parser.push(event.detail));
  serial.addEventListener('error', event => {
    log(`串口读取异常：${event.detail?.message || event.detail}`, 'err');
    // A removed USB device can terminate the reader before the user clicks Disconnect.
    if (serial.state === 'connected' && !serial.connected) {
      stopRide(false);
      void serial.disconnect().catch(() => {});
    }
  });

  if (!('serial' in navigator)) {
    elements.unsupported.style.display = 'block';
    setConnectionUI('disconnected');
  }

  // Chart.js setup
  const crosshairPlugin = {
    id: 'dashboardCrosshair',
    afterDraw(chart) {
      const active = chart.tooltip?.getActiveElements?.() || [];
      if (!active.length || !chart.scales?.y) return;
      const x = active[0].element.x;
      const ctx = chart.ctx;
      ctx.save(); ctx.beginPath(); ctx.moveTo(x, chart.scales.y.top); ctx.lineTo(x, chart.scales.y.bottom);
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,.4)'; ctx.setLineDash([4, 4]); ctx.stroke(); ctx.restore();
    }
  };
  // 鼠标交互缩放：滚轮以光标位置缩放 X 轴；拖动框选区间；双击复位。
  // 不依赖额外插件，缩放范围仅影响显示，不修改原始 CSV 数据。
  function installMouseZoom(chart, syncGroup = null) {
    const canvas = chart.canvas;
    canvas.style.cursor = 'crosshair';
    const getRange = () => {
      const count = chart.data.labels.length;
      const min = Number.isFinite(chart.options.scales.x.min) ? chart.options.scales.x.min : 0;
      const max = Number.isFinite(chart.options.scales.x.max) ? chart.options.scales.x.max : Math.max(0, count - 1);
      return { min, max, count };
    };
    const applyRange = (min, max) => {
      const targets = syncGroup && syncGroup.length ? syncGroup : [chart];
      const count = chart.data.labels.length;
      if (count < 2) return;
      min = Math.max(0, Math.floor(min));
      max = Math.min(count - 1, Math.ceil(max));
      if (max - min < 1) return;
      // 分析区三张图共用相同的横轴索引范围，缩放/平移效果保持同步。
      targets.forEach(target => {
        if (target.data.labels.length < 2) return;
        target.options.scales.x.min = Math.max(0, min);
        target.options.scales.x.max = Math.min(target.data.labels.length - 1, max);
        target.update('none');
      });
    };
    canvas.addEventListener('wheel', event => {
      if (chart.data.labels.length < 2) return;
      event.preventDefault();
      const { min, max } = getRange();
      const currentSpan = Math.max(1, max - min);
      const rect = canvas.getBoundingClientRect();
      // Chart.js scale coordinates use logical canvas pixels (CSS px), not the backing-store width.
      // Multiplying by canvas.width / rect.width causes the selection to drift on HiDPI displays.
      const pixelX = event.clientX - rect.left;
      const anchorValue = chart.scales.x.getValueForPixel(pixelX);
      const anchor = Number.isFinite(anchorValue) ? Math.max(min, Math.min(max, anchorValue)) : (min + max) / 2;
      const factor = event.deltaY < 0 ? 0.8 : 1.25;
      const nextSpan = Math.max(2, Math.min(chart.data.labels.length - 1, currentSpan * factor));
      const ratio = currentSpan > 0 ? (anchor - min) / currentSpan : 0.5;
      let nextMin = anchor - nextSpan * ratio;
      let nextMax = nextMin + nextSpan;
      if (nextMin < 0) { nextMax -= nextMin; nextMin = 0; }
      if (nextMax > chart.data.labels.length - 1) { nextMin -= nextMax - (chart.data.labels.length - 1); nextMax = chart.data.labels.length - 1; }
      applyRange(nextMin, nextMax);
    }, { passive: false });

    let dragStart = null;
    let dragCurrent = null;
    canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !chart.chartArea) return;
      const rect = canvas.getBoundingClientRect();
      // Keep pointer coordinates in the same CSS-pixel coordinate space as chart.chartArea.
      const x = event.clientX - rect.left;
      if (x < chart.chartArea.left || x > chart.chartArea.right) return;
      dragStart = x; dragCurrent = x;
      canvas.setPointerCapture?.(event.pointerId);
      chart.$mouseZoomDrag = { start: x, current: x };
      chart.draw();
    });
    canvas.addEventListener('pointermove', event => {
      if (dragStart === null) return;
      const rect = canvas.getBoundingClientRect();
      dragCurrent = event.clientX - rect.left;
      chart.$mouseZoomDrag = { start: dragStart, current: dragCurrent };
      chart.draw();
    });
    const finishDrag = () => {
      if (dragStart === null) return;
      const start = dragStart, end = dragCurrent;
      dragStart = null; dragCurrent = null; chart.$mouseZoomDrag = null;
      if (Math.abs(end - start) > 12) {
        const a = chart.scales.x.getValueForPixel(Math.min(start, end));
        const b = chart.scales.x.getValueForPixel(Math.max(start, end));
        if (Number.isFinite(a) && Number.isFinite(b)) applyRange(a, b);
        else chart.draw();
      } else chart.draw();
    };
    canvas.addEventListener('pointerup', finishDrag);
    canvas.addEventListener('pointercancel', finishDrag);
    canvas.addEventListener('dblclick', event => {
      event.preventDefault();
      const targets = syncGroup && syncGroup.length ? syncGroup : [chart];
      targets.forEach(target => {
        delete target.options.scales.x.min;
        delete target.options.scales.x.max;
        target.$mouseZoomDrag = null;
        target.update('none');
      });
    });
  }

  const mouseZoomSelectionPlugin = {
    id: 'mouseZoomSelection',
    afterDraw(chart) {
      const drag = chart.$mouseZoomDrag;
      if (!drag || !chart.chartArea) return;
      const left = Math.max(chart.chartArea.left, Math.min(drag.start, drag.current));
      const right = Math.min(chart.chartArea.right, Math.max(drag.start, drag.current));
      if (right <= left) return;
      const ctx = chart.ctx;
      ctx.save();
      ctx.fillStyle = 'rgba(0, 210, 255, 0.16)';
      ctx.strokeStyle = 'rgba(0, 210, 255, 0.9)';
      ctx.lineWidth = 1;
      ctx.fillRect(left, chart.chartArea.top, right - left, chart.chartArea.bottom - chart.chartArea.top);
      ctx.strokeRect(left, chart.chartArea.top, right - left, chart.chartArea.bottom - chart.chartArea.top);
      ctx.restore();
    }
  };

  const chartOptions = () => ({
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false }, tooltip: { enabled: true, mode: 'index', intersect: false } },
    layout: { padding: { top: 4, right: 10, bottom: 4, left: 4 } },
    scales: {
      x: {
        min: undefined,
        grid: { color: '#1f2730' },
        ticks: {
          color: '#7b8794', font: { size: 9 }, padding: 3,
          autoSkip: true, maxTicksLimit: 5, maxRotation: 0, minRotation: 0,
          callback(value, index, ticks) {
            const label = String(this.getLabelForValue(value) ?? '');
            // Long timestamps are shortened for narrow three-column charts.
            return label.length > 12 ? label.slice(-8) : label;
          }
        },
        title: { display: true, text: '时间', color: '#7b8794', font: { size: 10 }, padding: { top: 2, bottom: 0 } }
      },
      y: {
        beginAtZero: true,
        afterFit(scale) { scale.width = Math.min(scale.width, 54); },
        ticks: {
          color: '#7b8794', font: { size: 9 }, padding: 3, maxTicksLimit: 6,
          callback(value) {
            return typeof value === 'number' ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2, notation: 'compact' }).format(value) : value;
          }
        },
        grid: { color: '#1f2730' }
      }
    }
  });
  state.speedChart = new Chart($('speedChart').getContext('2d'), {
    type: 'line', data: { labels: [], datasets: [{ label: '速度 (km/h)', data: [], borderColor: '#00d2ff', borderWidth: 2, fill: false, tension: 0.2, pointRadius: 0 }] },
    options: { ...chartOptions(), scales: { ...chartOptions().scales, y: { ...chartOptions().scales.y, suggestedMax: 25 }, x: { ...chartOptions().scales.x, title: { display: true, text: '时间 (分:秒)', color: '#7b8794' } } } },
    plugins: [crosshairPlugin, mouseZoomSelectionPlugin]
  });
  installMouseZoom(state.speedChart);
  const chartColors = ['#00d2ff', '#4ade80', '#ff3347'];
  state.analyticsCharts = ['analyticsChart1', 'analyticsChart2', 'analyticsChart3'].map((id, index) =>
    new Chart($(id).getContext('2d'), {
      type: 'line', data: { labels: [], datasets: [{ label: '数值', data: [], borderColor: chartColors[index], borderWidth: 2, fill: false, tension: 0.2, pointRadius: 0 }] },
      options: chartOptions(), plugins: [crosshairPlugin, mouseZoomSelectionPlugin]
    })
  );
  state.analyticsCharts.forEach(chart => installMouseZoom(chart, state.analyticsCharts));

  let cursorRaf = 0;
  state.analyticsCharts.forEach((chart, sourceIndex) => {
    chart.canvas.addEventListener('mousemove', event => {
      if (cursorRaf) cancelAnimationFrame(cursorRaf);
      cursorRaf = requestAnimationFrame(() => {
        const points = chart.getElementsAtEventForMode(event, 'index', { intersect: false }, true);
        if (!points.length) return;
        const index = points[0].index;
        state.analyticsCharts.forEach((other, targetIndex) => {
          if (targetIndex !== sourceIndex && index < other.data.labels.length) {
            other.tooltip.setActiveElements([{ datasetIndex: 0, index }]);
            other.setActiveElements([{ datasetIndex: 0, index }]);
            other.update('none');
          }
        });
      });
    });
    chart.canvas.addEventListener('mouseleave', () => {
      state.analyticsCharts.forEach((other, index) => {
        if (index === sourceIndex) return;
        other.tooltip.setActiveElements([]); other.setActiveElements([]); other.update('none');
      });
    });
  });

  // Tabs
  document.querySelectorAll('.tab-btn').forEach(button => button.addEventListener('click', () => {
    const target = button.dataset.target;
    document.querySelectorAll('.tab-btn').forEach(item => item.classList.toggle('active', item === button));
    document.querySelectorAll('.page-container').forEach(page => page.classList.toggle('active', page.id === target));
    state.analyticsCharts.forEach(chart => chart.resize());
    state.speedChart.resize();
  }));

  // Shared serial controls
  elements.baud.addEventListener('change', () => { elements.baud2.value = elements.baud.value; });
  elements.baud2.addEventListener('change', () => { elements.baud.value = elements.baud2.value; });
  [elements.connect, elements.connect2].forEach(button => button.addEventListener('click', async () => {
    try {
      parser.reset();
      await serial.connect(Number(elements.baud.value));
      state.connectedAt = Date.now(); state.lastTelemetryAt = 0;
      state.speedChart.data.labels = []; state.speedChart.data.datasets[0].data = []; state.speedChart.update('none');
      log(`串口连接成功，波特率：${elements.baud.value}`, 'ok');
    } catch (error) { log(`串口连接失败：${error.message}`, 'err'); }
  }));
  [elements.disconnect, elements.disconnect2].forEach(button => button.addEventListener('click', async () => {
    try {
      await serial.disconnect();
      stopRide(false);
      parser.reset();
      log('串口设备已断开', 'ok');
    } catch (error) { log(`断开串口时出现问题：${error.message}`, 'err'); }
  }));

  $('readParamsBtn').addEventListener('click', async () => {
    try {
      await serial.write(window.SerialProtocol.encodeReadParametersRequest());
      log('已发送读取参数请求', 'ok');
    } catch (error) { log(`读取参数请求发送失败：${error.message}`, 'err'); }
  });

  $('writeParamsBtn').addEventListener('click', async () => {
    const values = [];
    for (const definition of elements.params) {
      const input = $(definition.id);
      const value = input.valueAsNumber;
      if (!input.value.trim() || !Number.isFinite(value) || value < definition.min || (definition.max !== undefined && value > definition.max) || (definition.integer && !Number.isInteger(value))) {
        input.focus();
        log(`参数“${input.closest('.metric')?.querySelector('.label')?.textContent || definition.id}”不合法`, 'err');
        return;
      }
      values.push({ ...definition, value: input.value.trim() });
    }
    try {
      for (const item of values) {
        await serial.write(window.SerialProtocol.encodeParameter(item.type, item.value));
        // 间隔是为了兼容旧固件处理速度；不是解决 USB 粘包的必要手段。
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      log('参数写入帧已发送，请确认设备是否回显/应答', 'ok');
    } catch (error) { log(`参数写入失败：${error.message}`, 'err'); }
  });

  function handleFrame(frame) {
    // Existing firmware protocol encodes numeric values as ASCII text.
    const value = window.SerialProtocol.parseNumericPayload(frame.payload);
    if (frame.type === 0x60) return; // read-parameters command/ack may have an empty payload
    if (value === null) { log(`忽略无效数据帧，类型 0x${frame.type.toString(16)}`, 'err'); return; }
    const telemetryMap = { 0x41: 'cadence', 0x44: 'resistance', 0x42: 'speed', 0x4A: 'power' };
    const field = telemetryMap[frame.type];
    if (field) {
      let safeValue = value;
      if (field === 'resistance') safeValue = Math.max(0, Math.min(100, value));
      if (field === 'cadence' || field === 'speed') safeValue = Math.max(0, value);
      state.telemetry[field] = safeValue;
      state.lastTelemetryAt = Date.now();
      const display = { cadence: String(Math.round(state.telemetry.cadence)), resistance: String(Math.round(state.telemetry.resistance)),
        power: String(Math.round(state.telemetry.power)), speed: state.telemetry.speed.toFixed(1) };
      elements[field].textContent = display[field];
      return;
    }
    const parameter = elements.params.find(item => item.type === frame.type);
    if (parameter) $(parameter.id).value = parameter.id === 'maxSpeed' ? value.toFixed(1) : String(value);
  }

  // Fixed-rate sampling decouples metrics from serial packet frequency.
  const MAX_LIVE_POINTS = 1200;
  let lastChartAt = 0;
  let lastSampleAt = 0;
  let previousPower = null;
  setInterval(() => {
    if (serial.state === 'connected' && !serial.connected) {
      stopRide(false);
      setConnectionUI('disconnected');
      log('串口连接已丢失，记录已停止', 'err');
      void serial.disconnect().catch(() => {});
    }
    const now = Date.now();
    if (state.connectedAt) {
      const age = state.lastTelemetryAt ? now - state.lastTelemetryAt : Infinity;
      if (age < 2000 && now - lastChartAt >= 250) {
        const elapsedSeconds = Math.floor((now - state.connectedAt) / 1000);
        const label = `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, '0')}`;
        state.speedChart.data.labels.push(label);
        state.speedChart.data.datasets[0].data.push(state.telemetry.speed);
        if (state.speedChart.data.labels.length > MAX_LIVE_POINTS) {
          state.speedChart.data.labels.splice(0, 100);
          state.speedChart.data.datasets[0].data.splice(0, 100);
        }
        state.speedChart.update('none'); lastChartAt = now;
      }
    }
    if (state.riding && state.session) sampleRide(now);
    if (state.riding && state.session) updateTotals(now);
  }, 250);

  function sampleRide(now) {
    const session = state.session;
    const elapsed = (now - session.startTime) / 1000;
    const dtSeconds = Math.max(0, (now - lastSampleAt) / 1000);
    const fresh = state.lastTelemetryAt && now - state.lastTelemetryAt < 2000;
    const speed = fresh ? state.telemetry.speed : 0;
    const power = fresh ? state.telemetry.power : 0;
    // Trapezoidal integration. speed km/h * hours => km; power W * hours => Wh.
    if (dtSeconds > 0 && dtSeconds < 2) {
      const dtHours = dtSeconds / 3600;
      session.distanceKm += ((session.previousSpeed + speed) / 2) * dtHours;
      session.energyWh += ((session.previousPower + power) / 2) * dtHours;
      session.powerIntegralWh += ((session.previousPower + power) / 2) * dtHours;
      session.validSeconds += dtSeconds;
    }
    session.previousSpeed = speed;
    session.previousPower = power;
    lastSampleAt = now;
    if (elapsed >= 0) {
      session.samples.push({ time_s: Number(elapsed.toFixed(2)), cadence: state.telemetry.cadence,
        resistance: state.telemetry.resistance, power: state.telemetry.power, speed: state.telemetry.speed });
    }
  }

  function updateTotals(now = Date.now()) {
    const session = state.session;
    if (!session) return;
    const elapsed = Math.floor((now - session.startTime) / 1000);
    elements.elapsed.textContent = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
    elements.distance.textContent = `${session.distanceKm.toFixed(3)} km`;
    elements.energy.textContent = `${session.energyWh.toFixed(2)} Wh`;
    const averagePower = session.validSeconds > 0 ? session.powerIntegralWh / (session.validSeconds / 3600) : 0;
    elements.avgPower.textContent = `${Math.round(averagePower)} W`;
  }

  function startRide() {
    if (!hasActiveConnection()) {
      setConnectionUI(serial.state);
      log('串口设备尚未成功连接，不能开始记录', 'err');
      return;
    }
    const now = Date.now();
    state.session = { startTime: now, samples: [], distanceKm: 0, energyWh: 0, powerIntegralWh: 0, validSeconds: 0,
      previousSpeed: state.telemetry.speed, previousPower: state.telemetry.power };
    state.riding = true; lastSampleAt = now;
    elements.ride.textContent = '停止记录'; elements.ride.classList.remove('start-btn'); elements.ride.classList.add('stop-btn');
    log('骑行数据记录已开始', 'ok');
  }
  function stopRide(logMessage = true) {
    if (state.riding) {
      state.riding = false;
      elements.ride.textContent = '开始记录'; elements.ride.classList.remove('stop-btn'); elements.ride.classList.add('start-btn');
      if (logMessage) log('骑行数据记录已停止', 'ok');
    }
  }
  elements.ride.addEventListener('click', () => {
    if (!hasActiveConnection()) {
      setConnectionUI(serial.state);
      log('串口设备尚未成功连接，不能开始记录', 'err');
      return;
    }
    state.riding ? stopRide() : startRide();
  });

  // Keep filename numbering persistent within each calendar day so repeated exports
  // receive a new default name, including when the page is reloaded.
  const memoryExportSequence = Object.create(null);
  function createDefaultLogFilename() {
    const now = new Date();
    const pad2 = value => String(value).padStart(2, '0');
    const dateStamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
    const timeStamp = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
    const storageKey = `dataLiveDashboardExportSequence-${dateStamp}`;
    let previous = 0;
    try {
      const stored = Number.parseInt(window.localStorage.getItem(storageKey) || '0', 10);
      if (Number.isFinite(stored) && stored > 0) previous = stored;
    } catch (_) {
      // localStorage can be unavailable in some browser profiles; memory fallback still works.
    }
    const sequence = Math.max(previous, memoryExportSequence[dateStamp] || 0) + 1;
    memoryExportSequence[dateStamp] = sequence;
    try { window.localStorage.setItem(storageKey, String(sequence)); } catch (_) {}
    return `日志_${dateStamp}_${timeStamp}_${String(sequence).padStart(3, '0')}.csv`;
  }

  elements.export.addEventListener('click', async () => {
    if (!hasActiveConnection()) {
      setConnectionUI(serial.state);
      log('串口设备尚未成功连接，不能导出 CSV', 'err');
      return;
    }
    const samples = state.session?.samples || [];
    if (!samples.length) { log('没有可导出的骑行记录，请先开始记录', 'err'); return; }
    if (typeof window.showSaveFilePicker !== 'function') {
      log('当前浏览器不支持文件保存窗口，请使用桌面版 Chrome/Edge，并通过 localhost 或 HTTPS 打开网页', 'err');
      return;
    }

    const headers = ['time_s', 'cadence', 'resistance', 'power_W', 'speed_kmh'];
    const lines = [headers.join(','), ...samples.map(sample => [sample.time_s, sample.cadence, sample.resistance, sample.power, sample.speed].join(','))];
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    let writable = null;
    try {
      // Call the picker directly from the click gesture so the browser can show its save dialog.
      const handle = await window.showSaveFilePicker({
        suggestedName: createDefaultLogFilename(),
        types: [{ description: 'CSV 文件', accept: { 'text/csv': ['.csv'] } }]
      });
      writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      writable = null;
      log(`CSV 已保存：${handle.name}（${samples.length} 条记录）`, 'ok');
    } catch (error) {
      if (writable) {
        try { await writable.abort(); } catch (_) {}
      }
      if (error?.name === 'AbortError') {
        log('已取消 CSV 保存');
      } else {
        log(`CSV 导出失败：${error?.message || error}`, 'err');
      }
    }
  });

  // CSV file selection and import
  // Use a real button and invoke the hidden input directly in the user gesture.
  elements.fileTrigger.addEventListener('click', event => {
    event.preventDefault();
    elements.fileInput.click();
  });
  // Reset the input after cancellation is not possible via change; clearing after a
  // successful load allows selecting the same file again later.

  elements.fileInput.addEventListener('change', () => {
    const file = elements.fileInput.files?.[0];
    if (!file) return;
    elements.fileInfo.textContent = `已选择文件：${file.name}（${(file.size / 1024).toFixed(1)} KB）`;
    elements.fileInfo.classList.add('success'); elements.fileDot.style.background = 'var(--good)'; elements.fileText.style.color = 'var(--good)';
  });
  elements.loadCsv.addEventListener('click', async () => {
    const file = elements.fileInput.files?.[0];
    if (!file) { log('请先选择 CSV 文件', 'err'); return; }
    if (file.size > 50 * 1024 * 1024) { log('CSV 文件超过 50 MB，请先拆分文件', 'err'); return; }
    try {
      const parsed = window.CsvUtils.parseCSV(await file.text());
      if (parsed.headers.length < 2) throw new Error('CSV 至少需要两列：时间列和一个数值列');
      state.csv = { ...parsed, labels: parsed.rows.map(row => row[0] ?? '') };
      populateColumnSelects();
      elements.fileText.textContent = 'CSV 已加载';
      elements.fileInfo.classList.add('success');
      elements.fileDot.style.background = 'var(--good)';
      elements.fileText.style.color = 'var(--good)';
      elements.fileInfo.textContent = `已加载：${file.name}，${parsed.rows.length} 行，${parsed.headers.length} 列`;
      elements.fileInput.value = ''; // 允许下次再次选择同一个文件
      log('CSV 加载完成', 'ok');
    } catch (error) { log(`CSV 加载失败：${error.message}`, 'err'); elements.fileInfo.textContent = `加载失败：${error.message}`; }
  });

  function populateColumnSelects() {
    const { headers } = state.csv;
    // 新文件可能比上一个文件短，清除旧的缩放区间，避免图表显示空白。
    state.analyticsCharts.forEach(chart => {
      delete chart.options.scales.x.min;
      delete chart.options.scales.x.max;
    });
    elements.selects.forEach((select, index) => {
      select.replaceChildren();
      for (let column = 1; column < headers.length; column++) {
        const option = document.createElement('option'); option.value = String(column); option.textContent = headers[column]; select.appendChild(option);
      }
      select.disabled = false;
      select.value = String(Math.min(index + 1, headers.length - 1));
      select.onchange = () => updateAnalyticsChart(index, Number(select.value));
      updateAnalyticsChart(index, Number(select.value));
    });
  }
  function updateAnalyticsChart(chartIndex, columnIndex) {
    if (!state.csv) return;
    const { headers, rows, labels } = state.csv;
    const chart = state.analyticsCharts[chartIndex];
    chart.data.labels = labels;
    chart.data.datasets[0].label = headers[columnIndex] || `列 ${columnIndex + 1}`;
    chart.data.datasets[0].data = rows.map(row => window.CsvUtils.parseFiniteNumber(row[columnIndex]));
    chart.update('none');
  }

  setConnectionUI('disconnected');
});
