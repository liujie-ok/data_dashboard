const connectBtn = document.getElementById('connect-btn');
const valueDisplay = document.getElementById('sensor-value');
const statusText = document.getElementById('status-text');

let port;
let reader;

// 1. 初始化 Chart.js 折线图
const ctx = document.getElementById('tempChart').getContext('2d');
const tempChart = new Chart(ctx, {
    type: 'line', // 图表类型：折线图
    data: {
        labels: [], // X轴：时间标签
        datasets: [{
            label: '实时温度 (°C)',
            data: [], // Y轴：温度数值
            borderColor: '#38bdf8', // 曲线颜色（天蓝色）
            backgroundColor: 'rgba(56, 189, 248, 0.1)', // 曲线下方阴影
            borderWidth: 2,
            fill: true,
            tension: 0.3 // 让曲线变得平滑圆润
        }]
    },
    options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
            x: {
                grid: { color: '#334155' }, // X轴网格线颜色
                ticks: { color: '#94a3b8' }  // X轴文字颜色
            },
            y: {
                grid: { color: '#334155' }, // Y轴网格线颜色
                ticks: { color: '#94a3b8' }  // Y轴文字颜色
            }
        }
    }
});

// 2. 点击连接串口
connectBtn.addEventListener('click', async () => {
    try {
        port = await navigator.serial.requestPort();
        await port.open({ baudRate: 115200 });
        
        connectBtn.textContent = "已连接串口";
        connectBtn.style.backgroundColor = "#22c55e"; 
        statusText.textContent = "正在实时接收数据并绘制曲线...";

        readSerialData();
    } catch (error) {
        console.error("串口连接失败:", error);
        statusText.textContent = "连接失败：" + error.message;
    }
});

// 3. 循环读取串口数据并更新图表
async function readSerialData() {
    const textDecoder = new TextDecoderStream();
    port.readable.pipeTo(textDecoder.writable);
    reader = textDecoder.readable.getReader();

    try {
        let buffer = "";
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            
            buffer += value;
            let lines = buffer.split('\n');
            buffer = lines.pop(); 

            for (let line of lines) {
                let cleanLine = line.trim();
                if (cleanLine) {
                    let tempNum = parseFloat(cleanLine);
                    
                    if (!isNaN(tempNum)) {
                        // 更新文本显示
                        valueDisplay.textContent = `当前温度: ${tempNum} °C`;
                        
                        // 获取当前时间作为X轴标签
                        let now = new Date();
                        let timeString = now.getHours().toString().padStart(2, '0') + ':' +
                                         now.getMinutes().toString().padStart(2, '0') + ':' +
                                         now.getSeconds().toString().padStart(2, '0');

                        // 把新数据塞进图表
                        tempChart.data.labels.push(timeString);
                        tempChart.data.datasets[0].data.push(tempNum);

                        // 【优化】如果折线图的点超过 20 个，把最前面的删掉，实现向左滚动的动态效果
                        if (tempChart.data.labels.length > 20) {
                            tempChart.data.labels.shift();
                            tempChart.data.datasets[0].data.shift();
                        }

                        // 刷新图表显示
                        tempChart.update();
                    }
                }
            }
        }
    } catch (error) {
        console.error("读取出错:", error);
    } finally {
        reader.releaseLock();
    }
}