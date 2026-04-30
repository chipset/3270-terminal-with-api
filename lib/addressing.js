'use strict';

const ADDRESS_CHARS = [
  0x40, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
  0xc8, 0xc9, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f,
  0x50, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7,
  0xd8, 0xd9, 0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f,
  0x60, 0x61, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7,
  0xe8, 0xe9, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x6f,
  0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7,
  0xf8, 0xf9, 0x7a, 0x7b, 0x7c, 0x7d, 0x7e, 0x7f
];

const ADDRESS_VALUES = new Map(ADDRESS_CHARS.map((byte, index) => [byte, index]));

function encodeAddress(address, rows = 24, cols = 80) {
  const size = rows * cols;
  const normalized = ((Number(address) || 0) % size + size) % size;
  return Buffer.from([
    ADDRESS_CHARS[(normalized >> 6) & 0x3f],
    ADDRESS_CHARS[normalized & 0x3f]
  ]);
}

function decodeAddress(first, second, rows = 24, cols = 80) {
  const high = ADDRESS_VALUES.get(first);
  const low = ADDRESS_VALUES.get(second);
  if (high !== undefined && low !== undefined) {
    return ((high << 6) | low) % (rows * cols);
  }
  return (((first & 0x3f) << 8) | second) % (rows * cols);
}

function rowColToAddress(row, col, cols = 80) {
  return (Number(row) || 0) * cols + (Number(col) || 0);
}

function addressToRowCol(address, cols = 80) {
  return {
    row: Math.floor((Number(address) || 0) / cols),
    col: (Number(address) || 0) % cols
  };
}

module.exports = {
  addressToRowCol,
  decodeAddress,
  encodeAddress,
  rowColToAddress
};
