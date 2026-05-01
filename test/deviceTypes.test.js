'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EmulatorSession } = require('../lib/emulator');
const { buildTerminalType, parseTerminalType, supportedTerminalTypes, terminalSize } = require('../lib/deviceTypes');

test('enumerates 3278 and 3279 models 2-5 with base and extended variants', () => {
  const types = supportedTerminalTypes();
  assert.equal(types.length, 16);
  assert.ok(types.includes('IBM-3278-2'));
  assert.ok(types.includes('IBM-3278-5-E'));
  assert.ok(types.includes('IBM-3279-4'));
  assert.ok(types.includes('IBM-3279-5-E'));
});

test('maps device models to 3270 screen dimensions', () => {
  assert.deepEqual(terminalSize('IBM-3278-2'), { rows: 24, cols: 80 });
  assert.deepEqual(terminalSize('IBM-3279-3-E'), { rows: 32, cols: 80 });
  assert.deepEqual(terminalSize('IBM-3278-4-E'), { rows: 43, cols: 80 });
  assert.deepEqual(terminalSize('IBM-3279-5-E'), { rows: 27, cols: 132 });
});

test('normalizes terminal type family, model, and extended attributes', () => {
  assert.deepEqual(parseTerminalType('ibm-3278-5-e@LU001'), {
    terminalType: 'IBM-3278-5-E',
    family: '3278',
    model: '5',
    extended: true,
    rows: 27,
    cols: 132,
    deviceName: 'LU001',
    valid: true
  });
  assert.equal(buildTerminalType({ family: '3279', model: '4', extended: false }), 'IBM-3279-4');
});

test('emulator session sizes itself from the selected terminal type', () => {
  const session = new EmulatorSession({ terminalType: 'IBM-3279-5-E' });
  assert.equal(session.getSnapshot().screen.rows, 27);
  assert.equal(session.getSnapshot().screen.cols, 132);
  session.setTerminalType('IBM-3278-3');
  assert.equal(session.getSnapshot().screen.rows, 32);
  assert.equal(session.getSnapshot().screen.cols, 80);
  assert.equal(session.options.terminalType, 'IBM-3278-3');
});

const { COMMANDS, isLikelyTn3270EHeader, stripTn3270EHeader } = require('../lib/datastream');

test('strips TN3270E data headers with non-zero flags and sequence numbers', () => {
  const payload = Buffer.from([COMMANDS.eraseWrite, 0x00]);
  const framed = Buffer.concat([Buffer.from([0x00, 0x01, 0x02, 0x12, 0x34]), payload]);
  assert.equal(isLikelyTn3270EHeader(framed), true);
  assert.deepEqual(stripTn3270EHeader(framed), payload);
});
