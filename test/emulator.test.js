'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { encodeAddress } = require('../lib/addressing');
const { COMMANDS, ORDERS, buildQueryReply } = require('../lib/datastream');
const { toEbcdic } = require('../lib/ebcdic');
const { EmulatorSession } = require('../lib/emulator');
const { IAC, Telnet3270Client, addTn3270EDataHeader, stripTelnetControls } = require('../lib/telnet3270');

test('writes host output and captures a fixed 24x80 text screenshot', () => {
  const session = new EmulatorSession();
  session.receive('LOGON APPLID\r\nUSERID ===>');

  const screenshot = session.getScreenshot({ trimRight: true });
  assert.match(screenshot, /^LOGON APPLID\nUSERID ===>/u);
  assert.equal(session.getSnapshot().screen.rows, 24);
  assert.equal(session.getSnapshot().screen.cols, 80);
});

test('navigates screens with text, cursor movement, enter, and PF keys while offline', () => {
  const session = new EmulatorSession();
  const sent = [];
  session.client.on('offlineWrite', (buffer) => sent.push([...buffer]));

  session.navigate([
    { type: 'receive', value: 'READY' },
    { type: 'cursor', row: 2, col: 4 },
    { type: 'text', value: 'LISTCAT' },
    { type: 'enter' },
    { type: 'pf', number: 3 }
  ]);

  assert.equal(session.getSnapshot().screen.cursor.row, 2);
  assert.match(session.getSnapshot().screen.lines[2], /^ {4}LISTCAT/u);
  assert.equal(sent.at(-2)[0], 0x7d);
  assert.deepEqual(sent.at(-2).slice(-2), [0xff, 0xef]);
  assert.equal(sent.at(-1)[0], 0xf3);
  assert.deepEqual(sent.at(-1).slice(-2), [0xff, 0xef]);
});

test('reports connection status for API validators', () => {
  const session = new EmulatorSession({ host: 'mainframe.example.com', port: 23, secure: false });

  session.connection.connected = true;

  assert.deepEqual(session.getConnectionStatus(), {
    connected: true,
    connecting: false,
    host: 'mainframe.example.com',
    systemName: 'mainframe.example.com',
    address: 'mainframe.example.com',
    port: 23,
    secure: false,
    lastError: '',
    lastReceive: undefined
  });
  assert.equal(session.getSnapshot().connection.systemName, 'mainframe.example.com');
});

test('strips telnet negotiation bytes before screen rendering', () => {
  const stripped = stripTelnetControls(Buffer.from([255, 251, 24, 72, 73, 255, 255]));

  assert.deepEqual([...stripped], [72, 73, 255]);
});

test('applies erase-write, SBA, field attributes, and EBCDIC text', () => {
  const session = new EmulatorSession();
  const buffer = Buffer.concat([
    Buffer.from([COMMANDS.eraseWrite, 0xc7, ORDERS.sba]),
    encodeAddress(0),
    Buffer.from([ORDERS.sf, 0x20]),
    toEbcdic('USERID ===>'),
    Buffer.from([ORDERS.sba]),
    encodeAddress(12),
    Buffer.from([ORDERS.sf, 0x00])
  ]);

  session.receiveDataStream(buffer);
  session.sendText('IBMUSER');

  const snapshot = session.getSnapshot();
  assert.match(snapshot.screen.lines[0], /^ USERID ===> IBMUSER/u);
  assert.equal(snapshot.screen.fields[0].protected, true);
  assert.equal(snapshot.screen.fields[1].protected, false);
  assert.equal(snapshot.screen.fields[1].modified, true);
});

test('sends modified unprotected fields after AID and cursor address', () => {
  const session = new EmulatorSession();
  const sent = [];
  session.client.on('offlineWrite', (buffer) => sent.push([...buffer]));

  session.receiveDataStream(Buffer.concat([
    Buffer.from([COMMANDS.eraseWrite, 0xc7, ORDERS.sba]),
    encodeAddress(0),
    Buffer.from([ORDERS.sf, 0x00])
  ]));
  session.sendText('LOGON');
  session.enter();

  const payload = sent.at(-1);
  assert.equal(payload[0], 0x7d);
  assert.equal(payload[3], ORDERS.sba);
  assert.deepEqual(payload.slice(-2), [0xff, 0xef]);
});

test('sends typed text on unformatted screens when Enter is pressed', () => {
  const session = new EmulatorSession();
  const sent = [];
  session.client.on('offlineWrite', (buffer) => sent.push([...buffer]));

  session.sendText('LOGON APPLID');
  session.enter();

  const payload = sent.at(-1);
  assert.equal(payload[0], 0x7d);
  assert.equal(payload[3], ORDERS.sba);
  assert.ok(payload.length > 8);
  assert.deepEqual(payload.slice(-2), [0xff, 0xef]);
  assert.equal(session.getSnapshot().screen.cells.some((cell) => cell.modified), false);
});

test('reports transmitted AID byte counts', () => {
  const session = new EmulatorSession();
  let event;
  session.on('aid', (aidEvent) => {
    event = aidEvent;
  });

  session.sendText('PING');
  session.enter();

  assert.equal(event.aid, 'enter');
  assert.ok(event.bytes > 3);
});

test('supports PA keys, field exit, read buffer, and SVG screenshots', () => {
  const session = new EmulatorSession();
  const sent = [];
  session.client.on('offlineWrite', (buffer) => sent.push([...buffer]));

  session.receiveDataStream(Buffer.concat([
    Buffer.from([COMMANDS.eraseWrite, 0xc7, ORDERS.sba]),
    encodeAddress(0),
    Buffer.from([ORDERS.sf, 0x00])
  ]));
  session.sendText('ABC');
  session.perform({ type: 'fieldExit' });
  session.pa(1);

  assert.equal(sent.at(-1)[0], 0x6c);
  assert.ok(Buffer.isBuffer(session.getReadBuffer()));
  assert.match(session.getScreenshot({ format: 'svg' }), /^<svg/u);
});

test('moves backward to the previous unprotected field', () => {
  const session = new EmulatorSession();

  session.receiveDataStream(Buffer.concat([
    Buffer.from([COMMANDS.eraseWrite, 0xc7, ORDERS.sba]),
    encodeAddress(0),
    Buffer.from([ORDERS.sf, 0x20]),
    toEbcdic('LABEL'),
    Buffer.from([ORDERS.sba]),
    encodeAddress(10),
    Buffer.from([ORDERS.sf, 0x00]),
    toEbcdic('FIRST'),
    Buffer.from([ORDERS.sba]),
    encodeAddress(20),
    Buffer.from([ORDERS.sf, 0x00]),
    toEbcdic('SECOND')
  ]));

  session.perform({ type: 'cursor', row: 0, col: 23 });
  session.perform({ type: 'backtab' });

  assert.deepEqual(session.getSnapshot().screen.cursor, { row: 0, col: 11 });
});

test('applies extended color and highlight attributes from SFE and SA orders', () => {
  const session = new EmulatorSession();

  session.receiveDataStream(Buffer.concat([
    Buffer.from([COMMANDS.eraseWrite, 0xc7, ORDERS.sba]),
    encodeAddress(0),
    Buffer.from([ORDERS.sfe, 3, 0xc0, 0x00, 0x42, 0xf2, 0x41, 0xf4]),
    toEbcdic('REDU'),
    Buffer.from([ORDERS.sa, 0x42, 0xf6, ORDERS.sa, 0x41, 0xf2]),
    toEbcdic('REV')
  ]));

  const snapshot = session.getSnapshot();
  assert.equal(snapshot.screen.fields[0].graphic.color, 'red');
  assert.equal(snapshot.screen.fields[0].graphic.highlight, 'underscore');
  assert.equal(snapshot.screen.cells[1].color, 'red');
  assert.equal(snapshot.screen.cells[1].underscore, true);
  assert.equal(snapshot.screen.cells[5].color, 'yellow');
  assert.equal(snapshot.screen.cells[5].reverse, true);
  assert.match(session.getScreenshot({ format: 'svg' }), /fill="#ffe66d"/u);
});

test('maps compact color bytes and extended 3279 palette', () => {
  const session = new EmulatorSession();

  session.receiveDataStream(Buffer.concat([
    Buffer.from([COMMANDS.eraseWrite, 0xc7, ORDERS.sba]),
    encodeAddress(0),
    Buffer.from([ORDERS.sfe, 2, 0xc0, 0x00, 0x42, 0x02]),
    toEbcdic('X'),
    Buffer.from([ORDERS.sba]),
    encodeAddress(2),
    Buffer.from([ORDERS.sfe, 2, 0xc0, 0x00, 0x42, 0xf9]),
    toEbcdic('Y')
  ]));

  const snapshot = session.getSnapshot();
  assert.equal(snapshot.screen.cells[1].color, 'red');
  assert.equal(snapshot.screen.cells[3].color, 'deepBlue');
});

test('renders ASCII host banners instead of treating them as blank EBCDIC', () => {
  const session = new EmulatorSession();

  session.receiveDataStream(Buffer.from('Welcome to the host\r\nlogin: ', 'utf8'));

  assert.match(session.getScreenshot({ trimRight: true }), /^Welcome to the host\nlogin:/u);
  assert.equal(session.getSnapshot().connection.lastReceive.mode, 'text');
});

test('strips simple TN3270E headers before applying 3270 screen data', () => {
  const session = new EmulatorSession();
  const payload = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from([COMMANDS.eraseWrite, 0xc7]),
    toEbcdic('HELLO')
  ]);

  session.receiveDataStream(payload);

  assert.match(session.getScreenshot({ trimRight: true }), /^HELLO/u);
  assert.equal(session.getSnapshot().connection.lastReceive.mode, '3270');
});

test('does not render the write control character as a stray P', () => {
  const session = new EmulatorSession();

  session.receiveDataStream(Buffer.concat([
    Buffer.from([COMMANDS.eraseWrite, 0xd7]),
    toEbcdic('LOGON')
  ]));

  assert.match(session.getScreenshot({ trimRight: true }), /^LOGON/u);
  assert.doesNotMatch(session.getSnapshot().screen.lines[0], /^PLOGON/u);
});

test('requests TN3270E functions after device-type IS and wraps after functions IS', () => {
  const client = new Telnet3270Client();
  const sent = [];
  client.on('offlineWrite', (buffer) => sent.push([...buffer]));

  client.handleTelnet(Buffer.concat([
    Buffer.from([IAC, 0xfa, 40, 2, 4]),
    Buffer.from('IBM-3279-2-E\u0001A003TC017', 'ascii'),
    Buffer.from([IAC, 0xf0])
  ]));
  client.handleTelnet(Buffer.from([IAC, 0xfa, 40, 3, 4, IAC, 0xf0]));
  client.write(Buffer.from([0x7d, 0xc1, 0xc1]));

  assert.deepEqual(sent.at(-2), [IAC, 0xfa, 40, 3, 7, IAC, 0xf0]);
  assert.equal(client.tn3270e, true);
  assert.deepEqual(sent.at(-1).slice(0, 8), [0x00, 0x00, 0x00, 0x00, 0x00, 0x7d, 0xc1, 0xc1]);
  assert.deepEqual(sent.at(-1).slice(-2), [0xff, 0xef]);
});

test('answers TN3270E functions requests from the host', () => {
  const client = new Telnet3270Client();
  const sent = [];
  client.on('offlineWrite', (buffer) => sent.push([...buffer]));

  client.handleTelnet(Buffer.from([IAC, 0xfa, 40, 3, 7, 0x02, IAC, 0xf0]));

  assert.equal(client.tn3270e, true);
  assert.deepEqual(sent.at(-1), [IAC, 0xfa, 40, 3, 4, 0x02, IAC, 0xf0]);
});

test('builds TN3270E data headers with sequence numbers', () => {
  assert.deepEqual([...addTn3270EDataHeader(Buffer.from([0x7d]), 258)], [0, 0, 0, 1, 2, 0x7d]);
});

test('answers write structured field read partition query', () => {
  const session = new EmulatorSession();
  const sent = [];
  session.client.on('offlineWrite', (buffer) => sent.push([...buffer]));

  session.receiveDataStream(Buffer.from([COMMANDS.writeStructuredField, 0x00, 0x05, 0x01, 0xff, 0x02]));

  assert.equal(session.getSnapshot().connection.lastReceive.mode, '3270');
  assert.equal(sent.at(-1)[0], 0x88);
  assert.deepEqual(sent.at(-1).slice(0, buildQueryReply().length), [...buildQueryReply()]);
  assert.deepEqual(sent.at(-1).slice(-2), [0xff, 0xef]);
});

test('moves typing from protected screen text to the next unprotected field', () => {
  const session = new EmulatorSession();

  session.receiveDataStream(Buffer.concat([
    Buffer.from([COMMANDS.eraseWrite, 0xc7, ORDERS.sba]),
    encodeAddress(0),
    Buffer.from([ORDERS.sf, 0x20]),
    toEbcdic('USER '),
    Buffer.from([ORDERS.sba]),
    encodeAddress(10),
    Buffer.from([ORDERS.sf, 0x00])
  ]));
  session.perform({ type: 'cursor', row: 0, col: 2 });
  session.sendText('A');

  assert.equal(session.getSnapshot().screen.lines[0][11], 'A');
  assert.equal(session.getSnapshot().screen.oia.inputInhibited, false);
});

test('records the cursor location from IC orders', () => {
  const session = new EmulatorSession();

  session.receiveDataStream(Buffer.concat([
    Buffer.from([COMMANDS.eraseWrite, 0xc7, ORDERS.sba]),
    encodeAddress(42),
    Buffer.from([ORDERS.ic])
  ]));

  assert.deepEqual(session.getSnapshot().screen.cursor, { row: 0, col: 42 });
  assert.deepEqual(session.getSnapshot().screen.insertCursor, { row: 0, col: 42 });
});
