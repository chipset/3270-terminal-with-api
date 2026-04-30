# m3270 for VS Code

This is a small VS Code extension that provides a 24x80 3270-style emulator panel and a programmatic API for tests, course validators, or other extensions.

It now includes the core pieces needed for practical automation: TN3270-style telnet negotiation, optional TLS, EBCDIC translation, 3270 write-order parsing, field attributes, color/highlight attributes, modified-data tracking, AID input-buffer generation, keyboard/PF/PA controls, navigation helpers, and text/HTML/JSON/SVG screen snapshots.

## Run

Open this folder in VS Code and press `F5`, or package it as a normal extension. The command palette includes:

- `m3270: Open Emulator`
- `m3270: Connect`
- `m3270: Disconnect`
- `m3270: Enter`
- `m3270: PF1` through `m3270: PF24`
- `m3270: PA1` through `m3270: PA3`
- `m3270: Field Exit`
- `m3270: Next Field`
- `m3270: Previous Field`

Set defaults with:

- `m3270.hostname`
- `m3270.port`
- `m3270.secure`
- `m3270.rejectUnauthorized`
- `m3270.terminalType`
- `m3270.deviceName`

## API

Other VS Code extensions can get the API returned from activation:

```js
const extension = vscode.extensions.getExtension('local.m3270');
const api = await extension.activate();

await api.connect({ host: 'mainframe.example.com', port: 23 });
api.sendText('TSO');
api.enter();
api.pressPf(3);
api.pressPa(1);

const text = api.getScreenshot({ trimRight: true });
const svg = api.getScreenshot({ format: 'svg' });
const connection = api.getConnectionStatus();
const snapshot = api.getSnapshot();
const fields = api.getFields();
```

`api.getConnectionStatus()` returns:

```js
{
  connected: true,
  connecting: false,
  host: 'mainframe.example.com',
  systemName: 'mainframe.example.com',
  address: 'mainframe.example.com',
  port: 23,
  secure: false,
  lastError: ''
}
```

For tests or headless validation, use the session directly:

```js
const { EmulatorSession } = require('./lib/emulator');

const session = new EmulatorSession();
session.receive('READY');
session.navigate([
  { type: 'cursor', row: 1, col: 0 },
  { type: 'text', value: 'LISTCAT' },
  { type: 'enter' }
]);

console.log(session.getScreenshot({ trimRight: true }));
```

An Instrktr validator can use the installed VS Code extension API like this:

```js
module.exports = async function validate(ctx) {
  const vscode = require('vscode');
  const extension = vscode.extensions.getExtension('local.m3270');

  if (!extension) {
    return { status: 'fail', message: 'm3270 extension is not installed.' };
  }

  const api = await extension.activate();
  await api.connect({ host: 'mainframe.example.com', port: 23, secure: false });

  const connection = api.getConnectionStatus();
  if (!connection.connected) {
    return {
      status: 'fail',
      message: `m3270 is not connected: ${connection.lastError || 'no connection'}`
    };
  }

  if (connection.systemName !== 'mainframe.example.com') {
    return {
      status: 'fail',
      message: `Connected to ${connection.systemName}, expected mainframe.example.com.`
    };
  }

  api.navigate([
    { type: 'text', value: 'TSO' },
    { type: 'enter' },
    { type: 'pf', number: 3 }
  ]);

  const screenText = api.getScreenshot({ trimRight: true });
  if (!screenText.includes('READY')) {
    return {
      status: 'fail',
      message: `Expected READY on the 3270 screen.\n\nScreen:\n${screenText}`
    };
  }

  return {
    status: 'pass',
    message: `Connected to ${connection.systemName}:${connection.port} and found READY.`
  };
};
```

Supported host data-stream pieces include Write, Erase/Write, Erase All Unprotected, SBA, SF, SFE, IC, PT, RA, EUA, SA, MF, and GE handling. Input buffers include AID, cursor address, and modified unprotected fields. SFE, SA, and MF support foreground color and highlighting attributes in snapshots, SVG screenshots, and the VS Code webview.

## Validate

Run the local tests:

```sh
npm test
```

To validate with Instrktr without modifying `instrktr-engine`, open the course folder:

```text
m3270/instrktr-validation
```

Then run **Instrktr: Check My Work**. The validation course checks that the emulator project exposes the API, supports navigation, captures screen snapshots, and sends PF-key AID bytes.

## Current limits

This is still a compact emulator, not a drop-in replacement for mature clients such as x3270. The current parser covers common orders and field behavior but does not yet implement every 3270 model, color/highlight rendering mode, printer session, file transfer mode, macro language, or every TN3270E edge case.
