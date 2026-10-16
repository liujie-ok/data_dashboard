/**
 * Web Serial 串口管理模块。
 * 统一封装请求设备、打开端口、持续读取、顺序写入和安全关闭的流程。
 * app.js 通过 statechange、data、error 事件接收状态与数据，不直接操作 reader/writer。
 */
(() => {
  'use strict';

  /** 串口管理器：通过自定义事件向界面层报告连接状态和接收数据。 */
  class SerialManager extends EventTarget {
    constructor() {
      super();
      this.port = null;
      this.reader = null;
      this.keepReading = false;
      this.readTask = null;
      this.writeQueue = Promise.resolve();
      this.state = 'disconnected';
    }

    // 只有端口以及读写流都存在时，才认为串口处于可用状态。
    get connected() {
      return Boolean(this.port && this.port.readable && this.port.writable);
    }

    /** 请求用户选择串口并打开端口，然后启动后台读取循环。 */
    async connect(baudRate) {
      if (!('serial' in navigator)) throw new Error('当前浏览器不支持 Web Serial API');
      if (this.state !== 'disconnected') throw new Error('串口正在连接或已经连接');
      this.state = 'connecting';
      try {
        const port = await navigator.serial.requestPort();
        await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
        this.port = port;
        this.keepReading = true;
        // 端口打开成功后再切换成 connected，不能把选择设备窗口打开当作连接成功。
        this.state = 'connected';
        this.dispatchEvent(new CustomEvent('statechange', { detail: this.state }));
        this.readTask = this.readLoop(port);
        return port;
      } catch (error) {
        this.state = 'disconnected';
        this.dispatchEvent(new CustomEvent('statechange', { detail: this.state }));
        throw error;
      }
    }

    /** 持续读取端口数据；每次读取获得的字节块通过 data 事件传出。 */
    async readLoop(port) {
      try {
        while (this.keepReading && this.port === port && port.readable) {
          const reader = port.readable.getReader();
          this.reader = reader;
          try {
            // 持续 await reader.read()，避免使用忙等循环消耗 CPU。
          while (this.keepReading) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value?.length) this.dispatchEvent(new CustomEvent('data', { detail: value }));
            }
          } finally {
            reader.releaseLock();
            if (this.reader === reader) this.reader = null;
          }
        }
      } catch (error) {
        if (this.keepReading) this.dispatchEvent(new CustomEvent('error', { detail: error }));
      } finally {
        if (this.state === 'connected' && this.port === port && !this.keepReading) {
          // 关闭端口的动作统一由 disconnect() 在读取任务退出后执行。
        }
      }
    }

    /** 将写入任务排队串行执行，避免多个按钮操作同时争用 writer 锁。 */
    write(bytes) {
      if (!this.connected || this.state !== 'connected') return Promise.reject(new Error('串口未连接'));
      const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      // 将写入操作排队执行，避免多个界面事件同时竞争 writer 锁。
      const operation = this.writeQueue.then(async () => {
        if (!this.connected || !this.port.writable) throw new Error('串口已断开');
        const writer = this.port.writable.getWriter();
        try {
          await writer.write(payload);
        } finally {
          writer.releaseLock();
        }
      });
      // 记录一个吞掉错误的队列尾部，保证前一个写入失败后后续写入仍能执行。
      this.writeQueue = operation.catch(() => {});
      return operation;
    }

    /** 先停读并释放 reader，再等待写入完成，最后关闭端口并归零状态。 */
    async disconnect() {
      if (this.state === 'disconnected') return;
      this.state = 'disconnecting';
      this.keepReading = false;
      this.dispatchEvent(new CustomEvent('statechange', { detail: this.state }));
      const port = this.port;
      try {
        if (this.reader) {
          try { await this.reader.cancel(); } catch (_) { /* reader may already be closed */ }
        }
        if (this.readTask) await this.readTask;
        await this.writeQueue;
        if (port) await port.close();
      } finally {
        this.reader = null;
        this.readTask = null;
        this.port = null;
        this.state = 'disconnected';
        this.dispatchEvent(new CustomEvent('statechange', { detail: this.state }));
      }
    }
  }

  window.SerialManager = SerialManager;
})();
