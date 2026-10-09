const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pool } = require('./db');

// Nightly backups.
//
// Runs inside the server process, like the billing scheduler, so there is no
// second thing to deploy and no host cron to forget. It takes a custom-format
// dump with pg_dump, checks the file is actually readable as a dump, and
// deletes ones older than the retention window.
//
// Two decisions worth knowing about:
//
// Rather than firing at a fixed hour, it asks on every tick whether the newest
// dump is older than the interval. A container that restarts in the night
// would miss a fixed hour entirely and nobody would notice until the day they
// needed the backup; this way a missed window is made up at the next tick and
// the schedule heals itself.
//
// The dump is written under a temporary name and renamed only once pg_dump has
// exited cleanly and the result has been verified. A half-written file is
// never left looking like a backup, which is the failure that turns "we have
// backups" into "we had something shaped like one".

const LOCK_KEY = 4820772;              // billing holds 4820771; neighbours, not twins
const TICK_MINUTES = 30;

function dir() { return process.env.BACKUP_DIR || '/data/backups'; }
function intervalHours() { return Number(process.env.BACKUP_INTERVAL_HOURS || 24); }
function keepDays() { return Number(process.env.BACKUP_KEEP_DAYS || 14); }
function enabled() { return String(process.env.BACKUP_ENABLED || 'on').toLowerCase() !== 'off'; }

const PREFIX = 'profitna-';
const SUFFIX = '.dump';

// Keeps the password out of the process list, where a dbname URI would put it
// for anyone who can run ps in the container.
function childEnv() {
  const url = new URL(process.env.DATABASE_URL);
  return Object.assign({}, process.env, {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '')),
    PGCONNECT_TIMEOUT: '10'
  });
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ ok: false, err: cmd + ' could not be started: ' + err.message });
    }
    let out = '';
    let errText = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } },
      timeoutMs || 10 * 60 * 1000);
    child.stdout.on('data', (d) => { out += d.toString().slice(0, 4000); });
    child.stderr.on('data', (d) => { errText += d.toString().slice(0, 4000); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, err: cmd + ' is not available in this image: ' + err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, out, err: errText.trim() });
    });
  });
}

function stamp(d) {
  return d.toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
}

// Every dump currently on disk, newest first.
function list() {
  let names;
  try {
    names = fs.readdirSync(dir());
  } catch (err) {
    return [];
  }
  return names
    .filter((n) => n.startsWith(PREFIX) && n.endsWith(SUFFIX))
    .map((n) => {
      const full = path.join(dir(), n);
      let st = null;
      try { st = fs.statSync(full); } catch (e) { return null; }
      return { name: n, bytes: st.size, takenAt: st.mtime.toISOString() };
    })
    .filter(Boolean)
    .sort((a, b) => (a.takenAt < b.takenAt ? 1 : -1));
}

function ensureDir() {
  fs.mkdirSync(dir(), { recursive: true });
  // Writable in practice, not just in theory: the container runs unprivileged
  // and a mounted volume owned by root fails here rather than at 2am.
  fs.accessSync(dir(), fs.constants.W_OK);
}

async function once(reason) {
  if (!process.env.DATABASE_URL) return { ok: false, error: 'DATABASE_URL is not set' };

  try {
    ensureDir();
  } catch (err) {
    return { ok: false, error: 'backup directory ' + dir() + ' is not writable: ' + err.message };
  }

  const name = PREFIX + stamp(new Date()) + SUFFIX;
  const target = path.join(dir(), name);
  const partial = target + '.part';
  const startedAt = Date.now();

  const dumped = await run('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file=' + partial]);
  if (!dumped.ok) {
    try { fs.unlinkSync(partial); } catch (e) { /* nothing to clean */ }
    return { ok: false, error: 'pg_dump failed: ' + (dumped.err || 'exit ' + dumped.code) };
  }

  let bytes = 0;
  try { bytes = fs.statSync(partial).size; } catch (e) { /* handled below */ }
  if (bytes < 1000) {
    try { fs.unlinkSync(partial); } catch (e) { /* nothing to clean */ }
    return { ok: false, error: 'the dump came out at ' + bytes + ' bytes, which cannot be a real one' };
  }

  // An unverified backup is a guess. If pg_restore cannot read its table of
  // contents then neither can anyone restoring it in a hurry.
  const checked = await run('pg_restore', ['--list', partial], 2 * 60 * 1000);
  if (!checked.ok || !/TABLE|DATABASE|SCHEMA/i.test(checked.out)) {
    try { fs.unlinkSync(partial); } catch (e) { /* nothing to clean */ }
    return { ok: false, error: 'the dump could not be read back: ' + (checked.err || 'no table of contents') };
  }

  fs.renameSync(partial, target);

  const pruned = prune();
  return {
    ok: true,
    name,
    bytes,
    seconds: Math.round((Date.now() - startedAt) / 1000),
    pruned,
    reason: reason || 'scheduled'
  };
}

// Deletes dumps past the retention window, but never the newest one — an old
// backup is worth more than none, and a database that has stopped dumping
// should not quietly erase its own history as well.
function prune() {
  const all = list();
  const cutoff = Date.now() - keepDays() * 24 * 60 * 60 * 1000;
  const removed = [];
  all.slice(1).forEach((b) => {
    if (new Date(b.takenAt).getTime() < cutoff) {
      try { fs.unlinkSync(path.join(dir(), b.name)); removed.push(b.name); } catch (e) { /* leave it */ }
    }
  });
  return removed;
}

function dueNow() {
  const newest = list()[0];
  if (!newest) return true;
  return Date.now() - new Date(newest.takenAt).getTime() >= intervalHours() * 60 * 60 * 1000;
}

async function tick() {
  if (!dueNow()) return null;

  // One container takes the backup, not all of them.
  const client = await pool.connect();
  try {
    const got = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
    if (!got.rows[0].ok) return null;
    try {
      const result = await once('scheduled');
      if (result.ok) {
        console.log('backup ' + result.name + ' (' + Math.round(result.bytes / 1024) + 'KB in ' +
          result.seconds + 's)' + (result.pruned.length ? ', pruned ' + result.pruned.length : ''));
      } else {
        console.error('BACKUP FAILED: ' + result.error);
      }
      return result;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

function start() {
  if (!enabled()) {
    console.log('nightly backups are off (BACKUP_ENABLED=off)');
    return null;
  }
  console.log('nightly backups on: every ' + intervalHours() + 'h into ' + dir() +
    ', keeping ' + keepDays() + ' days');

  // Say at boot whether the tool is even here. The alternative is a schedule
  // that looks fine for weeks and has never written anything.
  run('pg_dump', ['--version'], 15000).then((r) => {
    if (r.ok) console.log('  pg_dump: ' + (r.out || '').trim());
    else console.error('  WARNING: pg_dump is not available — no backups will be taken. ' +
      (r.err || ''));
  });

  const safely = () => { tick().catch((err) => console.error('backup tick failed:', err.message)); };
  // A minute after boot, so a deployment that has just changed the schema gets
  // a dump of it without waiting for the night.
  setTimeout(safely, 60 * 1000).unref();
  const timer = setInterval(safely, TICK_MINUTES * 60 * 1000);
  timer.unref();
  return timer;
}

// Whether pg_dump can be run at all, for the owner's console.
async function toolAvailable() {
  const r = await run('pg_dump', ['--version'], 15000);
  return { available: r.ok, version: r.ok ? (r.out || '').trim() : null };
}

module.exports = { start, once, list, prune, dueNow, dir, keepDays, intervalHours, enabled, toolAvailable };
