'use strict';

const net = require('node:net');
const tls = require('node:tls');
const { EventEmitter } = require('node:events');
const { AID_BYTES } = require('./datastream');

const IAC = 255;
const DO = 253;
const DONT = 254;
const WILL = 251;
const WONT = 252;
const SB = 250;
const SE = 240;
const EOR = 239;
const SEND = 1;
const IS = 0;
const OPT_BINARY = 0;
const OPT_TERMINAL_TYPE = 24;
const OPT_EOR = 25;
const OPT_TN3270E = 40;
const TN3270E_OP_SEND = 0x08;
const TN3270E_OP_DEVICE_TYPE = 0x02;
const TN3270E_OP_FUNCTIONS = 0x03;
const TN3270E_OP_IS = 0x04;
const TN3270E_OP_REQUEST = 0x07;

class Telnet3270Client extends EventEmitter {
  constructor() {
    super();
    this.socket = undefined;
    this.connected = false;
    this.terminalType = 'IBM-3278-2-E';
    this.deviceName = '';
    this.pending = [];
    this.tn3270e = false;
    this.tn3270eDeviceAccepted = false;
    this.tn3270eSequence = 0;
    this.assignedDeviceName = '';
  }

  connect({ host, port = 23, timeoutMs = 10000, secure = false, rejectUnauthorized = true, terminalType, deviceName } = {}) {
    if (!host) {
      return Promise.reject(new Error('A hostname is required.'));
    }
    this.disconnect();
    this.terminalType = terminalType || this.terminalType;
    this.deviceName = deviceName || '';
    this.tn3270e = false;
    this.tn3270eDeviceAccepted = false;
    this.tn3270eSequence = 0;
    this.assignedDeviceName = '';

    return new Promise((resolve, reject) => {
      this.emit('trace', `connecting ${secure ? 'tls' : 'telnet'} ${host}:${port}`);
      const socket = secure
        ? tls.connect({ host, port, rejectUnauthorized })
        : net.createConnection({ host, port });
      this.socket = socket;
      socket.setTimeout(timeoutMs);

      socket.once(secure ? 'secureConnect' : 'connect', () => {
        this.connected = true;
        socket.setTimeout(0);
        this.emit('trace', `connected ${secure ? 'tls' : 'telnet'} ${host}:${port}`);
        this.emit('connect', { host, port, secure });
        resolve();
      });
      socket.on('data', (chunk) => {
        this.emit('trace', `received ${chunk.length} bytes`);
        this.emit('trace', `received hex=${chunk.subarray(0, 32).toString('hex')}`);
        const parsed = this.handleTelnet(chunk);
        if (parsed.data.length > 0) {
          this.emit('data', parsed.data);
        }
        for (const frame of parsed.frames) {
          this.emit('frame', frame);
        }
      });
      socket.on('error', (error) => {
        this.emit('trace', `error ${error.message}`);
        this.emit('error', error);
        if (!this.connected) {
          reject(error);
        }
      });
      socket.on('timeout', () => {
        const error = new Error(`Timed out connecting to ${host}:${port}`);
        this.emit('trace', error.message);
        socket.destroy(error);
        reject(error);
      });
      socket.on('close', () => {
        this.connected = false;
        this.emit('trace', 'disconnected');
        this.emit('disconnect');
      });
    });
  }

  disconnect() {
    if (this.socket) {
      this.socket.destroy();
    }
    this.socket = undefined;
    this.connected = false;
  }

  sendText(text) {
    this.write(Buffer.from(String(text), 'utf8'));
  }

  sendAid(aid) {
    const key = String(aid).toLowerCase();
    const aidByte = AID_BYTES[key];
    if (aidByte === undefined) {
      throw new Error(`Unsupported AID key: ${aid}`);
    }
    this.write(Buffer.from([aidByte, IAC, EOR]));
  }

  write(buffer) {
    const payload = this.tn3270e ? addTn3270EDataHeader(buffer, this.nextTn3270ESequence()) : buffer;
    const framed = appendEor(escapeIac(payload));
    if (!this.socket || !this.connected) {
      this.emit('offlineWrite', framed);
      return;
    }
    this.emit('trace', `sent ${framed.length} bytes${this.tn3270e ? ' tn3270e-data' : ''}`);
    this.socket.write(framed);
  }

  rawWrite(buffer) {
    if (!this.socket || !this.connected) {
      this.emit('offlineWrite', buffer);
      return;
    }
    this.emit('trace', `sent negotiation ${buffer.length} bytes`);
    this.socket.write(buffer);
  }

  handleTelnet(chunk) {
    const out = [];
    const frames = [];
    for (let i = 0; i < chunk.length; i += 1) {
      const byte = chunk[i];
      if (byte !== IAC) {
        out.push(byte);
        continue;
      }

      const command = chunk[++i];
      if (command === IAC) {
        out.push(IAC);
      } else if (command === EOR) {
        frames.push(Buffer.from(out.splice(0, out.length)));
      } else if (command === DO || command === DONT || command === WILL || command === WONT) {
        const option = chunk[++i];
        this.emit('trace', `negotiation ${telnetCommandName(command)} ${optionName(option)}(${option})`);
        this.respondToNegotiation(command, option);
      } else if (command === SB) {
        const start = i + 1;
        while (i < chunk.length && !(chunk[i] === IAC && chunk[i + 1] === SE)) {
          i += 1;
        }
        this.handleSubnegotiation(chunk.subarray(start, i));
        i += 1;
      }
    }
    return { data: Buffer.from(out), frames };
  }

  respondToNegotiation(command, option) {
    if (!this.socket) {
      return;
    }
    const acceptedLocal = option === OPT_BINARY || option === OPT_TERMINAL_TYPE || option === OPT_EOR || option === OPT_TN3270E;
    const acceptedRemote = option === OPT_BINARY || option === OPT_EOR || option === OPT_TN3270E;
    if (command === DO) {
      const response = acceptedLocal ? WILL : WONT;
      this.emit('trace', `negotiation reply ${telnetCommandName(response)} ${optionName(option)}(${option})`);
      this.rawWrite(Buffer.from([IAC, response, option]));
    } else if (command === WILL) {
      const response = acceptedRemote ? DO : DONT;
      this.emit('trace', `negotiation reply ${telnetCommandName(response)} ${optionName(option)}(${option})`);
      this.rawWrite(Buffer.from([IAC, response, option]));
    } else if (command === DONT) {
      this.emit('trace', `negotiation reply WONT ${optionName(option)}(${option})`);
      this.rawWrite(Buffer.from([IAC, WONT, option]));
    } else if (command === WONT) {
      this.emit('trace', `negotiation reply DONT ${optionName(option)}(${option})`);
      this.rawWrite(Buffer.from([IAC, DONT, option]));
    }
  }

  handleSubnegotiation(payload) {
    const option = payload[0];
    this.emit('trace', `subnegotiation ${optionName(option)}(${option}) hex=${payload.toString('hex')}`);
    if (option === OPT_TERMINAL_TYPE && payload[1] === SEND) {
      this.emit('trace', `terminal-type is ${this.getTerminalTypeName()}`);
      this.rawWrite(Buffer.from([
        IAC, SB, OPT_TERMINAL_TYPE, IS,
        ...Buffer.from(this.getTerminalTypeName(), 'ascii'),
        IAC, SE
      ]));
    } else if (option === OPT_TN3270E) {
      this.handleTn3270ESubnegotiation(payload);
    }
  }

  handleTn3270ESubnegotiation(payload) {
    if (payload[1] !== TN3270E_OP_SEND || payload[2] !== TN3270E_OP_DEVICE_TYPE) {
      if (payload[1] === TN3270E_OP_DEVICE_TYPE && payload[2] === TN3270E_OP_IS) {
        this.tn3270eDeviceAccepted = true;
        this.assignedDeviceName = parseTn3270EDeviceName(payload.subarray(3));
        this.emit('trace', `tn3270e device-type accepted ${this.assignedDeviceName || '<unnamed>'}`);
        this.sendTn3270EFunctionsRequest([]);
      } else if (payload[1] === TN3270E_OP_FUNCTIONS && payload[2] === TN3270E_OP_IS) {
        this.tn3270e = true;
        this.emit('trace', `tn3270e functions accepted ${formatFunctionList(payload.subarray(3)) || '<basic>'}`);
      } else if (payload[1] === TN3270E_OP_FUNCTIONS && payload[2] === TN3270E_OP_REQUEST) {
        const functions = payload.subarray(3);
        this.emit('trace', `tn3270e functions requested ${formatFunctionList(functions) || '<basic>'}`);
        this.sendTn3270EFunctionsIs(functions);
        this.tn3270e = true;
      }
      return;
    }
    this.emit('trace', `tn3270e device-type request ${this.getTerminalTypeName()}`);
    this.rawWrite(Buffer.from([
      IAC, SB, OPT_TN3270E,
      TN3270E_OP_DEVICE_TYPE, TN3270E_OP_REQUEST,
      ...Buffer.from(this.getTerminalTypeName(), 'ascii'),
      IAC, SE
    ]));
  }

  sendTn3270EFunctionsRequest(functions) {
    this.emit('trace', `tn3270e functions request ${formatFunctionList(functions) || '<basic>'}`);
    this.rawWrite(Buffer.from([
      IAC, SB, OPT_TN3270E,
      TN3270E_OP_FUNCTIONS, TN3270E_OP_REQUEST,
      ...functions,
      IAC, SE
    ]));
  }

  sendTn3270EFunctionsIs(functions) {
    this.emit('trace', `tn3270e functions is ${formatFunctionList(functions) || '<basic>'}`);
    this.rawWrite(Buffer.from([
      IAC, SB, OPT_TN3270E,
      TN3270E_OP_FUNCTIONS, TN3270E_OP_IS,
      ...functions,
      IAC, SE
    ]));
  }

  getTerminalTypeName() {
    return this.terminalType + (this.deviceName ? `@${this.deviceName}` : '');
  }

  nextTn3270ESequence() {
    const sequence = this.tn3270eSequence;
    this.tn3270eSequence = (this.tn3270eSequence + 1) & 0xffff;
    return sequence;
  }
}

function telnetCommandName(command) {
  return ({
    [DO]: 'DO',
    [DONT]: 'DONT',
    [WILL]: 'WILL',
    [WONT]: 'WONT',
    [SB]: 'SB',
    [SE]: 'SE',
    [EOR]: 'EOR'
  })[command] ?? `CMD-${command}`;
}

function optionName(option) {
  return ({
    [OPT_BINARY]: 'BINARY',
    [OPT_TERMINAL_TYPE]: 'TERMINAL-TYPE',
    [OPT_EOR]: 'EOR',
    [OPT_TN3270E]: 'TN3270E'
  })[option] ?? 'OPTION';
}

function stripTelnetControls(chunk) {
  const client = new Telnet3270Client();
  return client.handleTelnet(chunk).data;
}

function escapeIac(buffer) {
  const bytes = [];
  for (const byte of buffer) {
    bytes.push(byte);
    if (byte === IAC) {
      bytes.push(IAC);
    }
  }
  return Buffer.from(bytes);
}

function appendEor(buffer) {
  if (buffer.length >= 2 && buffer.at(-2) === IAC && buffer.at(-1) === EOR) {
    return buffer;
  }
  return Buffer.concat([buffer, Buffer.from([IAC, EOR])]);
}

function addTn3270EDataHeader(buffer, sequence = 0) {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, (sequence >> 8) & 0xff, sequence & 0xff]),
    buffer
  ]);
}

function parseTn3270EDeviceName(payload) {
  const bytes = [];
  for (const byte of payload) {
    if (byte >= 0x20 && byte <= 0x7e) {
      bytes.push(byte);
    }
  }
  return Buffer.from(bytes).toString('ascii');
}

function formatFunctionList(functions) {
  return [...functions].map((fn) => ({
    0x00: 'BIND-IMAGE',
    0x01: 'DATA-STREAM-CTL',
    0x02: 'RESPONSES',
    0x03: 'SCS-CTL-CODES',
    0x04: 'SYSREQ'
  })[fn] ?? `FUNCTION-${fn}`).join(',');
}

module.exports = {
  AID_BYTES,
  EOR,
  IAC,
  Telnet3270Client,
  addTn3270EDataHeader,
  appendEor,
  escapeIac,
  parseTn3270EDeviceName,
  stripTelnetControls
};
