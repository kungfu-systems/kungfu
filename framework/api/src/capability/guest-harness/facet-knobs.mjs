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
// The network knob narrows differently per platform, so the facet reports two
// distinct observables and the runner asserts the platform-relevant one:
//   - loopback: a 127.0.0.1 round-trip. macOS Seatbelt `(deny network*)` refuses
//     every socket, loopback included, so this is the macOS signal.
//   - externalNet: whether any non-loopback network interface is present. Linux
//     `--unshare-net` puts the guest in a private network namespace with only a
//     loopback up — loopback still works, but external egress is gone — so the
//     absence of an external interface is the Linux signal.
import net from 'node:net';
import { writeFileSync, unlinkSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';

function tryFsWrite() {
  const path = join(tmpdir(), `kfx-knob-${process.pid}.tmp`);
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

export async function run(caps) {
  const fsWrite = tryFsWrite();
  const loopback = await tryLoopbackNet();
  const externalNet = hasExternalInterface() ? 'ok' : 'refused';
  await caps.report.result({ facet: 'knobs', fsWrite, loopback, externalNet });
}
