// A facet that exercises the restriction knobs (ADR-0014 decision 3: restriction
// is transparent interception, never API removal). It probes a filesystem write
// and the network, then reports each outcome — through the same report
// capability, over the same relay, in every profile.
//
// The point: this ONE source runs unchanged under a permissive profile and under
// each knob turned on. When a knob narrows what a capability reaches, the facet
// observes a refused syscall — a narrower result — never a withdrawn method. It
// is not re-adapted; it just sees 'refused' where it saw 'ok'.
//
// The network knob narrows differently per platform, so the facet reports three
// distinct observables and the runner asserts the platform-relevant one:
//   - loopback: a 127.0.0.1 round-trip. macOS Seatbelt `(deny network*)` refuses
//     every socket, loopback included, so this is the macOS signal.
//   - externalNet: whether any non-loopback network interface is present. Linux
//     `--unshare-net` puts the guest in a private network namespace with only a
//     loopback up — loopback still works, but external egress is gone — so the
//     absence of an external interface is the Linux signal.
//   - externalEgress: whether an EXTERNAL (non-loopback) connect is permitted to
//     even try. A Windows AppContainer gates the network through the internetClient
//     capability, which controls external egress ONLY — a raw AppContainer permits
//     loopback regardless (loopback is governed by the network-isolation exemption,
//     not internetClient), and it does not remove interfaces. So neither loopback
//     nor externalNet can observe deny-network on Windows; the signal is an
//     external connect that the socket layer refuses (WSAEACCES) without the
//     capability. This probe is platform-neutral (macOS Seatbelt refuses with
//     EPERM, Linux --unshare-net has no route with ENETUNREACH), so it could
//     unify the network observable later; for now only the runner's win32 branch
//     asserts it, to avoid regressing the mac/linux signals already proven green.
import net from 'node:net';
import { writeFileSync, unlinkSync } from 'node:fs';
import { networkInterfaces, homedir } from 'node:os';
import { join } from 'node:path';

function tryFsWrite() {
  // Probe a write into a launcher-designated user-space scratch dir. On Windows,
  // AppContainer write access is governed by the container SID's own ACE (a lowbox
  // token does not honour the user's ACEs), so the launcher passes KFX_WRITE_PROBE
  // pointing at a scratch dir it grants the container SID write on under a
  // permissive profile and leaves ungranted under deny-write — the knob is
  // observed here. The node runtime's own TEMP is redirected elsewhere (the
  // AppContainer folder), so this path is purely the facet's write target, not the
  // runtime scratch. Off-Windows the launcher leaves KFX_WRITE_PROBE unset and the
  // probe falls back to the home dir, which macOS Seatbelt `(deny file-write*)` and
  // Linux `--ro-bind /` deny globally when the knob is on and allow when permissive.
  const dir = process.env.KFX_WRITE_PROBE ?? homedir();
  const path = join(dir, `.kfx-knob-write-probe-${process.pid}.tmp`);
  try {
    writeFileSync(path, 'kfx');
    try {
      unlinkSync(path);
    } catch {}
    return 'ok';
  } catch (err) {
    return `refused:${err.code ?? err.message}`;
  }
}

function tryLoopbackNet() {
  return new Promise((resolve) => {
    let server;
    const done = (v) => {
      try {
        server?.close();
      } catch {}
      resolve(v);
    };
    try {
      server = net.createServer((socket) => socket.end());
      server.on('error', (err) => done(`refused:${err.code ?? err.message}`));
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        const client = net.connect(port, '127.0.0.1', () => {
          client.end();
          done('ok');
        });
        client.on('error', (err) => done(`refused:${err.code ?? err.message}`));
      });
    } catch (err) {
      done(`refused:${err.code ?? err.message}`);
    }
  });
}

function hasExternalInterface() {
  const ifaces = networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const addr of addrs ?? []) {
      if (!addr.internal) return true;
    }
  }
  return false;
}

// Probe whether an EXTERNAL egress is permitted to try. TEST-NET-1 192.0.2.1
// (RFC 5737) is reserved and never answers, so a permitted connect never truly
// connects — it stalls and our timer fires, which we read as 'ok' (egress was
// allowed to leave the socket layer). A denied guest is rejected before the
// packet leaves: a capability/permission refusal (Windows AppContainer WSAEACCES
// → EACCES, macOS Seatbelt EPERM) or no route out (Linux --unshare-net
// ENETUNREACH). Those codes read as 'refused'; a stall, a real connect, or a
// host-level ECONNREFUSED (egress worked, peer said no) read as 'ok'.
const EGRESS_REFUSED = new Set([
  'EACCES',
  'EPERM',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EADDRNOTAVAIL',
  'ENETDOWN',
]);

function tryExternalEgress() {
  return new Promise((resolve) => {
    let settled = false;
    let socket;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.destroy();
      } catch {}
      resolve(v);
    };
    const timer = setTimeout(() => done('ok'), 600);
    timer.unref?.();
    try {
      socket = net.connect({ host: '192.0.2.1', port: 80 });
      socket.on('connect', () => done('ok'));
      socket.on('error', (err) =>
        done(EGRESS_REFUSED.has(err.code) ? `refused:${err.code}` : 'ok'),
      );
    } catch (err) {
      done(EGRESS_REFUSED.has(err.code) ? `refused:${err.code}` : 'ok');
    }
  });
}

export async function run(caps) {
  const fsWrite = tryFsWrite();
  const loopback = await tryLoopbackNet();
  const externalNet = hasExternalInterface() ? 'ok' : 'refused';
  const externalEgress = await tryExternalEgress();
  await caps.report.result({
    facet: 'knobs',
    fsWrite,
    loopback,
    externalNet,
    externalEgress,
  });
}
