# m3270 for VS Code

This is a small VS Code extension that provides a TN3270/TN3270E-style emulator panel and a programmatic API for tests, course validators, or other extensions.

It now includes the core pieces needed for practical automation: TN3270E-aware telnet negotiation, optional TLS, EBCDIC translation, 3270 write-order parsing, field attributes, color/highlight attributes, modified-data tracking, AID input-buffer generation, IBM 3278/3279 models 2-5, multiple concurrent sessions, keyboard/PF/PA controls, configurable key remapping, copy/paste, navigation helpers, and text/HTML/JSON/SVG screen snapshots.

## Run

Open this folder in VS Code and press `F5`, or package it as a normal extension. The command palette includes:

- `m3270: Open Emulator`
- `m3270: Connect`
- `m3270: Disconnect`
- `m3270: New Session`
- `m3270: Enter`
- `m3270: PF1` through `m3270: PF24`
- `m3270: PA1` through `m3270: PA3`
- `m3270: Field Exit`
- `m3270: Next Field`
- `m3270: Previous Field`

To build the current package version and install it into VS Code, run:

```sh
npm run install:vscode
```

If the VS Code CLI is not on `PATH`, set `VSCODE_BIN` to the `code` executable path before running the script.

Set defaults with:

- `m3270.hostname`
- `m3270.port`
- `m3270.secure`
- `m3270.rejectUnauthorized`
- `m3270.terminalType`
- `m3270.deviceName`
- `m3270.connectionTimeoutMs`
- `m3270.keepSessionsInBackground`
- `m3270.keymap`

### Sessions, device types, and keyboard mapping

The Explorer view includes **m3270 Sessions**. Use it to create, switch, connect, and disconnect concurrent host sessions. The active emulator panel follows the selected session. By default, sessions keep running in the background when the terminal view is closed; set `m3270.keepSessionsInBackground` to `false` to disconnect all sessions on terminal close.

`m3270.terminalType` supports the IBM 3278 and 3279 model matrix: models 2, 3, 4, and 5, with or without the `-E` extended-attributes suffix. The screen buffer resizes to 24x80, 32x80, 43x80, or 27x132 based on the selected terminal type.

`m3270.keymap` lets you override terminal keyboard behavior. Example:

```json
{
  "m3270.keymap": {
    "ctrl+1": "pf1",
    "ctrl+shift+1": "pf11",
    "alt+enter": "enter",
    "home": "pa1",
    "ctrl+l": "clear",
    "ctrl+v": "text:LOGON "
  }
}
```

The terminal toolbar and native clipboard events support copying selected/full screen text and pasting text at the current cursor.

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

Supported host data-stream pieces include Write, Erase/Write, Erase All Unprotected, Write Structured Field query replies, TN3270E data headers with non-zero flags/sequence numbers, SBA, SF, SFE, IC, PT, RA, EUA, SA, MF, and GE handling. Input buffers include AID, cursor address, and modified unprotected fields. SFE, SA, and MF support foreground color and highlighting attributes in snapshots, SVG screenshots, and the terminal panel.

## Validate

Run the local tests:

```sh
npm test
```

To validate with Instrktr without modifying `instrktr-engine`, open the course folder:

```text
m3270/instrktr-validation
```

Then run **Instrktr: Check My Work**. The validation course checks that the emulator project exposes the API, supports navigation, captures screen snapshots, sends PF-key AID bytes, and includes the Endevor main-screen validator used by the tests.

## Current limits

This is still a compact emulator, not a drop-in replacement for mature clients such as x3270. The current parser covers common orders, field behavior, 3278/3279 display model sizes, and common TN3270E negotiation/data framing, but does not implement printer sessions, file transfer mode, macro language, or every host-specific TN3270E edge case.
