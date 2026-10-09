import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, chmodSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

const SESSION_TTL = 8 * 60 * 60 * 1000;
const IDLE_TTL = 30 * 60 * 1000;
const CHALLENGE_TTL = 5 * 60 * 1000;
const hash = (value) => createHash('sha256').update(value).digest('hex');
let fontLoaded = false;

export class SecurityStore {
  constructor(path) {
    if (!fontLoaded) {
      const font = fileURLToPath(new URL('./assets/DejaVuSans-Bold.ttf', import.meta.url));
      if (!GlobalFonts.registerFromPath(font, 'LoginFont')) throw new Error('Unable to load the bundled verification font');
      fontLoaded = true;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const parent = lstatSync(dirname(path));
    if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o077)) throw new Error('The security database directory must be owned by the current user with permissions 0700');
    for (const file of [path, path + '-wal', path + '-shm']) {
      const info = lstatSync(file, { throwIfNoEntry: false });
      if (!info) continue;
      if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('Security database files must be regular files owned by the current user with permissions 0600');
    }
    this.db = new DatabaseSync(path, { allowExtension: false });
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS login_ips (
        ip TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0,
        blocked INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, token TEXT NOT NULL, origin TEXT NOT NULL,
        created INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);
      CREATE TABLE IF NOT EXISTS security_keys (name TEXT PRIMARY KEY, value BLOB NOT NULL CHECK(length(value) = 32));`);
    this.db.prepare('INSERT OR IGNORE INTO security_keys(name, value) VALUES (?, ?)').run('csrf', randomBytes(32));
    this.csrfKey = Buffer.from(this.db.prepare('SELECT value FROM security_keys WHERE name = ?').get('csrf').value);
    this.challenges = new Map();
    this.requests = new Map();
    this.pending = new Set();
    this.challengeKey = randomBytes(32);
    this.cleanup = setInterval(() => {
      try { this.prune(); }
      catch { console.error(JSON.stringify({ event: 'security_storage_error', at: new Date().toISOString() })); }
    }, 60000);
    this.cleanup.unref();
  }

  state(ip) {
    return this.db.prepare('SELECT failures, blocked FROM login_ips WHERE ip = ?').get(ip) || { failures: 0, blocked: 0 };
  }

  fail(ip) {
    const row = this.db.prepare(`INSERT INTO login_ips(ip, failures, blocked, updated) VALUES (?, 1, 0, ?)
      ON CONFLICT(ip) DO UPDATE SET failures = MIN(failures + 1, 10),
      blocked = CASE WHEN failures + 1 >= 10 THEN 1 ELSE blocked END, updated = excluded.updated
      RETURNING failures, blocked`).get(ip, Date.now());
    console.log(JSON.stringify({ event: row.blocked ? 'ip_blocked' : 'login_failed', ip, failures: row.failures, at: new Date().toISOString() }));
    return row;
  }

  succeed(ip) {
    this.db.prepare('DELETE FROM login_ips WHERE ip = ? AND blocked = 0').run(ip);
    console.log(JSON.stringify({ event: 'login_success', ip, at: new Date().toISOString() }));
  }

  allowRequest(ip, bucket = 'login', limit = 40) {
    const now = Date.now();
    const key = bucket + ':' + ip;
    const previous = this.requests.get(key);
    const state = previous && previous.until > now ? previous : { count: 0, until: now + 60000 };
    if (!previous && this.requests.size >= 10000) return false;
    state.count += 1;
    this.requests.set(key, state);
    return state.count <= limit;
  }

  begin(ip) {
    if (this.pending.has(ip) || this.pending.size >= 20) return false;
    this.pending.add(ip);
    return true;
  }

  end(ip) { this.pending.delete(ip); }

  challenge(csrf, ip) {
    if (this.challenges.size >= 2000) this.prune();
    if (this.challenges.size >= 2000) throw new Error('Challenge capacity exceeded');
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const answer = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('');
    const canvas = createCanvas(270, 86);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f0f1f5';
    ctx.fillRect(0, 0, 270, 86);
    for (let i = 0; i < 140; i++) {
      ctx.fillStyle = `rgba(${randomInt(180)},${randomInt(180)},${randomInt(180)},0.25)`;
      ctx.fillRect(randomInt(270), randomInt(86), randomInt(1, 3), randomInt(1, 3));
    }
    for (let i = 0; i < answer.length; i++) {
      ctx.save();
      ctx.translate(25 + i * 42, 53 + randomInt(-7, 8));
      ctx.rotate(randomInt(-20, 21) * Math.PI / 180);
      ctx.font = 'bold 34px LoginFont';
      ctx.fillStyle = `rgb(${randomInt(15, 85)},${randomInt(15, 85)},${randomInt(15, 85)})`;
      ctx.fillText(answer[i], 0, 0);
      ctx.restore();
    }
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(0, randomInt(86));
      ctx.bezierCurveTo(80, randomInt(86), 170, randomInt(86), 270, randomInt(86));
      ctx.strokeStyle = '#66758b80';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    this.challenges.set(csrf, { ip, digest: this.answerHash(csrf, ip, answer), expires: Date.now() + CHALLENGE_TTL, image: canvas.toBuffer('image/png') });
  }

  answerHash(csrf, ip, answer) {
    return createHmac('sha256', this.challengeKey).update(csrf + '\0' + ip + '\0' + answer).digest();
  }

  image(csrf, ip) {
    const challenge = this.challenges.get(csrf);
    return challenge && challenge.ip === ip && challenge.expires > Date.now() ? challenge.image : undefined;
  }

  verifyChallenge(csrf, ip, answer) {
    const challenge = this.challenges.get(csrf);
    this.challenges.delete(csrf);
    if (!challenge || challenge.ip !== ip || challenge.expires <= Date.now() || !/^[A-Z2-9]{6}$/.test(answer)) return false;
    return timingSafeEqual(challenge.digest, this.answerHash(csrf, ip, answer));
  }

  createSession(token, origin) {
    const value = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.db.prepare('INSERT INTO sessions(id, token, origin, created, last_seen, expires) VALUES (?, ?, ?, ?, ?, ?)')
      .run(hash(value), token, origin, now, now, now + SESSION_TTL);
    return value;
  }

  session(value, origin, touch = true) {
    if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return;
    const id = hash(value);
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ? AND origin = ?').get(id, origin);
    const now = Date.now();
    if (!row || row.expires <= now || row.last_seen + IDLE_TTL <= now) {
      if (row) this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      return;
    }
    if (touch && now - row.last_seen >= 60000) this.db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?').run(now, id);
    return row;
  }

  revoke(value) {
    if (value) this.db.prepare('DELETE FROM sessions WHERE id = ?').run(hash(value));
  }

  prune() {
    const now = Date.now();
    for (const [key, row] of this.challenges) if (row.expires <= now) this.challenges.delete(key);
    for (const [key, row] of this.requests) if (row.until <= now) this.requests.delete(key);
    this.db.prepare('DELETE FROM sessions WHERE expires <= ? OR last_seen <= ?').run(now, now - IDLE_TTL);
  }

  close() { clearInterval(this.cleanup); this.db.close(); }
}
