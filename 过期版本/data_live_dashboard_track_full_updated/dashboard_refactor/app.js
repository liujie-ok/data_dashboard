/**
 * Data Live Dashboard 前端主控制器。
 *
 * 职责：
 * 1. 将 HTML 控件、串口管理器、通信协议解析器和图表连接起来。
 * 2. 更新实时遥测值，并按照固定周期计算记录数据。
 * 3. 管理串口连接状态、参数读写、CSV 导出与 CSV 文件分析。
 *
 * 串口生命周期由 serial-manager.js 管理；帧格式由 protocol.js 管理；
 * CSV 文本解析由 csv-utils.js 管理。这里仅负责界面和业务流程。
 */
document.addEventListener('DOMContentLoaded', () => {
  'use strict';
  // 统一的 DOM 查询简写，传入 HTML 元素的 id。
  const $ = id => document.getElementById(id);
  const serial = new window.SerialManager();
  // 帧解析器完成一帧后调用 handleFrame；遇到损坏帧时写入错误日志。
  const parser = new window.SerialProtocol.FrameParser(
    frame => handleFrame(frame),
    message => log(message, 'err')
  );

  // 集中保存页面中会被脚本访问的控件，避免在业务代码中反复查找 DOM。
  const elements = {
    cadence: $('cadence'),
    resistance: $('resistance'),
    power: $('power'),
    speed: $('speed'),
    elapsed: $('elapsed'),
    distance: $('distance'),
    energy: $('calories'),
    avgPower: $('avgPower'),
    log: $('log'),
    log2: $('log2'),
    log3: $('log3'),
    statusDot: $('statusDot'),
    statusDot2: $('statusDot2'),
    statusDot3: $('statusDot3'),
    statusText: $('statusText'),
    statusText2: $('statusText2'),
    statusText3: $('statusText3'),
    connect: $('connectBtn'),
    connect2: $('connectBtn2'),
    connect3: $('connectBtn3'),
    disconnect: $('disconnectBtn'),
    disconnect2: $('disconnectBtn2'),
    disconnect3: $('disconnectBtn3'),
    baud: $('baudRate'),
    baud2: $('baudRate2'),
    baud3: $('baudRate3'),
    ride: $('toggleRideBtn'),
    rideTrack: $('toggleRideBtn3'),
    export: $('exportBtn'),
    exportTrack: $('exportBtn3'),
    unsupported: $('unsupported'),
    fileTrigger: $('fileTriggerStatus'),
    fileDot: $('fileStatusDot'),
    fileText: $('fileStatusText'),
    fileInput: $('csvFileInput'),
    fileInfo: $('fileInfoText'),
    loadCsv: $('loadCsvBtn'),
    selects: [
      $('chart1Select'),
      $('chart2Select'),
      $('chart3Select')
    ],
    // 赛道页文件加载、路线画布和实时曲线控件。
    trackFileInput: $('trackFileInput'),
    loadTrack: $('loadTrackBtn'),
    trackFileStatus: $('trackFileStatus'),
    trackCanvas: $('trackCanvas'),
    trackEmptyState: $('trackEmptyState'),
    trackPositionReadout: $('trackPositionReadout'),
    trackSeriesSelect: $('trackSeriesSelect'),
    // 参数 ID 和类型编号与 Pico 2 测试固件 main.c 中的表格一一对应。
    // min/max/integer 是浏览器侧基础校验，设备固件仍必须独立进行安全校验。
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

  // 前端运行状态：遥测数据、连接时间、当前记录会话和图表实例。
  const state = {
    telemetry: {
      cadence: 0,
      resistance: 0,
      power: 0,
      speed: 0
    },
    // 设备附加数据：高度单位 m，经纬度单位为十进制度。
    position: { altitude: null, latitude: null, longitude: null, lastPositionAt: 0 },
    lastTelemetryAt: 0,
    connectedAt: 0,
    riding: false,
    session: null,
    csv: null,
    analyticsCharts: [],
    speedChart: null,
    trackChart: null,
    trackRoute: null,
    trackHistory: []
  };

  /** 将操作结果同时显示在两个页面共用的状态日志中。 */
  function log(message, cls = '') {
    const timestamp = new Date().toLocaleTimeString();
    [elements.log, elements.log2, elements.log3].filter(Boolean).forEach(node => {
      node.replaceChildren();
      const span = document.createElement('span');
      if (cls === 'ok' || cls === 'err') span.className = cls;
      span.textContent = `[${timestamp}] ${message}`;
      node.appendChild(span);
      node.scrollTop = node.scrollHeight;
    });
  }

  /** 同时检查串口状态机和读写流，防止仅凭界面状态误判为已连接。 */
  function hasActiveConnection() {
    return serial.state === 'connected' && serial.connected;
  }

  /** 根据串口状态同步更新指示灯、连接按钮及记录/导出按钮。 */
  function setConnectionUI(status) {
    // 不能只相信界面事件：串口管理器状态和读写流必须都仍然有效，才开放数据操作。
    const connected = status === 'connected' && hasActiveConnection();
    const busy = status === 'connecting' || status === 'disconnecting';

    [elements.statusDot, elements.statusDot2, elements.statusDot3].filter(Boolean).forEach(dot => {
      dot.classList.toggle('connected', connected);
    });
    [elements.statusText, elements.statusText2, elements.statusText3].filter(Boolean).forEach(text => {
      text.textContent = connected ? '已连接' : busy ? '连接处理中' : '未连接';
    });
    [elements.connect, elements.connect2, elements.connect3].forEach(button => {
      button.disabled = connected || busy || !('serial' in navigator);
    });
    [elements.disconnect, elements.disconnect2, elements.disconnect3].forEach(button => {
      button.disabled = !connected;
    });
    [elements.baud, elements.baud2, elements.baud3].forEach(select => {
      select.disabled = connected || busy;
    });

    // 遥测页和赛道页共用同一段记录会话；连接成功后，两页的按钮同步启用。
    [elements.ride, elements.rideTrack].forEach(button => {
      button.disabled = !connected;
      button.title = connected ? '开始或停止记录' : '请先成功连接串口设备';
    });
    [elements.export, elements.exportTrack].forEach(button => {
      button.disabled = !connected;
      button.title = connected ? '导出当前记录 CSV' : '请先成功连接串口设备';
    });
  }

  serial.addEventListener('statechange', event => {
    if (event.detail !== 'connected') stopRide(false);
    setConnectionUI(event.detail);
  });
  serial.addEventListener('data', event => parser.push(event.detail));
  serial.addEventListener('error', event => {
    log(`串口读取异常：${event.detail?.message || event.detail}`, 'err');
    // 如果用户直接拔掉 USB 设备，读取循环可能先于手动断开操作报错。
    if (serial.state === 'connected' && !serial.connected) {
      stopRide(false);
      void serial.disconnect().catch(() => {});
    }
  });

  if (!('serial' in navigator)) {
    elements.unsupported.style.display = 'block';
    setConnectionUI('disconnected');
  }

  // -----------------------------------------------------------------------
  // 图表初始化与鼠标交互
  // -----------------------------------------------------------------------
  // 鼠标悬停到数据点时绘制垂直辅助线，便于对齐读取当前横坐标。
  const crosshairPlugin = {
    id: 'dashboardCrosshair',
    afterDraw(chart) {
      const active = chart.tooltip?.getActiveElements?.() || [];
      if (!active.length || !chart.scales?.y) return;
      const x = active[0].element.x;
      const ctx = chart.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x, chart.scales.y.top);
      ctx.lineTo(x, chart.scales.y.bottom);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,255,255,.4)';
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.restore();
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
      const max = Number.isFinite(chart.options.scales.x.max)
        ? chart.options.scales.x.max
        : Math.max(0, count - 1);
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
      // Chart.js 使用 CSS 像素坐标，不应再按 canvas.width / rect.width 放大。
      // 否则在高 DPI 屏幕上，鼠标滚轮的缩放锚点会产生偏移。
      const pixelX = event.clientX - rect.left;
      const anchorValue = chart.scales.x.getValueForPixel(pixelX);
      const anchor = Number.isFinite(anchorValue)
        ? Math.max(min, Math.min(max, anchorValue))
        : (min + max) / 2;
      const factor = event.deltaY < 0 ? 0.8 : 1.25;
      const nextSpan = Math.max(2, Math.min(chart.data.labels.length - 1, currentSpan * factor));
      const ratio = currentSpan > 0 ? (anchor - min) / currentSpan : 0.5;
      let nextMin = anchor - nextSpan * ratio;
      let nextMax = nextMin + nextSpan;
      if (nextMin < 0) {
        nextMax -= nextMin;
        nextMin = 0;
      }
      if (nextMax > chart.data.labels.length - 1) {
        nextMin -= nextMax - (chart.data.labels.length - 1);
        nextMax = chart.data.labels.length - 1;
      }
      applyRange(nextMin, nextMax);
    }, { passive: false });

    let dragStart = null;
    let dragCurrent = null;
    canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !chart.chartArea) return;
      const rect = canvas.getBoundingClientRect();
      // 鼠标坐标和 chart.chartArea 必须统一使用 CSS 像素坐标系。
      const x = event.clientX - rect.left;
      if (x < chart.chartArea.left || x > chart.chartArea.right) return;
      dragStart = x;
      dragCurrent = x;
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
      const start = dragStart;
      const end = dragCurrent;
      dragStart = null;
      dragCurrent = null;
      chart.$mouseZoomDrag = null;
      if (Math.abs(end - start) > 12) {
        const a = chart.scales.x.getValueForPixel(Math.min(start, end));
        const b = chart.scales.x.getValueForPixel(Math.max(start, end));
        if (Number.isFinite(a) && Number.isFinite(b)) {
          applyRange(a, b);
        } else {
          chart.draw();
        }
      } else {
        chart.draw();
      }
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

  // 拖动时在图表上绘制半透明选区，帮助用户确认即将放大的横轴范围。
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
      const selectionWidth = right - left;
      const selectionHeight = chart.chartArea.bottom - chart.chartArea.top;
      ctx.fillRect(left, chart.chartArea.top, selectionWidth, selectionHeight);
      ctx.strokeRect(left, chart.chartArea.top, selectionWidth, selectionHeight);
      ctx.restore();
    }
  };

  /** 返回实时图和分析图共用的基础选项，统一字体、网格、提示框和坐标轴。 */
  const chartOptions = () => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: { enabled: true, mode: 'index', intersect: false }
    },
    layout: { padding: { top: 4, right: 10, bottom: 4, left: 4 } },
    scales: {
      x: {
        min: undefined,
        grid: { color: '#1f2730' },
        ticks: {
          color: '#7b8794',
          font: { size: 9 },
          padding: 3,
          autoSkip: true,
          maxTicksLimit: 5,
          maxRotation: 0,
          minRotation: 0,
          callback(value) {
            const label = String(this.getLabelForValue(value) ?? '');
            // 图表高度较小时缩短过长时间标签，避免横轴标签拥挤。
            return label.length > 12 ? label.slice(-8) : label;
          }
        },
        title: {
          display: true,
          text: '时间',
          color: '#7b8794',
          font: { size: 10 },
          padding: { top: 2, bottom: 0 }
        }
      },
      y: {
        beginAtZero: true,
        afterFit(scale) {
          scale.width = Math.min(scale.width, 54);
        },
        ticks: {
          color: '#7b8794',
          font: { size: 9 },
          padding: 3,
          maxTicksLimit: 6,
          callback(value) {
            if (typeof value !== 'number') return value;
            return new Intl.NumberFormat('zh-CN', {
              maximumFractionDigits: 2,
              notation: 'compact'
            }).format(value);
          }
        },
        grid: { color: '#1f2730' }
      }
    }
  });

  // 实时图表：只显示速度，横轴标签为从连接成功开始经过的时间。
  state.speedChart = new Chart($('speedChart').getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: '速度 (km/h)',
        data: [],
        borderColor: '#00d2ff',
        borderWidth: 2,
        fill: false,
        tension: 0.2,
        pointRadius: 0
      }]
    },
    options: {
      ...chartOptions(),
      scales: {
        ...chartOptions().scales,
        y: { ...chartOptions().scales.y, suggestedMax: 25 },
        x: {
          ...chartOptions().scales.x,
          title: { display: true, text: '时间 (分:秒)', color: '#7b8794' }
        }
      }
    },
    plugins: [crosshairPlugin, mouseZoomSelectionPlugin]
  });
  installMouseZoom(state.speedChart);

  // 赛道页底部实时曲线：通过下拉框选择高度或遥测字段；时间轴使用 MM:SS.cc。
  state.trackChart = new Chart($('trackDataChart').getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: '速度（km/h）',
        data: [],
        borderColor: '#00d2ff',
        borderWidth: 1.8,
        fill: false,
        tension: 0.15,
        pointRadius: 0,
        spanGaps: false
      }]
    },
    options: {
      ...chartOptions(),
      layout: { padding: { top: 1, right: 8, bottom: 0, left: 1 } },
      scales: {
        ...chartOptions().scales,
        x: {
          ...chartOptions().scales.x,
          title: { display: false, text: '' },
          ticks: { ...chartOptions().scales.x.ticks, maxTicksLimit: 6, font: { size: 8 } }
        },
        y: {
          ...chartOptions().scales.y,
          ticks: { ...chartOptions().scales.y.ticks, maxTicksLimit: 4, font: { size: 8 } }
        }
      }
    },
    plugins: [crosshairPlugin, mouseZoomSelectionPlugin]
  });
  installMouseZoom(state.trackChart);
  elements.trackSeriesSelect.addEventListener('change', updateTrackChartSeries);

  // 三张分析图使用不同颜色，便于同时查看多组曲线。
  const chartColors = ['#00d2ff', '#4ade80', '#ff3347'];
  state.analyticsCharts = ['analyticsChart1', 'analyticsChart2', 'analyticsChart3'].map((id, index) =>
    new Chart($(id).getContext('2d'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: '数值',
          data: [],
          borderColor: chartColors[index],
          borderWidth: 2,
          fill: false,
          tension: 0.2,
          pointRadius: 0
        }]
      },
      options: chartOptions(),
      plugins: [crosshairPlugin, mouseZoomSelectionPlugin]
    })
  );
  // 分析页将三张图注册到同一个同步组，任一图缩放时其他图使用相同索引范围。
  state.analyticsCharts.forEach(chart => installMouseZoom(chart, state.analyticsCharts));

  // 使用 requestAnimationFrame 合并鼠标移动事件，避免高频重绘占用过多 CPU。
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
        other.tooltip.setActiveElements([]);
        other.setActiveElements([]);
        other.update('none');
      });
    });
  });

  // -----------------------------------------------------------------------
  // 页面切换：切换后主动调整图表尺寸，避免隐藏容器造成画布尺寸错误。
  // -----------------------------------------------------------------------
  document.querySelectorAll('.tab-btn').forEach(button => button.addEventListener('click', () => {
    const target = button.dataset.target;
    document.querySelectorAll('.tab-btn').forEach(item => item.classList.toggle('active', item === button));
    document.querySelectorAll('.page-container').forEach(page => {
      page.classList.toggle('active', page.id === target);
    });
    state.analyticsCharts.forEach(chart => chart.resize());
    state.speedChart.resize();
    state.trackChart.resize();
    if (target === 'trackPage') drawTrack();
  }));

  // -----------------------------------------------------------------------
  // 串口连接、断开和参数读写事件
  // -----------------------------------------------------------------------
  // 参数页和遥测页显示相同波特率，修改任意一处都会同步另一处。
  [elements.baud, elements.baud2, elements.baud3].forEach(source => {
    source.addEventListener('change', () => {
      [elements.baud, elements.baud2, elements.baud3].forEach(target => {
        target.value = source.value;
      });
    });
  });
  [elements.connect, elements.connect2, elements.connect3].forEach(button => button.addEventListener('click', async () => {
    try {
      parser.reset();
      await serial.connect(Number(elements.baud.value));
      state.connectedAt = Date.now();
      state.lastTelemetryAt = 0;
      // 重连时清除旧坐标，只有本次连接收到新的 GPS 帧后才重新标记设备位置。
      state.position = { altitude: null, latitude: null, longitude: null, lastPositionAt: 0 };
      updateTrackPositionReadout();
      setConnectionUI(serial.state);
      state.speedChart.data.labels = [];
      state.speedChart.data.datasets[0].data = [];
      state.speedChart.update('none');
      // 每次新连接开启一段新的赛道实时曲线历史；位置数据由新到达的帧逐步刷新。
      state.trackHistory = [];
      state.trackChart.data.labels = [];
      state.trackChart.data.datasets[0].data = [];
      state.trackChart.update('none');
      log(`串口连接成功，波特率：${elements.baud.value}`, 'ok');
    } catch (error) {
      log(`串口连接失败：${error.message}`, 'err');
    }
  }));
  [elements.disconnect, elements.disconnect2, elements.disconnect3].forEach(button => button.addEventListener('click', async () => {
    try {
      await serial.disconnect();
      stopRide(false);
      parser.reset();
      log('串口设备已断开', 'ok');
    } catch (error) {
      log(`断开串口时出现问题：${error.message}`, 'err');
    }
  }));

  $('readParamsBtn').addEventListener('click', async () => {
    try {
      await serial.write(window.SerialProtocol.encodeReadParametersRequest());
      log('已发送读取参数请求', 'ok');
    } catch (error) {
      log(`读取参数请求发送失败：${error.message}`, 'err');
    }
  });

  $('writeParamsBtn').addEventListener('click', async () => {
    const values = [];
    for (const definition of elements.params) {
      const input = $(definition.id);
      const value = input.valueAsNumber;
      const isEmpty = !input.value.trim();
      const isNotFinite = !Number.isFinite(value);
      const isBelowMinimum = value < definition.min;
      const isAboveMaximum = definition.max !== undefined && value > definition.max;
      const mustBeInteger = definition.integer && !Number.isInteger(value);

      if (isEmpty || isNotFinite || isBelowMinimum || isAboveMaximum || mustBeInteger) {
        input.focus();
        log(`参数“${input.closest('.metric')?.querySelector('.label')?.textContent || definition.id}”不合法`, 'err');
        return;
      }
      values.push({ ...definition, value: input.value.trim() });
    }
    try {
      for (const item of values) {
        await serial.write(window.SerialProtocol.encodeParameter(item.type, item.value));
        // 该间隔是为了兼容处理速度较慢的旧固件，不是解决 USB 数据粘连的必要条件。
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      log('参数写入帧已发送，请确认设备是否回显/应答', 'ok');
    } catch (error) {
      log(`参数写入失败：${error.message}`, 'err');
    }
  });

  /** 将已通过帧校验的数据分发到实时指标或参数输入框。
   * 设备协议中的数值载荷采用 ASCII 数字字符串。
   */
  function handleFrame(frame) {
    const value = window.SerialProtocol.parseNumericPayload(frame.payload);
    if (frame.type === 0x60) return; // 读取参数命令允许使用空载荷；此类型不更新遥测或参数控件。
    if (value === null) { log(`忽略无效数据帧，类型 0x${frame.type.toString(16)}`, 'err'); return; }
    // 协议类型到界面状态字段的映射，必须与 Pico 固件发送的类型一致。
    const telemetryMap = { 0x41: 'cadence', 0x44: 'resistance', 0x42: 'speed', 0x4A: 'power' };
    const field = telemetryMap[frame.type];
    if (field) {
      let safeValue = value;
      if (field === 'resistance') safeValue = Math.max(0, Math.min(100, value));
      if (field === 'cadence' || field === 'speed') safeValue = Math.max(0, value);
      state.telemetry[field] = safeValue;
      state.lastTelemetryAt = Date.now();
      const display = {
        cadence: String(Math.round(state.telemetry.cadence)),
        resistance: String(Math.round(state.telemetry.resistance)),
        power: String(Math.round(state.telemetry.power)),
        speed: state.telemetry.speed.toFixed(1)
      };
      elements[field].textContent = display[field];
      return;
    }

    // 可选扩展帧：0x45=设备高度(m)，0x46=纬度，0x47=经度。
    // 如果实际设备使用不同类型编号，只需调整这里与 Pico 测试固件中的协议约定。
    if (frame.type === 0x45) {
      state.position.altitude = value;
      state.lastTelemetryAt = Date.now();
      updateTrackPositionReadout();
      return;
    }
    if (frame.type === 0x46) {
      if (value >= -90 && value <= 90) state.position.latitude = value;
      state.position.lastPositionAt = Date.now();
      state.lastTelemetryAt = Date.now();
      updateTrackPositionReadout();
      drawTrack();
      return;
    }
    if (frame.type === 0x47) {
      if (value >= -180 && value <= 180) state.position.longitude = value;
      state.position.lastPositionAt = Date.now();
      state.lastTelemetryAt = Date.now();
      updateTrackPositionReadout();
      drawTrack();
      return;
    }
    const parameter = elements.params.find(item => item.type === frame.type);
    if (parameter) $(parameter.id).value = parameter.id === 'maxSpeed' ? value.toFixed(1) : String(value);
  }

  // -----------------------------------------------------------------------
  // 定时采样与骑行数据统计
  // 使用固定时间间隔采样，避免统计结果依赖设备发送数据包的频率。
  // -----------------------------------------------------------------------
  // 实时曲线最多保留 1200 个点；超出后批量删除旧点以控制内存。
  const MAX_LIVE_POINTS = 1200;
  let lastChartAt = 0;
  let lastSampleAt = 0;
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
        const minutes = Math.floor(elapsedSeconds / 60);
      const seconds = String(elapsedSeconds % 60).padStart(2, '0');
      const label = `${minutes}:${seconds}`;
        state.speedChart.data.labels.push(label);
        state.speedChart.data.datasets[0].data.push(state.telemetry.speed);
        if (state.speedChart.data.labels.length > MAX_LIVE_POINTS) {
          state.speedChart.data.labels.splice(0, 100);
          state.speedChart.data.datasets[0].data.splice(0, 100);
        }
        state.speedChart.update('none');
        lastChartAt = now;
      }
      // 赛道曲线独立于“开始记录”按钮：只要串口持续有实时数据，就以 250 ms 采样。
      if (age < 2000 && serial.state === 'connected' && now - (state.trackHistory.length ? state.trackHistory[state.trackHistory.length - 1].stamp : 0) >= 250) {
        const elapsed = (now - state.connectedAt) / 1000;
        state.trackHistory.push({
          stamp: now,
          time_s: elapsed,
          label: formatCsvTime(elapsed),
          altitude: Number.isFinite(state.position.altitude) ? state.position.altitude : null,
          cadence: state.telemetry.cadence,
          resistance: state.telemetry.resistance,
          power: state.telemetry.power,
          speed: state.telemetry.speed
        });
        if (state.trackHistory.length > MAX_LIVE_POINTS) state.trackHistory.splice(0, 100);
        updateTrackChartSeries();
      }
    }
    if (state.riding && state.session) sampleRide(now);
    if (state.riding && state.session) updateTotals(now);
  }, 250);

  /** 采集当前遥测值，并使用梯形积分法累计距离与能量。 */
  function sampleRide(now) {
    const session = state.session;
    const elapsed = (now - session.startTime) / 1000;
    const dtSeconds = Math.max(0, (now - lastSampleAt) / 1000);
    const fresh = state.lastTelemetryAt && now - state.lastTelemetryAt < 2000;
    const speed = fresh ? state.telemetry.speed : 0;
    const power = fresh ? state.telemetry.power : 0;
    // 使用梯形积分：速度 (km/h) × 时间 (h) 得到距离 (km)；功率 (W) × 时间 (h) 得到能量 (Wh)。
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
      // 内部统一保存秒数（保留 0.01 s），仅在导出时转换成分:秒.百分秒字符串。
      session.samples.push({
        time_s: Number(elapsed.toFixed(2)),
        cadence: state.telemetry.cadence,
        resistance: state.telemetry.resistance,
        power: state.telemetry.power,
        speed: state.telemetry.speed
      });
    }
  }

  /** 将当前记录的运行时间、距离、能耗和平均功率刷新到统计卡片。 */
  function updateTotals(now = Date.now()) {
    const session = state.session;
    if (!session) return;
    const elapsed = Math.floor((now - session.startTime) / 1000);
    const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const seconds = String(elapsed % 60).padStart(2, '0');
    elements.elapsed.textContent = `${minutes}:${seconds}`;
    elements.distance.textContent = `${session.distanceKm.toFixed(3)} km`;
    elements.energy.textContent = `${session.energyWh.toFixed(2)} Wh`;
    const averagePower = session.validSeconds > 0 ? session.powerIntegralWh / (session.validSeconds / 3600) : 0;
    elements.avgPower.textContent = `${Math.round(averagePower)} W`;
  }

  /** 开始一段新的记录会话；未建立有效串口连接时不允许启动。 */
  function startRide() {
    if (!hasActiveConnection()) {
      setConnectionUI(serial.state);
      log('串口设备尚未成功连接，不能开始记录', 'err');
      return;
    }
    const now = Date.now();
    state.session = {
      startTime: now,
      samples: [],
      distanceKm: 0,
      energyWh: 0,
      powerIntegralWh: 0,
      validSeconds: 0,
      previousSpeed: state.telemetry.speed,
      previousPower: state.telemetry.power
    };
    state.riding = true;
    lastSampleAt = now;
    [elements.ride, elements.rideTrack].forEach(button => {
      button.textContent = '停止记录';
      button.classList.remove('start-btn');
      button.classList.add('stop-btn');
    });
    log('骑行数据记录已开始', 'ok');
  }
  /** 停止当前记录，但保留已采集的样本，供用户导出 CSV。 */
  function stopRide(logMessage = true) {
    if (state.riding) {
      state.riding = false;
      [elements.ride, elements.rideTrack].forEach(button => {
        button.textContent = '开始记录';
        button.classList.remove('stop-btn');
        button.classList.add('start-btn');
      });
      if (logMessage) log('骑行数据记录已停止', 'ok');
    }
  }
  /** 两个页面的“开始/停止记录”按钮控制同一个记录会话。 */
  [elements.ride, elements.rideTrack].forEach(button => button.addEventListener('click', () => {
    if (!hasActiveConnection()) {
      setConnectionUI(serial.state);
      log('串口设备尚未成功连接，不能开始记录', 'err');
      return;
    }
    state.riding ? stopRide() : startRide();
  }));

  // -----------------------------------------------------------------------
  // CSV 导出：生成防重文件名，并将内部秒数格式化为 MM:SS.cc。
  // 序号保存在 localStorage，页面刷新后仍可继续递增；不可用时退回内存计数。
  // -----------------------------------------------------------------------
  const memoryExportSequence = Object.create(null);

  /**
   * 将秒数转换为 MM:SS.cc 格式。
   * 示例：0 -> 00:00.00，65.37 -> 01:05.37。
   * cc 表示百分之一秒；先换算为整数百分秒，避免浮点运算导致进位错误。
   */
  function formatCsvTime(seconds) {
    const centiseconds = Math.max(0, Math.round(Number(seconds) * 100));
    const totalSeconds = Math.floor(centiseconds / 100);
    const minutes = Math.floor(totalSeconds / 60);
    const secondPart = totalSeconds % 60;
    const centisecondPart = centiseconds % 100;

    const minuteText = String(minutes).padStart(2, '0');
    const secondText = String(secondPart).padStart(2, '0');
    const centisecondText = String(centisecondPart).padStart(2, '0');
    return `${minuteText}:${secondText}.${centisecondText}`;
  }

  /** 生成“日志_日期_时间_编号.csv”，编号按日期持久化以降低覆盖风险。 */
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
      // 部分浏览器配置可能禁用 localStorage；此时仍可使用内存计数器避免本次页面内重复。
    }
    const sequence = Math.max(previous, memoryExportSequence[dateStamp] || 0) + 1;
    memoryExportSequence[dateStamp] = sequence;
    try { window.localStorage.setItem(storageKey, String(sequence)); } catch (_) {}
    return `日志_${dateStamp}_${timeStamp}_${String(sequence).padStart(3, '0')}.csv`;
  }

  async function exportCsv() {
    if (!hasActiveConnection()) {
      setConnectionUI(serial.state);
      log('串口设备尚未成功连接，不能导出 CSV', 'err');
      return;
    }
    const samples = state.session?.samples || [];
    if (!samples.length) {
      log('没有可导出的骑行记录，请先开始记录', 'err');
      return;
    }
    if (typeof window.showSaveFilePicker !== 'function') {
      log('当前浏览器不支持文件保存窗口，请使用桌面版 Chrome/Edge，并通过 localhost 或 HTTPS 打开网页', 'err');
      return;
    }

    // 第一列直接导出为可读时间字符串，格式固定为 MM:SS.cc（分:秒.百分秒）。
    // 例如 12.34 秒写为 00:12.34；时间列是文本，图表导入时将其用作 X 轴标签。
    // 表头使用稳定的机器可读标识；时间列为字符串，其余列为数值。
    const headers = ['time_mm_ss_cs', 'cadence', 'resistance', 'power_W', 'speed_kmh'];
    const lines = [
      headers.join(','),
      ...samples.map(sample => [
        formatCsvTime(sample.time_s),
        sample.cadence,
        sample.resistance,
        sample.power,
        sample.speed
      ].join(','))
    ];
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    let writable = null;
    try {
      // 必须直接在用户点击事件中调用保存文件 API，浏览器才会允许弹出保存窗口。
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
  }
  // 遥测页与赛道页的导出按钮调用同一函数，共享当前记录样本和默认文件命名规则。
  [elements.export, elements.exportTrack].forEach(button => button.addEventListener('click', exportCsv));

  // -----------------------------------------------------------------------
  // CSV 文件选择、加载、校验，以及分析图表列选择器的初始化
  // -----------------------------------------------------------------------
  // 文件输入控件保持隐藏，由可见按钮在用户手势中触发浏览器文件选择窗口。
  elements.fileTrigger.addEventListener('click', event => {
    event.preventDefault();
    elements.fileInput.click();
  });
  // 用户取消文件选择时不会触发 change；成功加载后清空 input，便于再次选择同一个文件。

  elements.fileInput.addEventListener('change', () => {
    const file = elements.fileInput.files?.[0];
    if (!file) return;
    elements.fileInfo.textContent = `已选择文件：${file.name}（${(file.size / 1024).toFixed(1)} KB）`;
    elements.fileInfo.classList.add('success');
    elements.fileDot.style.background = 'var(--good)';
    elements.fileText.style.color = 'var(--good)';
  });
  elements.loadCsv.addEventListener('click', async () => {
    const file = elements.fileInput.files?.[0];
    if (!file) {
      log('请先选择 CSV 文件', 'err');
      return;
    }
    // 避免在浏览器内一次性解析过大的文件导致页面长时间无响应。
    if (file.size > 50 * 1024 * 1024) {
      log('CSV 文件超过 50 MB，请先拆分文件', 'err');
      return;
    }
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
    } catch (error) {
      log(`CSV 加载失败：${error.message}`, 'err');
      elements.fileInfo.textContent = `加载失败：${error.message}`;
    }
  });

  /** 根据 CSV 表头生成三个图表的 Y 轴列选择器，并填入默认曲线。 */
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
        const option = document.createElement('option');
        option.value = String(column);
        option.textContent = headers[column];
        select.appendChild(option);
      }
      select.disabled = false;
      select.value = String(Math.min(index + 1, headers.length - 1));
      select.onchange = () => updateAnalyticsChart(index, Number(select.value));
      updateAnalyticsChart(index, Number(select.value));
    });
  }
  /** 将指定 CSV 数值列应用到指定分析图；第一列始终作为时间 X 轴。 */
  function updateAnalyticsChart(chartIndex, columnIndex) {
    if (!state.csv) return;
    const { headers, rows, labels } = state.csv;
    const chart = state.analyticsCharts[chartIndex];
    chart.data.labels = labels;
    chart.data.datasets[0].label = headers[columnIndex] || `列 ${columnIndex + 1}`;
    chart.data.datasets[0].data = rows.map(row => window.CsvUtils.parseFiniteNumber(row[columnIndex]));
    chart.update('none');
  }

  // -----------------------------------------------------------------------
  // 赛道文件加载、路线绘制与实时曲线选择
  // -----------------------------------------------------------------------
  elements.loadTrack.addEventListener('click', () => elements.trackFileInput.click());
  elements.trackFileInput.addEventListener('change', async () => {
    const file = elements.trackFileInput.files?.[0];
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) {
      log('赛道文件超过 25 MB，请先精简轨迹数据', 'err');
      elements.trackFileInput.value = '';
      return;
    }
    try {
      const text = await file.text();
      const points = /\.gpx$/i.test(file.name) || text.trimStart().startsWith('<?xml')
        ? parseGpxTrack(text)
        : parseCsvTrack(text);
      if (points.length < 2) throw new Error('赛道文件至少需要两个有效的经纬度点');
      state.trackRoute = createTrackModel(file.name, points);
      elements.trackFileStatus.textContent = `${file.name} · ${points.length} 个轨迹点`;
      elements.trackFileStatus.classList.add('success');
      elements.trackEmptyState.hidden = true;
      setConnectionUI(serial.state);
      drawTrack();
      updateTrackPositionReadout();
      log(`赛道文件加载完成：${file.name}，共 ${points.length} 个点`, 'ok');
    } catch (error) {
      elements.trackFileStatus.textContent = `加载失败：${error.message}`;
      elements.trackFileStatus.classList.remove('success');
      log(`赛道文件解析失败：${error.message}`, 'err');
    } finally {
      // 清空选择框，以便再次选同一个文件时依然触发 change 事件。
      elements.trackFileInput.value = '';
    }
  });

  /** CSV 赛道文件支持 latitude/longitude、lat/lon、lng 及常见中文列名。 */
  function parseCsvTrack(text) {
    const parsed = window.CsvUtils.parseCSV(text);
    const normalized = parsed.headers.map(header => String(header).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, ''));
    const findIndex = predicate => normalized.findIndex(predicate);
    const latIndex = findIndex(header => header === 'lat' || header.includes('latitude') || header.includes('纬度'));
    const lonIndex = findIndex(header => header === 'lon' || header === 'lng' || header.includes('longitude') || header.includes('经度'));
    const altIndex = findIndex(header => header.includes('altitude') || header.includes('elevation') || header.includes('height') || header.includes('海拔') || header.includes('高度'));
    if (latIndex < 0 || lonIndex < 0) {
      throw new Error('CSV 表头必须包含纬度/经度列，例如 latitude,longitude 或 纬度,经度');
    }
    return parsed.rows.map(row => ({
      latitude: window.CsvUtils.parseFiniteNumber(row[latIndex]),
      longitude: window.CsvUtils.parseFiniteNumber(row[lonIndex]),
      altitude: altIndex >= 0 ? window.CsvUtils.parseFiniteNumber(row[altIndex]) : null
    })).filter(point => Number.isFinite(point.latitude) && point.latitude >= -90 && point.latitude <= 90 &&
      Number.isFinite(point.longitude) && point.longitude >= -180 && point.longitude <= 180);
  }

  /** 解析 GPX 中的路线点、轨迹点或航点，并尽可能读取高度 ele。 */
  function parseGpxTrack(text) {
    const documentXml = new DOMParser().parseFromString(text, 'application/xml');
    if (documentXml.querySelector('parsererror')) throw new Error('GPX/XML 文件格式错误');
    const pointNodes = Array.from(documentXml.querySelectorAll('trkpt, rtept, wpt'));
    return pointNodes.map(node => {
      const latitude = Number(node.getAttribute('lat'));
      const longitude = Number(node.getAttribute('lon'));
      const elevationText = node.querySelector('ele')?.textContent;
      const altitude = elevationText == null || elevationText.trim() === '' ? null : Number(elevationText);
      return { latitude, longitude, altitude: Number.isFinite(altitude) ? altitude : null };
    }).filter(point => Number.isFinite(point.latitude) && point.latitude >= -90 && point.latitude <= 90 &&
      Number.isFinite(point.longitude) && point.longitude >= -180 && point.longitude <= 180);
  }

  /** 经纬度投影为本地平面坐标，修正经度随纬度变化的实际尺度。 */
  function projectTrackPoint(point, referenceLatitude) {
    return {
      x: point.longitude * Math.cos(referenceLatitude * Math.PI / 180),
      y: point.latitude
    };
  }

  /** 加载路线时预先计算投影和范围，避免每次位置刷新都重新扫描原始 GPX/CSV。 */
  function createTrackModel(name, points) {
    const referenceLatitude = points.reduce((sum, point) => sum + point.latitude, 0) / points.length;
    const projected = [];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    // 全量扫描只在加载文件时执行一次，获取精确包围框。
    for (const point of points) {
      const projectedPoint = projectTrackPoint(point, referenceLatitude);
      minX = Math.min(minX, projectedPoint.x);
      maxX = Math.max(maxX, projectedPoint.x);
      minY = Math.min(minY, projectedPoint.y);
      maxY = Math.max(maxY, projectedPoint.y);
    }
    // 为 Canvas 限制路径绘制点数量，避免超大 GPX 文件导致连续刷新时卡顿。
    const maxDrawPoints = 15000;
    const stride = Math.max(1, Math.ceil(points.length / maxDrawPoints));
    for (let index = 0; index < points.length; index += stride) {
      projected.push(projectTrackPoint(points[index], referenceLatitude));
    }
    if (points.length > 1 && (points.length - 1) % stride !== 0) {
      projected.push(projectTrackPoint(points[points.length - 1], referenceLatitude));
    }
    return {
      name, points, projected, referenceLatitude,
      minX, maxX, minY, maxY,
      rangeX: Math.max(maxX - minX, 1e-9),
      rangeY: Math.max(maxY - minY, 1e-9)
    };
  }

  /** 按当前赛道数据与设备最近一组经纬度，重绘路线和位置标记。 */
  function drawTrack() {
    const canvas = elements.trackCanvas;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const width = rect.width;
    const height = rect.height;
    ctx.clearRect(0, 0, width, height);

    // 暗色网格为地图参照，不代表真实道路底图；几何路线来自用户导入文件。
    ctx.strokeStyle = 'rgba(89, 112, 137, 0.13)';
    ctx.lineWidth = 1;
    for (let x = 0; x < width; x += 40) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    for (let y = 0; y < height; y += 40) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }
    if (!state.trackRoute?.points?.length) {
      elements.trackEmptyState.hidden = false;
      return;
    }
    elements.trackEmptyState.hidden = true;
    const route = state.trackRoute;
    const points = route.points;
    const referenceLatitude = route.referenceLatitude;
    const projected = route.projected;
    const { minX, maxX, minY, maxY, rangeX, rangeY } = route;
    // 先扩展绘图边界，给赛道外沿及当前位置留出空间。
    const paddedMinX = minX - rangeX * 0.18;
    const paddedMaxX = maxX + rangeX * 0.18;
    const paddedMinY = minY - rangeY * 0.18;
    const paddedMaxY = maxY + rangeY * 0.18;
    const plotWidth = Math.max(10, width - 48);
    const plotHeight = Math.max(10, height - 40);
    const scale = Math.min(plotWidth / (paddedMaxX - paddedMinX), plotHeight / (paddedMaxY - paddedMinY));
    const centerX = (paddedMinX + paddedMaxX) / 2;
    const centerY = (paddedMinY + paddedMaxY) / 2;
    const toCanvas = point => ({
      x: width / 2 + (point.x - centerX) * scale,
      y: height / 2 - (point.y - centerY) * scale
    });

    // 赛道路线描边及淡色内填充，保持路线原始点序。
    const canvasPoints = projected.map(toCanvas);
    ctx.beginPath();
    canvasPoints.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.strokeStyle = '#00d2ff';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(0,210,255,0.35)';
    ctx.shadowBlur = 7;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 起点与终点使用固定颜色，帮助确认路线方向。
    const start = canvasPoints[0];
    const end = canvasPoints[canvasPoints.length - 1];
    ctx.fillStyle = '#4ade80';
    ctx.beginPath(); ctx.arc(start.x, start.y, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#e8eef5'; ctx.font = '11px sans-serif'; ctx.fillText('起点', start.x + 8, start.y - 8);
    ctx.fillStyle = '#ffb454';
    ctx.beginPath(); ctx.arc(end.x, end.y, 4, 0, Math.PI * 2); ctx.fill();

    const latitude = state.position.latitude;
    const longitude = state.position.longitude;
    const hasPosition = Number.isFinite(latitude) && Number.isFinite(longitude);
    if (hasPosition) {
      const deviceProjected = projectTrackPoint({ latitude, longitude }, referenceLatitude);
      const inBounds = deviceProjected.x >= minX - rangeX * 0.2 && deviceProjected.x <= maxX + rangeX * 0.2 &&
        deviceProjected.y >= minY - rangeY * 0.2 && deviceProjected.y <= maxY + rangeY * 0.2;
      if (inBounds) {
        const devicePoint = toCanvas(deviceProjected);
        // 外圈白色、内圈红色，并添加定位十字，突出当前设备位置。
        ctx.beginPath(); ctx.arc(devicePoint.x, devicePoint.y, 9, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,51,71,0.18)'; ctx.fill();
        ctx.beginPath(); ctx.arc(devicePoint.x, devicePoint.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#ff3347'; ctx.fill();
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(devicePoint.x - 11, devicePoint.y); ctx.lineTo(devicePoint.x + 11, devicePoint.y);
        ctx.moveTo(devicePoint.x, devicePoint.y - 11); ctx.lineTo(devicePoint.x, devicePoint.y + 11); ctx.stroke();
        ctx.fillStyle = '#ffffff'; ctx.font = 'bold 11px sans-serif';
        ctx.fillText('设备', devicePoint.x + 11, devicePoint.y - 9);
      }
    }
    updateTrackPositionReadout();
  }

  /** 将当前 GPS / 高度读数写入底栏，并提示位置是否落在已加载路线附近。 */
  function updateTrackPositionReadout() {
    const { latitude, longitude, altitude, lastPositionAt } = state.position;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      elements.trackPositionReadout.textContent = Number.isFinite(altitude)
        ? `高度 ${altitude.toFixed(1)} m · 等待经纬度`
        : '等待设备 GPS 数据';
    } else {
      const ageSeconds = lastPositionAt ? Math.max(0, (Date.now() - lastPositionAt) / 1000) : 0;
      const staleText = hasActiveConnection() && ageSeconds > 2 ? ' · 数据较旧' : '';
      const altitudeText = Number.isFinite(altitude) ? ` · 高度 ${altitude.toFixed(1)} m` : '';
      let courseText = '';
      if (state.trackRoute) {
        const route = state.trackRoute;
        const device = projectTrackPoint({ latitude, longitude }, route.referenceLatitude);
        const inBounds = device.x >= route.minX - route.rangeX * 0.2 && device.x <= route.maxX + route.rangeX * 0.2 &&
          device.y >= route.minY - route.rangeY * 0.2 && device.y <= route.maxY + route.rangeY * 0.2;
        if (!inBounds) courseText = ' · 当前位置在赛道范围外';
      }
      elements.trackPositionReadout.textContent = `纬度 ${latitude.toFixed(6)} · 经度 ${longitude.toFixed(6)}${altitudeText}${staleText}${courseText}`;
    }
  }

  /** 依下拉框设置刷新赛道页曲线，数据源和遥测指标来自同一 state。 */
  function updateTrackChartSeries() {
    if (!state.trackChart) return;
    const selected = elements.trackSeriesSelect.value;
    const option = elements.trackSeriesSelect.selectedOptions[0];
    const label = option ? option.textContent : selected;
    const colors = { altitude: '#ffb454', cadence: '#4ade80', resistance: '#b79cff', power: '#ff6677', speed: '#00d2ff' };
    state.trackChart.data.labels = state.trackHistory.map(sample => sample.label);
    state.trackChart.data.datasets[0].label = label;
    state.trackChart.data.datasets[0].data = state.trackHistory.map(sample => sample[selected] ?? null);
    state.trackChart.data.datasets[0].borderColor = colors[selected] || '#00d2ff';
    state.trackChart.update('none');
  }

  // 调整窗口大小时重绘 canvas 路线，保留原有经纬度数据不变。
  window.addEventListener('resize', () => {
    if (document.getElementById('trackPage')?.classList.contains('active')) drawTrack();
  });

  setConnectionUI('disconnected');
});
