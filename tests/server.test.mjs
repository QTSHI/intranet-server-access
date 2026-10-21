import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, copyFileSync, symlinkSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

// File mutation tests run against a disposable snapshot. They never modify
// staging frontend assets, production assets, the real host pin or any service.
const project = fileURLToPath(new URL('../', import.meta.url));
let temporary;
let app;
let base;

before(async () => {
  temporary = mkdtempSync(path.join(tmpdir(), 'lab-http-cache-test-'));
  for (const filename of ['server.mjs', 'bridge.mjs']) copyFileSync(path.join(project, filename), path.join(temporary, filename));
  cpSync(path.join(project, 'public'), path.join(temporary, 'public'), { recursive: true });
  symlinkSync(path.join(project, 'node_modules'), path.join(temporary, 'node_modules'), 'dir');
  const hostPath = path.join(temporary, 'host');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'disposable-http-cache-test', '-f', hostPath], { stdio: 'ignore', timeout: 10000 });
  const { createApplication } = await import(pathToFileURL(path.join(temporary, 'server.mjs')).href);
  app = createApplication({ hostKeyPath: hostPath + '.pub', sshHost: '127.0.0.1', sshPort: 9 });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  base = 'http://127.0.0.1:' + app.server.address().port;
});

after(async () => {
  await app?.bridge.close();
  if (app?.server.listening) await new Promise(resolve => {
    app.server.close(resolve); app.server.closeAllConnections?.();
  });
  if (temporary) rmSync(temporary, { recursive: true, force: true });
});

test('root and legacy HTML routes serve the workbench with matching asset and API base paths', async () => {
  for (const [prefix, route] of [['', '/'], ['', '/servers/lab/terminal'], ['/lab', '/'], ['/lab', '/servers/lab/terminal']]) {
    const response = await fetch(base + prefix + route);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes(`name="lab-base-path" content="${prefix}"`));
    assert.ok(html.includes(`src="${prefix}/live.js"`));
    assert.ok(html.includes(`href="${prefix}/live.css"`));
    const metadata = await fetch(base + prefix + '/api/session');
    assert.equal(metadata.status, 200);
    assert.equal((await metadata.json()).authMode, 'campus');
    assert.equal(metadata.headers.get('cache-control'), 'no-store');
  }
});

test('static assets share content-derived ETags across root and legacy paths', async () => {
  for (const filename of ['live.js', 'live.css', 'editor.mjs', 'vendor/xterm.js']) {
    const first = await fetch(base + '/' + filename);
    assert.equal(first.status, 200);
    const etag = first.headers.get('etag');
    assert.match(etag, /^"[a-f0-9]{32}"$/);
    assert.equal(first.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
    const body = Buffer.from(await first.arrayBuffer());
    assert.equal(body.length, Number(first.headers.get('content-length')));
    const legacy = await fetch(base + '/lab/' + filename);
    assert.equal(legacy.status, 200);
    assert.equal(legacy.headers.get('etag'), etag);
    assert.deepEqual(Buffer.from(await legacy.arrayBuffer()), body);
  }
});

test('GET and HEAD honor exact, weak, list and wildcard If-None-Match with empty 304 bodies', async () => {
  const initial = await fetch(base + '/live.js');
  const etag = initial.headers.get('etag');
  const length = initial.headers.get('content-length');
  await initial.arrayBuffer();
  for (const pathname of ['/live.js', '/lab/live.js']) {
    for (const validator of [etag, 'W/' + etag, '"unrelated", W/' + etag, '*']) {
      for (const method of ['GET', 'HEAD']) {
        const response = await fetch(base + pathname, { method, headers: { 'If-None-Match': validator } });
        assert.equal(response.status, 304, `${method} ${pathname} ${validator}`);
        assert.equal(response.headers.get('etag'), etag);
        assert.equal((await response.arrayBuffer()).byteLength, 0);
      }
    }
  }
  const head = await fetch(base + '/live.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('etag'), etag);
  assert.equal(head.headers.get('content-length'), length);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test('a changed static file invalidates its former strong and weak ETags', async () => {
  const filename = path.join(temporary, 'public/live.js');
  const original = readFileSync(filename);
  const first = await fetch(base + '/live.js');
  const oldEtag = first.headers.get('etag');
  await first.arrayBuffer();
  try {
    const changed = Buffer.concat([original, Buffer.from('\n// disposable-cache-change-test\n')]);
    writeFileSync(filename, changed);
    for (const validator of [oldEtag, 'W/' + oldEtag]) {
      const fresh = await fetch(base + '/lab/live.js', { headers: { 'If-None-Match': validator } });
      assert.equal(fresh.status, 200);
      assert.notEqual(fresh.headers.get('etag'), oldEtag);
      assert.deepEqual(Buffer.from(await fresh.arrayBuffer()), changed);
    }
    const now = await fetch(base + '/live.js');
    const freshEtag = now.headers.get('etag');
    await now.arrayBuffer();
    const revalidated = await fetch(base + '/live.js', { headers: { 'If-None-Match': freshEtag } });
    assert.equal(revalidated.status, 304);
  } finally { writeFileSync(filename, original); }
});

test('HTML remains no-store and never returns 304 even for wildcard validators', async () => {
  for (const pathname of ['/', '/live.html', '/lab/', '/lab/live.html', '/lab/servers/lab/terminal']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(base + pathname, { method, headers: { 'If-None-Match': '*' } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('etag'), null);
      assert.equal((await response.arrayBuffer()).byteLength > 0, method === 'GET');
    }
  }
});
