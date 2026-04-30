module.exports = async function validate(ctx) {
  const path = require('path');
  const root = path.resolve(__dirname, '../../..');
  const { encodeAddress } = require(path.join(root, 'lib/addressing'));
  const { COMMANDS, ORDERS } = require(path.join(root, 'lib/datastream'));
  const { toEbcdic } = require(path.join(root, 'lib/ebcdic'));
  const { EmulatorSession } = require(path.join(root, 'lib/emulator'));

  const session = new EmulatorSession();
  const sent = [];
  session.client.on('offlineWrite', (buffer) => sent.push([...buffer]));

  session.navigate([
    { type: 'receive', value: 'WELCOME\r\nCOMMAND ===>' },
    { type: 'cursor', row: 1, col: 12 },
    { type: 'text', value: 'LOGON' },
    { type: 'enter' },
    { type: 'pf', number: 3 }
  ]);

  const screenshot = session.getScreenshot({ trimRight: true });
  if (!screenshot.includes('WELCOME') || !screenshot.includes('COMMAND ===>LOGON')) {
    return {
      status: 'fail',
      message: 'The emulator did not capture the expected screen text.'
    };
  }

  const snapshot = session.getSnapshot();
  if (snapshot.screen.rows !== 24 || snapshot.screen.cols !== 80) {
    return {
      status: 'fail',
      message: 'The emulator must expose a 24x80 screen snapshot.'
    };
  }

  if (sent.at(-2)[0] !== 0x7d || JSON.stringify(sent.at(-2).slice(-2)) !== JSON.stringify([0xff, 0xef])) {
    return {
      status: 'fail',
      message: 'Enter did not send the expected framed AID input buffer.'
    };
  }

  if (sent.at(-1)[0] !== 0xf3 || JSON.stringify(sent.at(-1).slice(-2)) !== JSON.stringify([0xff, 0xef])) {
    return {
      status: 'fail',
      message: 'PF3 did not send the expected framed AID input buffer.'
    };
  }

  session.receiveDataStream(Buffer.concat([
    Buffer.from([COMMANDS.eraseWrite, ORDERS.sba]),
    encodeAddress(0),
    Buffer.from([ORDERS.sfe, 3, 0xc0, 0x00, 0x42, 0xf2, 0x41, 0xf4]),
    toEbcdic('COLOR')
  ]));
  const styled = session.getSnapshot().screen.cells[1];
  if (styled.color !== 'red' || styled.underscore !== true) {
    return {
      status: 'fail',
      message: 'The emulator did not expose 3270 color/highlight attributes in snapshots.'
    };
  }

  return {
    status: 'pass',
    message: '3270 emulator API, navigation, screenshots, and PF keys are working.'
  };
};
