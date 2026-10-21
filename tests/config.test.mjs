import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfiguration, createApplication } from '../server.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));

test('configuration defaults to the local relay and local browser origin without reading a host key',()=>{
  assert.deepEqual(readConfiguration({}),{
    port:8090,sshHost:'127.0.0.1',sshPort:22002,
    hostKeyPath:path.join(project,'config/campus-host-key.pub'),
    allowedOrigins:['http://127.0.0.1:8090']
  });
});

test('configuration accepts valid deployment values and resolves relative host-key paths from the project',()=>{
  const config=readConfiguration({
    LAB_PREVIEW_PORT:'9000',LAB_SSH_PORT:'2222',LAB_HOST_KEY_PATH:'config/trusted-host.pub',
    LAB_ALLOWED_ORIGINS:'https://workbench.example.test, http://localhost:9000'
  });
  assert.deepEqual(config,{
    port:9000,sshHost:'127.0.0.1',sshPort:2222,
    hostKeyPath:path.join(project,'config/trusted-host.pub'),
    allowedOrigins:['https://workbench.example.test','http://localhost:9000']
  });
});

test('the default browser origin follows the configured listen port',()=>{
  assert.deepEqual(readConfiguration({LAB_PREVIEW_PORT:'65535'}).allowedOrigins,['http://127.0.0.1:65535']);
  assert.equal(readConfiguration({LAB_PREVIEW_PORT:'1',LAB_SSH_PORT:'65535'}).port,1);
  assert.equal(readConfiguration({LAB_PREVIEW_PORT:'1',LAB_SSH_PORT:'65535'}).sshPort,65535);
});

test('absolute host-key paths stay absolute and unknown SSH host settings cannot redirect the fixed relay',()=>{
  const key=path.resolve(project,'../private/trusted.pub');
  const config=readConfiguration({LAB_HOST_KEY_PATH:key,LAB_SSH_HOST:'remote.example.test'});
  assert.equal(config.hostKeyPath,key);
  assert.equal(config.sshHost,'127.0.0.1');
});

test('canonical origins are deduplicated and support local IPv6',()=>{
  assert.deepEqual(readConfiguration({LAB_ALLOWED_ORIGINS:'https://EXAMPLE.test:443,https://example.test,http://[::1]:8090'}).allowedOrigins,
    ['https://example.test','http://[::1]:8090']);
});

for(const name of ['LAB_PREVIEW_PORT','LAB_SSH_PORT']){
  test(name+' rejects malformed, empty and out-of-range ports',()=>{
    for(const value of ['', ' ', '0', '65536', '-1', '1.5', '1e3', '+22', '22x', 'Infinity', '9007199254740993', null, 22]){
      assert.throws(()=>readConfiguration({[name]:value}),new RegExp(name),String(value));
    }
  });
}

test('empty, non-string and NUL-containing host-key paths fail before reading any file',()=>{
  for(const value of ['', ' ', 'config/\0host', 5, null])assert.throws(()=>readConfiguration({LAB_HOST_KEY_PATH:value}),/LAB_HOST_KEY_PATH/);
});

test('origins reject paths, credentials, URL suffixes, empty entries and CSP injection',()=>{
  for(const value of [
    '', ' ', ',', 'https://example.test,', ',https://example.test',
    'https://example.test,,https://other.example.test',
    'https://example.test/', 'https://example.test/path',
    'https://user@example.test', 'https://user:pass@example.test', 'https://@example.test',
    'https://example.test?query', 'https://example.test#hash',
    'ftp://example.test', 'ws://example.test', 'example.test',
    'https://example.test;script-src', "https://example.test'", 'https://example.test\\evil',
    'https://example.test\nscript-src', 'https://example.test%3bscript-src', null, ['https://example.test']
  ])assert.throws(()=>readConfiguration({LAB_ALLOWED_ORIGINS:value}),/LAB_ALLOWED_ORIGINS/,String(value));
});

test('programmatic origin overrides receive the same validation before host-key loading',()=>{
  for(const value of [[], ['https://example.test/'], ["https://example.test;script-src"], ['https://user@example.test']]){
    assert.throws(()=>createApplication({allowedOrigins:value,hostKeyPath:'/nonexistent/key.pub'}),/LAB_ALLOWED_ORIGINS/);
  }
});
