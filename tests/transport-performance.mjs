import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import ssh2 from 'ssh2';
import WebSocket from 'ws';
import { createBridge } from '../bridge.mjs';

// Explicit opt-in benchmark: only ephemeral loopback SSH peers and fake secrets.
// It deliberately excludes nginx, physical networks, browsers and xterm drawing.
const origin = 'https://transport-probe.invalid';
const temporary = mkdtempSync(path.join(tmpdir(), 'lab-staged-transport-'));
const hostPath = path.join(temporary, 'host');
let privateKey;

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(server.address().port); });
});
const close = server => !server?.address?.() ? Promise.resolve() : new Promise(resolve => {
  server.close(resolve); server.closeAllConnections?.();
});
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const summarize = values => ({
  count: values.length,
  minMs: Math.min(...values), p50Ms: percentile(values, 0.5),
  p95Ms: percentile(values, 0.95), maxMs: Math.max(...values),
  meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
});
const withDeadline = (promise, name, timeoutMs = 6000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(name)), timeoutMs); })])
    .finally(() => clearTimeout(timer));
};

async function scenario({ noDelay, echoDelayMs, ackDelayMs, burst = false }) {
  const sockets = new Set();
  const timers = new Set();
  const pending = [];
  const rawSamples = [];
  let receivedBytes = 0;
  let observedPasswordAttempts = 0;
  let bridge;
  let ws;
  let web;
  let resolveConnected;
  const connected = new Promise(resolve => { resolveConnected = resolve; });
  const later = (callback, ms) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, ms);
    timers.add(timer);
  };
  const ssh = new ssh2.Server({ hostKeys: [privateKey] }, client => {
    sockets.add(client);
    client.setNoDelay(true); // Hold the fake peer constant in both conditions.
    client.on('error', () => {});
    client.on('close', () => sockets.delete(client));
    client.on('authentication', ctx => {
      if (ctx.method === 'password') observedPasswordAttempts += 1;
      if (ctx.method === 'password' && ctx.username === 'benchmark' && ctx.password === 'disposable-fake-password') ctx.accept();
      else ctx.reject(['password']);
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('pty', acceptPTY => acceptPTY?.());
      session.on('sftp', (_accept, reject) => reject());
      session.on('shell', acceptShell => {
        const stream = acceptShell();
        stream.on('error', () => {});
        stream.on('data', bytes => {
          for (const byte of bytes) {
            const respond = () => { if (!stream.destroyed) stream.write(Buffer.from([byte])); };
            if (echoDelayMs) later(respond, echoDelayMs); else respond();
          }
        });
      });
    }));
  });
  try {
    const sshPort = await listen(ssh);
    web = http.createServer((_req, res) => res.writeHead(404).end());
    bridge = createBridge(web, {
      sshHost: '127.0.0.1', sshPort, hostKeyPath: hostPath + '.pub', allowedOrigins: [origin],
      loginTimeoutMs: 6000, sshTimeoutMs: 6000, idleTimeoutMs: 60000, maxLifetimeMs: 120000,
      ...(noDelay ? {} : { sshNoDelay: false }),
    });
    const webPort = await listen(web);
    ws = new WebSocket(`ws://127.0.0.1:${webPort}/api/terminal`, { origin });
    ws.on('error', () => {});
    ws.on('message', bytes => {
      const message = JSON.parse(bytes.toString());
      if (message.type === 'state' && message.state === 'connected') resolveConnected();
      if (message.type !== 'data') return;
      const output = Buffer.from(message.data, 'base64');
      receivedBytes += output.length;
      for (const byte of output) {
        const current = pending.shift();
        assert.ok(current, 'Only requested synthetic echo bytes may be returned');
        assert.equal(byte, current.byte);
        const elapsedMs = performance.now() - current.started;
        if (current.measured) rawSamples.push({ sample: current.index, sentByte: byte, elapsedMs });
        current.resolve();
      }
      if (ackDelayMs !== null) later(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ack', bytes: output.length }));
      }, ackDelayMs);
    });
    await withDeadline(new Promise(resolve => ws.once('open', resolve)), 'Benchmark WebSocket did not open');
    ws.send(JSON.stringify({ type: 'login', username: 'benchmark', password: 'disposable-fake-password', cols: 80, rows: 24 }));
    await withDeadline(connected, 'Benchmark SSH did not authenticate');
    const send = (index, measured) => {
      const byte = 97 + index % 26;
      let resolve;
      const complete = new Promise(done => { resolve = done; });
      pending.push({ byte, index, measured, started: performance.now(), resolve });
      ws.send(JSON.stringify({ type: 'input', data: String.fromCharCode(byte) }));
      return withDeadline(complete, 'Synthetic echo did not arrive');
    };
    for (let i = 0; i < 5; i++) await send(i, false);
    if (burst) {
      const completed = [];
      for (let i = 0; i < 20; i++) { completed.push(send(i, true)); await delay(5); }
      await Promise.all(completed);
    } else {
      for (let i = 0; i < 20; i++) await send(i, true);
    }
    assert.equal(rawSamples.length, 20);
    assert.equal(receivedBytes, 25);
    assert.equal(observedPasswordAttempts, 1);
    assert.equal(ws.readyState, WebSocket.OPEN);
    return {
      sshClientNoDelay: noDelay ? 'new default true (option omitted)' : 'constructor option sshNoDelay:false',
      fakeServerNoDelay: true, syntheticRemoteEchoDelayMs: echoDelayMs,
      browserAckDelayMs: ackDelayMs, inputSchedule: burst ? '20 single-byte inputs, 5ms apart' : 'one outstanding single-byte input at a time',
      warmupSamples: 5, receivedBytes, flowControlThresholdBytes: 262144,
      summary: summarize(rawSamples.map(sample => sample.elapsedMs)), rawSamples,
    };
  } finally {
    for (const timer of timers) clearTimeout(timer);
    ws?.terminate();
    await bridge?.close();
    for (const socket of sockets) socket.end();
    await Promise.all([close(web), close(ssh)]);
  }
}

try {
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'temporary-loopback-performance-test', '-f', hostPath], { stdio: 'ignore', timeout: 10000 });
  privateKey = readFileSync(hostPath);
  const results = [];
  for (const echoDelayMs of [0, 100]) for (const ackDelayMs of [null, 100]) {
    for (const noDelay of [false, true]) results.push(await scenario({ noDelay, echoDelayMs, ackDelayMs }));
  }
  for (const noDelay of [false, true]) results.push(await scenario({ noDelay, echoDelayMs: 100, ackDelayMs: null, burst: true }));
  const report = {
    recordedAt: new Date().toISOString(), scope: 'staging bridge and ephemeral loopback fake SSH only',
    nodeVersion: process.version,
    bridgeSHA256: createHash('sha256').update(readFileSync(new URL('../bridge.mjs', import.meta.url))).digest('hex'),
    source: 'tests/transport-performance.mjs', measuredSamples: results.reduce((sum, result) => sum + result.rawSamples.length, 0),
    warmupSamples: results.reduce((sum, result) => sum + result.warmupSamples, 0),
    method: {
      metric: 'Node WebSocket client input send to receipt of the matching fake SSH echo byte; performance.now()',
      baseline: 'createBridge constructor option sshNoDelay:false; no prototype patching',
      treatment: 'createBridge new default sshNoDelay:true; option omitted',
      exclusions: ['No production endpoint, service or tunnel', 'No real campus authentication or server', 'No browser, xterm rendering, nginx/TLS, physical WAN/VPN or real remote shell'],
      ackControl: 'Either no application ACK at all, or every output ACK delayed by 100ms. All runs receive only 25 bytes, below the 256KiB output pause threshold.',
      limitations: ['Small controlled experiment; medians and p95 describe this fake peer on this machine only.', 'NoDelay affects the VPS local SSH TCP socket, not the reverse tunnel physical path.', 'Independent real network and remote echo delays remain; these results cannot establish a campus network speedup.'],
    },
    results,
  };
  const destination = new URL('../docs/qa-performance-transport.json', import.meta.url);
  writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: destination.pathname, measuredSamples: report.measuredSamples, results: results.map(({ sshClientNoDelay, syntheticRemoteEchoDelayMs, browserAckDelayMs, inputSchedule, summary }) => ({ sshClientNoDelay, syntheticRemoteEchoDelayMs, browserAckDelayMs, inputSchedule, ...summary })) }, null, 2));
} finally {
  privateKey?.fill(0);
  rmSync(temporary, { recursive: true, force: true });
}
