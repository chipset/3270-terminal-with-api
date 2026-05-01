# m3270 Architecture

This project is a compact VS Code extension that provides a TN3270/TN3270E-style terminal emulator. It has three main layers:

1. VS Code integration and webview UI in `extension.js`.
2. Session orchestration in `lib/emulator.js`.
3. Protocol, datastream, and screen-buffer primitives in `lib/`.

The extension receives input from the VS Code command palette, the emulator webview, the connection settings webview, and the host network socket. All of those inputs eventually flow through a single `EmulatorSession`, which owns the connection state and the `ScreenBuffer`.

## High-Level Flow

```text
VS Code command / webview click / keypress
  -> extension.js message or command handler
  -> EmulatorSession method
  -> ScreenBuffer update and/or Telnet3270Client.write()
  -> host socket

host socket bytes
  -> Telnet3270Client.handleTelnet()
  -> EmulatorSession.receiveDataStream()
  -> datastream.applyDataStream()
  -> ScreenBuffer mutation
  -> EmulatorSession update event
  -> extension.js postSnapshot()
  -> webview render + local snapshot JSON mirrors
```

## Input Components

### VS Code Commands

`activate()` in `extension.js` registers the public commands:

- `m3270.open`, `m3270.settings`, `m3270.colorSettings`
- `m3270.connect`, `m3270.disconnect`, `m3270.showLog`
- `m3270.enter`, `m3270.clear`, `m3270.fieldExit`, `m3270.tab`, `m3270.backtab`
- `m3270.pf1` through `m3270.pf24`
- `m3270.pa1` through `m3270.pa3`

Most commands call methods on the single `activeSession`. The returned activation API exposes the same core operations for tests, validators, and other extensions.

### Emulator Webview

`getWebviewHtml()` builds the terminal UI. Its script sends messages back to the extension with `vscode.postMessage()`:

- `input`: typed text or pasted text.
- `aid`: Enter, Clear, PF, and PA keys.
- `cursor`: mouse click or arrow-key cursor movement.
- `tab`, `backtab`, `fieldExit`: field navigation helpers.
- `connect`, `disconnect`, `settings`, `colors`: toolbar actions.

The extension receives these in `openEmulator()` and translates them into `EmulatorSession` calls.

### Settings And Color Webviews

`getSettingsHtml()` and `getColorSettingsHtml()` create configuration panels. They exchange small JSON messages with `extension.js`:

- Connection settings are saved to VS Code configuration keys under `m3270.*`.
- Color overrides are saved to `m3270.colors`.
- The color settings panel uses `DEFAULT_TERMINAL_COLORS` and `TERMINAL_COLOR_ROWS` from `lib/colorPalette.js`.

### Host Network Socket

`Telnet3270Client.connect()` creates a `net` or `tls` socket. Host data arrives as byte chunks, then `handleTelnet()` separates telnet negotiation from 3270 datastream frames. Parsed frames are emitted to `EmulatorSession`, which applies them to the screen.

## Main Modules

### `extension.js`

This is the VS Code boundary. It owns:

- Webview creation and message routing.
- VS Code command registration.
- Connection settings persistence.
- Color settings persistence.
- Output-channel logging.
- Snapshot delivery to the webview.
- Snapshot mirroring to local JSON files.

Important functions:

- `activate(context)`: Creates the output channel, creates the initial `EmulatorSession`, registers all commands, wires session events, and returns the extension API.
- `openEmulator(context)`: Creates or reveals the emulator webview, installs the webview message handler, and sends the latest snapshot into the UI.
- `connectFromSettings(settings)`: Normalizes connection settings, calls `activeSession.connect()`, and opens the emulator after connection.
- `postSnapshot(snapshot)`: Sends the snapshot to the active webview and calls `mirrorSnapshotToWorkspaces()`.
- `mirrorSnapshotToWorkspaces(snapshot)`: Writes the current screen and connection state to workspace, home, and temp JSON files. Log lines like `snapshot mirrored to 3 target(s)` come from here. This is local-only; it does not communicate with the host.
- `getWebviewHtml()`: Produces the full terminal webview HTML, CSS, and client script. The client script renders every cell from `snapshot.screen.cells`.

### `lib/emulator.js`

`EmulatorSession` is the central runtime object. It composes a `ScreenBuffer` and a `Telnet3270Client`.

Important methods:

- `connect(options)`: Sets connection state, enables reconnect, and delegates socket setup to `Telnet3270Client.connect()`.
- `disconnect()`: Disables reconnect and closes the client.
- `_scheduleReconnect()`: Exponential reconnect loop used after a disconnect while reconnect is enabled.
- `receiveDataStream(data)`: Records receive metadata, parses host bytes through `applyDataStream()`, sends any structured-field response back to the host, emits trace/datastream/update events, and returns a snapshot.
- `sendText(text)`: Writes local typed text into the screen buffer.
- `sendAid(aid)`: Builds a 3270 input buffer from modified fields and sends it to the host.
- `sendAidAsync(aid, timeoutMs)`: Sends an AID key and resolves when the host responds, the session is offline, or the timeout expires.
- `perform(action)`: Small action dispatcher used by navigation and the API.
- `getSnapshot()`: Returns `{ connection, screen }`, where `screen` is the full `ScreenBuffer` snapshot.

### `lib/telnet3270.js`

This module handles telnet, TN3270E negotiation, EOR framing, IAC escaping, and socket I/O.

Important functions and methods:

- `Telnet3270Client.connect(options)`: Opens the socket, installs listeners, logs raw host receive sizes/hex previews, and emits parsed data or frames.
- `handleTelnet(chunk)`: Scans bytes for telnet commands. It responds to `DO`, `WILL`, subnegotiation, and splits framed 3270 records on `IAC EOR`.
- `respondToNegotiation(command, option)`: Accepts binary, terminal type, EOR, and TN3270E. Rejects unsupported options.
- `handleSubnegotiation(payload)`: Handles terminal-type requests and delegates TN3270E subnegotiation.
- `handleTn3270ESubnegotiation(payload)`: Handles TN3270E device-type negotiation and functions negotiation.
- `write(buffer)`: Adds a TN3270E data header when needed, escapes `IAC`, appends `IAC EOR`, and writes to the socket.
- `addTn3270EDataHeader(buffer, sequence)`: Prepends the 5-byte TN3270E data header.
- `escapeIac(buffer)` and `appendEor(buffer)`: Low-level framing helpers.

### `lib/datastream.js`

This module parses 3270 host datastream bytes and builds outbound input buffers.

Important functions:

- `applyDataStream(buffer, screen)`: Main host datastream parser. It strips a TN3270E header, detects text vs. 3270 data, handles commands, executes orders, and mutates the `ScreenBuffer`.
- `handleWriteStructuredField(data)`: Handles WSF read-partition query requests and returns a structured-field response when needed.
- `buildQueryReply()`: Builds the terminal query reply sent to hosts after `Write Structured Field` read-partition query. This is sensitive protocol data; length fields must match exactly.
- `buildInputBuffer(screen, aid)`: Builds outbound AID input: AID byte, cursor address, modified unprotected fields, or unformatted input.
- `describeInputBuffer(screen, aid)`: Produces trace metadata for outbound input.
- `buildReadBuffer(screen)`: Serializes the visible screen characters back to EBCDIC bytes.
- `stripTn3270EHeader(data)`: Removes the 5-byte TN3270E data header when present.

Supported incoming commands include Write, Erase/Write, Erase/Write Alternate, Write Structured Field, Erase All Unprotected, and common 3270 orders such as SBA, SF, SFE, IC, PT, RA, EUA, SA, MF, and GE.

### `lib/screen.js`

`ScreenBuffer` is the in-memory 3270 presentation space.

It tracks:

- Fixed rows, columns, and total cell count.
- One cell per screen address.
- 3270 fields and field attributes.
- Cursor and insert-cursor location.
- Current graphic attributes.
- Modified fields for outbound AID input.
- A small OIA-like state for input inhibition messages.

Important methods:

- `clear()`: Resets cells, fields, cursor, graphic attributes, and OIA state.
- `write(text)`: Applies local text input and simple control characters.
- `putChar(ch, options)`: Writes one character at the current address, respecting protected fields for user input and applying field/graphic metadata.
- `startField(attributeByte, extendedAttributes)`: Starts or replaces a 3270 field at the current address and applies field metadata across the screen.
- `modifyCurrentField()` and `modifyCurrentFieldAttributes()`: Apply MF order changes to the current field.
- `setGraphicAttribute(type, value)`: Applies SA order graphic context.
- `applyFieldMetadata()`: Recomputes cell-to-field relationships and inherited display attributes.
- `tabToNextUnprotectedField()` and `tabToPreviousUnprotectedField()`: Navigation helpers for user input.
- `fieldExit()`: Clears the remainder of the current unprotected field and marks it modified.
- `repeatToAddress(address, char)`: Implements RA order.
- `eraseUnprotected()` and `eraseUnprotectedToAddress(address)`: Implement EAU and EUA behavior.
- `getModifiedFields()`: Returns modified unprotected fields for `buildInputBuffer()`.
- `getUnformattedInput()`: Returns typed data when there are no fields.
- `getSnapshot()`: Returns rows, cols, cursor, OIA, lines, fields, and cells for rendering and validation.

### `lib/addressing.js`

Encodes and decodes 3270 12-bit buffer addresses.

- `encodeAddress(address, rows, cols)`: Converts a screen address into two 3270 address bytes.
- `decodeAddress(first, second, rows, cols)`: Converts two host address bytes into a screen address.
- `rowColToAddress(row, col, cols)` and `addressToRowCol(address, cols)`: Convert between linear and row/column coordinates.

### `lib/ebcdic.js`

Provides a compact ASCII/EBCDIC table for characters this emulator currently supports.

- `toAscii(buffer)`: Converts bytes to a string.
- `toEbcdic(text)`: Converts a string to EBCDIC bytes.
- `ebcdicByteToAscii(byte)` and `asciiCharToEbcdic(char)`: Single-character helpers.

### `lib/colorPalette.js`

Defines built-in display colors and the stable row order used by the color settings UI.

## Snapshot Files

Every session update emits a snapshot. `extension.js` posts that snapshot to the webview and mirrors a reduced JSON payload to:

- Workspace `.m3270/snapshot.json` for each open workspace folder.
- User home `.m3270/snapshot.json`.
- OS temp `m3270-snapshot.json`.

These files are for validators and external tooling. They are not part of the TN3270/TN3270E connection.

## Rendering Model

The webview renders from `snapshot.screen.cells`, not from a plain text block. Each cell becomes a `span` with:

- One character.
- Row/column data attributes.
- Cursor/protected/editable/blink/underscore CSS classes.
- Inline color styling based on the resolved terminal palette.

Hidden fields render as spaces. The text snapshot (`screen.lines`) is used for validators, copy behavior, and mirrored JSON.

## Outbound Input Model

Typing in the webview updates the local `ScreenBuffer`. Pressing Enter, PF, PA, or Clear sends an AID input buffer:

1. AID byte.
2. Current cursor address.
3. SBA plus EBCDIC text for each modified unprotected field.
4. Optional SBA plus EBCDIC text for unformatted screens.
5. TN3270E data header if TN3270E is active.
6. Escaped IAC bytes and final `IAC EOR`.

After sending, `ScreenBuffer.clearModified()` clears modified flags.

## Host Receive Model

Host bytes are processed in stages:

1. `Telnet3270Client.handleTelnet()` strips telnet negotiation and emits complete EOR-delimited frames.
2. `EmulatorSession.receiveDataStream()` records trace metadata and calls `applyDataStream()`.
3. `applyDataStream()` strips TN3270E headers, recognizes commands and orders, and mutates `ScreenBuffer`.
4. If the host sent a WSF read-partition query, `buildQueryReply()` returns bytes that are sent back through `Telnet3270Client.write()`.
5. The updated snapshot is emitted, rendered, and mirrored.

## Build And Test

`package.json` scripts:

- `npm test`: Runs all Node tests under `test/*.test.js`.
- `npm run validate`: Runs `test/emulator.test.js` directly.
- `npm run build`: Packages the extension into `m3270-${npm_package_version}.vsix`.

The test suite focuses on protocol helpers, screen behavior, AID buffers, structured-field query replies, color mapping, SVG output, and validation-course behavior.

## Known Sensitive Areas

- Structured-field query replies must have exact length fields. Hosts may react with TSO/VTAM recovery errors if the reply is malformed.
- TN3270E framing must include correct data headers and `IAC EOR` delimiters when TN3270E is active.
- Field attributes determine protected vs. editable regions; bad field metadata can cause invalid outbound input.
- `RA`, `SF/SFE`, `SA`, and `MF` order interactions are easy to get subtly wrong because they affect both characters and display attributes.
- Snapshot mirroring is local file I/O only; it can be noisy in logs but does not affect the host session.
