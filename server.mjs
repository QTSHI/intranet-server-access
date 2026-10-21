import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createBridge } from './bridge.mjs';

const project=fileURLToPath(new URL('./',import.meta.url));
const publicRoot=path.join(project,'public');
const routes=new Set(['/','/login','/servers/lab/terminal']);
const retiredRoutes=new Set(['/servers','/connect','/admin','/help']);
const files=new Set(['live.html','live.js','live.css','editor.mjs','favicon.svg','vendor/xterm.js','vendor/xterm.css','vendor/addon-fit.js']);
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};

function configuredPort(env,name,fallback) {
  const value=env[name];
  if(value===undefined)return fallback;
  if(typeof value!=='string'||!/^\d+$/.test(value))throw new Error(`Invalid ${name}`);
  const port=Number(value);
  if(!Number.isSafeInteger(port)||port<1||port>65535)throw new Error(`Invalid ${name}`);
  return port;
}

function allowedOrigins(values) {
  if(!Array.isArray(values)||!values.length)throw new Error('Invalid LAB_ALLOWED_ORIGINS');
  const origins=values.map(value=>{
    // Accept only an HTTP(S) authority, never a URL path or CSP fragment.
    if(typeof value!=='string'||!/^https?:\/\/[^\s/?#\\@]+$/.test(value))throw new Error('Invalid LAB_ALLOWED_ORIGINS');
    let url;
    try{url=new URL(value);}catch{throw new Error('Invalid LAB_ALLOWED_ORIGINS');}
    if(url.username||url.password||!/^https?:\/\/[A-Za-z0-9.\[\]:-]+$/.test(url.origin))throw new Error('Invalid LAB_ALLOWED_ORIGINS');
    return url.origin;
  });
  return [...new Set(origins)];
}

export function readConfiguration(env=process.env) {
  const port=configuredPort(env,'LAB_PREVIEW_PORT',8090);
  const sshPort=configuredPort(env,'LAB_SSH_PORT',22002);
  const keyPath=env.LAB_HOST_KEY_PATH===undefined?'config/campus-host-key.pub':env.LAB_HOST_KEY_PATH;
  if(typeof keyPath!=='string'||!keyPath.trim()||keyPath.includes('\0'))throw new Error('Invalid LAB_HOST_KEY_PATH');
  const entries=env.LAB_ALLOWED_ORIGINS===undefined
    ? [`http://127.0.0.1:${port}`]
    : typeof env.LAB_ALLOWED_ORIGINS==='string'
      ? env.LAB_ALLOWED_ORIGINS.split(',').map(value=>value.trim())
      : null;
  return {port,sshHost:'127.0.0.1',sshPort,hostKeyPath:path.resolve(project,keyPath),allowedOrigins:allowedOrigins(entries)};
}

function resolveRequest(pathname) {
  let basePath='';
  if(pathname==='/lab'||pathname.startsWith('/lab/')) {basePath='/lab';pathname=pathname.slice(4)||'/';}
  return {pathname,basePath};
}

export function createApplication(bridgeOptions={}) {
  let bridge;
  const defaults=readConfiguration({});
  const origins=allowedOrigins(bridgeOptions.allowedOrigins??defaults.allowedOrigins);
  const connectPolicy=["'self'",...origins.map(o=>o.replace(/^https:/,'wss:').replace(/^http:/,'ws:'))].join(' ');
  const server=http.createServer(async(req,res)=>{
    try {
      let url;
      try {url=new URL(req.url,'http://localhost');}
      catch {res.writeHead(400);return res.end('Bad request');}
      const {pathname,basePath}=resolveRequest(url.pathname);
      if(await bridge.handleHttp(req,res,pathname))return;
      if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{Allow:'GET, HEAD'});return res.end();}
      if(retiredRoutes.has(pathname)){res.writeHead(302,{Location:`${basePath}/`,'Cache-Control':'no-store'});return res.end();}
      const file=routes.has(pathname)?'live.html':pathname.slice(1);
      if(!files.has(file)){res.writeHead(404);return res.end('Not found');}
      let body;
      try{body=await readFile(path.join(publicRoot,file));}
      catch{res.writeHead(404);return res.end('Not found');}
      if(file.endsWith('.html')&&basePath){
        body=Buffer.from(body.toString('utf8')
          .replace('name="lab-base-path" content=""',`name="lab-base-path" content="${basePath}"`)
          .replaceAll('href="/',`href="${basePath}/`).replaceAll('src="/',`src="${basePath}/`));
      }
      const html=file.endsWith('.html');
      const etag=html?null:`"${createHash('sha256').update(body).digest('hex').slice(0,32)}"`;
      const unchanged=etag&&typeof req.headers['if-none-match']==='string'&&req.headers['if-none-match'].split(',').some(value=>value.trim().replace(/^W\//,'')===etag||value.trim()==='*');
      res.writeHead(unchanged?304:200,{
        'Content-Type':types[path.extname(file)],'Content-Length':body.length,'Cache-Control':html?'no-store':'public, max-age=0, must-revalidate',
        ...(etag?{ETag:etag}:{}),
        'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin',
        'Content-Security-Policy':`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ${connectPolicy}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        'Permissions-Policy':'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()'
      });
      res.end(req.method==='HEAD'||unchanged?undefined:body);
    }catch{
      if(!res.headersSent)res.writeHead(500,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});
      res.end('Service temporarily unavailable');
    }
  });
  server.headersTimeout=10000;server.requestTimeout=15000;server.keepAliveTimeout=5000;
  server.on('clientError',(_err,socket)=>{if(socket.writable)socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');else socket.destroy();});
  bridge=createBridge(server,{
    sshHost:defaults.sshHost,sshPort:defaults.sshPort,hostKeyPath:defaults.hostKeyPath,
    maxSessions:8,maxSessionsPerUser:2,loginTimeoutMs:60000,
    sshTimeoutMs:20000,idleTimeoutMs:1800000,maxLifetimeMs:28800000,...bridgeOptions,allowedOrigins:origins
  });
  return {server,bridge};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {port,...bridgeOptions}=readConfiguration();
  const {server,bridge}=createApplication(bridgeOptions);
  server.listen(port,'127.0.0.1',()=>console.log(`Lab workbench: http://127.0.0.1:${port} (SSH transport enabled; campus login requires personal credentials)`));
  let stopping=false;
  const stop=async()=>{if(stopping)return;stopping=true;await bridge.close();server.close();};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
