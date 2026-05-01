# m3270 Architecture

m3270 is a VS Code extension that provides a compact TN3270/TN3270E terminal emulator and a programmatic automation API. The project is implemented in CommonJS JavaScript and is split between a VS Code integration layer (`extension.js`) and emulator/networking primitives in `lib/`.

## High-level design

```text
VS Code commands / webviews / extension API
                |
                v
        extension.js
  session management, settings, UI panels,
  snapshot mirroring, command registration
                |
                v
        EmulatorSession (lib/emulator.js)
  public emulator API, connection state,
  input/navigation commands, screenshots
        |                         |
        v                         v
 ScreenBuffer (lib/screen.js)   Telnet3270Client (lib/telnet3270.js)
 screen cells, fields, cursor,  TCP/TLS sockets, Telnet negotiation,
 protected input, attributes    TN3270E framing, EOR handling
        ^                         |
        |                         v
 3270 data-stream parser <--- host bytes / outbound AID buffers
        (lib/datastream.js)
```

The extension keeps one active `EmulatorSession` and can manage multiple named sessions. Each session owns its own screen buffer and telnet client. Host output is decoded into the screen buffer; user actions update the buffer and/or send 3270 AID input buffers back to the host.

## Runtime entry point: `extension.js`

`extension.js` is the extension main file declared by `package.json` (`"main": "./extension.js"`). Its `activate(context)` function wires the VS Code-facing surface:

- Creates the `m3270` output channel.
- Creates the first managed `EmulatorSession` from VS Code settings.
- Registers commands such as `m3270.open`, `m3270.connect`, `m3270.disconnect`, `m3270.enter`, `m3270.clear`, `m3270.pf1`-`m3270.pf24`, `m3270.pa1`-`m3270.pa3`, and session-management commands.
- Registers the Explorer tree view `m3270.sessions`.
- Opens and coordinates three webview panels:
  - the emulator terminal panel,
  - the connection settings panel,
  - the color/appearance settings panel.
- Returns an activation API for tests, validators, or other extensions.

The returned API exposes core operations such as `connect`, `disconnect`, `sendText`, `sendAid`, `pressPf`, `pressPa`, `enter`, `clear`, `navigate`, `getConnectionStatus`, `getFields`, `getReadBuffer`, `getScreenText`, `getScreenshot`, and `getSnapshot`.

### Sessions

Managed sessions are stored in a module-level `Map` keyed by generated IDs (`session-1`, `session-2`, ...). A managed record contains:

- the display name,
- its `EmulatorSession`,
- normalized connection settings.

`SessionsProvider` and `SessionTreeItem` render those records in the Explorer view. Switching a session updates `activeSession`/`activeSessionId`, refreshes the webview snapshot, and reveals the emulator panel. The `m3270.keepSessionsInBackground` setting controls whether sessions are disconnected when the terminal webview closes.

### Webviews and UI messaging

The emulator webview renders each screen cell as a styled `<span>` inside a `<pre>`. It receives `snapshot` messages from the extension with:

- connection status,
- screen rows/columns/cursor/cells,
- rendered screen text,
- resolved terminal colors,
- configured keymap.

User events flow back to the extension using `webview.postMessage` commands:

- text input and paste: `input`,
- AID keys: `aid`,
- cursor clicks/arrows: `cursor`,
- field navigation: `tab`, `backtab`, `fieldExit`,
- connection/session actions: `connect`, `disconnect`, `newSession`, `settings`, `colors`.

The webview handles native keyboard mappings, custom `m3270.keymap` overrides, toolbar buttons, copy/paste, cursor movement, and rendering of color/highlight attributes.

### Snapshot mirroring

Every posted snapshot is also mirrored as JSON by `mirrorSnapshotToWorkspaces()` to several locations, including workspace `.m3270/snapshot.json`, home `~/.m3270/snapshot.json`, and `/tmp/m3270-snapshot.json`. This lets external validation tooling inspect current terminal state without calling the VS Code API directly.

## Core emulator: `lib/emulator.js`

`EmulatorSession` is the central domain object. It extends `EventEmitter` and composes:

- `ScreenBuffer` for in-memory screen state,
- `Telnet3270Client` for host communication,
- the data-stream helpers for inbound host bytes and outbound input buffers.

Important responsibilities:

- connection lifecycle (`connect`, `disconnect`, reconnect scheduling),
- terminal sizing from terminal type,
- receiving plain text or 3270 data streams,
- sending text and AID keys (`enter`, `clear`, `pf`, `pa`, `sendAid`),
- high-level navigation (`navigate`, `perform`),
- API snapshots and screenshots (`text`, `json`, `html`, `svg`),
- emitting `update`, `trace`, `datastream`, and `aid` events.

When host data arrives, `receiveDataStream()` calls `applyDataStream(data, this.screen)`. If the parser returns a structured-field response, the session writes it back through the telnet client. After state changes, it emits an `update` event consumed by `extension.js`.

When the user presses Enter/PF/PA/Clear, `sendAid()` builds an input buffer from the current cursor address plus modified fields, writes it to the telnet client, clears modified flags, emits an `aid` event, and publishes a new snapshot.

## Screen model: `lib/screen.js`

`ScreenBuffer` models the 3270 display as a fixed-size array of cells plus a field table.

Each cell tracks:

- address and character,
- field association,
- field-start marker,
- protected/numeric/intensified/hidden/modified flags,
- color and highlight attributes,
- cursor-related rendering metadata.

Each field tracks the field start address, base field attribute byte, extended attributes, decoded protection/visibility flags, and graphic attributes.

Key behaviors include:

- writing plain text at the current cursor,
- respecting protected fields for user input,
- field creation and modification (`SF`, `SFE`, `MF`),
- stream graphic attributes (`SA`),
- tab/backtab through unprotected fields,
- field exit clearing,
- erase-unprotected operations,
- collecting modified fields for outbound input buffers,
- generating text lines and JSON snapshots.

This module is intentionally UI-independent: it only maintains terminal state and metadata.

## 3270 data-stream parser: `lib/datastream.js`

`datastream.js` translates between host data-stream bytes and `ScreenBuffer` operations. It defines:

- 3270 command bytes (`Write`, `Erase/Write`, `Erase/Write Alternate`, `Write Structured Field`, `Read Buffer`, `Read Modified`, `Erase All Unprotected`),
- 3270 order bytes (`SBA`, `SF`, `SFE`, `SA`, `MF`, `IC`, `PT`, `RA`, `EUA`, `GE`),
- AID bytes for Enter, Clear, PA1-PA3, and PF1-PF24.

Inbound processing:

1. Coerce text to EBCDIC if needed.
2. Strip a likely TN3270E data header.
3. Detect whether the payload looks like a 3270 stream or fallback text.
4. Execute commands/orders against the screen buffer.
5. Return metadata describing the render mode and parsed orders.

`Write Structured Field` query requests are answered by `buildQueryReply()`, which advertises usable area, implicit partition, color, and highlighting capabilities.

Outbound processing uses `buildInputBuffer(screen, aid)`, which emits:

- the AID byte,
- encoded cursor address,
- `SBA` + field address + EBCDIC field text for each modified unprotected field,
- unformatted input when no fields exist.

## Telnet and TN3270E transport: `lib/telnet3270.js`

`Telnet3270Client` owns the TCP/TLS socket and telnet protocol state. It supports:

- plain `net` and TLS `tls` connections,
- timeout and error handling,
- Telnet negotiation for Binary, Terminal-Type, EOR, and TN3270E,
- terminal-type response including optional device/LU name,
- TN3270E device-type and function negotiation,
- EOR-delimited frame extraction,
- escaping outbound IAC bytes,
- adding TN3270E data headers when TN3270E mode is active,
- offline writes for tests or disconnected sessions.

Socket bytes are parsed by `handleTelnet()`. Non-control bytes accumulate as data; `IAC EOR` emits complete frames. Negotiation and subnegotiation are handled internally, and decoded payloads are emitted as `data` or `frame` events for `EmulatorSession`.

## Supporting modules

- `lib/addressing.js` encodes and decodes 3270 buffer addresses and converts row/column pairs to linear addresses.
- `lib/ebcdic.js` contains a compact ASCII/EBCDIC translation table used by parser and input-buffer generation.
- `lib/deviceTypes.js` parses/builds supported IBM 3278/3279 terminal types and maps models to dimensions:
  - model 2: 24x80,
  - model 3: 32x80,
  - model 4: 43x80,
  - model 5: 27x132.
- `lib/colorPalette.js` defines built-in TN3279-style color names and stable ordering for the color settings UI.

## Configuration and extension manifest

`package.json` contributes commands, keybindings, settings, views, and menus. Important settings include:

- `m3270.hostname`, `m3270.port`, `m3270.secure`, `m3270.rejectUnauthorized`,
- `m3270.terminalType`, `m3270.deviceName`, `m3270.connectionTimeoutMs`,
- `m3270.keepSessionsInBackground`,
- `m3270.colors`,
- `m3270.keymap`.

The only package script for verification is `npm test`, which runs Node's built-in test runner over `test/*.test.js`. The packaging dev dependency is `@vscode/vsce`.

## Validation and tests

The `test/` directory covers the emulator core and validation workflow:

- `emulator.test.js` checks screen rendering, navigation, telnet control stripping, field handling, AID buffers, PA/PF keys, SVG screenshots, colors, and highlights.
- `deviceTypes.test.js` checks supported terminal types, screen dimensions, type normalization, resizing, and TN3270E header stripping.
- `colorPalette.test.js` checks color setting row coverage.
- `step02-main-screen.test.js` checks the Instrktr Endevor validation behavior.

`instrktr-validation/` is a small course/validator fixture. Its validators use the exported emulator modules and mirrored snapshot files to check API behavior, screen text, connection state, PF key execution, and Endevor screen recognition.

## Main data flows

### Host output to rendered screen

```text
host socket bytes
  -> Telnet3270Client.handleTelnet()
  -> data/frame event
  -> EmulatorSession.receiveDataStream()
  -> datastream.applyDataStream()
  -> ScreenBuffer mutations
  -> update event
  -> extension.js postSnapshot()
  -> webview cell rendering + mirrored snapshot JSON
```

### User input to host

```text
keyboard/toolbar/API action
  -> extension.js or activation API
  -> EmulatorSession.sendText()/perform()/sendAid()
  -> ScreenBuffer modified cells/fields
  -> datastream.buildInputBuffer()
  -> Telnet3270Client.write()
  -> optional TN3270E header + IAC escaping + EOR
  -> TCP/TLS socket
```

### Automation/API use

```text
other extension / validator / test
  -> VS Code extension activation API or require('./lib/emulator')
  -> EmulatorSession operations
  -> snapshots, fields, read buffers, screenshots, connection status
```

## Current architectural boundaries

- `extension.js` owns VS Code concerns: commands, webviews, settings, session list UI, output channel, and snapshot mirroring.
- `lib/emulator.js` owns orchestration between transport, parser, and screen state.
- `lib/telnet3270.js` owns wire protocol and socket framing.
- `lib/datastream.js` owns 3270 byte-level command/order parsing and input-buffer construction.
- `lib/screen.js` owns terminal state and field semantics.
- Support modules are pure helpers for encoding, device metadata, and colors.

This separation keeps the core emulator usable in tests or validators without a VS Code host, while `extension.js` adapts that core into an interactive VS Code terminal panel.
