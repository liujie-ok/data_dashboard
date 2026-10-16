/**
 * 仪表板二进制帧协议模块。
 * 帧格式：F1 | 类型 | 载荷长度 | ASCII 载荷 | 校验和 | F6。
 * 校验和只累加载荷字节并保留低 8 位。此规则需要与 MCU 固件保持一致。
 * 本模块不负责串口连接，只负责帧编码、逐字节解析和数字载荷转换。
 */
(() => {
  'use strict';

  // 每帧的固定起始/结束标记，以及单帧允许的最大载荷长度。
  const START = 0xF1;
  const END = 0xF6;
  const MAX_PAYLOAD_LENGTH = 64;

  /** 将类型和二进制载荷编码成可直接通过 Web Serial 发送的完整帧。 */
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

  /** 将参数数值编码为 ASCII 文本后，再封装为普通数据帧。 */
  function encodeParameter(type, value) {
    const text = String(value).trim();
    if (!text || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) {
      throw new TypeError(`参数 ${type.toString(16)} 不是有效数字`);
    }
    return encodeFrame(type, new TextEncoder().encode(text));
  }

  /** 构造约定的读取参数请求帧；该请求采用专用的空载荷格式。 */
  function encodeReadParametersRequest() {
    // 保留旧程序使用的专用请求帧：F1 60 00 00 F6。
    return new Uint8Array([START, 0x60, 0x00, 0x00, END]);
  }

  /**
   * 面向串口数据流的逐字节状态机。一次 push 可能只收到半帧，
   * 也可能同时收到多帧，因此解析状态必须跨 push 调用保留。
   */
  class FrameParser {
    constructor(onFrame, onError = () => {}) {
      this.onFrame = onFrame;
      this.onError = onError;
      this.reset();
    }

    /** 清空当前半帧状态，使解析器回到等待起始标记的状态。 */
    reset() {
      this.state = 'wait-start';
      this.type = 0;
      this.length = 0;
      this.payload = [];
      this.checksum = 0;
    }

    /** 输入一段新到达的字节流，并依序交给状态机处理。 */
    push(chunk) {
      for (const byte of chunk) this.consume(byte);
    }

    /** 处理单个字节：起始标记、类型、长度、载荷、校验和、结束标记。 */
    consume(byte) {
      switch (this.state) {
        // 等待起始字节，忽略帧外杂散数据。
        case 'wait-start':
          if (byte === START) this.state = 'type';
          break;
        // 起始标记之后依次读取类型和载荷长度。
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
        // 依照长度字段收集载荷；载荷可以跨多个 USB 数据块到达。
        case 'payload':
          this.payload.push(byte);
          if (this.payload.length >= this.length) this.state = 'checksum';
          break;
        // 校验和不匹配时丢弃当前帧，并回到等待起始标记的状态。
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
        // 结束标记正确后才把完整帧交给业务层。
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

  /** 将 ASCII 数字载荷转成有限数值；不合法字符串返回 null。 */
  function parseNumericPayload(payload) {
    const text = new TextDecoder().decode(payload).trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
  }

  // 只向全局暴露网页需要的协议接口，避免污染其他模块的命名空间。
  window.SerialProtocol = {
    encodeFrame,
    encodeParameter,
    encodeReadParametersRequest,
    FrameParser,
    parseNumericPayload
  };
})();
