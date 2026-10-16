/**
 * Data Live Dashboard - 串口数据解析、多图表光标联动与独立参数读写
 */
document.addEventListener('DOMContentLoaded', () => {
  const $ = (id) => document.getElementById(id);

  // 遥测界面元素
  const cadenceEl = $('cadence');
  const resistanceEl = $('resistance');
  const powerEl = $('power');
  const speedEl = $('speed');
  const elapsedEl = $('elapsed');
  const distanceEl = $('distance');
  const caloriesEl = $('calories');
  const avgPowerEl = $('avgPower');

  // 参数设置界面输入框元素 (2x4 网格)
  const maxCadenceEl = $('maxCadence');
  const maxResistanceEl = $('maxResistance');
  const maxPowerEl = $('maxPower');
  const maxSpeedEl = $('maxSpeed');
  const maxPhaseCurrentEl = $('maxPhaseCurrent');
  const maxBatteryCurrentEl = $('maxBatteryCurrent');
  const pwmFrequencyEl = $('pwmFrequency');
  const currentGainEl = $('currentGain');
  
  // 遥测控制面板元素
  const logEl = $('log');
  const statusDot = $('statusDot');
  const statusText = $('statusText');
  const connectBtn = $('connectBtn');
  const disconnectBtn = $('disconnectBtn');
  const toggleRideBtn = $('toggleRideBtn');
  const exportBtn = $('exportBtn');
  const baudRateSelect = $('baudRate');

  // 参数设置界面的面板同步元素
  const logEl2 = $('log2');
  const statusDot2 = $('statusDot2');
  const statusText2 = $('statusText2');
  const connectBtn2 = $('connectBtn2');
  const disconnectBtn2 = $('disconnectBtn2');
  const readParamsBtn = $('readParamsBtn');
  const writeParamsBtn = $('writeParamsBtn');
  const baudRateSelect2 = $('baudRate2');

  const tabButtons = document.querySelectorAll('.tab-btn');
  const pages = document.querySelectorAll('.page-container');

  // 数据分析界面元素
  const fileTriggerStatus = $('fileTriggerStatus');
  const fileStatusDot = $('fileStatusDot');
  const fileStatusText = $('fileStatusText');
  const csvFileInput = $('csvFileInput');
  const fileInfoText = $('fileInfoText');
  const loadCsvBtn = $('loadCsvBtn');
  
  const chart1Select = $('chart1Select');
  const chart2Select = $('chart2Select');
  const chart3Select = $('chart3Select');

  let csvParsedData = { xLabels: [], headers: [], rows: [] };

  // 垂直虚线光标联动插件
  const crosshairPlugin = {
    id: 'crosshairPlugin',
    afterDraw(chart) {
      if (chart.tooltip?._active && chart.tooltip._active.length) {
        const ctx = chart.ctx;
        const x = chart.tooltip._active[0].element.x;
        const topY = chart.scales.y.top;
        const bottomY = chart.scales.y.bottom;

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(x, topY);
        ctx.lineTo(x, bottomY);
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.restore();
      }
    }
  };

  // 初始化遥测速度曲线图表
  const speedCtx = document.getElementById('speedChart').getContext('2d');
  const speedChart = new Chart(speedCtx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: '速度 (km/h)',
        data: [],
        borderColor: '#00d2ff',
        borderWidth: 2,
        fill: false,
        tension: 0.3,
        pointRadius: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { 
        legend: { display: false },
        tooltip: { enabled: true, mode: 'index', intersect: false }
      },
      scales: {
        x: { 
          grid: { color: '#1f2730' }, 
          ticks: { color: '#7b8794', maxRotation: 0, maxTicksLimit: 10 },
          title: { display: true, text: '时间 (s)', color: '#7b8794', font: { size: 11 } }
        },
        y: { beginAtZero: true, suggestedMax: 25, ticks: { color: '#7b8794' }, grid: { color: '#1f2730' } },
      },
    },
    plugins: [crosshairPlugin],
  });

  const createAnalyticsLineChart = (canvasId, color) => {
    const ctx = document.getElementById(canvasId).getContext('2d');
    return new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{ label: '数值', data: [], borderColor: color, borderWidth: 2, fill: false, tension: 0.3, pointRadius: 0 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: { enabled: true, mode: 'index', intersect: false } },
        scales: {
          x: { grid: { color: '#1f2730' }, ticks: { color: '#7b8794', maxRotation: 0, maxTicksLimit: 10 }, title: { display: true, text: '时间 (s)', color: '#7b8794', font: { size: 11 } } },
          y: { beginAtZero: true, ticks: { color: '#7b8794' }, grid: { color: '#1f2730' } },
        },
      },
      plugins: [crosshairPlugin],
    });
  };

  const analyticsChart1 = createAnalyticsLineChart('analyticsChart1', '#00d2ff');
  const analyticsChart2 = createAnalyticsLineChart('analyticsChart2', '#4ade80');
  const analyticsChart3 = createAnalyticsLineChart('analyticsChart3', '#ff3347');
  const analyticsCharts = [analyticsChart1, analyticsChart2, analyticsChart3];

  analyticsCharts.forEach((chart, index) => {
    chart.canvas.addEventListener('mousemove', (e) => {
      const points = chart.getElementsAtEventForMode(e, 'index', { intersect: false }, true);
      if (points.length) {
        const dataIndex = points[0].index;
        analyticsCharts.forEach((otherChart, oIndex) => {
          if (oIndex !== index && otherChart.data.labels.length > dataIndex) {
            otherChart.tooltip.setActiveElements([{ datasetIndex: 0, index: dataIndex }]);
            otherChart.setActiveElements([{ datasetIndex: 0, index: dataIndex }]);
            otherChart.update('none');
          }
        });
      }
    });
    chart.canvas.addEventListener('mouseleave', () => {
      analyticsCharts.forEach((otherChart) => {
        otherChart.tooltip.setActiveElements([], { x: 0, y: 0 });
        otherChart.setActiveElements([]);
        otherChart.update('none');
      });
    });
  });

  if (!('serial' in navigator)) {
    $('unsupported').style.display = 'block';
    connectBtn.disabled = true;
    connectBtn2.disabled = true;
  }

  let port = null;
  let reader = null;
  let keepReading = false;
  let isRiding = false; 
  let connectedTime = null; 
  let buffer = new Uint8Array(0);

  let session = { startTime: null, samples: [], powerSum: 0, powerCount: 0, distanceKm: 0, calories: 0, lastSampleTime: null };
  let lastCadence = 0, lastResistance = 0, lastPower = 0, lastSpeed = 0;

  tabButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const targetId = button.getAttribute('data-target');
      tabButtons.forEach((btn) => btn.classList.remove('active'));
      button.classList.add('active');
      pages.forEach((page) => page.classList.toggle('active', page.id === targetId));
    });
  });

  if (fileTriggerStatus && csvFileInput) {
    fileTriggerStatus.addEventListener('click', () => csvFileInput.click());
    csvFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        fileInfoText.textContent = `已选择文件: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
        fileInfoText.classList.add('success');
        fileStatusDot.style.background = 'var(--good)';
        fileStatusText.style.color = 'var(--good)';
      }
    });
  }

  function updateAnalyticsChartColumn(chartIndex, colIndex) {
    if (csvParsedData.rows.length === 0) return;
    const chart = analyticsCharts[chartIndex];
    chart.data.labels = csvParsedData.xLabels;
    chart.data.datasets[0].label = csvParsedData.headers[colIndex] || `列 ${colIndex + 1}`;
    chart.data.datasets[0].data = csvParsedData.rows.map(row => parseFloat(row[colIndex]) || 0);
    chart.update();
  }

  chart1Select.addEventListener('change', (e) => updateAnalyticsChartColumn(0, parseInt(e.target.value, 10)));
  chart2Select.addEventListener('change', (e) => updateAnalyticsChartColumn(1, parseInt(e.target.value, 10)));
  chart3Select.addEventListener('change', (e) => updateAnalyticsChartColumn(2, parseInt(e.target.value, 10)));

  if (loadCsvBtn) {
    loadCsvBtn.addEventListener('click', () => {
      const file = csvFileInput.files[0];
      if (!file) { alert('请先选择 CSV 文件！'); return; }
      const readerObj = new FileReader();
      readerObj.onload = function(evt) {
        const lines = evt.target.result.split(/\r\n|\n/).filter(line => line.trim() !== '');
        if (lines.length < 2) return;
        const headers = lines[0].split(',').map(h => h.trim());
        csvParsedData.headers = headers;
        csvParsedData.xLabels = [];
        csvParsedData.rows = [];
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(',').map(c => c.trim());
          if (cols.length >= 2) {
            csvParsedData.xLabels.push(cols[0]);
            csvParsedData.rows.push(cols);
          }
        }
        let optionsHtml = '';
        for (let j = 1; j < headers.length; j++) optionsHtml += `<option value="${j}">${headers[j]}</option>`;
        [chart1Select, chart2Select, chart3Select].forEach(sel => { sel.innerHTML = optionsHtml; sel.disabled = false; });
        chart1Select.value = "1"; updateAnalyticsChartColumn(0, 1);
        chart2Select.value = headers.length >= 3 ? "2" : "1"; updateAnalyticsChartColumn(1, parseInt(chart2Select.value));
        chart3Select.value = headers.length >= 4 ? "3" : "1"; updateAnalyticsChartColumn(2, parseInt(chart3Select.value));
      };
      readerObj.readAsText(file);
    });
  }

  function log(msg, cls = '') {
    const ts = new Date().toLocaleTimeString();
    const htmlContent = `<span class="${cls}">[${ts}] ${msg}</span>`;
    logEl.innerHTML = htmlContent; logEl2.innerHTML = htmlContent;
    logEl.scrollTop = logEl.scrollHeight; logEl2.scrollTop = logEl2.scrollHeight;
  }

  async function handleConnect() {
    try {
      const selectedBaud = parseInt(baudRateSelect.value, 10);
      port = await navigator.serial.requestPort();
      await port.open({ baudRate: selectedBaud, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
      statusDot.classList.add('connected'); statusDot2.classList.add('connected');
      statusText.textContent = '已连接'; statusText2.textContent = '已连接';
      connectBtn.disabled = true; connectBtn2.disabled = true;
      disconnectBtn.disabled = false; disconnectBtn2.disabled = false;
      baudRateSelect.disabled = true; baudRateSelect2.disabled = true;
      log(`串口连接成功，波特率：${selectedBaud}`, 'ok');
      connectedTime = Date.now();
      speedChart.data.labels = []; speedChart.data.datasets[0].data = []; speedChart.update();
      keepReading = true; readLoop();
    } catch (e) { log('串口连接失败：' + e.message, 'err'); }
  }

  async function handleDisconnect() {
    keepReading = false;
    if (isRiding) { isRiding = false; toggleRideBtn.textContent = '开始记录'; toggleRideBtn.className = 'start-btn'; }
    if (reader) { try { await reader.cancel(); } catch (e) {} }
    if (port) { try { await port.close(); } catch (e) {} }
    port = null; reader = null; connectedTime = null;
    statusDot.classList.remove('connected'); statusDot2.classList.remove('connected');
    statusText.textContent = '未连接'; statusText2.textContent = '未连接';
    connectBtn.disabled = false; connectBtn2.disabled = false;
    disconnectBtn.disabled = true; disconnectBtn2.disabled = true;
    baudRateSelect.disabled = false; baudRateSelect2.disabled = false;
    log('串口设备已安全断开', 'err');
  }

  connectBtn.addEventListener('click', handleConnect);
  connectBtn2.addEventListener('click', handleConnect);
  disconnectBtn.addEventListener('click', handleDisconnect);
  disconnectBtn2.addEventListener('click', handleDisconnect);
  baudRateSelect.addEventListener('change', () => { baudRateSelect2.value = baudRateSelect.value; });
  baudRateSelect2.addEventListener('change', () => { baudRateSelect.value = baudRateSelect2.value; });

  toggleRideBtn.addEventListener('click', () => {
    if (!isRiding) {
      isRiding = true;
      session = { startTime: Date.now(), samples: [], powerSum: 0, powerCount: 0, distanceKm: 0, calories: 0, lastSampleTime: Date.now() };
      toggleRideBtn.textContent = '停止记录'; toggleRideBtn.className = 'stop-btn';
      log('骑行数据记录已开始...', 'ok');
    } else {
      isRiding = false;
      toggleRideBtn.textContent = '开始记录'; toggleRideBtn.className = 'start-btn';
      log('骑行数据记录已停止', 'err');
    }
  });

  async function handleReadParameters() {
    if (!port || !port.writable) { alert('请先连接串口设备！'); return; }
    try {
      const writer = port.writable.getWriter();
      await writer.write(new Uint8Array([0xf1, 0x60, 0x00, 0x00, 0xf6]));
      writer.releaseLock();
      log('已发送读取参数请求...', 'ok');
    } catch (e) { log('发送读取参数指令异常：' + e.message, 'err'); }
  }
  readParamsBtn.addEventListener('click', handleReadParameters);

  // 优化后的参数写入函数：逐个发送并加入延时，防止 USB 粘包
  async function handleWriteParameters() {
    if (!port || !port.writable) { alert('请先连接串口设备！'); return; }

    const params = [
      { type: 0x51, val: maxCadenceEl.value },
      { type: 0x52, val: maxResistanceEl.value },
      { type: 0x53, val: maxPowerEl.value },
      { type: 0x54, val: maxSpeedEl.value },
      { type: 0x55, val: maxPhaseCurrentEl.value },
      { type: 0x56, val: maxBatteryCurrentEl.value },
      { type: 0x57, val: pwmFrequencyEl.value },
      { type: 0x58, val: currentGainEl.value }
    ];

    try {
      const writer = port.writable.getWriter();
      
      for (const p of params) {
        const strVal = String(p.val);
        const digits = new Uint8Array(strVal.length);
        let sum = 0;
        for (let i = 0; i < strVal.length; i++) {
          digits[i] = strVal.charCodeAt(i);
          sum = (sum + digits[i]) & 0xff;
        }

        const frame = new Uint8Array(3 + digits.length + 1);
        frame[0] = 0xf1;
        frame[1] = p.type;
        frame[2] = digits.length;
        frame.set(digits, 3);
        frame[3 + digits.length] = sum;
        frame[4 + digits.length] = 0xf6;

        await writer.write(frame);
        // 每次发送后暂停 20ms，确保单片机有充足时间解析，防止 USB 粘包
        await new Promise(resolve => setTimeout(resolve, 20));
      }

      writer.releaseLock();
      log('成功将参数写入单片机！', 'ok');
    } catch (e) {
      log('参数写入异常：' + e.message, 'err');
    }
  }
  writeParamsBtn.addEventListener('click', handleWriteParameters);

  async function readLoop() {
    while (port && port.readable && keepReading) {
      reader = port.readable.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) ingest(value);
        }
      } catch (e) { log('读取异常：' + e.message, 'err'); }
      finally { reader.releaseLock(); reader = null; }
    }
  }

  function ingest(chunk) {
    const merged = new Uint8Array(buffer.length + chunk.length);
    merged.set(buffer, 0); merged.set(chunk, buffer.length);
    buffer = merged;
    let start = -1;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] === 0xf1) start = i;
      else if (buffer[i] === 0xf6 && start !== -1) {
        parseFrame(buffer.slice(start + 1, i));
        start = -1;
      }
    }
    if (start !== -1) buffer = buffer.slice(start);
    else if (buffer.length > 256) buffer = buffer.slice(buffer.length - 64);
  }

  // 修复后的标准帧解析函数：支持整数、浮点数以及字符串正确解析
  function parseFrame(frame) {
    if (frame.length < 3) return;
    const type = frame[0];
    const len = frame[1];
    if (frame.length < 2 + len + 1) return;

    const digits = frame.slice(2, 2 + len);
    const checksum = frame[2 + len];

    let sum = 0;
    for (const b of digits) sum = (sum + b) & 0xff;
    if (sum !== checksum) return;

    const strVal = String.fromCharCode(...digits);
    const numVal = parseFloat(strVal);
    if (isNaN(numVal)) return;

    if (type === 0x41) { lastCadence = numVal; cadenceEl.textContent = numVal; handleIncomingData(); }
    else if (type === 0x44) { lastResistance = Math.max(0, Math.min(100, numVal)); resistanceEl.textContent = lastResistance; handleIncomingData(); }
    else if (type === 0x42) { lastSpeed = numVal; speedEl.textContent = numVal.toFixed(1); handleIncomingData(); }
    else if (type === 0x4a) { lastPower = numVal; powerEl.textContent = Math.round(numVal); handleIncomingData(); }
    // 回显单片机传来的参数
    else if (type === 0x51) maxCadenceEl.value = numVal;
    else if (type === 0x52) maxResistanceEl.value = numVal;
    else if (type === 0x53) maxPowerEl.value = numVal;
    else if (type === 0x54) maxSpeedEl.value = numVal.toFixed(1);
    else if (type === 0x55) maxPhaseCurrentEl.value = numVal;
    else if (type === 0x56) maxBatteryCurrentEl.value = numVal;
    else if (type === 0x57) pwmFrequencyEl.value = numVal;
    else if (type === 0x58) currentGainEl.value = numVal;
  }

  function handleIncomingData() {
    if (!connectedTime) return;
    const now = Date.now();
    const relativeSecs = Math.floor((now - connectedTime) / 1000);
    const timeLabel = `${Math.floor(relativeSecs / 60)}:${String(relativeSecs % 60).padStart(2, '0')}`;

    if (!speedChart._lastChartUpdate || now - speedChart._lastChartUpdate > 250) {
      speedChart.data.labels.push(timeLabel);
      speedChart.data.datasets[0].data.push(lastSpeed);
      if (speedChart.data.labels.length > 1200) {
        speedChart.data.labels.shift(); speedChart.data.datasets[0].data.shift();
      }
      speedChart.update();
      speedChart._lastChartUpdate = now;
    }

    if (isRiding && session.startTime) {
      const t = (now - session.startTime) / 1000;
      const lastSample = session.samples[session.samples.length - 1];
      if (!lastSample || t - lastSample.t >= 0.25) {
        session.samples.push({ t: +t.toFixed(2), cadence: lastCadence, resistance: lastResistance, power: +lastPower.toFixed(1), speed: lastSpeed });
        session.powerSum += lastPower; session.powerCount += 1;
        const dt = (now - session.lastSampleTime) / 1000 / 3600;
        session.lastSampleTime = now;
        session.distanceKm += lastSpeed * dt;
        session.calories += ((lastPower * (dt * 3600)) / 3600) * 3.6;
        updateTotals();
      }
    }
  }

  function updateTotals() {
    if (!session.startTime) return;
    const elapsed = Math.floor((Date.now() - session.startTime) / 1000);
    elapsedEl.textContent = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
    distanceEl.textContent = session.distanceKm.toFixed(2) + ' km';
    caloriesEl.textContent = Math.round(session.calories);
    avgPowerEl.textContent = Math.round(session.powerCount > 0 ? session.powerSum / session.powerCount : 0) + ' W';
  }

  setInterval(() => { if (isRiding && session.startTime) updateTotals(); }, 1000);
});