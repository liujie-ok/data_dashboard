/* Owns Web Serial port lifecycle, reader loop and serialized writes. */
(() => {
  'use strict';

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

    get connected() { return Boolean(this.port && this.port.readable && this.port.writable); }

    async connect(baudRate) {
      if (!('serial' in navigator)) throw new Error('当前浏览器不支持 Web Serial API');
      if (this.state !== 'disconnected') throw new Error('串口正在连接或已经连接');
      this.state = 'connecting';
      try {
        const port = await navigator.serial.requestPort();
        await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
        this.port = port;
        this.keepReading = true;
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

    async readLoop(port) {
      try {
        while (this.keepReading && this.port === port && port.readable) {
          const reader = port.readable.getReader();
          this.reader = reader;
          try {
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
          // disconnect() will perform close after the read task finishes.
        }
      }
    }

    write(bytes) {
      if (!this.connected || this.state !== 'connected') return Promise.reject(new Error('串口未连接'));
      const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      // Serialize writes so simultaneous UI actions never compete for a writer lock.
      const operation = this.writeQueue.then(async () => {
        if (!this.connected || !this.port.writable) throw new Error('串口已断开');
        const writer = this.port.writable.getWriter();
        try {
          await writer.write(payload);
        } finally {
          writer.releaseLock();
        }
      });
      this.writeQueue = operation.catch(() => {});
      return operation;
    }

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
