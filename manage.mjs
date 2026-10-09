import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { defaultStatePath } from './config.mjs';

export function manage(command, input, path = defaultStatePath()) {
  if (statSync(path).uid !== process.getuid()) {
    console.error('Run this command as the opencode-login service user.');
    throw new Error('Run this command as the database owner');
  }
  const db = new DatabaseSync(path, { allowExtension: false });
  db.exec('PRAGMA busy_timeout=3000');
  try {
    if (command === 'blocked') {
      console.log(JSON.stringify(db.prepare('SELECT ip, failures, updated FROM login_ips WHERE blocked = 1 ORDER BY updated DESC').all(), null, 2));
    } else if (command === 'unblock' && isIP(input || '')) {
      const ip = input.startsWith('::ffff:') && isIP(input.slice(7)) === 4 ? input.slice(7)
        : isIP(input) === 6 ? new URL(`http://[${input}]`).hostname.slice(1, -1) : input;
      const result = db.prepare('DELETE FROM login_ips WHERE ip = ?').run(ip);
      console.log(JSON.stringify({ event: 'ip_unblocked', ip, changed: result.changes, at: new Date().toISOString() }));
    } else if (command === 'revoke-sessions') {
      const result = db.prepare('DELETE FROM sessions').run();
      console.log(JSON.stringify({ event: 'sessions_revoked', count: result.changes, at: new Date().toISOString() }));
    } else {
      console.error('Usage: node manage.mjs blocked | unblock IP | revoke-sessions');
      process.exitCode = 1;
    }
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  manage(process.argv[2], process.argv[3], process.env.LOGIN_STATE_DB || '/var/lib/opencode-login/security.sqlite');
}
