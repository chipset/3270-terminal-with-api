'use strict';

const { EventEmitter } = require('node:events');
const { applyDataStream, buildInputBuffer, buildReadBuffer, describeInputBuffer } = require('./datastream');
const { ScreenBuffer } = require('./screen');
const { Telnet3270Client } = require('./telnet3270');

class EmulatorSession extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      rows: 24,
      cols: 80,
      host: '',
      port: 23,
      secure: false,
      terminalType: 'IBM-3278-2-E',
      ...options
    };
    this.screen = new ScreenBuffer(this.options.rows, this.options.cols);
    this.client = new Telnet3270Client();
    this.connection = {
      host: this.options.host,
      port: this.options.port,
      secure: this.options.secure,
      connected: false,
      lastError: ''
    };

    this.client.on('connect', ({ host, port, secure }) => {
      this.connection = { ...this.connection, host, port, secure, connected: true, connecting: false, lastError: '' };
      this.emitUpdate();
    });
    this.client.on('disconnect', () => {
      this.connection.connected = false;
      this.connection.connecting = false;
      this.emitUpdate();
    });
    this.client.on('error', (error) => {
      this.connection.lastError = error.message;
      this.connection.connecting = false;
      this.emitUpdate();
    });
    this.client.on('trace', (message) => this.emit('trace', message));
    this.client.on('data', (data) => this.receiveDataStream(data));
    this.client.on('frame', (data) => this.receiveDataStream(data));
  }

  async connect(options = {}) {
    const host = options.host ?? options.hostname ?? this.connection.host;
    const port = options.port ?? this.connection.port;
    const secure = options.secure ?? this.connection.secure;
    this.connection.host = host;
    this.connection.port = port;
    this.connection.secure = secure;
    this.connection.connecting = true;
    this.connection.lastError = '';
    this.emitUpdate();
    await this.client.connect({
      host,
      port,
      secure,
      timeoutMs: options.timeoutMs,
      rejectUnauthorized: options.rejectUnauthorized,
      terminalType: options.terminalType ?? this.options.terminalType,
      deviceName: options.deviceName
    });
    return this.getSnapshot();
  }

  disconnect() {
    this.client.disconnect();
    return this.getSnapshot();
  }

  receive(text) {
    this.screen.write(text);
    this.emitUpdate();
    return this.getSnapshot();
  }

  receiveDataStream(data) {
    this.connection.lastReceive = {
      bytes: data.length,
      preview: data.subarray(0, 16).toString('hex')
    };
    this.emit('trace', `receive payload ${data.length} bytes hex=${this.connection.lastReceive.preview}`);
    const result = applyDataStream(data, this.screen);
    this.connection.lastReceive.mode = result.mode;
    this.emit('trace', `rendered payload as ${result.mode}${result.orders?.length ? ` orders=${result.orders.join(',')}` : ''}`);
    if (result.response) {
      this.emit('trace', `sending structured-field response ${result.response.length} bytes`);
      this.client.write(result.response);
    }
    this.emit('datastream', result);
    this.emitUpdate();
    return this.getSnapshot();
  }

  sendText(text) {
    this.screen.write(text);
    this.emitUpdate();
    return this.getSnapshot();
  }

  enter() {
    return this.sendAid('enter');
  }

  clear() {
    this.sendAid('clear');
    this.screen.clear();
    this.emitUpdate();
    return this.getSnapshot();
  }

  pf(number) {
    return this.sendAid(`pf${number}`);
  }

  pa(number) {
    return this.sendAid(`pa${number}`);
  }

  sendAid(aid) {
    const inputDescription = describeInputBuffer(this.screen, aid);
    const inputBuffer = buildInputBuffer(this.screen, aid);
    this.emit('trace', `send aid=${aid} modifiedFields=${inputDescription.modifiedFields} unformattedInput=${inputDescription.hasUnformattedInput}`);
    this.client.write(inputBuffer);
    this.screen.clearModified();
    this.emit('aid', { aid, bytes: inputBuffer.length });
    this.emitUpdate();
    return this.getSnapshot();
  }

  navigate(actions = []) {
    const results = [];
    for (const action of actions) {
      results.push(this.perform(action));
    }
    return results.at(-1) ?? this.getSnapshot();
  }

  perform(action) {
    if (typeof action === 'string') {
      return this.sendText(action);
    }

    switch (action.type) {
      case 'text':
        return this.sendText(action.value ?? '');
      case 'enter':
        return this.enter();
      case 'clear':
        return this.clear();
      case 'pf':
        return this.pf(action.number);
      case 'pa':
        return this.pa(action.number);
      case 'cursor':
        this.screen.setCursor(action.row, action.col);
        this.emitUpdate();
        return this.getSnapshot();
      case 'tab':
        this.screen.tabToNextUnprotectedField();
        this.emitUpdate();
        return this.getSnapshot();
      case 'backtab':
        this.screen.tabToPreviousUnprotectedField();
        this.emitUpdate();
        return this.getSnapshot();
      case 'fieldExit':
        this.screen.fieldExit();
        this.emitUpdate();
        return this.getSnapshot();
      case 'receive':
        return this.receive(action.value ?? '');
      case 'datastream':
        return this.receiveDataStream(action.value ?? Buffer.alloc(0));
      default:
        throw new Error(`Unknown navigation action: ${JSON.stringify(action)}`);
    }
  }

  getScreenText(options = {}) {
    return this.screen.getText(Boolean(options.trimRight));
  }

  getScreenshot(options = {}) {
    const format = options.format ?? 'text';
    if (format === 'json') {
      return this.getSnapshot();
    }
    if (format === 'html') {
      return `<pre>${escapeHtml(this.getScreenText())}</pre>`;
    }
    if (format === 'svg') {
      return this.getSvgScreenshot();
    }
    return this.getScreenText(options);
  }

  getSvgScreenshot() {
    const charWidth = 9;
    const lineHeight = 18;
    const padding = 16;
    const width = this.screen.cols * charWidth + padding * 2;
    const height = this.screen.rows * lineHeight + padding * 2;
    const cells = this.screen.getSnapshot().cells;
    const nodes = cells.map((cell) => {
      const x = padding + cell.address % this.screen.cols * charWidth;
      const y = padding + Math.floor(cell.address / this.screen.cols) * lineHeight;
      const fg = svgColor(cell.reverse ? 'black' : cell.color);
      const bg = cell.reverse ? svgColor(cell.color) : undefined;
      const decoration = cell.underscore ? ' text-decoration="underline"' : '';
      const background = bg ? `<rect x="${x}" y="${y + 2}" width="${charWidth}" height="${lineHeight}" fill="${bg}"/>` : '';
      const char = cell.hidden ? ' ' : cell.char;
      return `${background}<text x="${x}" y="${y + lineHeight}" fill="${fg}"${decoration}>${escapeHtml(char)}</text>`;
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#050806"/><g font-family="Menlo, Consolas, monospace" font-size="14">${nodes}</g></svg>`;
  }

  getFields() {
    return this.screen.getSnapshot().fields;
  }

  getReadBuffer() {
    return buildReadBuffer(this.screen);
  }

  getConnectionStatus() {
    return {
      connected: Boolean(this.connection.connected),
      connecting: Boolean(this.connection.connecting),
      host: this.connection.host || '',
      systemName: this.connection.host || '',
      address: this.connection.host || '',
      port: this.connection.port,
      secure: Boolean(this.connection.secure),
      lastError: this.connection.lastError || '',
      lastReceive: this.connection.lastReceive ? { ...this.connection.lastReceive } : undefined
    };
  }

  getSnapshot() {
    return {
      connection: this.getConnectionStatus(),
      screen: this.screen.getSnapshot()
    };
  }

  emitUpdate() {
    this.emit('update', this.getSnapshot());
  }
}

function svgColor(color) {
  return ({
    black: '#050806',
    blue: '#65a9ff',
    brightWhite: '#ffffff',
    deepBlue: '#3d6cff',
    default: '#95ff86',
    gray: '#9aa7a0',
    green: '#95ff86',
    orange: '#ff9f43',
    paleGreen: '#b8f5b0',
    paleTurquoise: '#aee9e6',
    pink: '#ff8bd1',
    purple: '#c678ff',
    red: '#ff6b6b',
    turquoise: '#6ff7e8',
    white: '#f2fff0',
    yellow: '#ffe66d'
  })[color] ?? '#95ff86';
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

module.exports = { EmulatorSession };
