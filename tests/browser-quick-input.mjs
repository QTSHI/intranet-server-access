// Real Chrome + disposable loopback SSH/SFTP. Never connects to the campus host.
import { chromium } from 'playwright-core';
import ssh2 from 'ssh2';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'lab-quick-input-browser-'));
const snapshot = path.join(temporary, 'app');
const key = path.join(temporary, 'fake-host');
await fs.mkdir(snapshot);
for (const file of ['server.mjs', 'bridge.mjs']) await fs.copyFile(path.join(root, file), path.join(snapshot, file));
await fs.cp(path.join(root, 'public'), path.join(snapshot, 'public'), { recursive: true });
await fs.symlink(path.join(root, 'node_modules'), path.join(snapshot, 'node_modules'), 'dir');
const hashes = {};
for (const file of ['server.mjs', 'bridge.mjs', 'public/live.js', 'public/live.css']) hashes[file] = createHash('sha256').update(await fs.readFile(path.join(snapshot, file))).digest('hex');
const { createApplication } = await import(pathToFileURL(path.join(snapshot, 'server.mjs')).href);
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'isolated-quick-input-fixture', '-f', key], { stdio: 'ignore', timeout: 10000 });
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], geometry = [], errors = [], csp = [], clients = new Set(), echoTimers = new Set();
let app, browser, page, fixtureStream, inputBytes = '', attempts = 0, activeShells = 0, lastResize, echoCount = 0;
const echoDelayMs = 500;
const check = (name, passed, detail) => { checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) }); assert(passed, name); };
function serveFiles(sftp) {
  const handles = new Map(); let sequence = 0;
  const attrs = { mode: 0o040755, uid: 1000, gid: 1000, size: 0, atime: 1700000000, mtime: 1700000000 };
  sftp.on('error', () => {});
  sftp.on('REALPATH', (id, value) => { const filename = path.posix.resolve('/home/alice', value); sftp.name(id, [{ filename, longname: filename, attrs: {} }]); });
  sftp.on('STAT', id => sftp.attrs(id, attrs));
  sftp.on('LSTAT', id => sftp.attrs(id, attrs));
  sftp.on('OPENDIR', id => { const handle = Buffer.alloc(4); handle.writeUInt32BE(++sequence); handles.set(handle.toString('hex'), false); sftp.handle(id, handle); });
  sftp.on('READDIR', (id, handle) => { const key = handle.toString('hex'); if (handles.get(key)) return sftp.status(id, 1); handles.set(key, true); sftp.name(id, []); });
  sftp.on('CLOSE', (id, handle) => { handles.delete(handle.toString('hex')); sftp.status(id, 0); });
}
const ssh = new ssh2.Server({ hostKeys: [await fs.readFile(key)] }, client => {
  clients.add(client); client.setNoDelay(true);
  client.on('error', () => {}); client.on('close', () => clients.delete(client));
  client.on('authentication', ctx => { if (ctx.method === 'password') { attempts++; if (ctx.username === 'alice' && ctx.password === 'quick-input-fixture-password') return ctx.accept(); } ctx.reject(['password']); });
  client.on('ready', () => client.on('session', accept => {
    const session = accept();
    session.on('pty', (acceptPTY, _, dimensions) => { lastResize = dimensions; acceptPTY(); });
    session.on('window-change', (acceptResize, _, dimensions) => { lastResize = dimensions; acceptResize?.(); });
    session.on('sftp', acceptSftp => serveFiles(acceptSftp()));
    session.on('shell', acceptShell => {
      const stream = acceptShell(); fixtureStream = stream; activeShells++;
      stream.on('error', () => {}); stream.on('close', () => activeShells--);
      stream.write('[ISOLATED QUICK INPUT FIXTURE]\r\nalice@fixture:~$ ');
      stream.on('data', bytes => {
        inputBytes += bytes.toString('utf8');
        const timer = setTimeout(() => { echoTimers.delete(timer); if (!stream.destroyed) { echoCount++; stream.write(bytes); } }, echoDelayMs);
        echoTimers.add(timer);
      });
    });
  }));
});

const focusedTerminal = () => page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'));
const inputText = () => page.locator('#w-quick-input').inputValue();
async function waitInput(expected) { for (let i = 0; i < 100; i++) { if (inputBytes === expected) return; await pause(10); } assert.equal(inputBytes, expected, 'Exact fixture PTY input'); }
async function expectNoInput(name, expected = inputBytes) { await pause(80); check(name, inputBytes === expected, { receivedBytes: Buffer.byteLength(inputBytes) }); }
async function frames() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function inspectGeometry(width, height) {
  await page.setViewportSize({ width, height });
  if (width <= 760) await page.locator('[data-view="terminal"]').evaluate(button => button.click());
  await pause(120); await frames();
  const result = await page.evaluate(() => {
    const rect = e => { const r = e?.getBoundingClientRect(); return r && { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const inside = (r, b) => r && r.width > 0 && r.height > 0 && r.left >= b.left - 1.5 && r.top >= b.top - 1.5 && r.right <= b.right + 1.5 && r.bottom <= b.bottom + 1.5;
    const visible = e => !!e?.getClientRects().length && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
    const bounds = { left: 0, top: 0, right: innerWidth, bottom: Math.min(innerHeight, visualViewport?.height || innerHeight) };
    const holder = rect(document.querySelector('#w-xterm')), screen = rect(document.querySelector('.xterm-screen'));
    const term = window.__quickInputTerm;
    const cellHeight = screen.height / term.rows;
    const lastRow = { left: screen.left, top: screen.bottom - cellHeight, right: screen.right, bottom: screen.bottom, width: screen.width, height: cellHeight };
    const form = document.querySelector('#w-quick-input-form');
    const footer = [...document.querySelectorAll('.w-statusbar,.w-mobile-views')].find(visible);
    return { width: innerWidth, height: innerHeight, rows: term.rows, cols: term.cols, holder, screen, lastRow, form: rect(form), formVisible: visible(form), footer: rect(footer), validations: {
      noDocumentOverflow: document.documentElement.scrollHeight <= innerHeight + 2 && document.documentElement.scrollWidth <= innerWidth + 2,
      terminalGridWithinHolder: inside(screen, holder), lastRowWithinViewport: inside(lastRow, bounds),
      footerWithinViewport: inside(rect(footer), bounds), quickInputWithinViewportWhenShown: !visible(form) || inside(rect(form), bounds),
      quickInputDoesNotOverlapTerminal: !visible(form) || rect(form).top >= screen.bottom - 1.5,
    } };
  });
  geometry.push(result);
  for (const [name, valid] of Object.entries(result.validations)) check(`${width}x${height}: ${name}`, valid, valid ? undefined : result);
  check(`${width}x${height}: PTY dimensions follow terminal`, lastResize?.rows === result.rows && lastResize?.cols === result.cols);
}

try {
  const sshPort = await listen(ssh), reservation = http.createServer();
  const port = await listen(reservation); await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  app = createApplication({ sshHost: '127.0.0.1', sshPort, hostKeyPath: key + '.pub', allowedOrigins: [origin], sshTimeoutMs: 5000, loginTimeoutMs: 10000, idleTimeoutMs: 120000, maxLifetimeMs: 240000 });
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } }); page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (/content security policy|violates.*directive/i.test(m.text())) csp.push(m.text()); });
  await page.addInitScript(() => {
    let Terminal;
    Object.defineProperty(window, 'Terminal', { configurable: true, get: () => Terminal, set(value) {
      Terminal = new Proxy(value, { construct(target, args, newTarget) { const term = Reflect.construct(target, args, newTarget); window.__quickInputTerm = term; window.__quickInputRenderEvents = 0; term.onRender(() => window.__quickInputRenderEvents++); return term; } });
    } });
  });
  await page.goto(origin + '/lab/');
  await page.locator('#campus-username').fill('alice'); await page.locator('#campus-password').fill('quick-input-fixture-password'); await page.locator('#w-connect').click();
  await page.locator('#w-workspace').waitFor({ state: 'visible' }); await page.locator('#w-quick-input').waitFor({ state: 'visible' });
  await page.evaluate(() => document.fonts.ready); await frames();
  check('One isolated authenticated SSH shell', attempts === 1 && activeShells === 1);
  check('Quick input starts expanded and names its controlled form', await page.locator('#w-quick-input-toggle').getAttribute('aria-expanded') === 'true' && await page.locator('#w-quick-input-toggle').getAttribute('aria-controls') === 'w-quick-input-form');
  await expectNoInput('Page initialization does not send shell input', '');
  await page.locator('#w-quick-input').focus(); await page.keyboard.insertText('echo 快速ab'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Backspace'); await frames();
  check('Local Chinese editing, cursor movement and backspace are immediate', await inputText() === 'echo 快速b');
  check('Locally edited value is visible before any PTY input or echo', inputBytes === '' && echoCount === 0 && await page.locator('#w-quick-input').isVisible());
  await page.keyboard.press('Enter'); await waitInput('echo 快速b\r');
  check('Enter sends exactly one preserved command and CR', inputBytes === 'echo 快速b\r');
  check('Submit clears input and returns focus to terminal', await inputText() === '' && await focusedTerminal());
  check('No synthetic terminal echo before delayed SSH fixture output', await page.evaluate(() => { const b = window.__quickInputTerm.buffer.active; return !Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString()).join('\n').includes('echo 快速b'); }));
  await page.waitForFunction(() => { const b = window.__quickInputTerm.buffer.active; return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString()).join('\n').includes('echo 快速b'); });
  check('Delayed real SSH echo renders through public xterm API', echoCount > 0 && await page.evaluate(() => window.__quickInputRenderEvents > 0));
  await pause(120); check('Delayed echo never resubmits command', inputBytes === 'echo 快速b\r');

  await page.locator('#w-quick-input').fill('IME草稿');
  await page.locator('#w-quick-input').evaluate(input => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '草' })));
  await page.keyboard.press('Enter');
  await expectNoInput('IME composing Enter does not send a command', 'echo 快速b\r');
  check('IME Enter preserves the draft', await inputText() === 'IME草稿');
  await page.locator('#w-quick-input').evaluate(input => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '草' })));
  const composingFlags = await page.locator('#w-quick-input').evaluate(input => [
    { isComposing: true }, { keyCode: 229, which: 229 },
  ].map(extra => { const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', ...extra }); input.dispatchEvent(event); return event.defaultPrevented; }));
  check('Explicit isComposing and legacy229 Enter suppress implicit form submission', composingFlags.every(Boolean));
  await page.keyboard.press('Escape');
  await expectNoInput('Escape never submits the command draft', 'echo 快速b\r');
  check('Escape returns focus to the original terminal', await focusedTerminal());

  await page.locator('#w-quick-input').fill('  printf fixture-spaces  '); await page.locator('#w-quick-input-send').click();
  await waitInput('echo 快速b\r  printf fixture-spaces  \r');
  check('Send button preserves leading and trailing spaces and sends one CR', inputBytes === 'echo 快速b\r  printf fixture-spaces  \r');
  check('Send click returns focus to the terminal', await focusedTerminal());
  const beforeRaw = inputBytes;
  await page.keyboard.type('raw-fixture'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('Enter');
  await waitInput(beforeRaw + 'raw-fixture\x1b[A\r');
  check('Original terminal still routes raw keys, arrows and CR unchanged', inputBytes === beforeRaw + 'raw-fixture\x1b[A\r');
  const beforeShortcut = inputBytes;
  await page.keyboard.press('Control+Shift+Enter');
  check('Quick input shortcut focuses local input', await page.locator('#w-quick-input').evaluate(input => input === document.activeElement));
  await expectNoInput('Quick input shortcut does not leak key bytes to PTY', beforeShortcut);

  await page.locator('#w-quick-input').fill('draft survives collapse'); const beforeCollapse = inputBytes;
  await page.locator('#w-quick-input-toggle').click();
  check('Quick input toggle collapses the form', await page.locator('#w-quick-input-form').isHidden() && await page.locator('#w-quick-input-toggle').getAttribute('aria-expanded') === 'false');
  await page.locator('#w-quick-input-toggle').click();
  check('Expanding restores the unchanged draft', await inputText() === 'draft survives collapse');
  await expectNoInput('Collapse and expansion never send the draft', beforeCollapse);
  await page.locator('#w-quick-input').focus();
  const paste = await page.locator('#w-quick-input').evaluate(input => {
    const data = new DataTransfer(); data.setData('text/plain', 'first-line\nsecond-line');
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }); input.dispatchEvent(event);
    return { prevented: event.defaultPrevented, value: input.value };
  });
  check('Multi-line paste is blocked before single-line input normalization', paste.prevented && paste.value === 'draft survives collapse');
  await expectNoInput('Rejected multi-line paste sends no PTY bytes', beforeCollapse);
  check('Commands and credentials are absent from browser storage', await page.evaluate(() => !/quick-input-fixture-password|echo 快速|draft survives collapse|fixture-spaces/.test(JSON.stringify(localStorage) + JSON.stringify(sessionStorage))));

  for (const [width, height] of [[1366, 768], [900, 500], [900, 360], [900, 300], [375, 812], [390, 300]]) await inspectGeometry(width, height);
  await page.setViewportSize({ width: 1366, height: 768 }); await pause(100); await frames();
  await page.locator('#toast').waitFor({ state: 'hidden', timeout: 6000 });
  fixtureStream.write('\x1b[2J\x1b[H[ISOLATED QUICK INPUT FIXTURE]\r\nalice@fixture:~$ ');
  await page.locator('#w-quick-input').fill('python train.py --epochs 20');
  await pause(80); await frames();
  await fs.mkdir(path.join(root, 'screenshots'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'screenshots/quick-input-desktop-fixture.png'), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 }); await page.locator('[data-view="terminal"]').evaluate(button => button.click()); await pause(100);
  await page.screenshot({ path: path.join(root, 'screenshots/quick-input-mobile-fixture.png'), fullPage: true });
  await page.setViewportSize({ width: 1366, height: 768 }); await pause(100);
  await page.locator('#w-quick-input').fill('must-clear-on-disconnect');
  const disconnectedInput = await page.locator('#w-quick-input').elementHandle();
  const disconnectedSend = await page.locator('#w-quick-input-send').elementHandle();
  const disconnectedToggle = await page.locator('#w-quick-input-toggle').elementHandle();
  const disconnectedForm = await page.locator('#w-quick-input-form').elementHandle();
  for (const client of clients) client.end();
  await page.waitForFunction(() => document.querySelector('#campus-username') || document.querySelector('#w-session-status')?.textContent.includes('已断开'));
  check('Disconnect clears command draft before removing or preserving workspace', await disconnectedInput.evaluate(input => input.value === ''));
  check('Disconnect disables input, send and toggle before teardown', await disconnectedInput.evaluate(input => input.disabled) && await disconnectedSend.evaluate(button => button.disabled) && await disconnectedToggle.evaluate(button => button.disabled));
  const beforeDisconnected = inputBytes;
  await disconnectedForm.evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await expectNoInput('A disconnected submit cannot send any PTY bytes', beforeDisconnected);
  check('No command content is persisted on disconnect', await page.evaluate(() => !/must-clear-on-disconnect|fixture-password|draft survives/.test(JSON.stringify(localStorage) + JSON.stringify(sessionStorage))));
  check('No browser runtime errors', errors.length === 0, errors); check('No CSP violations', csp.length === 0, csp);
  const report = { finishedUTC: new Date().toISOString(), passed: checks.filter(c => c.passed).length, failed: checks.filter(c => !c.passed).length, hashes, checks, geometry, errors, csp, fixtureEchoDelayMs: echoDelayMs, limitations: ['The experiment proves local input visibility before any PTY bytes and real delayed echo. It does not measure WAN latency or claim faster remote execution.', 'Synthetic composition and clipboard events exercise browser handlers; native OS IME behavior still benefits from user testing.'], environment: 'Real Chrome with disposable loopback SSH/SFTP fixture and throwaway host key/account. No campus authentication, commands, files, production changes or private xterm APIs.' };
  await fs.writeFile(path.join(root, 'docs/qa-quick-input-browser.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.rm(path.join(root, 'docs/qa-quick-input-browser-failure.json'), { force: true });
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, fixtureEchoDelayMs: echoDelayMs, errors, csp }));
} catch (error) {
  await page?.screenshot({ path: '/tmp/lab-quick-input-failure.png', fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(root, 'docs/qa-quick-input-browser-failure.json'), JSON.stringify({ finishedUTC: new Date().toISOString(), checks, errors, csp, geometry, error: error.message, hashes }, null, 2) + '\n');
  throw error;
} finally {
  for (const timer of echoTimers) clearTimeout(timer);
  await browser?.close();
  if (app) { await app.bridge.close(); app.server.closeAllConnections?.(); await new Promise(resolve => app.server.close(resolve)); }
  for (const client of clients) client.end();
  await new Promise(resolve => ssh.close(resolve));
  await fs.rm(temporary, { recursive: true, force: true });
}
