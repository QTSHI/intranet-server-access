import { readFileSync } from 'node:fs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { posix } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Client } from 'ssh2';
import { WebSocket, WebSocketServer } from 'ws';

const BUFFER_LIMIT = 1024 * 1024;
const INPUT_LIMIT = 16 * 1024;
const FILE_LIMIT = 256 * 1024;
const MESSAGE_LIMIT = 64 * 1024;
const FAILURE_WINDOW = 5 * 60 * 1000;
const FAILURE_LIMIT = 5;
class FileError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function pin(filename) {
  let text;
  try { text = readFileSync(filename, 'utf8'); } catch { throw new Error('校园 SSH 主机公钥文件不可用。'); }
  const lines = text.trim().split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'));
  if (text.length > 16384 || lines.length !== 1) throw new Error('必须配置单个完整 ED25519 主机公钥。');
  const fields = lines[0].trim().split(/\s+/);
  const value = fields[0] === 'ssh-ed25519' ? fields[1] : fields[1] === 'ssh-ed25519' ? fields[2] : null;
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('校园 SSH 主机公钥格式无效。');
  const key = Buffer.from(value, 'base64');
  if (key.toString('base64') !== value || key.length !== 51 || key.readUInt32BE(0) !== 11
    || key.subarray(4, 15).toString('ascii') !== 'ssh-ed25519' || key.readUInt32BE(15) !== 32) throw new Error('校园 SSH 主机公钥格式无效。');
  return key;
}
const route = path => path === '/lab' || path.startsWith('/lab/') ? path.slice(4) || '/' : path;
function positive(value, fallback, name) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`连接配置 ${name} 无效。`);
  return result;
}
function dimension(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error('Invalid terminal size');
  return value;
}
const loopback = ip => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
const normalizeIP = ip => ip?.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip || 'unknown';
function kind(attrs) {
  const mode = Number(attrs?.mode) & 0o170000;
  return mode === 0o040000 ? 'directory' : mode === 0o100000 ? 'file' : mode === 0o120000 ? 'symlink' : 'other';
}
const safeNumber = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
function sftpCall(sftp, name, ...args) {
  return new Promise((resolve, reject) => {
    try { sftp[name](...args, (error, result) => {
      // ssh2 returns an EOF status error for a directory handle, unlike its
      // path-based aggregate readdir API. EOF ends this bounded listing.
      if (name === 'readdir' && error?.code === 1) return resolve(false);
      error ? reject(error) : resolve(result);
    }); }
    catch (error) { reject(error); }
  });
}
// Cancelling a local operation settles its promises immediately, even if a peer
// never acknowledges channelClose. ssh2 retains no live application callback.
function cancellableSFTP(raw) {
  const pending = new Set();
  const view = {};
  let cancelled = false;
  for (const method of ['realpath', 'stat', 'opendir', 'readdir', 'open', 'fstat', 'read', 'write', 'fsetstat', 'close', 'unlink', 'ext_openssh_rename']) {
    view[method] = (...args) => {
      let callback = args.pop();
      if (cancelled) return queueMicrotask(() => callback(new FileError('cancelled', '文件请求已取消。')));
      const complete = (...result) => {
        if (!callback) return;
        const handler = callback; callback = null; pending.delete(complete); handler(...result);
      };
      pending.add(complete);
      try { raw[method](...args, complete); } catch (error) { complete(error); }
    };
  }
  return { view, raw, cancel() {
    if (cancelled) return;
    cancelled = true;
    for (const callback of [...pending]) callback(new FileError('cancelled', '文件请求已取消。'));
    pending.clear();
  } };
}
function fileFailure(error) {
  if (error instanceof FileError) return { code: error.code, message: error.message };
  if (error?.code === 2 || error?.code === 'ENOENT') return { code: 'not_found', message: '文件或目录不存在。' };
  if (error?.code === 3 || error?.code === 'EACCES') return { code: 'permission_denied', message: '校园账户没有操作该文件或目录的权限。' };
  return { code: 'files_failed', message: '无法读取文件或目录，请检查路径与校园账户权限。' };
}

/** Public portal: the fixed, pinned campus SSH server is the only login authority. */
export function createBridge(server, options = {}) {
  const hostKey = pin(options.hostKeyPath);
  const host = options.sshHost ?? '127.0.0.1';
  const port = positive(options.sshPort, 22002, 'sshPort');
  if (typeof host !== 'string' || !host || host.length > 253 || port > 65535) throw new Error('固定 SSH 目标配置无效。');
  const origins = new Set(options.allowedOrigins ?? ['http://127.0.0.1:8090']);
  if (!origins.size || [...origins].some(origin => typeof origin !== 'string' || !/^https?:\/\//.test(origin) || new URL(origin).origin !== origin)) throw new Error('访问来源配置无效。');
  const maxSessions = positive(options.maxSessions, 8, 'maxSessions');
  const maxSessionsPerUser = positive(options.maxSessionsPerUser, 2, 'maxSessionsPerUser');
  const maxPending = positive(options.maxPending, 16, 'maxPending');
  const maxPendingPerIP = positive(options.maxPendingPerIP, 3, 'maxPendingPerIP');
  const loginTimeout = positive(options.loginTimeoutMs, 60000, 'loginTimeoutMs');
  const sshTimeout = positive(options.sshTimeoutMs, 20000, 'sshTimeoutMs');
  const idleTimeout = positive(options.idleTimeoutMs, 1800000, 'idleTimeoutMs');
  const lifetime = positive(options.maxLifetimeMs, 28800000, 'maxLifetimeMs');
  const fileTimeout = positive(options.fileTimeoutMs, 10000, 'fileTimeoutMs');
  const probeInterval = positive(options.performanceProbeMs, 15000, 'performanceProbeMs');
  const probeTimeout = positive(options.performanceProbeTimeoutMs, 3000, 'performanceProbeTimeoutMs');
  const logInterval = positive(options.performanceLogMs, 60000, 'performanceLogMs');
  const trustProxy = options.trustProxyIp === true || process.env.NODE_ENV === 'production';
  // A UTF-8 text save may need JSON escaping. All other messages retain the
  // original 64 KiB limit, and a save is still limited to 256 KiB of text.
  const wss = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false });
  const sessions = new Set();
  const closingSockets = new Map();
  const failuresIP = new Map();
  const failuresUser = new Map();
  let closing = false;
  let closePromise;
  const loopDelays = [];
  const measurements = { sftpSamples: [], sftpTimeouts: 0, outputHighWater: 0 };
  let expectedLoopTime = performance.now() + 200;
  const loopMonitor = setInterval(() => {
    const now = performance.now();
    loopDelays.push(Math.max(0, now - expectedLoopTime));
    if (loopDelays.length > 300) loopDelays.shift();
    expectedLoopTime = now + 200;
  }, 200);
  loopMonitor.unref?.();
  const percentile = (values, fraction) => {
    if (!values.length) return 0;
    const ordered = [...values].sort((a, b) => a - b);
    return Math.round(ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] * 100) / 100;
  };
  function performanceStats(s, requestId) {
    return { type: 'perf:stats', ...(requestId ? { requestId } : {}),
      sftpStatMs: s.lastSftpMs ?? null,
      sftpSampleAgeMs: s.lastSftpAt === null ? null : Math.max(0, Math.round(performance.now() - s.lastSftpAt)),
      outputPending: s.outputOutstanding, outputPaused: s.outputPaused,
      eventLoopDelayMs: percentile(loopDelays, 0.95) };
  }
  function scheduleProbe(s) {
    if (s.closed || !s.filesReady) return;
    s.probeTimer = timer(s, () => {
      scheduleProbe(s);
      if (!s.connected || !s.sftp || s.fileBusy || s.probeOutstanding) {
        if (s.connected) send(s, performanceStats(s));
        return;
      }
      const raw = s.sftp;
      s.probeOutstanding = true;
      let settled = false;
      const began = performance.now();
      const timeout = timer(s, () => {
        if (settled) return;
        settled = true; measurements.sftpTimeouts++;
        // A remote stat cannot be cancelled independently in SFTP v3. Keep
        // the in-flight flag until its callback arrives, bounding hung probes.
        if (s.connected) send(s, performanceStats(s));
      }, probeTimeout);
      try { raw.stat(s.homePath, error => {
        s.probeOutstanding = false;
        if (settled || s.closed || raw !== s.sftp) return;
        settled = true; clearTimer(s, timeout);
        if (!error) {
          s.lastSftpMs = Math.round((performance.now() - began) * 100) / 100;
          s.lastSftpAt = performance.now();
          measurements.sftpSamples.push(s.lastSftpMs);
          if (measurements.sftpSamples.length > 4096) measurements.sftpSamples.shift();
        }
        if (s.connected) send(s, performanceStats(s));
      }); } catch {
        s.probeOutstanding = false; settled = true; clearTimer(s, timeout);
      }
    }, probeInterval);
  }
  const performanceLog = setInterval(() => {
    const samples = measurements.sftpSamples.splice(0);
    const active = [...sessions].filter(s => s.connected);
    if (!active.length && !samples.length && !measurements.sftpTimeouts) return;
    console.log(JSON.stringify({ event: 'bridge_performance', timestamp: new Date().toISOString(),
      activeSessions: active.length, pendingSessions: [...sessions].filter(s => !s.authenticated).length,
      sftpStat: { count: samples.length, medianMs: samples.length ? percentile(samples, 0.5) : null,
        p95Ms: samples.length ? percentile(samples, 0.95) : null, timeouts: measurements.sftpTimeouts },
      outputPendingHighWater: Math.max(measurements.outputHighWater, ...active.map(s => s.outputOutstanding)),
      outputPausedSessions: active.filter(s => s.outputPaused).length,
      eventLoopDelayP95Ms: percentile(loopDelays, 0.95) }));
    measurements.sftpTimeouts = 0; measurements.outputHighWater = 0;
  }, logInterval);
  performanceLog.unref?.();

  function clientIP(req) {
    const peer = req.socket.remoteAddress;
    const real = req.headers['x-real-ip'];
    return trustProxy && loopback(peer) && typeof real === 'string' && isIP(real) ? normalizeIP(real) : normalizeIP(peer);
  }
  function failureCount(map, key, add = false) {
    const cutoff = Date.now() - FAILURE_WINDOW;
    for (const [id, times] of map) {
      const recent = times.filter(time => time > cutoff);
      if (recent.length) map.set(id, recent); else map.delete(id);
    }
    const times = map.get(key) ?? [];
    if (add) {
      if (!map.has(key) && map.size >= 10000) map.delete(map.keys().next().value);
      times.push(Date.now()); map.set(key, times);
    }
    return times.length;
  }
  function noteFailure(s) {
    if (s.failureCounted) return;
    s.failureCounted = true;
    failureCount(failuresIP, s.ip, true); failureCount(failuresUser, s.username, true);
  }
  function clearSecret(s) { s.secret?.fill(0); s.secret = null; }
  function timer(s, callback, delay) {
    const handle = setTimeout(() => { s.timers.delete(handle); if (!s.closed) callback(); }, delay);
    handle.unref?.(); s.timers.add(handle); return handle;
  }
  function clearTimer(s, handle) { clearTimeout(handle); s.timers.delete(handle); }
  function finish(s, payload, code = 1000) {
    if (s.closed) return;
    s.closed = true;
    if (payload && s.ws.readyState === WebSocket.OPEN) {
      try { const text = JSON.stringify(payload); if (s.ws.bufferedAmount + Buffer.byteLength(text) <= BUFFER_LIMIT) s.ws.send(text, () => {}); } catch {}
    }
    for (const handle of s.timers) clearTimeout(handle);
    s.timers.clear(); clearSecret(s); s.fileCancel?.(); s.fileCancel = null;
    s.connected = false; s.outputOutstanding = 0; sessions.delete(s);
    for (const stream of [s.sftp, s.channel, s.ssh]) { try { stream?.destroy(); } catch {} }
    s.sftp = null; s.channel = null; s.ssh = null;
    if (s.ws.readyState === WebSocket.OPEN || s.ws.readyState === WebSocket.CONNECTING) {
      try { s.ws.close(code, 'Session ended'); } catch { s.ws.terminate(); }
    }
    if (s.ws.readyState !== WebSocket.CLOSED) {
      const handle = setTimeout(() => { closingSockets.delete(s.ws); s.ws.terminate(); }, 1000);
      handle.unref?.(); closingSockets.set(s.ws, handle);
    }
  }
  const fail = (s, code, message, wsCode = 1008) => finish(s, { type: 'state', state: 'error', code, message }, wsCode);
  function send(s, payload) {
    if (s.closed || s.ws.readyState !== WebSocket.OPEN) return false;
    const text = JSON.stringify(payload);
    if (s.ws.bufferedAmount + Buffer.byteLength(text) > BUFFER_LIMIT) { fail(s, 'output_overflow', '终端输出积压过多，连接已关闭。请重新连接。', 1009); return false; }
    try { s.ws.send(text, error => { if (error) finish(s); }); return true; } catch { finish(s); return false; }
  }
  function idle(s) {
    clearTimer(s, s.idleTimer);
    s.idleTimer = timer(s, () => fail(s, 'idle_timeout', '长时间没有操作，会话已断开。服务器任务是否继续取决于运行方式。'), idleTimeout);
  }
  function fileError(s, requestId, code, message) { send(s, { type: 'files:error', requestId, code, message }); }
  function sendFile(s, payload) {
    let length = Buffer.byteLength(JSON.stringify(payload));
    while (length > BUFFER_LIMIT / 2 && payload.type === 'files:list' && payload.entries.length) {
      payload.entries = payload.entries.slice(0, Math.floor(payload.entries.length / 2));
      payload.truncated = true; length = Buffer.byteLength(JSON.stringify(payload));
    }
    if (length > BUFFER_LIMIT) return fileError(s, payload.requestId, 'preview_too_large', '文件内容编码后超出网页预览上限。');
    send(s, payload);
  }
  function unavailable(s, message) {
    if (s.closed || s.filesUnavailable) return;
    s.filesUnavailable = true; s.filesReady = false;
    s.fileCancel?.();
    clearTimer(s, s.sftpTimer);
    clearTimer(s, s.probeTimer);
    const sftp = s.sftp; s.sftp = null;
    try { sftp?.destroy(); } catch {}
    send(s, { type: 'files:unavailable', message });
  }
  function startFiles(s) {
    s.sftpTimer = timer(s, () => unavailable(s, '文件服务未及时响应，终端仍可继续使用。'), fileTimeout);
    try {
      s.ssh.sftp((error, sftp) => {
        if (s.closed || s.filesUnavailable) { try { sftp?.destroy(); } catch {} return; }
        if (error || !sftp) return unavailable(s, '校园服务器暂不支持文件浏览，终端仍可继续使用。');
        s.sftp = sftp;
        sftp.on('error', () => unavailable(s, '文件服务已中断，终端仍可继续使用。'));
        sftp.on('close', () => unavailable(s, '文件服务已关闭，终端仍可继续使用。'));
        sftp.realpath('.', (err, home) => {
          if (s.closed || s.filesUnavailable) return;
          if (err || typeof home !== 'string' || !home.startsWith('/') || home.includes('\0') || Buffer.byteLength(home) > 4096) return unavailable(s, '无法读取校园工作目录，终端仍可继续使用。');
          clearTimer(s, s.sftpTimer); s.homePath = home; s.filesReady = true;
          send(s, { type: 'files:ready', homePath: home });
          scheduleProbe(s);
        });
      });
    } catch { unavailable(s, '文件服务暂不可用，终端仍可继续使用。'); }
  }
  function candidate(s, value, optional = false) {
    if (value === undefined && optional) return s.homePath;
    if (typeof value !== 'string' || !value || value.includes('\0') || Buffer.byteLength(value) > 4096) throw new FileError('invalid_path', '文件路径无效。');
    return posix.resolve(s.homePath, value);
  }
  async function canonical(sftp, path) {
    const result = await sftpCall(sftp, 'realpath', path);
    if (typeof result !== 'string' || !result.startsWith('/') || result.includes('\0') || Buffer.byteLength(result) > 4096) throw new FileError('invalid_path', '文件路径无效。');
    return result;
  }
  async function listFiles(s, data, sftp) {
    const path = await canonical(sftp, candidate(s, data.path, true));
    const handle = await sftpCall(sftp, 'opendir', path);
    const entries = []; let truncated = false;
    try {
      for (let pages = 0; pages < 2048; pages++) {
        const page = await sftpCall(sftp, 'readdir', handle);
        if (page === false) break;
        if (!Array.isArray(page)) throw new FileError('files_failed', '目录内容无法读取。');
        for (const entry of page) {
          const name = entry.filename;
          if (name === '.' || name === '..') continue;
          if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\0') || Buffer.byteLength(name) > 4096) { truncated = true; continue; }
          if (entries.length >= 1000) { truncated = true; break; }
          entries.push({ name, type: kind(entry.attrs), size: safeNumber(entry.attrs?.size), mtime: safeNumber(entry.attrs?.mtime) });
        }
        if (entries.length >= 1000) {
          if (!truncated) {
            const extra = await sftpCall(sftp, 'readdir', handle);
            truncated = Array.isArray(extra) && extra.some(entry => entry.filename !== '.' && entry.filename !== '..');
          }
          break;
        }
        if (pages === 2047) truncated = true;
      }
    } finally { await sftpCall(sftp, 'close', handle).catch(() => {}); }
    return { type: 'files:list', requestId: data.requestId, path, homePath: s.homePath, entries, ...(truncated ? { truncated: true } : {}) };
  }
  function revision(path, bytes, attrs) {
    // atime is intentionally excluded: merely reading must not stale an editor.
    const metadata = { path, mode: attrs.mode ?? null, uid: attrs.uid ?? null,
      gid: attrs.gid ?? null, size: attrs.size ?? null, mtime: attrs.mtime ?? null };
    return `sha256:${createHash('sha256').update(JSON.stringify(metadata)).update('\0').update(bytes).digest('hex')}`;
  }
  async function readExisting(sftp, path, writable = false) {
    // r+ asks the remote OS to enforce write permission without modifying data.
    const handle = await sftpCall(sftp, 'open', path, writable ? 'r+' : 'r');
    const buffer = Buffer.alloc(FILE_LIMIT + 1);
    try {
      const opened = await sftpCall(sftp, 'fstat', handle);
      if (kind(opened) !== 'file') throw new FileError('not_file', '该路径不是可预览的普通文件。');
      if (opened.size > FILE_LIMIT) throw new FileError('file_too_large', '文件超过 256 KiB，请使用本地开发工具查看。');
      let length = 0;
      while (length < buffer.length) {
        const count = await new Promise((resolve, reject) => {
          sftp.read(handle, buffer, length, buffer.length - length, length, (error, bytesRead) => error ? reject(error) : resolve(bytesRead));
        });
        if (!Number.isInteger(count) || count < 0 || count > buffer.length - length) throw new FileError('files_failed', '文件内容无法读取。');
        if (!count) break;
        length += count;
      }
      if (length > FILE_LIMIT) throw new FileError('file_too_large', '文件超过 256 KiB，请使用本地开发工具查看。');
      const bytes = buffer.subarray(0, length);
      if (bytes.includes(0)) throw new FileError('binary_file', '二进制文件不支持网页文本预览。');
      let content;
      try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new FileError('binary_file', '该文件不是有效 UTF-8 文本，请使用本地工具查看。'); }
      return { content, size: length, revision: revision(path, bytes, opened), attrs: opened };
    } finally { buffer.fill(0); await sftpCall(sftp, 'close', handle).catch(() => {}); }
  }
  async function readFile(s, data, sftp) {
    const path = await canonical(sftp, candidate(s, data.path));
    const result = await readExisting(sftp, path);
    return { type: 'files:read', requestId: data.requestId, path, content: result.content,
      encoding: 'utf-8', size: result.size, revision: result.revision, truncated: false };
  }
  function cleanupCall(raw, name, ...args) {
    // A broken remote transport cannot promise removal. Keep cleanup bounded,
    // attempt only our exclusive temporary file, and never unlink the original.
    return new Promise(resolve => {
      let done = false;
      const handle = setTimeout(complete, 500); handle.unref?.();
      function complete() { if (!done) { done = true; clearTimeout(handle); resolve(); } }
      try { raw[name](...args, complete); } catch { complete(); }
    });
  }
  async function writeFile(s, data, sftp, scope) {
    if (typeof data.content !== 'string' || data.content.includes('\0')
      || Buffer.byteLength(data.content) > FILE_LIMIT
      || Buffer.from(data.content, 'utf8').toString('utf8') !== data.content) throw new FileError('invalid_content', '仅支持保存不超过 256 KiB 的 UTF-8 文本。');
    if (typeof data.revision !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(data.revision)) throw new FileError('invalid_revision', '请重新打开文件后再保存。');
    const bytes = Buffer.from(data.content, 'utf8');
    data.content = null;
    let temporary = null, handle = null, cleanupPromise;
    scope.cleanup = () => {
      if (cleanupPromise) return cleanupPromise;
      const jobs = [];
      if (handle) { jobs.push(cleanupCall(scope.raw, 'close', handle)); handle = null; }
      if (temporary) { jobs.push(cleanupCall(scope.raw, 'unlink', temporary)); temporary = null; }
      return cleanupPromise = Promise.allSettled(jobs);
    };
    try {
      const path = await canonical(sftp, candidate(s, data.path));
      const original = await readExisting(sftp, path, true);
      if (original.revision !== data.revision) throw new FileError('conflict', '文件已被其他程序修改。请重新打开并核对后再保存。');
      const attrs = original.attrs;
      if (![attrs.mode, attrs.uid, attrs.gid].every(value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff)) throw new FileError('save_failed', '无法确认原文件的权限与属主，未保存。');
      temporary = posix.join(posix.dirname(path), `.lab-save-${randomUUID()}`);
      handle = await sftpCall(sftp, 'open', temporary, 'wx', { mode: 0o600 });
      for (let offset = 0; offset < bytes.length;) {
        const length = Math.min(32768, bytes.length - offset);
        await sftpCall(sftp, 'write', handle, bytes, offset, length, offset);
        offset += length;
      }
      await sftpCall(sftp, 'fsetstat', handle, { mode: attrs.mode & 0o7777, uid: attrs.uid, gid: attrs.gid });
      const saved = await sftpCall(sftp, 'fstat', handle);
      if (kind(saved) !== 'file' || (saved.mode & 0o7777) !== (attrs.mode & 0o7777)
        || saved.uid !== attrs.uid || saved.gid !== attrs.gid || saved.size !== bytes.length) throw new FileError('save_failed', '临时文件的权限或内容校验失败，未替换原文件。');
      await sftpCall(sftp, 'close', handle); handle = null;
      // SFTP v3 has no compare-and-swap. Recheck immediately before atomic
      // replacement to narrow, but cannot eliminate, the final external race.
      if (await canonical(sftp, candidate(s, data.path)) !== path
        || (await readExisting(sftp, path, true)).revision !== data.revision) throw new FileError('conflict', '保存期间文件已改变。请重新打开并核对后再保存。');
      try { await sftpCall(sftp, 'ext_openssh_rename', temporary, path); }
      catch (error) {
        if (error?.code === 8 || /does not support this extended request/.test(error?.message ?? '')) throw new FileError('atomic_save_unsupported', '校园服务器不支持原子保存，原文件未更改。');
        throw error;
      }
      temporary = null;
      return { type: 'files:write', requestId: data.requestId, path, size: bytes.length,
        revision: revision(path, bytes, saved), mtime: safeNumber(saved.mtime) };
    } finally { bytes.fill(0); await scope.cleanup(); }
  }
  async function files(s, data) {
    const requestId = typeof data.requestId === 'string' && data.requestId.length <= 128 && !data.requestId.includes('\0') ? data.requestId : '';
    if (!requestId) return fileError(s, '', 'invalid_request', '文件请求标识无效。');
    if (!s.connected) return fileError(s, requestId, 'not_connected', '请先使用个人校园账户建立连接。');
    const now = Date.now(); s.fileRequests = s.fileRequests.filter(time => time > now - 1000);
    if (s.fileRequests.length >= 5) return fileError(s, requestId, 'rate_limited', '文件请求较频繁，请稍后重试。');
    s.fileRequests.push(now);
    if (!s.filesReady || !s.sftp) return fileError(s, requestId, 'files_unavailable', '文件服务暂不可用，终端仍可继续使用。');
    if (s.fileBusy) return fileError(s, requestId, 'busy', '正在处理上一项文件请求，请稍候。');
    if (!['files:list', 'files:read', 'files:write'].includes(data.type)) return fileError(s, requestId, 'unsupported_operation', '不支持该文件操作。');
    s.fileBusy = true; idle(s);
    const operationChannel = cancellableSFTP(s.sftp);
    let rejectCancelled;
    const cancelled = new Promise((_, reject) => { rejectCancelled = reject; });
    s.fileCancel = () => { operationChannel.cancel(); rejectCancelled(new FileError('cancelled', '文件请求已取消。')); };
    const timeout = timer(s, () => {
      s.filesReady = false;
      const cleanup = operationChannel.cleanup?.();
      rejectCancelled(new FileError('files_timeout', '文件操作超时，终端仍可继续使用。')); operationChannel.cancel();
      Promise.resolve(cleanup).then(() => unavailable(s, '文件服务未及时响应，终端仍可继续使用。'), () => unavailable(s, '文件服务未及时响应，终端仍可继续使用。'));
    }, fileTimeout);
    try {
      const operation = data.type === 'files:list' ? listFiles(s, data, operationChannel.view)
        : data.type === 'files:read' ? readFile(s, data, operationChannel.view) : writeFile(s, data, operationChannel.view, operationChannel);
      const response = await Promise.race([operation, cancelled]);
      if (!s.closed) sendFile(s, response);
    } catch (error) {
      if (!s.closed) { const failure = fileFailure(error); fileError(s, requestId,
        data.type === 'files:write' && failure.code === 'files_failed' ? 'save_failed' : failure.code,
        data.type === 'files:write' && failure.code === 'files_failed' ? '文件保存失败，请重新打开文件核对。' : failure.message); }
    } finally { data.content = null; clearTimer(s, timeout); operationChannel.cancel(); s.fileCancel = null; s.fileBusy = false; }
  }
  function connect(s) {
    const ssh = new Client(); s.ssh = ssh;
    let method = null, checked = false, badHost = false, unsupported = false, authFailed = false, prompted = false;
    s.sshTimer = timer(s, () => fail(s, 'tunnel_unavailable', '校园终端连接超时，请稍后重试。', 1011), sshTimeout);
    ssh.on('error', error => {
      if (s.closed) return;
      clearSecret(s);
      if (badHost) return fail(s, 'host_key_changed', '校园服务器身份核验失败，连接已停止。请联系管理员。');
      if (unsupported) return fail(s, 'unsupported_auth', '服务器需要额外认证步骤，网页终端暂不支持。请使用本地 SSH。');
      if (authFailed || error.level === 'client-authentication') {
        if (method === 'password' || prompted) noteFailure(s);
        return fail(s, 'auth_failed', '校园账户认证失败，请核对你自己的用户名和密码。');
      }
      fail(s, 'tunnel_unavailable', '校园连接暂时不可用，请稍后重试。', 1011);
    });
    ssh.on('close', () => {
      if (s.closed) return;
      if (s.authenticated) finish(s, { type: 'state', state: 'disconnected', message: '校园连接已关闭。服务器任务是否继续取决于运行方式。' });
      else fail(s, badHost ? 'host_key_changed' : 'tunnel_unavailable', badHost ? '校园服务器身份核验失败，连接已停止。' : '校园连接未能建立，请稍后重试。', 1011);
    });
    ssh.on('change password', () => { unsupported = true; fail(s, 'unsupported_auth', '校园账户要求改密，请先使用本地 SSH 完成。'); });
    ssh.on('ready', () => {
      if (s.closed) return;
      clearSecret(s); s.authFinished = true;
      if (!checked || method === null || method === 'none' || (method === 'keyboard-interactive' && !prompted)) return fail(s, 'unsupported_auth', '服务器未完成受支持的个人密码认证，连接已停止。');
      const active = [...sessions].filter(other => other !== s && other.authenticated);
      if (active.length >= maxSessions || active.filter(other => other.username === s.username).length >= maxSessionsPerUser) return fail(s, 'rate_limited', '已达到校园账户或站点的同时连接上限，请先断开其他会话。');
      s.authenticated = true;
      ssh.shell({ term: 'xterm-256color', cols: s.cols, rows: s.rows, width: 0, height: 0 }, (error, channel) => {
        if (s.closed) { channel?.destroy(); return; }
        if (error || !channel) return fail(s, 'permission_denied', '校园账户无法打开终端，请检查该账户的服务器权限。');
        clearTimer(s, s.sshTimer); s.channel = channel; s.connected = true; idle(s);
        send(s, { type: 'state', state: 'connected', username: s.username, sessionId: s.id,
          features: { performance: true, fileWrite: true }, message: '已连接到你的校园账户。' });
        const output = data => {
          if (s.closed) return;
          const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
          if (s.outputOutstanding + bytes.length > BUFFER_LIMIT) return fail(s, 'output_overflow', '浏览器未能及时处理终端输出，连接已关闭。', 1009);
          s.outputOutstanding += bytes.length;
          measurements.outputHighWater = Math.max(measurements.outputHighWater, s.outputOutstanding);
          if (!send(s, { type: 'data', data: bytes.toString('base64') })) return;
          if (s.outputOutstanding > 256 * 1024 && !s.outputPaused) { s.outputPaused = true; channel.pause(); channel.stderr.pause(); }
        };
        channel.on('data', output); channel.stderr.on('data', output);
        channel.on('error', () => fail(s, 'connection_lost', '终端传输已中断，请重新连接。', 1011));
        channel.on('exit', (code, signal) => {
          const payload = { type: 'exit' };
          if (Number.isInteger(code)) payload.code = code;
          if (typeof signal === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(signal)) payload.signal = signal;
          send(s, payload);
        });
        channel.on('close', () => finish(s, { type: 'state', state: 'disconnected', message: '校园终端已结束。服务器任务是否继续取决于运行方式。' }));
        startFiles(s);
      });
    });
    try {
      ssh.connect({ host, port, username: s.username, readyTimeout: sshTimeout, keepaliveInterval: 15000, keepaliveCountMax: 2,
        algorithms: { serverHostKey: ['ssh-ed25519'] },
        hostVerifier: key => { const valid = Buffer.isBuffer(key) && key.length === hostKey.length && timingSafeEqual(key, hostKey); checked = valid; badHost = !valid; return valid; },
        authHandler(methods, partial, callback) {
          if (s.closed) return callback(false);
          if (partial) { unsupported = true; clearSecret(s); return callback(false); }
          if (method === null) { method = 'none'; return callback({ type: 'none', username: s.username }); }
          if (method !== 'none') { authFailed = true; noteFailure(s); clearSecret(s); return callback(false); }
          if (!Array.isArray(methods)) { unsupported = true; clearSecret(s); return callback(false); }
          if (methods.includes('password')) {
            method = 'password';
            // ssh2 copies this Buffer into its authentication packet synchronously.
            try { callback({ type: 'password', username: s.username, password: s.secret }); } finally { clearSecret(s); }
            return;
          }
          if (methods.includes('keyboard-interactive')) {
            method = 'keyboard-interactive';
            return callback({ type: 'keyboard-interactive', username: s.username, prompt(name, instructions, language, prompts, done) {
              const prompt = Array.isArray(prompts) && prompts.length === 1 ? prompts[0] : null;
              if (prompted || !prompt || prompt.echo !== false || !/password|密码|口令/i.test(prompt.prompt)
                || /\botp\b|one[- ]?time|verification|\btoken\b|\bcode\b|new password|change password|验证码|动态|新密码|修改密码/i.test(`${name} ${instructions} ${prompt?.prompt ?? ''}`)) {
                unsupported = true; clearSecret(s); return fail(s, 'unsupported_auth', '服务器需要验证码、改密或额外认证步骤，请使用本地 SSH。');
              }
              prompted = true;
              let answer = s.secret.toString('utf8');
              try { done([answer]); } finally { answer = null; clearSecret(s); }
            } });
          }
          unsupported = true; clearSecret(s); callback(false);
        },
      });
      // ssh2 otherwise leaves Node's Nagle default in place. This affects the
      // local SSH socket only; it cannot tune the existing Windows relay.
      ssh.setNoDelay(options.sshNoDelay !== false);
    } catch { clearSecret(s); fail(s, 'tunnel_unavailable', '校园连接暂时不可用，请稍后重试。', 1011); }
  }
  async function message(s, raw, binary) {
    const rawLength = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(raw);
    if (s.closed || binary) {
      if (Buffer.isBuffer(raw)) raw.fill(0);
      if (!s.closed) fail(s, 'invalid_request', '终端消息格式无效。');
      return;
    }
    let data;
    try { data = JSON.parse(raw.toString('utf8')); } catch { return fail(s, 'invalid_request', '终端消息格式无效。'); }
    finally { if (Buffer.isBuffer(raw)) raw.fill(0); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return fail(s, 'invalid_request', '终端消息格式无效。');
    if (rawLength > MESSAGE_LIMIT && !(s.connected && data.type === 'files:write')) {
      delete data.password; data.content = null;
      return fail(s, 'invalid_request', '单次消息过长。', 1009);
    }
    if (data.type === 'files:write' && rawLength > BUFFER_LIMIT) {
      data.content = null;
      const id = typeof data.requestId === 'string' && data.requestId.length <= 128 && !data.requestId.includes('\0') ? data.requestId : '';
      return fileError(s, id, 'save_too_large', '文本编码后的保存请求过大，请使用本地工具编辑。');
    }
    if (typeof data.type === 'string' && data.type.startsWith('files:')) return files(s, data);
    if (data.type === 'perf:ping' || data.type === 'perf:stats') {
      if (!s.connected) return;
      const requestId = typeof data.requestId === 'string' && data.requestId.length <= 128 && !data.requestId.includes('\0') ? data.requestId : '';
      if (!requestId && (data.type === 'perf:ping' || data.requestId !== undefined)) return;
      const now = Date.now(); s.performanceRequests = s.performanceRequests.filter(time => time > now - 1000);
      if (s.performanceRequests.length >= 10) return;
      s.performanceRequests.push(now);
      if (data.type === 'perf:ping') send(s, { type: 'perf:pong', requestId });
      send(s, performanceStats(s, requestId));
      return;
    }
    if (data.type === 'disconnect') return finish(s, { type: 'state', state: 'disconnected', message: '浏览器会话已断开。服务器任务是否继续取决于运行方式。' });
    if (data.type === 'login') {
      if (s.loginStarted) { delete data.password; return fail(s, 'invalid_request', '当前连接已经提交过认证，请重新建立连接。'); }
      if (typeof data.username !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,63}$/.test(data.username) || data.username.toLowerCase() === 'root'
        || typeof data.password !== 'string' || !data.password.length || Buffer.byteLength(data.password) > 4096) { delete data.password; return fail(s, 'invalid_request', '请输入有效的个人校园账户和密码；不支持 root 账户。'); }
      s.loginStarted = true; s.username = data.username;
      const attempting = [...sessions].filter(other => other !== s && other.loginStarted && !other.authFinished);
      if (failureCount(failuresIP, s.ip) + attempting.filter(other => other.ip === s.ip).length >= FAILURE_LIMIT
        || failureCount(failuresUser, s.username) + attempting.filter(other => other.username === s.username).length >= FAILURE_LIMIT) {
        delete data.password; return fail(s, 'rate_limited', '校园认证失败次数较多或请求正在处理，请稍后重试；失败限制为五分钟。');
      }
      s.secret = Buffer.from(data.password, 'utf8'); delete data.password;
      try { s.cols = dimension(data.cols, 100, 2, 500); s.rows = dimension(data.rows, 30, 1, 300); }
      catch { return fail(s, 'invalid_request', '终端尺寸无效。'); }
      clearTimer(s, s.loginTimer);
      if (send(s, { type: 'state', state: 'authenticating', message: '正在验证你的个人校园账户。' })) connect(s);
      return;
    }
    if (data.type === 'resize') {
      try { s.cols = dimension(data.cols, s.cols, 2, 500); s.rows = dimension(data.rows, s.rows, 1, 300); if (s.connected) s.channel.setWindow(s.rows, s.cols, 0, 0); }
      catch { fail(s, 'invalid_request', '终端尺寸无效。'); }
      return;
    }
    if (data.type === 'ack') {
      if (!s.connected || !Number.isSafeInteger(data.bytes) || data.bytes <= 0 || data.bytes > s.outputOutstanding) return fail(s, 'invalid_request', '终端输出确认无效，连接已停止。');
      s.outputOutstanding -= data.bytes;
      if (s.outputPaused && s.outputOutstanding < 128 * 1024) { s.outputPaused = false; try { s.channel.resume(); s.channel.stderr.resume(); } catch { fail(s, 'connection_lost', '终端传输已中断，请重新连接。', 1011); } }
      return;
    }
    if (data.type === 'input') {
      if (!s.connected || !s.channel) return fail(s, 'invalid_request', '请等待校园账户连接完成。');
      if (typeof data.data !== 'string' || Buffer.byteLength(data.data) > INPUT_LIMIT) return fail(s, 'invalid_request', '单次终端输入过长或格式无效。');
      if (!data.data.length) return;
      if (s.channel.writableLength + Buffer.byteLength(data.data) > BUFFER_LIMIT) return fail(s, 'input_overflow', '终端输入积压过多，连接已停止。', 1009);
      idle(s); try { s.channel.write(data.data, 'utf8'); } catch { fail(s, 'connection_lost', '终端传输已中断，请重新连接。', 1011); }
      return;
    }
    fail(s, 'invalid_request', '不支持的终端消息。');
  }
  function attach(ws, ip) {
    const s = { id: `SSH-${randomUUID()}`, ws, ip, username: null, secret: null, ssh: null, channel: null, sftp: null,
      connected: false, authenticated: false, closed: false, loginStarted: false, authFinished: false, failureCounted: false, alive: true,
      timers: new Set(), cols: 100, rows: 30, outputOutstanding: 0, outputPaused: false,
      filesReady: false, filesUnavailable: false, fileBusy: false, fileRequests: [], fileCancel: null, homePath: null,
      lastSftpMs: null, lastSftpAt: null, probeOutstanding: false, performanceRequests: [] };
    sessions.add(s);
    ws.on('error', () => finish(s));
    ws.on('close', () => { const handle = closingSockets.get(ws); if (handle) { clearTimeout(handle); closingSockets.delete(ws); } finish(s); });
    ws.on('pong', () => { s.alive = true; });
    ws.on('message', (raw, binary) => { message(s, raw, binary).catch(() => fail(s, 'connection_lost', '连接已停止，请重新连接。', 1011)); });
    s.loginTimer = timer(s, () => fail(s, 'login_timeout', '等待校园账户登录超时，请重新打开连接。'), loginTimeout);
    timer(s, () => fail(s, 'session_expired', '会话已达到最长连接时间，请重新连接。服务器任务是否继续取决于运行方式。'), lifetime);
  }
  const heartbeat = setInterval(() => {
    for (const s of sessions) {
      if (!s.alive) { finish(s); s.ws.terminate(); continue; }
      s.alive = false; try { s.ws.ping(); } catch { finish(s); }
    }
  }, 30000);
  heartbeat.unref?.();
  function reject(socket, status) {
    if (socket.destroyed) return;
    const reasons = { 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 503: 'Service Unavailable' };
    socket.end(`HTTP/1.1 ${status} ${reasons[status] ?? 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\r\n`, () => socket.destroy());
  }
  function upgrade(req, socket, head) {
    const socketError = () => socket.destroy();
    const clearError = () => socket.removeListener('error', socketError);
    socket.on('error', socketError); socket.once('close', clearError);
    let path;
    try { path = route(new URL(req.url, 'http://localhost').pathname); } catch { return reject(socket, 400); }
    if (path !== '/api/terminal') return reject(socket, 404);
    if (closing) return reject(socket, 503);
    if (req.method !== 'GET' || !origins.has(req.headers.origin)) return reject(socket, 403);
    const ip = clientIP(req);
    const pending = [...sessions].filter(s => !s.authenticated);
    if (failureCount(failuresIP, ip) >= FAILURE_LIMIT || pending.length >= maxPending || pending.filter(s => s.ip === ip).length >= maxPendingPerIP) return reject(socket, 429);
    socket.removeListener('error', socketError); socket.removeListener('close', clearError);
    try { wss.handleUpgrade(req, socket, head, ws => attach(ws, ip)); }
    catch { socket.on('error', socketError); socket.once('close', clearError); reject(socket, 400); }
  }
  server.on('upgrade', upgrade);
  async function handleHttp(req, res, path) {
    if (route(path) !== '/api/session') return false;
    const method = ['GET', 'HEAD'].includes(req.method);
    const payload = method ? { authMode: 'campus', requiresLogin: true, serverName: '实验室服务器' } : { code: 'invalid_request', message: '不支持的请求方法。' };
    const body = Buffer.from(JSON.stringify(payload));
    res.writeHead(method ? 200 : 405, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", ...(method ? {} : { Allow: 'GET, HEAD' }) });
    res.end(req.method === 'HEAD' ? undefined : body); return true;
  }
  function close() {
    if (closePromise) return closePromise;
    closing = true; clearInterval(heartbeat); clearInterval(loopMonitor); clearInterval(performanceLog); server.removeListener('upgrade', upgrade);
    for (const s of [...sessions]) finish(s, { type: 'state', state: 'disconnected', message: '连接服务正在退出，请稍后重新连接。' }, 1001);
    for (const [socket, handle] of closingSockets) { clearTimeout(handle); socket.terminate(); }
    closingSockets.clear(); failuresIP.clear(); failuresUser.clear();
    closePromise = new Promise(resolve => wss.close(() => resolve())); return closePromise;
  }
  return { handleHttp, close };
}
