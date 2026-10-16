/* Serial protocol: F1 | type | payload length | ASCII payload | checksum(sum payload) | F6 */
(() => {
  'use strict';

  const START = 0xF1;
  const END = 0xF6;
  const MAX_PAYLOAD_LENGTH = 64;

  function encodeFrame(type, payloadBytes = new Uint8Array()) {
    if (!Number.isInteger(type) || type < 0 || type > 0xFF) {
      throw new TypeError('帧类型必须是 0~255 的整数');
    }
    if (!(payloadBytes instanceof Uint8Array)) payloadBytes = new Uint8Array(payloadBytes);
    if (payloadBytes.length > MAX_PAYLOAD_LENGTH) throw new RangeError('帧数据过长');

    let checksum = 0;
    for (const byte of payloadBytes) checksum = (checksum + byte) & 0xFF;
    const frame = new Uint8Array(payloadBytes.length + 5);
    frame[0] = START;
    frame[1] = type;
    frame[2] = payloadBytes.length;
    frame.set(payloadBytes, 3);
    frame[3 + payloadBytes.length] = checksum;
    frame[4 + payloadBytes.length] = END;
    return frame;
  }

  function encodeParameter(type, value) {
    const text = String(value).trim();
    if (!text || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) {
      throw new TypeError(`参数 ${type.toString(16)} 不是有效数字`);
    }
    return encodeFrame(type, new TextEncoder().encode(text));
  }

  function encodeReadParametersRequest() {
    // 保留旧程序使用的专用请求帧：F1 60 00 00 F6。
    return new Uint8Array([START, 0x60, 0x00, 0x00, END]);
  }

  class FrameParser {
    constructor(onFrame, onError = () => {}) {
      this.onFrame = onFrame;
      this.onError = onError;
      this.reset();
    }

    reset() {
      this.state = 'wait-start';
      this.type = 0;
      this.length = 0;
      this.payload = [];
      this.checksum = 0;
    }

    push(chunk) {
      for (const byte of chunk) this.consume(byte);
    }

    consume(byte) {
      switch (this.state) {
        case 'wait-start':
          if (byte === START) this.state = 'type';
          break;
        case 'type':
          this.type = byte;
          this.state = 'length';
          break;
        case 'length':
          this.length = byte;
          this.payload = [];
          if (this.length > MAX_PAYLOAD_LENGTH) {
            this.onError(`收到过长帧：${this.length} 字节`);
            this.reset();
          } else {
            this.state = this.length === 0 ? 'checksum' : 'payload';
          }
          break;
        case 'payload':
          this.payload.push(byte);
          if (this.payload.length >= this.length) this.state = 'checksum';
          break;
        case 'checksum': {
          let sum = 0;
          for (const value of this.payload) sum = (sum + value) & 0xFF;
          if (sum !== byte) {
            this.onError('收到的串口帧校验和错误');
            this.reset();
          } else {
            this.checksum = byte;
            this.state = 'end';
          }
          break;
        }
        case 'end':
          if (byte === END) {
            this.onFrame({ type: this.type, payload: new Uint8Array(this.payload) });
            this.reset();
          } else {
            this.onError('串口帧结束标记错误');
            // 当前字节若是起始标记，直接开始下一帧，便于重新同步。
            this.reset();
            if (byte === START) this.state = 'type';
          }
          break;
        default:
          this.reset();
      }
    }
  }

  function parseNumericPayload(payload) {
    const text = new TextDecoder().decode(payload).trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
  }

  window.SerialProtocol = { encodeFrame, encodeParameter, encodeReadParametersRequest, FrameParser, parseNumericPayload };
})();
