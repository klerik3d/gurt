Headless probe
==============

Run from the repository root:

    node scripts/remote-probe.mjs --relay ws://localhost:8080 --pair 'gurt://pair#…'

Compare the displayed six-digit SAS with the desktop and confirm there. The
probe waits for acceptance, reconnects with IK, validates the API range, and
prints the advertised methods and tree (sessions). It does not persist keys;
each CLI invocation pairs a new device. Remove test devices on the desktop.
The URL and keys are never logged. Shell history can retain a URL passed as an
argument. The printed session tree is application content.

`RemoteProbe` in src/probe.ts uses an injected ordered binary stream, no Node
or browser APIs. Keep the same instance and device key across reconnects.
Subscribe with onEvent; seed trackSession(id, page.logSeq) only after applying
a session.get snapshot. Reconnect, then call resume(). Duplicate seq values are
ignored; a gap closes the channel, requiring a fresh snapshot. A reset result
also requires session.get and trackSession. No automatic reconnection or
background ping loop is installed: a driver controls connection lifetime and
can call remote.ping explicitly. WebSocket reads and connection establishment
have bounded waits in scripts/lib/probe-socket.mjs.

The scenarios in probe.test.mjs run over memory and over the client socket of
scripts/lib/fake-relay.mjs. probe-host.mjs is a test oracle only. When the real
host exists, supply a dialer and desktop test controls to the same scenarios;
passing these tests today does not establish production host conformance.
Existing channel.test.mjs exercises exact 16 MiB reassembly, sending over the
cap, and authenticated incoming chunks over the cap.

Protocol decisions to settle before implementing the host:

* §5 says the secret is single-use but does not specify its consumption point.
  The oracle consumes it on a successfully authenticated first pair message,
  before desktop confirmation. Concurrent attempts and rejected confirmations
  cannot reuse it; generate a new QR for a retry.
* §7.5 subscribes before replay, which permits live/replay overlap and does not
  explicitly prescribe ordering between the two. The probe drops seq <= last
  and treats seq > last + 1 as a gap. A real host should serialize replay and
  buffered live records in seq order. Otherwise the client needs an explicit
  replay-completion boundary and buffering before it can safely apply records.
* The handshake only permits ios/android. The probe identifies as android
  with app=remote-probe/1 rather than inventing an unsupported platform.
