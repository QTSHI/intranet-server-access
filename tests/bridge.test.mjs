import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import ssh2 from 'ssh2';
import WebSocket from 'ws';
import { createBridge } from '../bridge.mjs';

const { Server: SSHServer, utils: { sftp: { STATUS_CODE, OPEN_MODE } } } = ssh2;

// All SSH traffic stays inside disposable loopback test servers. No shell is run.
const ORIGIN = 'https://portal.example.test';
const PASSWORD = 'fake-test-only';
let keyDirectory;
let hostPrivateKey;
let hostPublicPath;
let wrongPublicPath;

before(() => {
  keyDirectory = mkdtempSync(path.join(tmpdir(), 'lab-bridge-test-'));
  for (const name of ['host', 'wrong-host']) {
    execFileSync('ssh-keygen', [
      '-q', '-t', 'ed25519', '-N', '', '-C', 'disposable-bridge-test',
      '-f', path.join(keyDirectory, name),
    ], { stdio: 'ignore', timeout: 10000 });
  }
  hostPrivateKey = readFileSync(path.join(keyDirectory, 'host'));
  hostPublicPath = path.join(keyDirectory, 'host.pub');
  wrongPublicPath = path.join(keyDirectory, 'wrong-host.pub');
});

after(() => {
  hostPrivateKey?.fill(0);
  if (keyDirectory) rmSync(keyDirectory, { recursive: true, force: true });
});

async function until(predicate, message, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await delay(10);
  }
  assert.fail(message);
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server.address().port;
}

async function closeServer(server) {
  if (!server?.address?.()) return;
  await new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

const USER_IDS = { alice: 1101, bob: 1102, charlie: 1103 };

function virtualFilesystem() {
  const files = new Map();
  const directory = (filename, uid = 0, mode = 0o755) => files.set(filename, {
    type: 'directory', uid, gid: uid, mode: 0o040000 | mode, mtime: 1700000000,
  });
  const file = (filename, contents, metadata = {}) => files.set(filename, {
    type: 'file', data: Buffer.isBuffer(contents) ? contents : Buffer.from(contents),
    uid: 0, gid: 0, mode: 0o100644, mtime: 1700000000, ...metadata,
  });
  directory('/shared');
  file('/shared/readable.txt', 'Shared content permitted by the fake SSH account.\n');
  // An account may write this existing file, but cannot create a sibling temp.
  file('/shared/writable.txt', 'Shared original\n', { mode: 0o100666 });
  for (const [username, uid] of Object.entries(USER_IDS)) {
    const home = `/home/${username}`;
    directory(home, uid, 0o700);
    directory(`${home}/projects`, uid);
    directory(`${home}/many`, uid);
    const ownFile = (filename, contents, metadata = {}) => file(`${home}/${filename}`, contents, { uid, gid: uid, ...metadata });
    ownFile('README.md', '# Test workspace\n校园测试文本。\n');
    ownFile('notes.txt', 'alpha\nbeta\n');
    ownFile('projects/train.py', 'print("test-only")\n', { mode: 0o100751 });
    ownFile('readonly.txt', 'readable but not writable\n', { mode: 0o100444 });
    ownFile('private.txt', 'unreadable', { denied: true });
    ownFile('binary.bin', Buffer.from([0, 1, 2, 3]));
    ownFile('invalid-utf8.txt', Buffer.from([0xc3, 0x28]));
    ownFile('large.txt', Buffer.alloc(262145, 65));
    ownFile('exact-limit.txt', Buffer.alloc(262144, 65));
    ownFile('growing.txt', Buffer.alloc(262145, 65), { reportedSize: 16 });
    files.set(`${home}/named-pipe`, { type: 'other', uid, gid: uid, mode: 0o010600, mtime: 1700000000 });
    for (let i = 0; i < 1005; i += 1) ownFile(`many/file-${String(i).padStart(4, '0')}.txt`, 'test');
  }
  return files;
}

// ssh2's test server advertises no extensions by default. Change only this
// disposable channel's VERSION packet so the real client can use POSIX rename.
function advertiseAtomicRename(sftp) {
  const original = sftp._protocol.channelData;
  sftp._protocol.channelData = function(channel, payload) {
    if (channel === sftp.outgoing.id && payload.length === 9 && payload[4] === 2) {
      const extension = Buffer.from('posix-rename@openssh.com');
      const packet = Buffer.alloc(9 + 4 + extension.length + 4 + 1);
      payload.copy(packet);
      packet.writeUInt32BE(packet.length - 4, 0);
      packet.writeUInt32BE(extension.length, 9);
      extension.copy(packet, 13);
      packet.writeUInt32BE(1, 13 + extension.length);
      packet[17 + extension.length] = 49; // extension version '1'
      return original.call(this, channel, packet);
    }
    return original.call(this, channel, payload);
  };
}

function serveSftp(session, username, mode, stats, files) {
  session.on('sftp', (accept, reject) => {
    stats.sftpRequestsToOpen += 1;
    if (mode.sftpUnavailable) return reject();
    const sftp = accept();
    if (!mode.noAtomicExtension) advertiseAtomicRename(sftp);
    const home = `/home/${username}`;
    const uid = USER_IDS[username];
    const handles = new Map();
    let nextHandle = 1;
    stats.activeSftpChannels += 1;
    sftp.on('error', () => {});
    sftp.on('close', () => {
      stats.activeSftpChannels -= 1;
      stats.activeSftpHandles -= handles.size;
      handles.clear();
    });
    const canonical = value => path.posix.resolve(home, value);
    const attrs = node => ({
      mode: node.mode,
      size: node.reportedSize ?? node.data?.length ?? 0,
      uid: node.uid, gid: node.gid, atime: 1700000000, mtime: node.mtime,
    });
    const status = (id, code) => sftp.status(id, code);
    const allowed = (filename, node, bits = 4) => {
      if (node.denied) return false;
      // Simulate 0700 home directories enforced by the SSH server, not a UI path rule.
      if (filename.startsWith('/home/') && !filename.startsWith(home + '/') && filename !== home) return false;
      return ((node.mode >> (node.uid === uid ? 6 : 0)) & bits) === bits;
    };
    const getNode = (id, filename, bits = 4) => {
      const node = files.get(filename);
      if (!node) { status(id, STATUS_CODE.NO_SUCH_FILE); return null; }
      if (!allowed(filename, node, bits)) { stats.permissionDenials += 1; status(id, STATUS_CODE.PERMISSION_DENIED); return null; }
      return node;
    };
    const getHandle = (id, handle) => {
      const value = handles.get(handle.toString('hex'));
      if (!value) status(id, STATUS_CODE.FAILURE);
      return value;
    };
    const newHandle = (id, value) => {
      const handle = Buffer.alloc(4);
      handle.writeUInt32BE(nextHandle++);
      handles.set(handle.toString('hex'), value);
      stats.activeSftpHandles += 1;
      sftp.handle(id, handle);
    };
    const on = (event, handler) => sftp.on(event, (...args) => {
      stats.sftpOperations.push(event);
      handler(...args);
    });
    on('REALPATH', (id, requested) => {
      const filename = canonical(requested);
      if (getNode(id, filename)) sftp.name(id, [{ filename, longname: filename, attrs: {} }]);
    });
    for (const event of ['STAT', 'LSTAT']) on(event, (id, requested) => {
      const filename = canonical(requested);
      if (event === 'STAT' && filename === home) {
        stats.homeStatRequests += 1;
        if (mode.suppressHomeStat) return;
      }
      const node = getNode(id, filename);
      if (node) sftp.attrs(id, attrs(node));
    });
    on('OPENDIR', (id, requested) => {
      const filename = canonical(requested);
      const node = getNode(id, filename);
      if (!node) return;
      if (node.type !== 'directory') return status(id, STATUS_CODE.FAILURE);
      const entries = [...files].filter(([name]) => name !== filename && path.posix.dirname(name) === filename)
        .map(([name, item]) => ({ filename: path.posix.basename(name), longname: path.posix.basename(name), attrs: attrs(item) }));
      newHandle(id, { type: 'directory', filename, entries, offset: 0 });
    });
    on('READDIR', (id, handle) => {
      const value = getHandle(id, handle);
      if (!value) return;
      if (value.offset >= value.entries.length) return status(id, STATUS_CODE.EOF);
      const entries = value.entries.slice(value.offset, value.offset + 128);
      value.offset += entries.length;
      sftp.name(id, entries);
    });
    on('OPEN', (id, requested, flags, attributes) => {
      const filename = canonical(requested);
      if (flags & OPEN_MODE.CREAT) {
        stats.writeOperations += 1;
        const parent = files.get(path.posix.dirname(filename));
        if (!parent || !allowed(path.posix.dirname(filename), parent, 3)) {
          stats.permissionDenials += 1; return status(id, STATUS_CODE.PERMISSION_DENIED);
        }
        if (files.has(filename) && flags & OPEN_MODE.EXCL) return status(id, STATUS_CODE.FAILURE);
        if (files.has(filename)) return status(id, STATUS_CODE.FAILURE);
        const node = { type: 'file', data: Buffer.alloc(0), uid, gid: uid, mode: 0o100000 | ((attributes.mode ?? 0o600) & 0o7777), mtime: 1700000001 };
        files.set(filename, node);
        stats.createdPaths.push(filename);
        return newHandle(id, { type: 'file', filename, node, writable: true, temporary: true });
      }
      const writable = Boolean(flags & OPEN_MODE.WRITE);
      const node = getNode(id, filename, writable ? 6 : 4);
      if (!node) return;
      if (node.type !== 'file') return status(id, STATUS_CODE.FAILURE);
      if (writable) stats.writableOriginalOpens += 1;
      newHandle(id, { type: 'file', filename, node, writable });
    });
    on('FSTAT', (id, handle) => {
      const value = getHandle(id, handle);
      if (value) sftp.attrs(id, attrs(value.node ?? files.get(value.filename)));
    });
    on('READ', (id, handle, offset, length) => {
      const value = getHandle(id, handle);
      if (!value) return;
      if (mode.suppressSftpRead) return;
      if (offset >= value.node.data.length) return status(id, STATUS_CODE.EOF);
      const data = value.node.data.subarray(offset, offset + Math.min(length, 16384));
      stats.fileBytesRead += data.length;
      if (mode.readDelayMs) setTimeout(() => { if (!sftp.destroyed) sftp.data(id, data); }, mode.readDelayMs);
      else sftp.data(id, data);
    });
    on('WRITE', (id, handle, offset, data) => {
      stats.writeOperations += 1;
      const value = getHandle(id, handle);
      if (!value) return;
      if (!value.writable || !allowed(value.filename, value.node, 2)) return status(id, STATUS_CODE.PERMISSION_DENIED);
      if (mode.failWriteAfter !== undefined && stats.tempBytesWritten >= mode.failWriteAfter) return status(id, STATUS_CODE.FAILURE);
      if (mode.suppressSftpWrite) return;
      const replacement = Buffer.alloc(Math.max(value.node.data.length, offset + data.length));
      value.node.data.copy(replacement); data.copy(replacement, offset); value.node.data = replacement;
      value.node.mtime += 1;
      stats.tempBytesWritten += data.length;
      if (value.temporary && mode.externalChangeDuringWrite && !stats.externalChangeInjected) {
        stats.externalChangeInjected = true;
        files.get(mode.externalChangePath ?? home + '/notes.txt').data = Buffer.from('external concurrent change\n');
      }
      status(id, STATUS_CODE.OK);
    });
    const setAttrs = (id, value, attributes) => {
      if (mode.failSetstat) return status(id, STATUS_CODE.FAILURE);
      if (value.node.uid !== uid || (attributes.uid !== undefined && attributes.uid !== uid)) return status(id, STATUS_CODE.PERMISSION_DENIED);
      if (!mode.ignoreSetstat) for (const name of ['uid', 'gid', 'mode', 'mtime']) if (attributes[name] !== undefined) value.node[name] = name === 'mode' ? (value.node.mode & 0o170000) | (attributes.mode & 0o7777) : attributes[name];
      stats.preservedAttrs.push({ ...attributes });
      status(id, STATUS_CODE.OK);
    };
    on('FSETSTAT', (id, handle, attributes) => {
      stats.writeOperations += 1;
      const value = getHandle(id, handle);
      if (value) setAttrs(id, value, attributes);
    });
    on('SETSTAT', (id, requested, attributes) => {
      stats.writeOperations += 1;
      const filename = canonical(requested);
      const node = getNode(id, filename, 2);
      if (node) setAttrs(id, { node }, attributes);
    });
    on('CLOSE', (id, handle) => {
      if (handles.delete(handle.toString('hex'))) stats.activeSftpHandles -= 1;
      status(id, STATUS_CODE.OK);
    });
    on('REMOVE', (id, requested) => {
      stats.writeOperations += 1;
      const filename = canonical(requested);
      const node = getNode(id, filename, 2);
      if (!node) return;
      if (!stats.createdPaths.includes(filename)) return status(id, STATUS_CODE.PERMISSION_DENIED);
      files.delete(filename); stats.removedPaths.push(filename); status(id, STATUS_CODE.OK);
    });
    on('EXTENDED', (id, extension, payload) => {
      stats.writeOperations += 1;
      if (extension !== 'posix-rename@openssh.com' || mode.renameUnsupported) return status(id, STATUS_CODE.OP_UNSUPPORTED);
      let cursor = 0;
      const takeString = () => { const length = payload.readUInt32BE(cursor); cursor += 4; const value = payload.subarray(cursor, cursor + length).toString(); cursor += length; return canonical(value); };
      const from = takeString(); const to = takeString();
      const node = getNode(id, from, 2);
      if (!node) return;
      const parent = getNode(id, path.posix.dirname(to), 3);
      if (!parent) return;
      if (!stats.createdPaths.includes(from) || !files.has(to)) return status(id, STATUS_CODE.PERMISSION_DENIED);
      files.set(to, node); files.delete(from);
      stats.atomicRenames.push({ from, to }); status(id, STATUS_CODE.OK);
    });
    for (const event of ['RMDIR', 'MKDIR', 'RENAME', 'SYMLINK']) {
      on(event, id => { stats.writeOperations += 1; status(id, STATUS_CODE.OP_UNSUPPORTED); });
    }
  });
}

async function fixture(t, overrides = {}, sshMode = {}) {
  const files = virtualFilesystem();
  const stats = {
    passwordAttempts: 0, keyboardAttempts: 0, keyboardAnswers: 0, passwordReplies: 0,
    sshConnections: 0, activeSSH: 0, activeShells: 0, shellRequests: 0,
    bulkBytesWritten: 0, ptys: [], resizes: [], sftpRequestsToOpen: 0,
    activeSftpChannels: 0, activeSftpHandles: 0, fileBytesRead: 0, writeOperations: 0, sftpOperations: [],
    createdPaths: [], removedPaths: [], atomicRenames: [], preservedAttrs: [],
    tempBytesWritten: 0, writableOriginalOpens: 0, permissionDenials: 0, homeStatRequests: 0,
  };
  const sshClients = new Set();
  const webClients = new Set();
  let bridge;

  const ssh = new SSHServer({ hostKeys: [hostPrivateKey] }, client => {
    stats.sshConnections += 1;
    sshClients.add(client);
    let username;
    let ready = false;
    client.on('error', () => {});
    client.on('authentication', ctx => {
      const keyboardMode = sshMode.authentication?.startsWith('keyboard');
      const advertised = keyboardMode ? ['keyboard-interactive'] : ['password'];
      if (ctx.method === 'password') stats.passwordAttempts += 1;
      if (!keyboardMode && ctx.method === 'password' && ['alice', 'bob', 'charlie'].includes(ctx.username) && ctx.password === PASSWORD) {
        username = ctx.username;
        return ctx.accept();
      }
      if (keyboardMode && ctx.method === 'keyboard-interactive') {
        stats.keyboardAttempts += 1;
        const prompts = sshMode.authentication === 'keyboard-otp'
          ? [{ prompt: 'Verification code: ', echo: false }]
          : sshMode.authentication === 'keyboard-multi'
            ? [{ prompt: 'Password: ', echo: false }, { prompt: 'OTP code: ', echo: false }]
            : [{ prompt: 'Password: ', echo: false }];
        ctx.prompt(prompts, 'Campus login', '', answers => {
          stats.keyboardAnswers += 1;
          stats.passwordReplies += answers.filter(answer => answer === PASSWORD).length;
          if (sshMode.authentication === 'keyboard-password' && answers.length === 1 && answers[0] === PASSWORD) {
            username = ctx.username;
            ctx.accept();
          } else ctx.reject(advertised);
        });
        return;
      }
      ctx.reject(advertised);
    });
    client.on('ready', () => {
      ready = true;
      stats.activeSSH += 1;
      client.on('session', accept => {
        const session = accept();
        serveSftp(session, username, sshMode, stats, files);
        session.on('pty', (acceptPTY, _reject, info) => {
          stats.ptys.push({ username, rows: info.rows, cols: info.cols });
          acceptPTY?.();
        });
        session.on('window-change', (acceptResize, _reject, info) => {
          stats.resizes.push({ username, rows: info.rows, cols: info.cols });
          acceptResize?.();
        });
        session.on('shell', acceptShell => {
          stats.shellRequests += 1;
          if (sshMode.suppressShell) return;
          const stream = acceptShell();
          stats.activeShells += 1;
          stream.on('error', () => {});
          stream.on('close', () => { stats.activeShells -= 1; });
          stream.write(`ready:${username}\r\n`);
          stream.on('data', bytes => {
            if (sshMode.bulkBytes && bytes.toString() === 'test-only-bulk\r') {
              const chunk = Buffer.alloc(16 * 1024, 120);
              let offset = 0;
              const pump = () => {
                while (!stream.destroyed && offset < sshMode.bulkBytes) {
                  const output = chunk.subarray(0, Math.min(chunk.length, sshMode.bulkBytes - offset));
                  offset += output.length;
                  stats.bulkBytesWritten += output.length;
                  if (!stream.write(output)) { stream.once('drain', pump); return; }
                }
                if (!stream.destroyed) stream.write('\r\nbulk-finished\r\n');
              };
              pump();
              return;
            }
            stream.write(Buffer.concat([Buffer.from(`echo:${username}:`), bytes]));
          });
        });
      });
    });
    client.on('close', () => {
      sshClients.delete(client);
      if (ready) stats.activeSSH -= 1;
    });
  });
  const sshPort = await listen(ssh);
  const web = http.createServer(async (req, res) => {
    try {
      if (await bridge.handleHttp(req, res, new URL(req.url, 'http://localhost').pathname)) return;
      res.writeHead(404).end();
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  t.after(async () => {
    for (const socket of webClients) socket.terminate();
    await bridge?.close();
    for (const client of sshClients) client.end();
    await Promise.all([closeServer(web), closeServer(ssh)]);
  });
  bridge = createBridge(web, {
    sshHost: '127.0.0.1', sshPort, hostKeyPath: hostPublicPath,
    allowedOrigins: [ORIGIN], maxSessions: 8, maxSessionsPerUser: 2,
    maxPending: 16, maxPendingPerIP: 3, trustProxyIp: false,
    loginTimeoutMs: 1000, fileTimeoutMs: 5000,
    sshTimeoutMs: 1000, idleTimeoutMs: 10000, maxLifetimeMs: 20000,
    ...overrides,
  });
  const webPort = await listen(web);

  async function attempt(options = {}) {
    const wsOptions = { headers: options.headers ?? {}, handshakeTimeout: 2000 };
    if (!options.omitOrigin) wsOptions.origin = options.origin ?? ORIGIN;
    const socket = new WebSocket(`ws://127.0.0.1:${webPort}${options.path ?? '/api/terminal'}`, wsOptions);
    const client = {
      socket, messages: [], closed: false, open: false, rejectedStatus: null, closeCode: null,
      outputBytes: 0, acknowledgedBytes: 0, autoAck: options.autoAck === true,
    };
    webClients.add(socket);
    socket.on('open', () => { client.open = true; });
    socket.on('error', () => {});
    socket.on('unexpected-response', (_request, response) => {
      client.rejectedStatus = response.statusCode;
      response.resume();
      socket.terminate();
    });
    socket.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        client.messages.push(message);
        if (message.type === 'data') {
          client.outputBytes += Buffer.from(message.data, 'base64').length;
          if (client.autoAck) acknowledgeOutput(client);
        }
      }
      catch { client.messages.push({ type: 'invalid-server-message' }); }
    });
    socket.on('close', code => {
      client.closed = true;
      client.closeCode = code;
      webClients.delete(socket);
    });
    await until(() => client.open || client.rejectedStatus || client.closed, 'WebSocket handshake did not finish');
    return client;
  }

  async function connected(username = 'alice', options = {}) {
    const client = await attempt(options);
    assert.equal(client.open, true, 'Correct-origin WebSocket should upgrade without a portal cookie');
    client.socket.send(JSON.stringify({ type: 'login', username, password: PASSWORD, cols: 80, rows: 24, ...options.login }));
    await until(() => client.messages.find(m => m.type === 'state' && m.state === 'connected'), 'SSH session did not reach connected');
    return client;
  }

  return {
    stats, attempt, connected, bridge, files,
    base: `http://127.0.0.1:${webPort}`,
  };
}

const dataText = client => client.messages.filter(m => m.type === 'data').map(m => Buffer.from(m.data, 'base64').toString('utf8')).join('');
const sendInput = (client, text) => client.socket.send(JSON.stringify({ type: 'input', data: text }));
function acknowledgeOutput(client) {
  const bytes = client.outputBytes - client.acknowledgedBytes;
  if (bytes > 0 && client.socket.readyState === WebSocket.OPEN) {
    client.socket.send(JSON.stringify({ type: 'ack', bytes }));
    client.acknowledgedBytes += bytes;
  }
}

async function assertRejected(client, statuses = [401, 403, 429], username = 'alice') {
  if (client.open && !client.closed) {
    client.socket.send(JSON.stringify({ type: 'login', username, password: PASSWORD, cols: 80, rows: 24 }));
  }
  await until(() => client.closed || client.rejectedStatus, 'Rejected session remained open');
  if (client.rejectedStatus) assert.ok(statuses.includes(client.rejectedStatus), `Unexpected rejection status ${client.rejectedStatus}`);
  assert.equal(client.messages.some(m => m.type === 'state' && m.state === 'connected'), false);
}

let nextFileRequest = 1;
async function filesReady(client) {
  return until(() => client.messages.find(m => m.type === 'files:ready'), 'SFTP should become ready on the authenticated SSH connection');
}
async function fileRequest(client, type, filename, fields = {}) {
  const requestId = 'test-file-' + nextFileRequest++;
  const message = { type: 'files:' + type, requestId, ...fields };
  if (filename !== undefined) message.path = filename;
  client.socket.send(JSON.stringify(message));
  return until(() => client.messages.find(m => m.requestId === requestId && (m.type === 'files:' + type || m.type === 'files:error')), 'File request should return a correlated result', 5000);
}
async function submit(client, username = 'alice', password = PASSWORD) {
  client.socket.send(JSON.stringify({ type: 'login', username, password, cols: 80, rows: 24 }));
}

test('public session metadata requires only campus login and exposes no user or internal target', async t => {
  const h = await fixture(t);
  for (const pathname of ['/api/session', '/lab/api/session']) {
    const response = await fetch(h.base + pathname);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { authMode: 'campus', requiresLogin: true, serverName: '实验室服务器' });
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(h.stats.sshConnections, 0);
});

test('a correct-origin WebSocket upgrades without cookies but does not create SSH before credentials', async t => {
  const h = await fixture(t);
  const client = await h.attempt();
  assert.equal(client.open, true);
  assert.equal(h.stats.sshConnections, 0);
  assert.equal(h.stats.sftpRequestsToOpen, 0);
});

test('foreign, null and missing WebSocket origins are refused before SSH', async t => {
  const h = await fixture(t);
  for (const options of [{ origin: 'https://attacker.invalid' }, { origin: 'null' }, { omitOrigin: true }]) {
    await assertRejected(await h.attempt(options), [403]);
  }
  assert.equal(h.stats.sshConnections, 0);
});

test('a mismatched pinned host key prevents sending the campus password', async t => {
  const h = await fixture(t, { hostKeyPath: wrongPublicPath });
  const client = await h.attempt();
  await submit(client);
  await until(() => client.messages.some(m => m.type === 'state' && m.state === 'error'), 'Host-key mismatch should report an error');
  await until(() => client.closed, 'Host-key mismatch must close the connection');
  assert.equal(h.stats.passwordAttempts, 0);
  assert.equal(h.stats.sftpRequestsToOpen, 0);
});

test('campus credentials alone establish PTY, input and resize through the prefixed route', async t => {
  const h = await fixture(t);
  const client = await h.connected('alice', { path: '/lab/api/terminal', headers: { Cookie: 'irrelevant=expired' } });
  await until(() => h.stats.ptys.some(p => p.username === 'alice' && p.rows === 24 && p.cols === 80), 'PTY dimensions must reach SSH');
  sendInput(client, 'marker-alice\r');
  await until(() => dataText(client).includes('echo:alice:marker-alice'), 'Terminal input must reach SSH');
  client.socket.send(JSON.stringify({ type: 'resize', rows: 32, cols: 101 }));
  await until(() => h.stats.resizes.some(p => p.rows === 32 && p.cols === 101), 'Resize must reach SSH');
  const connected = client.messages.find(m => m.type === 'state' && m.state === 'connected');
  assert.equal(connected.username, 'alice');
  assert.equal(typeof connected.sessionId, 'string');
  assert.equal(h.stats.passwordAttempts, 1);
});

test('wrong campus passwords fail once, remain secret and never open SFTP', async t => {
  const h = await fixture(t);
  const client = await h.attempt();
  const badPassword = 'wrong-fake-secret-sentinel';
  await submit(client, 'alice', badPassword);
  await until(() => client.closed, 'Rejected password must close');
  assert.equal(h.stats.passwordAttempts, 1);
  assert.equal(JSON.stringify(client.messages).includes(badPassword), false);
  assert.equal(h.stats.activeShells, 0);
  assert.equal(h.stats.sftpRequestsToOpen, 0);
});

test('root is rejected before sending any SSH password', async t => {
  const h = await fixture(t);
  const client = await h.attempt();
  await submit(client, 'root');
  await until(() => client.closed, 'Privileged username must be rejected');
  assert.equal(h.stats.passwordAttempts, 0);
  assert.equal(h.stats.sftpRequestsToOpen, 0);
});

test('independent campus accounts receive only their own terminal output and SFTP home', async t => {
  const h = await fixture(t);
  const [alice, bob] = await Promise.all([h.connected('alice'), h.connected('bob')]);
  sendInput(alice, 'alice-private-marker\r');
  sendInput(bob, 'bob-private-marker\r');
  await until(() => dataText(alice).includes('alice-private-marker') && dataText(bob).includes('bob-private-marker'), 'Independent sessions should carry output');
  assert.equal(dataText(alice).includes('bob-private-marker'), false);
  assert.equal(dataText(bob).includes('alice-private-marker'), false);
  assert.equal((await filesReady(alice)).homePath, '/home/alice');
  assert.equal((await filesReady(bob)).homePath, '/home/bob');
});

test('the authenticated campus username limit preserves existing sessions and allows another account', async t => {
  const h = await fixture(t, { maxSessionsPerUser: 1 });
  const alice = await h.connected('alice');
  const bob = await h.connected('bob');
  await assertRejected(await h.attempt(), [429], 'alice');
  await until(() => h.stats.activeSSH === 2, 'Rejected duplicate account must release its SSH transport');
  assert.equal(alice.closed, false);
  assert.equal(bob.closed, false);
});

test('the authenticated global session limit prevents another live terminal', async t => {
  const h = await fixture(t, { maxSessions: 2 });
  await h.connected('alice');
  await h.connected('bob');
  await assertRejected(await h.attempt(), [429], 'charlie');
  await until(() => h.stats.activeSSH === 2, 'Global limit must leave at most two authenticated transports');
});

test('the global pending limit bounds sockets waiting for credentials', async t => {
  const h = await fixture(t, { maxPending: 2, maxPendingPerIP: 2 });
  assert.equal((await h.attempt()).open, true);
  assert.equal((await h.attempt()).open, true);
  const rejected = await h.attempt();
  assert.equal(rejected.rejectedStatus, 429);
  assert.equal(h.stats.sshConnections, 0);
});

test('pending per-IP limits do not trust spoofed forwarding headers by default', async t => {
  const h = await fixture(t, { maxPending: 8, maxPendingPerIP: 1, trustProxyIp: false });
  await h.attempt({ headers: { 'X-Real-IP': '192.0.2.1', 'X-Forwarded-For': '192.0.2.1' } });
  const rejected = await h.attempt({ headers: { 'X-Real-IP': '192.0.2.2', 'X-Forwarded-For': '192.0.2.2' } });
  assert.equal(rejected.rejectedStatus, 429);
  assert.equal(h.stats.sshConnections, 0);
});

test('five password failures from one IP block a new username despite spoofed proxy headers', async t => {
  const h = await fixture(t, { trustProxyIp: false });
  for (let i = 0; i < 5; i += 1) {
    const client = await h.attempt({ headers: { 'X-Real-IP': '192.0.2.' + (i + 1), 'X-Forwarded-For': '198.51.100.' + (i + 1) } });
    await submit(client, ['alice', 'bob', 'charlie', 'unknown-a', 'unknown-b'][i], 'fake-wrong-password');
    await until(() => client.closed, 'Failed authentication must close');
  }
  const before = h.stats.sshConnections;
  const rejected = await h.attempt({ headers: { 'X-Real-IP': '192.0.2.99', 'X-Forwarded-For': '198.51.100.99' } });
  assert.equal(rejected.rejectedStatus, 429);
  assert.equal(h.stats.sshConnections, before);
  assert.equal(h.stats.passwordAttempts, 5);
});

test('five failures for one campus username cannot be bypassed by changing a trusted proxy IP', async t => {
  const h = await fixture(t, { trustProxyIp: true });
  for (let i = 0; i < 5; i += 1) {
    const client = await h.attempt({ headers: { 'X-Real-IP': '192.0.2.' + (i + 1) } });
    await submit(client, 'alice', 'fake-wrong-password');
    await until(() => client.closed, 'Failed authentication must close');
  }
  const before = h.stats.sshConnections;
  const rejected = await h.attempt({ headers: { 'X-Real-IP': '192.0.2.99' } });
  if (rejected.open) {
    await submit(rejected, 'alice');
    await until(() => rejected.closed, 'Username failure limit must reject a fresh IP');
  } else assert.equal(rejected.rejectedStatus, 429);
  assert.equal(h.stats.sshConnections, before);
  assert.equal(h.stats.passwordAttempts, 5);
});

test('client-supplied host and port cannot redirect the fixed SSH target', async t => {
  let trapConnections = 0;
  const trap = net.createServer(socket => { trapConnections += 1; socket.destroy(); });
  const trapPort = await listen(trap);
  t.after(() => closeServer(trap));
  const h = await fixture(t);
  const client = await h.attempt();
  client.socket.send(JSON.stringify({ type: 'login', username: 'alice', password: PASSWORD, cols: 80, rows: 24, host: '127.0.0.1', port: trapPort }));
  await until(() => client.closed || client.messages.some(m => m.type === 'state' && ['connected', 'error'].includes(m.state)), 'Extra target fields must be rejected or ignored');
  assert.equal(trapConnections, 0);
  if (client.messages.some(m => m.type === 'state' && m.state === 'connected')) assert.equal(h.stats.passwordAttempts, 1);
});

test('one hidden keyboard-interactive password prompt succeeds without a second authentication method', async t => {
  const h = await fixture(t, {}, { authentication: 'keyboard-password' });
  const client = await h.connected();
  sendInput(client, 'keyboard-auth-marker\r');
  await until(() => dataText(client).includes('echo:alice:keyboard-auth-marker'), 'Keyboard password authentication should yield a usable terminal');
  assert.equal(h.stats.keyboardAttempts, 1);
  assert.equal(h.stats.passwordReplies, 1);
  assert.equal(h.stats.passwordAttempts, 0);
});

for (const authentication of ['keyboard-otp', 'keyboard-multi']) {
  test(authentication + ' is rejected without answering with the password', async t => {
    const h = await fixture(t, {}, { authentication });
    const client = await h.attempt();
    await submit(client);
    await until(() => client.closed, 'Unsupported authentication prompts must close');
    assert.equal(h.stats.keyboardAttempts, 1);
    assert.equal(h.stats.passwordReplies, 0);
    assert.equal(h.stats.sftpRequestsToOpen, 0);
  });
}

test('missing credential frames time out without opening SSH or SFTP', async t => {
  const h = await fixture(t, { loginTimeoutMs: 120 });
  const client = await h.attempt();
  await until(() => client.closed, 'Missing credentials must time out');
  assert.equal(h.stats.sshConnections, 0);
  assert.equal(h.stats.sftpRequestsToOpen, 0);
});

test('an absolute lifetime expires even while terminal input continues', async t => {
  const h = await fixture(t, { maxLifetimeMs: 1100, idleTimeoutMs: 400 });
  const client = await h.connected();
  const input = setInterval(() => { if (client.socket.readyState === WebSocket.OPEN) sendInput(client, '.'); }, 50);
  t.after(() => clearInterval(input));
  await until(() => client.closed, 'Input activity cannot bypass absolute lifetime');
  assert.ok(dataText(client).includes('echo:alice:.'));
  await until(() => h.stats.activeSSH === 0, 'Lifetime must release SSH');
});

test('idle terminals expire and release their SSH connection', async t => {
  const h = await fixture(t, { idleTimeoutMs: 180 });
  const client = await h.connected();
  await until(() => client.closed, 'Idle terminal should expire');
  await until(() => h.stats.activeSSH === 0, 'Idle expiry must release SSH');
});

test('SSH timeout covers an authenticated server that never accepts a shell', async t => {
  const h = await fixture(t, { sshTimeoutMs: 800 }, { suppressShell: true });
  const client = await h.attempt();
  await submit(client);
  await until(() => h.stats.shellRequests === 1, 'Fake SSH should receive a shell request after authentication');
  await until(() => client.closed, 'Hung shell request must time out');
  assert.equal(client.messages.some(m => m.type === 'state' && m.state === 'connected'), false);
  await until(() => h.stats.activeSSH === 0, 'Timeout must release authenticated SSH');
});

for (const method of ['browser-close', 'disconnect-message']) {
  test(method + ' releases SSH, PTY, SFTP and file handles', async t => {
    const h = await fixture(t);
    const client = await h.connected();
    await filesReady(client);
    if (method === 'browser-close') client.socket.close(1000, 'test tab closed');
    else client.socket.send(JSON.stringify({ type: 'disconnect' }));
    await until(() => client.closed && h.stats.activeSSH === 0 && h.stats.activeShells === 0 && h.stats.activeSftpChannels === 0 && h.stats.activeSftpHandles === 0, 'Closing the browser session must clean up every SSH channel');
  });
}

test('oversized WebSocket input closes the transport and SSH connection', async t => {
  const h = await fixture(t);
  const client = await h.connected();
  client.socket.send('x'.repeat(2 * 1024 * 1024));
  await until(() => client.closed, 'Oversized input must close');
  await until(() => h.stats.activeSSH === 0, 'Oversized input must release SSH');
});

test('unconsumed terminal output pauses and acknowledgements resume a complete large transfer', async t => {
  const bulkBytes = 4 * 1024 * 1024;
  const h = await fixture(t, {}, { bulkBytes });
  const client = await h.connected();
  sendInput(client, 'test-only-bulk\r');
  await until(() => client.outputBytes >= 256 * 1024, 'Output must reach flow-control threshold');
  await delay(80);
  const pausedAt = client.outputBytes;
  await delay(120);
  assert.equal(client.outputBytes, pausedAt);
  assert.ok(pausedAt < bulkBytes);
  assert.equal(client.closed, false);
  client.autoAck = true;
  acknowledgeOutput(client);
  await until(() => dataText(client).includes('bulk-finished'), 'ACK should resume the full transfer without deadlocking', 6000);
  assert.equal(h.stats.bulkBytesWritten, bulkBytes);
  assert.equal(client.closed, false);
  sendInput(client, 'after-bulk\r');
  await until(() => dataText(client).includes('echo:alice:after-bulk'), 'Terminal must remain usable after flow-controlled output');
});

test('invalid or overstated output acknowledgements close and release SSH', async t => {
  const h = await fixture(t);
  for (const bytes of [0, -1, 1.5, '1', 1024 * 1024]) {
    const client = await h.connected();
    client.socket.send(JSON.stringify({ type: 'ack', bytes }));
    await until(() => client.closed && h.stats.activeSSH === 0, 'Invalid ACK must close and release SSH');
  }
});

test('file requests before campus authentication do not open SSH or SFTP', async t => {
  const h = await fixture(t);
  const client = await h.attempt();
  client.socket.send(JSON.stringify({ type: 'files:list', requestId: 'before-login' }));
  await until(() => client.closed || client.messages.some(m => m.type === 'files:error' || m.type === 'state' && m.state === 'error'), 'Unauthenticated file access must fail');
  assert.equal(h.stats.sshConnections, 0);
  assert.equal(h.stats.sftpRequestsToOpen, 0);
});

test('SFTP home and directory listing use the already-authenticated SSH transport', async t => {
  const h = await fixture(t);
  const client = await h.connected();
  assert.equal((await filesReady(client)).homePath, '/home/alice');
  const result = await fileRequest(client, 'list');
  assert.equal(result.type, 'files:list');
  assert.equal(result.path, '/home/alice');
  assert.equal(result.homePath, '/home/alice');
  assert.ok(result.entries.some(entry => entry.name === 'README.md' && entry.type === 'file'));
  assert.ok(result.entries.some(entry => entry.name === 'projects' && entry.type === 'directory'));
  assert.equal(h.stats.sshConnections, 1);
  assert.equal(h.stats.passwordAttempts, 1);
  await until(() => h.stats.activeSftpHandles === 0, 'Listing must close the directory handle');
});

test('relative paths resolve from home and readable shared paths follow server permissions', async t => {
  const h = await fixture(t);
  const client = await h.connected();
  await filesReady(client);
  const listed = await fileRequest(client, 'list', 'projects');
  assert.equal(listed.type, 'files:list');
  assert.equal(listed.path, '/home/alice/projects');
  assert.ok(listed.entries.some(entry => entry.name === 'train.py'));
  const shared = await fileRequest(client, 'read', '/shared/readable.txt');
  assert.equal(shared.type, 'files:read');
  assert.equal(shared.content, 'Shared content permitted by the fake SSH account.\n');
});

test('text reads preserve UTF-8 content and exact byte metadata', async t => {
  const h = await fixture(t);
  const client = await h.connected();
  await filesReady(client);
  const result = await fileRequest(client, 'read', 'README.md');
  assert.equal(result.type, 'files:read');
  assert.equal(result.content, '# Test workspace\n校园测试文本。\n');
  assert.equal(result.encoding, 'utf-8');
  assert.equal(result.truncated, false);
  assert.equal(result.size, Buffer.byteLength(result.content));
  assert.equal(h.stats.sshConnections, 1);
  await until(() => h.stats.activeSftpHandles === 0, 'Reading must close the file handle');
});

test('a text file exactly at the 256 KiB limit remains readable', async t => {
  const h = await fixture(t);
  const client = await h.connected();
  await filesReady(client);
  const result = await fileRequest(client, 'read', 'exact-limit.txt');
  assert.equal(result.type, 'files:read');
  assert.equal(result.size, 262144);
  assert.equal(Buffer.byteLength(result.content), 262144);
  await until(() => h.stats.activeSftpHandles === 0, 'Large bounded read must close its handle');
});

test('SFTP permission errors do not terminate a usable terminal', async t => {
  const h = await fixture(t);
  const client = await h.connected();
  await filesReady(client);
  const result = await fileRequest(client, 'read', 'private.txt');
  assert.equal(result.type, 'files:error');
  assert.equal(typeof result.code, 'string');
  assert.equal(client.closed, false);
  sendInput(client, 'after-file-denied\r');
  await until(() => dataText(client).includes('echo:alice:after-file-denied'), 'File permission errors must leave the terminal working');
});

test('directory enumeration is capped at 1000 entries and closes its handle', async t => {
  const h = await fixture(t);
  const client = await h.connected();
  await filesReady(client);
  const result = await fileRequest(client, 'list', 'many');
  assert.equal(result.type, 'files:list');
  assert.equal(result.entries.length, 1000);
  assert.equal(result.truncated, true);
  await until(() => h.stats.activeSftpHandles === 0, 'Truncated directory listing must close its handle');
});

test('invalid file paths are rejected before sending an SFTP operation', async t => {
  const h = await fixture(t);
  const client = await h.connected();
  await filesReady(client);
  for (const filename of ['bad\u0000path', 123, 'x'.repeat(5000)]) {
    const before = h.stats.sftpOperations.length;
    const result = await fileRequest(client, 'read', filename);
    assert.equal(result.type, 'files:error');
    assert.equal(h.stats.sftpOperations.length, before);
    assert.equal(client.closed, false);
  }
});

test('files reported above the text-size limit are rejected without reading their contents', async t => {
  const h = await fixture(t);
  const client = await h.connected();
  await filesReady(client);
  const before = h.stats.fileBytesRead;
  const result = await fileRequest(client, 'read', 'large.txt');
  assert.equal(result.type, 'files:error');
  assert.equal(result.code, 'file_too_large');
  assert.equal(h.stats.fileBytesRead, before);
  assert.equal(h.stats.activeSftpHandles, 0);
});

test('binary and invalid UTF-8 files cannot be returned as text previews', async t => {
  const h = await fixture(t);
  const client = await h.connected();
  await filesReady(client);
  for (const filename of ['binary.bin', 'invalid-utf8.txt']) {
    const result = await fileRequest(client, 'read', filename);
    assert.equal(result.type, 'files:error');
    assert.equal(result.code, 'binary_file');
    assert.equal(result.content, undefined);
    await until(() => h.stats.activeSftpHandles === 0, 'Rejected text preview must close its file handle');
  }
  assert.equal(client.closed, false);
});

test('a growing file cannot bypass the text read cap by reporting a small size', async t => {
  const h = await fixture(t);
  const client = await h.connected();
  await filesReady(client);
  const before = h.stats.fileBytesRead;
  const result = await fileRequest(client, 'read', 'growing.txt');
  assert.equal(result.type, 'files:error');
  assert.equal(result.code, 'file_too_large');
  assert.ok(h.stats.fileBytesRead - before <= 262145, 'Read must stop at a bounded sentinel byte');
  await until(() => h.stats.activeSftpHandles === 0, 'Growing-file rejection must close its handle');
});

test('an SSH server without SFTP support still provides a usable terminal', async t => {
  const h = await fixture(t, {}, { sftpUnavailable: true });
  const client = await h.connected();
  await until(() => client.messages.some(m => m.type === 'files:unavailable'), 'Unsupported SFTP must have a clear unavailable result');
  assert.equal(client.closed, false);
  sendInput(client, 'terminal-without-sftp\r');
  await until(() => dataText(client).includes('echo:alice:terminal-without-sftp'), 'SFTP failure must not break terminal input');
});

test('the file protocol cannot create, delete or rename arbitrary paths', async t => {
  const h = await fixture(t);
  const client = await h.connected();
  await filesReady(client);
  for (const type of ['files:create', 'files:delete', 'files:rename']) client.socket.send(JSON.stringify({ type, requestId: type, path: '/home/alice/notes.txt', destination: '/home/alice/renamed.txt', content: 'must-not-be-written' }));
  await until(() => client.closed || client.messages.some(m => m.type === 'files:error' || m.type === 'state' && m.state === 'error'), 'Unsupported write request must fail');
  assert.equal(h.stats.writeOperations, 0);
  assert.equal(h.files.get('/home/alice/notes.txt').data.toString(), 'alpha\nbeta\n');
});

test('a stalled SFTP read times out without hanging the browser or terminal', async t => {
  const h = await fixture(t, { fileTimeoutMs: 800 }, { suppressSftpRead: true });
  const client = await h.connected();
  await filesReady(client);
  const result = await fileRequest(client, 'read', 'notes.txt');
  assert.equal(result.type, 'files:error');
  assert.equal(client.closed, false);
  await until(() => h.stats.activeSftpHandles === 0 && h.stats.activeSftpChannels === 0, 'File timeout must cancel and release SFTP without closing the terminal');
  sendInput(client, 'after-file-timeout\r');
  await until(() => dataText(client).includes('echo:alice:after-file-timeout'), 'A file timeout must not block the terminal');
});

const VALID_REVISION_SHAPE = /^sha256:[a-f0-9]{64}$/;
const unknownRevision = 'sha256:' + '0'.repeat(64);
const pendingTemps = h => h.stats.createdPaths.filter(filename => h.files.has(filename));

test('saving an existing owned file atomically replaces text and preserves mode, uid and gid', async t => {
  const h = await fixture(t);
  const client = await h.connected();
  await filesReady(client);
  const filename = '/home/alice/projects/train.py';
  const original = h.files.get(filename);
  const metadata = { mode: original.mode, uid: original.uid, gid: original.gid };
  const read = await fileRequest(client, 'read', filename);
  assert.match(read.revision, VALID_REVISION_SHAPE);
  const content = '# 更新测试\nprint("saved")\n';
  const saved = await fileRequest(client, 'write', filename, { content, revision: read.revision });
  assert.equal(saved.type, 'files:write');
  assert.equal(saved.path, filename);
  assert.equal(saved.size, Buffer.byteLength(content));
  assert.match(saved.revision, VALID_REVISION_SHAPE);
  assert.notEqual(saved.revision, read.revision);
  assert.equal(Number.isInteger(saved.mtime), true);
  assert.equal(h.files.get(filename).data.toString(), content);
  assert.deepEqual(Object.fromEntries(Object.keys(metadata).map(key => [key, h.files.get(filename)[key]])), metadata);
  assert.equal(h.stats.atomicRenames.length, 1);
  assert.equal(h.stats.atomicRenames[0].to, filename);
  assert.ok(h.stats.writableOriginalOpens >= 1, 'The remote account must actually open the original for writing');
  assert.equal(pendingTemps(h).length, 0);
  await until(() => h.stats.activeSftpHandles === 0, 'A successful save must close every handle');
  const reread = await fileRequest(client, 'read', filename);
  assert.equal(reread.content, content);
  assert.equal(reread.revision, saved.revision);
});

test('server-enforced read-only permissions reject save without altering the original', async t => {
  const h = await fixture(t);
  const client = await h.connected();
  await filesReady(client);
  const filename = '/home/alice/readonly.txt';
  const before = Buffer.from(h.files.get(filename).data);
  const read = await fileRequest(client, 'read', filename);
  const saved = await fileRequest(client, 'write', filename, { content: 'forbidden replacement', revision: read.revision });
  assert.equal(saved.type, 'files:error');
  assert.equal(saved.code, 'permission_denied');
  assert.ok(h.stats.permissionDenials > 0, 'The fake SSH account, rather than a UI restriction, must deny writing');
  assert.deepEqual(h.files.get(filename).data, before);
  assert.equal(h.stats.atomicRenames.length, 0);
  assert.equal(pendingTemps(h).length, 0);
  sendInput(client, 'after-readonly-save\r');
  await until(() => dataText(client).includes('echo:alice:after-readonly-save'), 'A refused save must leave the terminal usable');
});

test('save requires a writable parent for an atomic sibling even when the existing file is writable', async t => {
  const h = await fixture(t);
  const client = await h.connected();
  await filesReady(client);
  const filename = '/shared/writable.txt';
  const read = await fileRequest(client, 'read', filename);
  const saved = await fileRequest(client, 'write', filename, { content: 'must not replace', revision: read.revision });
  assert.equal(saved.type, 'files:error');
  assert.equal(saved.code, 'permission_denied');
  assert.ok(h.stats.writableOriginalOpens >= 1);
  assert.equal(h.files.get(filename).data.toString(), 'Shared original\n');
  assert.equal(pendingTemps(h).length, 0);
});

test('save cannot create a missing file or replace a directory or non-regular file', async t => {
  const h = await fixture(t);
  const client = await h.connected();
  await filesReady(client);
  for (const filename of ['new-file.txt', 'projects', 'named-pipe']) {
    const result = await fileRequest(client, 'write', filename, { content: 'not allowed', revision: unknownRevision });
    assert.equal(result.type, 'files:error', filename);
  }
  assert.equal(h.files.has('/home/alice/new-file.txt'), false);
  assert.equal(h.files.get('/home/alice/projects').type, 'directory');
  assert.equal(h.files.get('/home/alice/named-pipe').type, 'other');
  assert.equal(h.stats.createdPaths.length, 0);
  assert.equal(h.stats.atomicRenames.length, 0);
});

test('binary existing files and invalid or oversized replacement text are never saved', async t => {
  const h = await fixture(t);
  const client = await h.connected();
  await filesReady(client);
  const notes = await fileRequest(client, 'read', 'notes.txt');
  for (const [filename, content, revision] of [
    ['binary.bin', 'text cannot overwrite a binary file', unknownRevision],
    ['notes.txt', 'bad\u0000content', notes.revision],
    ['notes.txt', 'x'.repeat(262145), notes.revision],
  ]) {
    const result = await fileRequest(client, 'write', filename, { content, revision });
    assert.equal(result.type, 'files:error');
    assert.equal(client.closed, false);
  }
  assert.deepEqual(h.files.get('/home/alice/binary.bin').data, Buffer.from([0, 1, 2, 3]));
  assert.equal(h.files.get('/home/alice/notes.txt').data.toString(), 'alpha\nbeta\n');
  assert.equal(h.stats.atomicRenames.length, 0);
  assert.equal(pendingTemps(h).length, 0);
});

test('an existing file above the text limit cannot be overwritten through save', async t => {
  const h = await fixture(t);
  const client = await h.connected();
  await filesReady(client);
  const result = await fileRequest(client, 'write', 'large.txt', { content: 'small replacement', revision: unknownRevision });
  assert.equal(result.type, 'files:error');
  assert.equal(h.files.get('/home/alice/large.txt').data.length, 262145);
  assert.equal(h.stats.createdPaths.length, 0);
});

test('an exact 256 KiB replacement is accepted and keeps the terminal usable', async t => {
  const h = await fixture(t);
  const client = await h.connected();
  await filesReady(client);
  const read = await fileRequest(client, 'read', 'notes.txt');
  const content = 'A'.repeat(262144);
  const saved = await fileRequest(client, 'write', 'notes.txt', { content, revision: read.revision });
  assert.equal(saved.type, 'files:write');
  assert.equal(saved.size, 262144);
  assert.equal(h.files.get('/home/alice/notes.txt').data.length, 262144);
  assert.equal(pendingTemps(h).length, 0);
  sendInput(client, 'after-large-save\r');
  await until(() => dataText(client).includes('echo:alice:after-large-save'), 'Large save must not break terminal input');
});

test('an external content change after preview produces a conflict and retains external data', async t => {
  const h = await fixture(t);
  const client = await h.connected();
  await filesReady(client);
  const read = await fileRequest(client, 'read', 'notes.txt');
  h.files.get('/home/alice/notes.txt').data = Buffer.from('changed outside the editor\n');
  const saved = await fileRequest(client, 'write', 'notes.txt', { content: 'stale editor content', revision: read.revision });
  assert.equal(saved.type, 'files:error');
  assert.equal(saved.code, 'conflict');
  assert.equal(h.files.get('/home/alice/notes.txt').data.toString(), 'changed outside the editor\n');
  assert.equal(h.stats.atomicRenames.length, 0);
  assert.equal(pendingTemps(h).length, 0);
});

test('an external metadata change invalidates a preview revision without changing file contents', async t => {
  const h = await fixture(t);
  const client = await h.connected();
  await filesReady(client);
  const read = await fileRequest(client, 'read', 'notes.txt');
  h.files.get('/home/alice/notes.txt').mode = 0o100600;
  const saved = await fileRequest(client, 'write', 'notes.txt', { content: 'stale editor content', revision: read.revision });
  assert.equal(saved.type, 'files:error');
  assert.equal(saved.code, 'conflict');
  assert.equal(h.files.get('/home/alice/notes.txt').mode, 0o100600);
  assert.equal(h.files.get('/home/alice/notes.txt').data.toString(), 'alpha\nbeta\n');
  assert.equal(pendingTemps(h).length, 0);
});

test('a concurrent external change during temp upload is detected before atomic replacement', async t => {
  const h = await fixture(t, {}, { externalChangeDuringWrite: true });
  const client = await h.connected();
  await filesReady(client);
  const read = await fileRequest(client, 'read', 'notes.txt');
  const saved = await fileRequest(client, 'write', 'notes.txt', { content: 'editor upload', revision: read.revision });
  assert.equal(h.stats.externalChangeInjected, true);
  assert.equal(saved.type, 'files:error');
  assert.equal(saved.code, 'conflict');
  assert.equal(h.files.get('/home/alice/notes.txt').data.toString(), 'external concurrent change\n');
  assert.equal(h.stats.atomicRenames.length, 0);
  assert.equal(pendingTemps(h).length, 0);
  assert.equal(h.stats.removedPaths.length, 1);
});

test('a partial temporary-file write failure preserves the original and removes the temporary file', async t => {
  const h = await fixture(t, {}, { failWriteAfter: 1 });
  const client = await h.connected();
  await filesReady(client);
  const read = await fileRequest(client, 'read', 'notes.txt');
  const saved = await fileRequest(client, 'write', 'notes.txt', { content: 'B'.repeat(100000), revision: read.revision });
  assert.equal(saved.type, 'files:error');
  assert.ok(h.stats.tempBytesWritten > 0 && h.stats.tempBytesWritten < 100000);
  assert.equal(h.files.get('/home/alice/notes.txt').data.toString(), 'alpha\nbeta\n');
  assert.equal(h.stats.atomicRenames.length, 0);
  assert.equal(pendingTemps(h).length, 0);
  assert.equal(h.stats.removedPaths.length, 1);
  await until(() => h.stats.activeSftpHandles === 0, 'Failed save must close all file handles');
});

test('failure to preserve file attributes aborts replacement and cleans up the temporary file', async t => {
  const h = await fixture(t, {}, { failSetstat: true });
  const client = await h.connected();
  await filesReady(client);
  const read = await fileRequest(client, 'read', 'notes.txt');
  const saved = await fileRequest(client, 'write', 'notes.txt', { content: 'must stay temporary', revision: read.revision });
  assert.equal(saved.type, 'files:error');
  assert.equal(h.files.get('/home/alice/notes.txt').data.toString(), 'alpha\nbeta\n');
  assert.equal(h.stats.atomicRenames.length, 0);
  assert.equal(pendingTemps(h).length, 0);
});

for (const [name, sshMode] of [['unadvertised', { noAtomicExtension: true }], ['refused by the server', { renameUnsupported: true }]]) {
  test(`an atomic rename extension ${name} fails closed without falling back to truncation`, async t => {
    const h = await fixture(t, {}, sshMode);
    const client = await h.connected();
    await filesReady(client);
    const read = await fileRequest(client, 'read', 'notes.txt');
    const saved = await fileRequest(client, 'write', 'notes.txt', { content: 'must not replace', revision: read.revision });
    assert.equal(saved.type, 'files:error');
    assert.equal(saved.code, 'atomic_save_unsupported');
    assert.equal(h.files.get('/home/alice/notes.txt').data.toString(), 'alpha\nbeta\n');
    assert.equal(h.stats.atomicRenames.length, 0);
    assert.equal(pendingTemps(h).length, 0);
  });
}

test('two accounts save independently and the remote account refuses another user home', async t => {
  const h = await fixture(t);
  const [alice, bob] = await Promise.all([h.connected('alice'), h.connected('bob')]);
  await Promise.all([filesReady(alice), filesReady(bob)]);
  const [a, b] = await Promise.all([fileRequest(alice, 'read', 'notes.txt'), fileRequest(bob, 'read', 'notes.txt')]);
  const deniedBefore = h.stats.permissionDenials;
  const denied = await fileRequest(alice, 'write', '/home/bob/notes.txt', { content: 'unauthorized', revision: b.revision });
  assert.equal(denied.type, 'files:error');
  assert.equal(denied.code, 'permission_denied');
  assert.ok(h.stats.permissionDenials > deniedBefore, 'The SFTP peer must receive and deny the unauthorized account request');
  const saved = await Promise.all([
    fileRequest(alice, 'write', 'notes.txt', { content: 'alice only\n', revision: a.revision }),
    fileRequest(bob, 'write', 'notes.txt', { content: 'bob only\n', revision: b.revision }),
  ]);
  assert.ok(saved.every(result => result.type === 'files:write'));
  assert.equal(h.files.get('/home/alice/notes.txt').data.toString(), 'alice only\n');
  assert.equal(h.files.get('/home/bob/notes.txt').data.toString(), 'bob only\n');
  assert.equal(h.stats.sshConnections, 2);
  assert.equal(pendingTemps(h).length, 0);
});

test('performance messages before campus authentication cannot create SSH or probe SFTP', async t => {
  const h = await fixture(t, { performanceProbeMs: 30, performanceProbeTimeoutMs: 20 });
  const client = await h.attempt();
  for (const type of ['perf:ping', 'perf:stats']) client.socket.send(JSON.stringify({ type, requestId: 'unauth-' + type }));
  await delay(100);
  assert.equal(h.stats.sshConnections, 0);
  assert.equal(h.stats.sftpOperations.length, 0);
  assert.equal(client.messages.some(message => message.type.startsWith('perf:')), false);
});

test('performance ping reports immediate web transport state without issuing extra SSH probes', async t => {
  const h = await fixture(t, { performanceProbeMs: 60000 });
  const client = await h.connected();
  await filesReady(client);
  const before = h.stats.sftpOperations.length;
  const started = performance.now();
  client.socket.send(JSON.stringify({ type: 'perf:ping', requestId: 'transport-only' }));
  const pong = await until(() => client.messages.find(m => m.type === 'perf:pong' && m.requestId === 'transport-only'), 'Authenticated performance ping must return pong');
  assert.equal(pong.requestId, 'transport-only');
  assert.ok(performance.now() - started < 500);
  const stats = await until(() => client.messages.find(m => m.type === 'perf:stats' && m.requestId === 'transport-only'), 'Ping must include current transport stats');
  assert.equal(stats.sftpStatMs, null);
  assert.equal(typeof stats.outputPending, 'number');
  assert.equal(typeof stats.outputPaused, 'boolean');
  assert.equal(typeof stats.eventLoopDelayMs, 'number');
  assert.equal(h.stats.sftpOperations.length, before);
});

test('performance request floods are throttled and do not amplify SSH traffic', async t => {
  const h = await fixture(t, { performanceProbeMs: 60000 });
  const client = await h.connected();
  await filesReady(client);
  const before = h.stats.sftpOperations.length;
  for (let i = 0; i < 100; i++) client.socket.send(JSON.stringify({ type: 'perf:ping', requestId: 'flood-' + i }));
  await delay(150);
  const pongs = client.messages.filter(m => m.type === 'perf:pong' && m.requestId.startsWith('flood-'));
  assert.ok(pongs.length > 0 && pongs.length <= 10);
  assert.equal(h.stats.sftpOperations.length, before);
  assert.equal(client.closed, false);
  sendInput(client, 'after-diag-flood\r');
  await until(() => dataText(client).includes('echo:alice:after-diag-flood'), 'Diagnostic flooding must not block terminal input');
});

test('a timed-out remote performance probe is not stacked and leaves SFTP and terminal usable', async t => {
  const mode = { suppressHomeStat: true };
  const h = await fixture(t, { performanceProbeMs: 40, performanceProbeTimeoutMs: 25 }, mode);
  const client = await h.connected();
  await filesReady(client);
  await until(() => h.stats.homeStatRequests > 0, 'Automatic diagnostics must probe the authenticated home');
  await until(() => client.messages.some(m => m.type === 'perf:stats' && m.sftpStatMs === null), 'Probe timeout must yield a bounded diagnostic result');
  await delay(140);
  assert.equal(h.stats.homeStatRequests, 1, 'A silent peer must not accumulate more pending probes');
  assert.equal(client.closed, false);
  const read = await fileRequest(client, 'read', 'notes.txt');
  assert.equal(read.type, 'files:read');
  sendInput(client, 'after-diag-timeout\r');
  await until(() => dataText(client).includes('echo:alice:after-diag-timeout'), 'Diagnostic failure must not close SSH');
});

test('automatic diagnostics do not make a concurrent real file request busy', async t => {
  const h = await fixture(t, { performanceProbeMs: 40, performanceProbeTimeoutMs: 100 }, { readDelayMs: 120 });
  const client = await h.connected();
  await filesReady(client);
  const read = await fileRequest(client, 'read', 'notes.txt');
  assert.equal(read.type, 'files:read');
  assert.equal(read.content, 'alpha\nbeta\n');
  await until(() => client.messages.some(m => m.type === 'perf:stats' && typeof m.sftpStatMs === 'number'), 'A background probe must report a remote sample');
  assert.equal(client.messages.some(m => m.type === 'files:error' && m.code === 'files_busy'), false);
  assert.equal(client.closed, false);
});

test('missing or invalid save revisions are rejected without creating a temporary file', async t => {
  const h = await fixture(t);
  const client = await h.connected();
  await filesReady(client);
  const before = h.stats.sftpOperations.length;
  for (const revision of [undefined, 'sha256:wrong', 123]) {
    const result = await fileRequest(client, 'write', 'notes.txt', { content: 'must not write', revision });
    assert.equal(result.type, 'files:error');
    assert.equal(result.code, 'invalid_revision');
  }
  assert.equal(h.stats.sftpOperations.length, before);
  assert.equal(h.stats.createdPaths.length, 0);
  assert.equal(h.files.get('/home/alice/notes.txt').data.toString(), 'alpha\nbeta\n');
});

test('invalid save paths cannot reach SFTP or alter any original file', async t => {
  const h = await fixture(t);
  const client = await h.connected();
  await filesReady(client);
  const before = h.stats.sftpOperations.length;
  for (const filename of ['bad\u0000path', 42, 'x'.repeat(5000)]) {
    const result = await fileRequest(client, 'write', filename, { content: 'must not write', revision: unknownRevision });
    assert.equal(result.type, 'files:error');
    assert.equal(result.code, 'invalid_path');
  }
  assert.equal(h.stats.sftpOperations.length, before);
  assert.equal(h.stats.createdPaths.length, 0);
});

test('a UTF-8 BOM is preserved when previewing, editing and saving text', async t => {
  const h = await fixture(t);
  h.files.get('/home/alice/notes.txt').data = Buffer.from('\ufeffBOM original\n');
  const client = await h.connected();
  await filesReady(client);
  const read = await fileRequest(client, 'read', 'notes.txt');
  assert.equal(read.content, '\ufeffBOM original\n');
  const saved = await fileRequest(client, 'write', 'notes.txt', { content: '\ufeffBOM edited\n', revision: read.revision });
  assert.equal(saved.type, 'files:write');
  assert.deepEqual(h.files.get('/home/alice/notes.txt').data, Buffer.from('\ufeffBOM edited\n'));
});

test('an unpaired Unicode surrogate cannot be silently corrupted into saved UTF-8', async t => {
  const h = await fixture(t);
  const client = await h.connected();
  await filesReady(client);
  const read = await fileRequest(client, 'read', 'notes.txt');
  const saved = await fileRequest(client, 'write', 'notes.txt', { content: 'invalid\ud800text', revision: read.revision });
  assert.equal(saved.type, 'files:error');
  assert.equal(saved.code, 'invalid_content');
  assert.equal(h.files.get('/home/alice/notes.txt').data.toString(), 'alpha\nbeta\n');
  assert.equal(h.stats.createdPaths.length, 0);
});

test('a server that acknowledges but fails to preserve attributes cannot replace the original', async t => {
  const h = await fixture(t, {}, { ignoreSetstat: true });
  const client = await h.connected();
  await filesReady(client);
  const read = await fileRequest(client, 'read', 'notes.txt');
  const saved = await fileRequest(client, 'write', 'notes.txt', { content: 'must remain temporary', revision: read.revision });
  assert.equal(saved.type, 'files:error');
  assert.equal(saved.code, 'save_failed');
  assert.equal(h.files.get('/home/alice/notes.txt').data.toString(), 'alpha\nbeta\n');
  assert.equal(h.stats.atomicRenames.length, 0);
  assert.equal(pendingTemps(h).length, 0);
});

test('a stalled temporary-file upload times out, cleans up and keeps the terminal alive', async t => {
  const h = await fixture(t, { fileTimeoutMs: 900 }, { suppressSftpWrite: true });
  const client = await h.connected();
  await filesReady(client);
  const read = await fileRequest(client, 'read', 'notes.txt');
  assert.equal(read.type, 'files:read');
  const saved = await fileRequest(client, 'write', 'notes.txt', { content: 'stalled upload', revision: read.revision });
  assert.equal(saved.type, 'files:error');
  assert.equal(saved.code, 'files_timeout');
  assert.equal(h.stats.createdPaths.length, 1);
  assert.equal(h.files.get('/home/alice/notes.txt').data.toString(), 'alpha\nbeta\n');
  await until(() => pendingTemps(h).length === 0 && h.stats.activeSftpHandles === 0 && h.stats.activeSftpChannels === 0, 'Timed-out save must remove its temp and release SFTP', 2000);
  assert.equal(client.closed, false);
  sendInput(client, 'after-save-timeout\r');
  await until(() => dataText(client).includes('echo:alice:after-save-timeout'), 'Save timeout must leave terminal input usable');
});

test('a large save frame before login cannot use the enlarged authenticated write allowance', async t => {
  const h = await fixture(t);
  const client = await h.attempt();
  client.socket.send(JSON.stringify({ type: 'files:write', requestId: 'large-unauth-save', path: 'notes.txt', content: 'x'.repeat(100000), revision: unknownRevision }));
  await until(() => client.closed, 'Unauthenticated large frames must close');
  assert.equal(h.stats.sshConnections, 0);
  assert.equal(h.stats.sftpOperations.length, 0);
});
