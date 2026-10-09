import http from 'node:http';
import { parseArgs } from 'node:util';
import { configFromEnv } from './config.mjs';

const usage = `OpenCode Web Login

Usage:
  opencode-web-login serve [--config /absolute/path/login.env]
  opencode-web-login doctor [--config /absolute/path/login.env]
  opencode-web-login blocked [--config /absolute/path/login.env]
  opencode-web-login unblock IP [--config /absolute/path/login.env]
  opencode-web-login revoke-sessions [--config /absolute/path/login.env]
  opencode-web-login install --opencode-bin /absolute/path/opencode [options]

Requires Node.js 24+ and OpenCode v2 with /api/info, /api/pair and /auth/connect.
Run "opencode-web-login install --help" for Linux service installation.
`;

async function doctor(config) {
  const status = await new Promise((resolve, reject) => {
    const request = http.get({ hostname: config.backendHost, port: config.backendPort, path: '/api/info' }, (response) => {
      const json = (response.headers['content-type'] || '').includes('application/json');
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode, json }));
    });
    request.setTimeout(3000, () => request.destroy(new Error('OpenCode backend timeout')));
    request.on('error', reject);
  });
  if (status.status !== 401 || !status.json) throw new Error('Expected a password-protected OpenCode v2 backend returning JSON HTTP 401 at /api/info');
  console.log(JSON.stringify({ ok: true, node: process.versions.node, gateway: config.localOrigin,
    backend: { host: config.backendHost, port: config.backendPort, protected: true }, statePath: config.statePath,
    publicOrigins: config.publicOrigins }, null, 2));
}

export async function runCLI(args = process.argv.slice(2)) {
  if (args[0] === 'install') {
    const { install } = await import('./install.mjs');
    return install(args.slice(1));
  }
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { config: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help || positionals[0] === 'help') { console.log(usage); return; }
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required');
  if (values.config) process.loadEnvFile(values.config);
  const command = positionals[0] || 'serve';
  const config = configFromEnv();
  if (command === 'serve' && positionals.length <= 1) {
    const { createLoginServer } = await import('./index.mjs');
    const login = createLoginServer(config);
    try { await login.listen(); } catch (error) { await login.close(); throw error; }
    console.log(`OpenCode web sign-in listening on ${config.localOrigin}`);
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await login.close();
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    return login;
  }
  if (command === 'doctor' && positionals.length === 1) return doctor(config);
  if (['blocked', 'unblock', 'revoke-sessions'].includes(command)) {
    const { manage } = await import('./manage.mjs');
    return manage(command, positionals[1], config.statePath);
  }
  throw new Error('Unknown command. Run opencode-web-login --help');
}
