'use strict';

const ASCII_TO_EBCDIC = new Map();
const EBCDIC_TO_ASCII = new Map();

const PAIRS = [
  [0x00, '\u0000'], [0x05, '\t'], [0x0d, '\r'], [0x15, '\n'], [0x25, '\n'],
  [0x40, ' '], [0x4a, '['], [0x4b, '.'], [0x4c, '<'], [0x4d, '('], [0x4e, '+'], [0x4f, '|'],
  [0x50, '&'], [0x5a, ']'], [0x5b, '$'], [0x5c, '*'], [0x5d, ')'], [0x5e, ';'], [0x5f, '^'],
  [0x60, '-'], [0x61, '/'], [0x6a, '|'], [0x6b, ','], [0x6c, '%'], [0x6d, '_'], [0x6e, '>'], [0x6f, '?'],
  [0x79, '`'], [0x7a, ':'], [0x7b, '#'], [0x7c, '@'], [0x7d, '\''], [0x7e, '='], [0x7f, '"'],
  [0x81, 'a'], [0x82, 'b'], [0x83, 'c'], [0x84, 'd'], [0x85, 'e'], [0x86, 'f'], [0x87, 'g'], [0x88, 'h'], [0x89, 'i'],
  [0x91, 'j'], [0x92, 'k'], [0x93, 'l'], [0x94, 'm'], [0x95, 'n'], [0x96, 'o'], [0x97, 'p'], [0x98, 'q'], [0x99, 'r'],
  [0xa1, '~'], [0xa2, 's'], [0xa3, 't'], [0xa4, 'u'], [0xa5, 'v'], [0xa6, 'w'], [0xa7, 'x'], [0xa8, 'y'], [0xa9, 'z'],
  [0xc0, '{'], [0xc1, 'A'], [0xc2, 'B'], [0xc3, 'C'], [0xc4, 'D'], [0xc5, 'E'], [0xc6, 'F'], [0xc7, 'G'], [0xc8, 'H'], [0xc9, 'I'],
  [0xd0, '}'], [0xd1, 'J'], [0xd2, 'K'], [0xd3, 'L'], [0xd4, 'M'], [0xd5, 'N'], [0xd6, 'O'], [0xd7, 'P'], [0xd8, 'Q'], [0xd9, 'R'],
  [0xe0, '\\'], [0xe2, 'S'], [0xe3, 'T'], [0xe4, 'U'], [0xe5, 'V'], [0xe6, 'W'], [0xe7, 'X'], [0xe8, 'Y'], [0xe9, 'Z'],
  [0xf0, '0'], [0xf1, '1'], [0xf2, '2'], [0xf3, '3'], [0xf4, '4'], [0xf5, '5'], [0xf6, '6'], [0xf7, '7'], [0xf8, '8'], [0xf9, '9']
];

for (const [code, char] of PAIRS) {
  EBCDIC_TO_ASCII.set(code, char);
  if (!ASCII_TO_EBCDIC.has(char)) {
    ASCII_TO_EBCDIC.set(char, code);
  }
}

function toAscii(buffer) {
  return [...buffer].map((byte) => EBCDIC_TO_ASCII.get(byte) ?? ' ').join('');
}

function toEbcdic(text) {
  return Buffer.from([...String(text)].map((char) => ASCII_TO_EBCDIC.get(char) ?? 0x6f));
}

function ebcdicByteToAscii(byte) {
  return EBCDIC_TO_ASCII.get(byte) ?? ' ';
}

function asciiCharToEbcdic(char) {
  return ASCII_TO_EBCDIC.get(String(char)[0] ?? ' ') ?? 0x6f;
}

module.exports = {
  asciiCharToEbcdic,
  ebcdicByteToAscii,
  toAscii,
  toEbcdic
};
