'use strict';

const { decodeAddress, encodeAddress, rowColToAddress } = require('./addressing');
const { asciiCharToEbcdic, ebcdicByteToAscii, toEbcdic } = require('./ebcdic');

const COMMANDS = {
  write: 0xf1,
  eraseWrite: 0xf5,
  eraseWriteAlternate: 0x7e,
  writeStructuredField: 0xf3,
  readBuffer: 0xf2,
  readModified: 0xf6,
  eraseAllUnprotected: 0x6f
};

const ORDERS = {
  sba: 0x11,
  sf: 0x1d,
  sfe: 0x29,
  sa: 0x28,
  mf: 0x2c,
  ic: 0x13,
  pt: 0x05,
  ra: 0x3c,
  eua: 0x12,
  ge: 0x08
};

const AID_BYTES = {
  noAid: 0x60,
  enter: 0x7d,
  clear: 0x6d,
  pa1: 0x6c,
  pa2: 0x6e,
  pa3: 0x6b,
  pf1: 0xf1,
  pf2: 0xf2,
  pf3: 0xf3,
  pf4: 0xf4,
  pf5: 0xf5,
  pf6: 0xf6,
  pf7: 0xf7,
  pf8: 0xf8,
  pf9: 0xf9,
  pf10: 0x7a,
  pf11: 0x7b,
  pf12: 0x7c,
  pf13: 0xc1,
  pf14: 0xc2,
  pf15: 0xc3,
  pf16: 0xc4,
  pf17: 0xc5,
  pf18: 0xc6,
  pf19: 0xc7,
  pf20: 0xc8,
  pf21: 0xc9,
  pf22: 0x4a,
  pf23: 0x4b,
  pf24: 0x4c
};

function applyDataStream(buffer, screen) {
  const raw = Buffer.isBuffer(buffer) ? buffer : toEbcdic(String(buffer));
  const data = stripTn3270EHeader(raw);
  if (data.length === 0) {
    return { command: undefined, orders: [], mode: 'empty' };
  }

  if (!looksLike3270DataStream(data)) {
    screen.write(decodeFallbackText(data));
    return { command: undefined, orders: [], mode: 'text' };
  }

  const command = data[0];
  const start = getPayloadStart(command, data);
  if (command === COMMANDS.eraseWrite || command === COMMANDS.eraseWriteAlternate) {
    screen.clear();
  } else if (command === COMMANDS.writeStructuredField) {
    return handleWriteStructuredField(data);
  } else if (command === COMMANDS.eraseAllUnprotected) {
    screen.eraseUnprotected();
    return { command, orders: ['eraseAllUnprotected'], mode: '3270' };
  }

  const orders = [];
  for (let i = start; i < data.length; i += 1) {
    const byte = data[i];
    if (byte === ORDERS.sba) {
      const address = decodeAddress(data[i + 1], data[i + 2], screen.rows, screen.cols);
      screen.setAddress(address);
      orders.push('sba');
      i += 2;
    } else if (byte === ORDERS.sf) {
      screen.startField(data[i + 1] ?? 0x00);
      orders.push('sf');
      i += 1;
    } else if (byte === ORDERS.sfe) {
      const pairCount = data[i + 1] ?? 0;
      const attributes = {};
      for (let pair = 0; pair < pairCount; pair += 1) {
        const type = data[i + 2 + pair * 2];
        const value = data[i + 3 + pair * 2];
        attributes[type] = value;
      }
      screen.startField(attributes[0xc0] ?? 0x00, attributes);
      orders.push('sfe');
      i += 1 + pairCount * 2;
    } else if (byte === ORDERS.ic) {
      screen.setInsertCursor();
      orders.push('ic');
    } else if (byte === ORDERS.pt) {
      screen.tabToNextUnprotectedField();
      orders.push('pt');
    } else if (byte === ORDERS.ra) {
      const address = decodeAddress(data[i + 1], data[i + 2], screen.rows, screen.cols);
      screen.repeatToAddress(address, ebcdicByteToAscii(data[i + 3] ?? 0x40));
      orders.push('ra');
      i += 3;
    } else if (byte === ORDERS.eua) {
      const address = decodeAddress(data[i + 1], data[i + 2], screen.rows, screen.cols);
      screen.eraseUnprotectedToAddress(address);
      orders.push('eua');
      i += 2;
    } else if (byte === ORDERS.sa) {
      screen.setGraphicAttribute(data[i + 1], data[i + 2]);
      orders.push('sa');
      i += 2;
    } else if (byte === ORDERS.mf) {
      const pairCount = data[i + 1] ?? 0;
      const attributes = {};
      for (let pair = 0; pair < pairCount; pair += 1) {
        const type = data[i + 2 + pair * 2];
        const value = data[i + 3 + pair * 2];
        attributes[type] = value;
      }
      if (attributes[0xc0] !== undefined && pairCount === 1) {
        screen.modifyCurrentField(attributes[0xc0]);
      } else {
        screen.modifyCurrentFieldAttributes(attributes);
      }
      orders.push('mf');
      i += 1 + pairCount * 2;
    } else if (byte === ORDERS.ge) {
      i += 1;
      orders.push('ge');
    } else {
      screen.putChar(ebcdicByteToAscii(byte), { fromHost: true });
    }
  }

  return { command, orders, mode: '3270' };
}

function handleWriteStructuredField(data) {
  const responses = [];
  const orders = [];
  for (let offset = 1; offset + 1 < data.length;) {
    const length = data.readUInt16BE(offset);
    if (length < 3 || offset + length > data.length) {
      break;
    }
    const field = data.subarray(offset, offset + length);
    const id = field[2];
    if (id === 0x01) {
      orders.push('readPartition');
      const type = field[4];
      if (type === 0x02) {
        orders.push('query');
        responses.push(buildQueryReply());
      }
    }
    offset += length;
  }
  return {
    command: COMMANDS.writeStructuredField,
    orders,
    mode: '3270',
    response: responses.length > 0 ? Buffer.concat(responses) : undefined
  };
}

function buildQueryReply() {
  return Buffer.concat([
    Buffer.from([0x88]),
    // Usable Area Query Reply: 24 rows x 80 columns, character-cell display.
    Buffer.from([
      0x00, 0x17, 0x81, 0x81, 0x01, 0x00, 0x00, 0x50,
      0x00, 0x18, 0x01, 0x00, 0x01, 0x00, 0x03, 0x00,
      0x64, 0x00, 0xc4, 0x09, 0x0e, 0x07, 0x80
    ]),
    // Implicit Partition Query Reply: one 24x80 implicit partition.
    Buffer.from([
      0x00, 0x11, 0x81, 0xa6, 0x00, 0x00, 0x0b, 0x01,
      0x00, 0x00, 0x50, 0x00, 0x18, 0x00, 0x50, 0x00,
      0x18
    ]),
    // Color Query Reply: basic 3279 color support.
    Buffer.from([
      0x00, 0x12, 0x81, 0x86, 0x00, 0x00, 0x08, 0x00,
      0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
      0x00, 0x00
    ]),
    // Highlighting Query Reply: normal, blink, reverse, underscore.
    Buffer.from([
      0x00, 0x0b, 0x81, 0x87, 0x00, 0x00, 0x04, 0xf1,
      0xf2, 0xf4, 0xf8
    ])
  ]);
}

function getPayloadStart(command, data) {
  if (command === COMMANDS.write || command === COMMANDS.eraseWrite || command === COMMANDS.eraseWriteAlternate) {
    return data.length > 1 ? 2 : 1;
  }
  return Object.values(COMMANDS).includes(command) ? 1 : 0;
}

function looksLike3270DataStream(data) {
  if (Object.values(COMMANDS).includes(data[0]) || Object.values(ORDERS).includes(data[0])) {
    return true;
  }
  return asciiPrintableRatio(data) < 0.45;
}

function decodeFallbackText(data) {
  if (asciiPrintableRatio(data) >= 0.45) {
    return data.toString('utf8');
  }
  return [...data].map((byte) => ebcdicByteToAscii(byte)).join('');
}

function asciiPrintableRatio(data) {
  if (data.length === 0) {
    return 0;
  }
  const printable = [...data].filter((byte) => byte === 9 || byte === 10 || byte === 13 || (byte >= 0x20 && byte <= 0x7e)).length;
  return printable / data.length;
}

function stripTn3270EHeader(data) {
  if (data.length > 5 && data[0] <= 0x07 && data[1] === 0x00 && data[2] === 0x00 && data[3] === 0x00) {
    return data.subarray(5);
  }
  return data;
}

function buildInputBuffer(screen, aid) {
  const aidByte = typeof aid === 'number' ? aid : AID_BYTES[String(aid).toLowerCase()];
  if (aidByte === undefined) {
    throw new Error(`Unsupported AID key: ${aid}`);
  }
  const chunks = [Buffer.from([aidByte]), encodeAddress(rowColToAddress(screen.cursor.row, screen.cursor.col, screen.cols), screen.rows, screen.cols)];

  for (const field of screen.getModifiedFields()) {
    chunks.push(Buffer.from([ORDERS.sba]));
    chunks.push(encodeAddress(field.address, screen.rows, screen.cols));
    chunks.push(toEbcdic(field.text));
  }

  const unformatted = screen.getUnformattedInput();
  if (unformatted) {
    chunks.push(Buffer.from([ORDERS.sba]));
    chunks.push(encodeAddress(unformatted.address, screen.rows, screen.cols));
    chunks.push(toEbcdic(unformatted.text));
  }

  return Buffer.concat(chunks);
}

function describeInputBuffer(screen, aid) {
  return {
    aid,
    modifiedFields: screen.getModifiedFields().length,
    hasUnformattedInput: Boolean(screen.getUnformattedInput())
  };
}

function buildReadBuffer(screen) {
  const bytes = [];
  for (const cell of screen.iterCells()) {
    bytes.push(asciiCharToEbcdic(cell.char));
  }
  return Buffer.from(bytes);
}

module.exports = {
  AID_BYTES,
  COMMANDS,
  ORDERS,
  applyDataStream,
  buildQueryReply,
  decodeFallbackText,
  describeInputBuffer,
  buildInputBuffer,
  buildReadBuffer,
  getPayloadStart,
  looksLike3270DataStream,
  stripTn3270EHeader
};
