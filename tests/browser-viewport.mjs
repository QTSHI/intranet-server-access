// Real Chrome + real SSH/SFTP protocols, disposable loopback accounts only.
// Run with --baseline --source=/tmp/... to retain a failing pre-fix snapshot.
import { chromium } from 'playwright-core';
import ssh2 from 'ssh2';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.resolve(process.argv.find(arg => arg.startsWith('--source='))?.slice(9) || root);
const baseline = process.argv.includes('--baseline');
const reportPath = path.join(root, 'docs/qa-viewport.json');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'lab-viewport-browser-'));
const snapshot = path.join(temporary, 'app');
await fs.mkdir(snapshot);
for (const filename of ['server.mjs', 'bridge.mjs']) await fs.copyFile(path.join(source, filename), path.join(snapshot, filename));
await fs.cp(path.join(source, 'public'), path.join(snapshot, 'public'), { recursive: true });
await fs.symlink(path.join(root, 'node_modules'), path.join(snapshot, 'node_modules'), 'dir');
const hashes = {};
for (const filename of ['server.mjs', 'bridge.mjs', 'public/live.js', 'public/live.css']) {
  hashes[filename] = createHash('sha256').update(await fs.readFile(path.join(snapshot, filename))).digest('hex');
}
const { createApplication } = await import(pathToFileURL(path.join(snapshot, 'server.mjs')).href);
const key = path.join(temporary, 'fake-host');
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'isolated-viewport-fixture', '-f', key], { stdio: 'ignore', timeout: 10000 });
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(server.address().port); });
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], scenarios = [], errors = [], csp = [], clients = new Set();
let lastResize = null, resizeCount = 0, attempts = 0, activeShells = 0;
let app, browser, page, firstFailureScreenshot;
const check = (name, passed, detail) => checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) });
const files = new Map([
  ['/home/alice', { mode: 0o040755 }],
  ['/home/alice/README.txt', { mode: 0o100644, data: Buffer.from('Isolated viewport fixture.\n' + 'Editor line\n'.repeat(100)) }],
]);
const attrs = node => ({ mode: node.mode, uid: 1000, gid: 1000, size: node.data?.length ?? 0, atime: 1700000000, mtime: 1700000000 });
function serveFiles(sftp) {
  const handles = new Map(); let nextHandle = 0;
  const get = (id, filename) => { const node = files.get(filename); if (!node) sftp.status(id, 2); return node; };
  const handle = (id, data) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(++nextHandle); handles.set(bytes.toString('hex'), data); sftp.handle(id, bytes); };
  const entry = (id, bytes) => { const result = handles.get(bytes.toString('hex')); if (!result) sftp.status(id, 4); return result; };
  sftp.on('error', () => {});
  sftp.on('REALPATH', (id, filename) => { filename = path.posix.resolve('/home/alice', filename); if (get(id, filename)) sftp.name(id, [{ filename, longname: filename, attrs: {} }]); });
  for (const event of ['STAT', 'LSTAT']) sftp.on(event, (id, filename) => { const node = get(id, filename); if (node) sftp.attrs(id, attrs(node)); });
  sftp.on('OPENDIR', (id, filename) => { if (get(id, filename)) handle(id, { filename, listed: false }); });
  sftp.on('READDIR', (id, bytes) => { const value = entry(id, bytes); if (!value) return; if (value.listed) return sftp.status(id, 1); value.listed = true; sftp.name(id, [...files].filter(([filename]) => filename !== value.filename && path.posix.dirname(filename) === value.filename).map(([filename, node]) => ({ filename: path.posix.basename(filename), longname: filename, attrs: attrs(node) }))); });
  sftp.on('OPEN', (id, filename, flags) => { const node = get(id, filename); if (!node) return; if (flags !== 1) return sftp.status(id, 3); handle(id, { node }); });
  sftp.on('FSTAT', (id, bytes) => { const value = entry(id, bytes); if (value) sftp.attrs(id, attrs(value.node)); });
  sftp.on('READ', (id, bytes, offset, length) => { const value = entry(id, bytes); if (!value) return; const data = value.node.data.subarray(offset, offset + length); data.length ? sftp.data(id, data) : sftp.status(id, 1); });
  sftp.on('CLOSE', (id, bytes) => { handles.delete(bytes.toString('hex')); sftp.status(id, 0); });
}
const ssh = new ssh2.Server({ hostKeys: [await fs.readFile(key)] }, client => {
  clients.add(client); client.setNoDelay(true);
  client.on('error', () => {}); client.on('close', () => clients.delete(client));
  client.on('authentication', ctx => {
    if (ctx.method === 'password') { attempts++; if (ctx.username === 'alice' && ctx.password === 'viewport-fixture-password') return ctx.accept(); }
    ctx.reject(['password']);
  });
  client.on('ready', () => client.on('session', accept => {
    const session = accept();
    session.on('pty', (acceptPTY, _reject, dimensions) => { lastResize = dimensions; resizeCount++; acceptPTY(); });
    session.on('window-change', (acceptResize, _reject, dimensions) => { lastResize = dimensions; resizeCount++; acceptResize?.(); });
    session.on('sftp', acceptSftp => serveFiles(acceptSftp()));
    session.on('shell', acceptShell => {
      const stream = acceptShell(); activeShells++;
      stream.on('error', () => {}); stream.on('close', () => activeShells--);
      stream.write('[ISOLATED VIEWPORT FIXTURE]\r\n');
      let input = '';
      stream.on('data', bytes => {
        input += bytes.toString();
        if (input.includes('fixture-bottom\r')) {
          input = '';
          // This is not a shell command: the fake peer draws directly at its PTY's final row.
          stream.write(`\x1b[2J\x1b[H\x1b[${lastResize.rows};1H[BOTTOM]\x1b[?25h`);
        }
      });
    });
  }));
});

async function settled() {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  for (let i = 0; i < 50; i++) {
    const dimensions = await page.evaluate(() => {
      const term = window.__viewportTerm;
      return term ? { rows: term.rows, cols: term.cols } : null;
    });
    if (dimensions && dimensions.rows === lastResize?.rows && dimensions.cols === lastResize?.cols) { await pause(60); return; }
    await pause(25);
  }
  throw new Error('The fake SSH PTY did not receive xterm dimensions');
}

async function geometry(name, { terminal = true, layoutViewport = false, drawer = false } = {}) {
  await settled();
  if (terminal) {
    await page.evaluate(() => { window.__viewportTerm.options.cursorBlink = false; window.__viewportTerm.input('fixture-bottom\r', true); });
    await page.waitForFunction(() => {
      const term = window.__viewportTerm; const buffer = term.buffer.active;
      return buffer.cursorY === term.rows - 1 && buffer.getLine(buffer.baseY + term.rows - 1)?.translateToString().includes('[BOTTOM]');
    }, null, { timeout: 3000 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  }
  const result = await page.evaluate(({ name, terminal, layoutViewport, drawer }) => {
    const rect = element => { const r = element?.getBoundingClientRect(); return r && { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const visible = element => !!element && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden' && element.getClientRects().length > 0;
    const viewport = window.visualViewport;
    const visual = { left: viewport?.offsetLeft || 0, top: viewport?.offsetTop || 0, width: viewport?.width || innerWidth, height: viewport?.height || innerHeight, scale: viewport?.scale || 1 };
    visual.right = visual.left + visual.width; visual.bottom = visual.top + visual.height;
    const bounds = layoutViewport ? { left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight } : visual;
    const inside = (a, b, tolerance = 1.25) => !!a && a.width > 0 && a.height > 0 && a.left >= b.left - tolerance && a.top >= b.top - tolerance && a.right <= b.right + tolerance && a.bottom <= b.bottom + tolerance;
    const workspace = rect(document.querySelector('#w-workspace'));
    const footerElement = [...document.querySelectorAll('.w-statusbar,.w-mobile-views')].find(visible);
    const footer = rect(footerElement);
    const validations = {
      workspaceWithinViewport: inside(workspace, bounds),
      footerWithinViewport: inside(footer, bounds),
      documentNoVerticalOverflow: document.documentElement.scrollHeight <= innerHeight + 2,
      documentNoHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth + 2,
    };
    const details = { name, innerWidth, innerHeight, visualViewport: visual, usedLayoutViewport: layoutViewport, workspace, footer, scrollHeight: document.documentElement.scrollHeight, terminalExpected: terminal, fullscreen: !!document.fullscreenElement };
    if (terminal) {
      const term = window.__viewportTerm;
      const holder = document.querySelector('#w-xterm');
      const screenElement = holder.querySelector('.xterm-screen');
      const holderRect = rect(holder), screen = rect(screenElement), style = getComputedStyle(holder);
      const content = {
        left: holderRect.left + parseFloat(style.paddingLeft), top: holderRect.top + parseFloat(style.paddingTop),
        right: holderRect.right - parseFloat(style.paddingRight), bottom: holderRect.bottom - parseFloat(style.paddingBottom),
      };
      content.width = content.right - content.left; content.height = content.bottom - content.top;
      const dimensions = term._core?._renderService?.dimensions?.css;
      const cellHeight = dimensions?.cell?.height || screen.height / term.rows;
      const cellWidth = dimensions?.cell?.width || screen.width / term.cols;
      const lastRow = { left: screen.left, top: screen.top + (term.rows - 1) * cellHeight, right: screen.right, bottom: screen.top + term.rows * cellHeight, width: screen.width, height: cellHeight };
      const cursor = {
        left: screen.left + term.buffer.active.cursorX * cellWidth, top: screen.top + term.buffer.active.cursorY * cellHeight,
        right: screen.left + (term.buffer.active.cursorX + 1) * cellWidth, bottom: screen.top + (term.buffer.active.cursorY + 1) * cellHeight,
        width: cellWidth, height: cellHeight,
      };
      const terminalPane = rect(document.querySelector('#w-terminal-pane'));
      validations.xtermScreenWithinHolderContent = inside(screen, content);
      validations.xtermLastRowWithinHolderContent = inside(lastRow, content);
      validations.xtermLastRowWithinVisibleViewport = inside(lastRow, bounds);
      validations.xtermLastRowWithinTerminalPane = inside(lastRow, terminalPane);
      validations.xtermCursorWithinHolderContent = inside(cursor, content);
      validations.xtermCursorWithinVisibleViewport = inside(cursor, bounds);
      validations.xtermCellGridMatchesScreen = Math.abs(screen.height - term.rows * cellHeight) <= 1.25;
      validations.xtermCursorOnLastRow = term.buffer.active.cursorY === term.rows - 1;
      Object.assign(details, { rows: term.rows, cols: term.cols, cursorX: term.buffer.active.cursorX, cursorY: term.buffer.active.cursorY, cellHeight, cellWidth, screen, content, lastRow, cursor, terminalPane });
    }
    if (drawer) {
      const sidebar = document.querySelector('#w-file-sidebar');
      const backdrop = document.querySelector('#w-files-backdrop');
      details.drawer = rect(sidebar);
      details.backdrop = rect(backdrop);
      validations.drawerWithinViewport = visible(sidebar) && inside(details.drawer, bounds);
      validations.drawerDoesNotCoverMobileFooter = details.drawer.bottom <= footer.top + 1.25;
      validations.backdropWithinViewport = visible(backdrop) && inside(details.backdrop, bounds);
      validations.backdropDoesNotCoverMobileFooter = details.backdrop.bottom <= footer.top + 1.25;
    }
    return { ...details, validations };
  }, { name, terminal, layoutViewport, drawer });
  if (terminal) {
    result.pty = { rows: lastResize.rows, cols: lastResize.cols };
    result.validations.ptyRowsMatchXterm = result.rows === lastResize.rows;
    result.validations.ptyColsMatchXterm = result.cols === lastResize.cols;
  }
  scenarios.push(result);
  for (const [key, passed] of Object.entries(result.validations)) check(name + ': ' + key, passed);
  if (!firstFailureScreenshot && Object.values(result.validations).some(value => !value)) {
    firstFailureScreenshot = `/tmp/lab-viewport-${baseline ? 'baseline' : 'final'}-first-failure.png`;
    await page.screenshot({ path: firstFailureScreenshot, fullPage: true });
  }
  return result;
}

async function viewport(width, height) { await page.setViewportSize({ width, height }); await pause(80); }
async function threeHeights(label) {
  const sizes = [];
  for (let i = 0; i < 3; i++) {
    sizes.push((await geometry(`${label}, height preset ${i + 1}`)).terminalPane.height);
    await page.locator('#w-terminal-resize').evaluate(button => button.click());
  }
  check(label + ': three height choices remain usable', sizes.every(size => size > 35), sizes);
}

try {
  const sshPort = await listen(ssh), reservation = http.createServer();
  const port = await listen(reservation); await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  app = createApplication({ sshHost: '127.0.0.1', sshPort, hostKeyPath: key + '.pub', allowedOrigins: [origin], sshTimeoutMs: 5000, loginTimeoutMs: 10000, idleTimeoutMs: 240000, maxLifetimeMs: 480000 });
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (/content security policy|violates.*directive/i.test(message.text())) csp.push(message.text()); });
  await page.addInitScript(() => {
    let Terminal;
    Object.defineProperty(window, 'Terminal', { configurable: true, get: () => Terminal, set(value) {
      Terminal = new Proxy(value, { construct(target, args, newTarget) {
        const term = Reflect.construct(target, args, newTarget); window.__viewportTerm = term; return term;
      } });
    } });
  });
  await page.goto(origin + '/lab/');
  await page.locator('#campus-username').fill('alice'); await page.locator('#campus-password').fill('viewport-fixture-password');
  await page.locator('#w-connect').click(); await page.locator('#w-workspace').waitFor({ state: 'visible' });
  await page.locator('[data-path="/home/alice/README.txt"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  check('Exactly one isolated campus authentication', attempts === 1);
  for (const [width, height, label] of [
    [1440, 960, 'desktop 1440x960'], [1366, 768, 'laptop 1366x768'], [1280, 720, 'window 1280x720'],
    [1024, 600, 'short 1024x600'], [900, 500, 'short 900x500'], [800, 480, 'small 800x480'],
    [900, 360, 'very short 900x360'], [1093, 614, '125% zoom equivalent'], [911, 512, '150% zoom equivalent'],
  ]) { await viewport(width, height); await threeHeights('empty editor ' + label); }
  await viewport(1366, 768);
  await page.locator('[data-path="/home/alice/README.txt"]').click(); await page.locator('.cm-content').waitFor({ state: 'visible' });
  for (const [width, height] of [[1440, 900], [1366, 768], [1024, 600], [900, 500], [800, 480], [900, 360]]) {
    await viewport(width, height); await threeHeights(`open editor ${width}x${height}`);
  }
  await viewport(1024, 600);
  await page.locator('#w-terminal-collapse').evaluate(button => button.click());
  await geometry('terminal collapsed', { terminal: false });
  check('Collapsed terminal hides xterm', await page.locator('#w-xterm').isHidden());
  await page.locator('#w-terminal-toggle').evaluate(button => button.click()); await geometry('terminal restored');
  await page.locator('#w-files-toggle').click(); await geometry('desktop sidebar collapsed');
  await page.locator('#w-files-toggle').click(); await geometry('desktop sidebar restored');
  await page.locator('#w-fullscreen').click(); await page.waitForFunction(() => !!document.fullscreenElement);
  await geometry('fullscreen entered');
  await page.locator('#w-fullscreen').click(); await page.waitForFunction(() => !document.fullscreenElement);
  await geometry('fullscreen exited');
  for (const [width, height, label] of [[375, 812, 'portrait'], [667, 375, 'rotated landscape'], [390, 844, 'rotated portrait'], [320, 568, 'narrow portrait'], [375, 380, 'keyboard layout resize'], [390, 300, 'small keyboard layout resize']]) {
    await viewport(width, height);
    await page.locator('[data-view="terminal"]').evaluate(button => button.click()); await geometry('mobile ' + label);
    await page.locator('[data-view="editor"]').evaluate(button => button.click()); await geometry('mobile editor ' + label, { terminal: false });
    await page.locator('[data-view="files"]').evaluate(button => button.click()); await geometry('mobile drawer ' + label, { terminal: false, drawer: true });
    await page.locator('#w-files-close').evaluate(button => button.click());
  }
  await viewport(390, 844); await page.locator('[data-view="terminal"]').evaluate(button => button.click());
  await page.locator('.xterm-helper-textarea').focus();
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: () => 320 });
    window.visualViewport.dispatchEvent(new Event('resize'));
  });
  await pause(100); const keyboard = await geometry('synthetic visualViewport keyboard height 320, layout 844');
  check('Synthetic keyboard leaves the layout viewport unchanged', keyboard.innerHeight === 844 && keyboard.visualViewport.height === 320);
  check('Terminal remains the focused input while the synthetic keyboard is visible', await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')));
  await page.locator('#w-files-toggle').evaluate(button => button.click());
  await geometry('synthetic visualViewport keyboard drawer and backdrop', { terminal: false, drawer: true });
  await page.locator('#w-files-close').evaluate(button => button.click());
  await geometry('terminal restored after visualViewport keyboard drawer');
  await page.locator('#w-fullscreen').click(); await page.waitForFunction(() => !!document.fullscreenElement);
  const stale = await geometry('fullscreen ignores a stale visualViewport keyboard height', { layoutViewport: true });
  check('Fullscreen uses its actual height instead of stale visualViewport height', Math.abs(stale.workspace.height - stale.innerHeight) <= 2);
  await page.locator('#w-fullscreen').click(); await page.waitForFunction(() => !document.fullscreenElement);
  await geometry('fullscreen exit restores the active visualViewport keyboard height');
  await page.evaluate(() => { delete window.visualViewport.height; window.visualViewport.dispatchEvent(new Event('resize')); });
  await pause(100); await geometry('visualViewport keyboard restored');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.5 }); await pause(100);
  const zoom = await geometry('real CDP pinch zoom preserves layout geometry', { layoutViewport: true });
  check('Pinch zoom changes visual scale without shrinking workspace to the zoomed area', zoom.visualViewport.scale > 1.4 && Math.abs(zoom.workspace.height - zoom.innerHeight) <= 2);
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 }); await pause(100);
  await geometry('pinch zoom restored');
  await viewport(1366, 768); await page.locator('[data-tab-close]').evaluate(button => button.click());
  await geometry('editor file closed again');
  check('All viewport changes retained the same SSH shell', activeShells === 1 && attempts === 1);
  check('PTY resize events were sent after viewport changes', resizeCount >= 20, resizeCount);
  check('No browser runtime errors', errors.length === 0, errors);
  check('No CSP violations', csp.length === 0, csp);
} catch (error) {
  errors.push(error.stack || String(error)); check('Viewport harness completed all scenarios', false, error.message);
  if (page) await page.screenshot({ path: '/tmp/lab-viewport-harness-failure.png', fullPage: true }).catch(() => {});
} finally {
  const result = {
    recordedAt: new Date().toISOString(), source, sourcesSHA256: hashes,
    passed: checks.filter(check => check.passed).length, failed: checks.filter(check => !check.passed).length,
    scenarioCount: scenarios.length, checks, scenarios, errors, csp, firstFailureScreenshot,
    environment: 'Real headless Chrome, real ssh2 loopback PTY/SFTP, disposable fake account and password; no actual campus login or shell command.',
    method: 'The fake SSH peer places a visible marker and cursor at its negotiated PTY final row. Each scenario compares PTY rows/cols with xterm, renderer cell grid, screen/content/terminal bounds and visible viewport/footer.',
    limits: [
      '125%/150% browser zoom cases use equivalent CSS viewport sizes, not an actual desktop browser zoom setting.',
      'Synthetic keyboard changes only the VisualViewport.height getter and dispatches its resize event while innerHeight stays fixed; this is an app geometry signal test, not an Android/iOS soft keyboard or compositor test.',
      'Real CDP page scaling exercises pinch zoom; layout viewport remains the containment target while visual scale differs from 1.',
      'Cursor visibility is checked against the actual xterm renderer cell grid, current buffer cursor and clipping rectangles; it is not a pixel/OCR assertion.',
    ],
  };
  let report = { scope: 'Isolated staging viewport regression only', baseline: null, final: null };
  try { report = JSON.parse(await fs.readFile(reportPath, 'utf8')); } catch {}
  report[baseline ? 'baseline' : 'final'] = result;
  if (report.baseline && report.final) {
    const before = new Map(report.baseline.checks.map(check => [check.name, check]));
    const after = new Map(report.final.checks.map(check => [check.name, check]));
    report.comparison = {
      sharedChecks: [...before.keys()].filter(name => after.has(name)).length,
      baselineFailuresNowPassing: [...before].filter(([name, check]) => !check.passed && after.get(name)?.passed).length,
      sharedFailuresRemaining: [...before.keys()].filter(name => after.has(name) && !after.get(name).passed).length,
      additionalFinalChecks: [...after.keys()].filter(name => !before.has(name)).length,
      note: 'The final harness additionally covers stale visualViewport during fullscreen and drawer/backdrop containment while the synthetic keyboard is visible.',
    };
  }
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ baseline, report: reportPath, scenarios: result.scenarioCount, passed: result.passed, failed: result.failed, failures: checks.filter(check => !check.passed), errors, firstFailureScreenshot }, null, 2));
  await browser?.close();
  if (app) { await app.bridge.close(); app.server.closeAllConnections?.(); await new Promise(resolve => app.server.close(resolve)); }
  for (const client of clients) client.end();
  await new Promise(resolve => ssh.close(resolve));
  await fs.rm(temporary, { recursive: true, force: true });
  if (result.failed && !baseline) process.exitCode = 1;
}
