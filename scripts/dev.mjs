#!/usr/bin/env node
// `npm run dev` — starts the DineFlow API and web app together, in one terminal.
//
// Running them in two terminals kept going wrong: each command holds its terminal,
// so starting the second often meant stopping the first, and the web app then
// showed "Can't reach the DineFlow server". This starts both, says plainly when
// they are ready and where to go, and stops both on Ctrl+C.
import { spawn } from 'node:child_process';
import net from 'node:net';

const API_PORT = 4000;
const WEB_PORT = 5180;
const WEB_URL = `http://localhost:${WEB_PORT}`;

const green = (text) => `\x1b[32m${text}\x1b[0m`;
const red = (text) => `\x1b[31m${text}\x1b[0m`;
const bold = (text) => `\x1b[1m${text}\x1b[0m`;

/** True if something is already listening on the port, on either IPv4 or IPv6 loopback. */
function portInUse(port) {
  const probe = (host) => new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
  return Promise.all([probe('127.0.0.1'), probe('::1')]).then((results) => results.some(Boolean));
}

for (const [name, port] of [['API', API_PORT], ['web app', WEB_PORT]]) {
  if (await portInUse(port)) {
    console.error(red(`\nPort ${port} (the ${name}) is already in use, so DineFlow cannot start.`));
    console.error(`See what is using it:   lsof -iTCP:${port} -sTCP:LISTEN`);
    console.error('If it is an earlier DineFlow still running, stop it (Ctrl+C in its terminal) and try again.\n');
    process.exit(1);
  }
}

const children = [];
let stopping = false;

function start(label, script) {
  // Each server gets its own process group, so stopping it also stops what npm
  // started underneath (the file watcher, Vite), leaving nothing behind.
  const child = spawn('npm', ['run', script], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const prefix = label === 'api' ? '\x1b[36m[api]\x1b[0m ' : '\x1b[35m[web]\x1b[0m ';
  const relay = (stream, out) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) out.write(prefix + line + '\n');
    });
  };
  relay(child.stdout, process.stdout);
  relay(child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (!stopping) {
      console.error(red(`\nThe ${label === 'api' ? 'API' : 'web app'} stopped unexpectedly (exit ${code}). Stopping DineFlow.`));
      stopAll(1);
    }
  });
  children.push(child);
}

function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => { console.log('\nStopping DineFlow…'); stopAll(0); });
process.on('SIGTERM', () => stopAll(0));

console.log(bold('Starting DineFlow…'));
start('api', 'dev:api');
start('web', 'dev:web');

// Wait until both answer, then say so in one unmissable line.
const ready = async (url) => { try { return (await fetch(url)).ok; } catch { return false; } };
const deadline = Date.now() + 60_000;
while (!stopping) {
  if (await ready(`http://localhost:${API_PORT}/healthz/ready`) && await ready(`${WEB_URL}/`)) {
    console.log(green(bold(`\n  DineFlow is ready → open ${WEB_URL}\n`)) + '  Keep this terminal open. Press Ctrl+C to stop both.\n');
    break;
  }
  if (Date.now() > deadline) {
    console.error(red('\nDineFlow did not become ready within 60 seconds. The messages above say why.'));
    stopAll(1);
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
