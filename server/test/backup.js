// Do the nightly backups actually work, and do they fail safely?
//   npm run test:backup
//
// Takes a real dump of the real database, checks it can be read back, then
// exercises retention and the ways it can go wrong. The one thing a backup
// suite must not do is assert that a file exists and call it proof.

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pool } = require('../src/db');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'profitna-backup-'));
process.env.BACKUP_DIR = DIR;
const backup = require('../src/backup');

let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

const stale = (file) => fs.utimesSync(file, new Date('2020-01-01'), new Date('2020-01-01'));

(async () => {
  console.log('\ntaking one');
  const first = await backup.once('test');
  check('it completes', first.ok === true, first.error);
  check('and produces a file of real size', first.ok && first.bytes > 1000, first.ok && String(first.bytes));
  check('which is on disk', backup.list().length === 1);

  // The part that matters: pg_restore has already been asked to read the
  // table of contents inside once(), so a file that got here is one a person
  // in a hurry can actually open.
  const file = path.join(DIR, backup.list()[0].name);
  let toc = '';
  try { toc = execFileSync('pg_restore', ['--list', file], { encoding: 'utf8' }); } catch (e) { toc = ''; }
  check('and whose contents list reads back', /TABLE|SCHEMA/i.test(toc));
  check('including the tables that hold money',
    /payments/.test(toc) && /subscriptions/.test(toc) && /transactions/.test(toc),
    'a dump missing these is not a backup of this product');

  console.log('\nscheduling');
  check('nothing is due straight after one is taken', backup.dueNow() === false);
  stale(file);
  check('one is due once the newest has aged out', backup.dueNow() === true);

  console.log('\nretention');
  const older = ['profitna-2020-01-01T00-00-00Z.dump', 'profitna-2020-01-02T00-00-00Z.dump']
    .map((n) => path.join(DIR, n));
  older.forEach((f) => { fs.writeFileSync(f, 'x'.repeat(2000)); stale(f); });
  const removed = backup.prune();
  check('dumps past the window are deleted', removed.length === 2, JSON.stringify(removed));
  check('and the newest survives', backup.list().length === 1);

  stale(path.join(DIR, backup.list()[0].name));
  backup.prune();
  check('the last one is never deleted, however old',
    backup.list().length === 1,
    'an old backup is worth more than none, and a database that has stopped ' +
    'dumping should not erase its history as well');

  console.log('\nwhen it cannot work');
  process.env.BACKUP_DIR = '/etc/hostname/backups';   // the parent is a file
  const unwritable = await backup.once('test');
  check('an unusable directory is reported rather than thrown',
    unwritable.ok === false && /not writable/.test(unwritable.error), unwritable.error);
  process.env.BACKUP_DIR = DIR;

  const realPath = process.env.PATH;
  process.env.PATH = '/nonexistent';
  const missing = await backup.once('test');
  check('a missing pg_dump says so plainly',
    missing.ok === false && /pg_dump/.test(missing.error), missing.error);
  process.env.PATH = realPath;
  check('and leaves no half-written file behind',
    fs.readdirSync(DIR).filter((f) => f.endsWith('.part')).length === 0,
    'a partial file that looks like a backup is worse than no file');

  console.log('\nclient against server');
  // The real failure on the live server: a 16 client meeting a 17 database.
  // pg_dump reads older servers happily and newer ones never, so the only
  // wrong answer is a client behind the database.
  const here = await backup.compatibility();
  check('it can see both versions',
    here.available && here.clientMajor !== null && here.serverMajor !== null,
    JSON.stringify(here));
  check('and matching versions are compatible', here.compatible === true, JSON.stringify(here));

  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'fakebin-'));
  fs.writeFileSync(path.join(fakeBin, 'pg_dump'),
    '#!/bin/sh\n' +
    'if [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 16.15"; exit 0; fi\n' +
    'echo "pg_dump: error: aborting because of server version mismatch" >&2\n' +
    'echo "pg_dump: detail: server version: 17.11; pg_dump version: 16.15" >&2\n' +
    'exit 1\n');
  fs.chmodSync(path.join(fakeBin, 'pg_dump'), 0o755);
  const realPath2 = process.env.PATH;
  process.env.PATH = fakeBin + ':' + realPath2;

  const mismatched = await backup.once('test');
  check('a version mismatch is reported as a failure', mismatched.ok === false);
  check('and comes with the fix rather than only the complaint',
    typeof mismatched.fix === 'string' && /at least as new as the database/.test(mismatched.fix),
    'pg_dump\'s own words are accurate and say nothing about what to do');
  check('leaving no half-written file',
    fs.readdirSync(DIR).filter((f) => f.endsWith('.part')).length === 0);

  process.env.PATH = realPath2;
  fs.rmSync(fakeBin, { recursive: true, force: true });

  // test/offsite.js proves the copy itself — the signature against AWS's own
  // signer, and an upload against a store that answers like S3. What is left
  // to prove here is that a real backup run actually reaches for it, and that
  // a store having a bad night cannot cost us the dump we already have.
  console.log('\ngetting it off the machine');
  const http = require('http');
  const held = new Map();
  let refuse = false;
  const store = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (refuse) { res.writeHead(500); return res.end('nope'); }
      if (req.method === 'PUT') { held.set(req.url, Buffer.concat(chunks)); res.writeHead(200); return res.end(); }
      if (req.method === 'HEAD') {
        const o = held.get(req.url);
        if (!o) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'content-length': String(o.length) });
        return res.end();
      }
      res.writeHead(405); res.end();
    });
  });
  const port = await new Promise((r) => store.listen(0, '127.0.0.1', () => r(store.address().port)));
  Object.assign(process.env, {
    BACKUP_S3_ENDPOINT: 'http://127.0.0.1:' + port,
    BACKUP_S3_BUCKET: 'profitna-test',
    BACKUP_S3_REGION: 'us-east-1',
    BACKUP_S3_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    BACKUP_S3_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    BACKUP_S3_PREFIX: 'nightly',
    BACKUP_S3_PATH_STYLE: 'on'
  });

  const copied = await backup.once('test');
  check('a backup now goes somewhere else as well', copied.ok && copied.offsite && copied.offsite.ok,
    copied.offsite && copied.offsite.error);
  check('and the far end holds the same bytes as the file on disk',
    copied.ok && held.get('/profitna-test/nightly/' + copied.name) &&
    held.get('/profitna-test/nightly/' + copied.name).length ===
      fs.statSync(path.join(DIR, copied.name)).size);

  refuse = true;
  const stranded = await backup.once('test');
  // The dump is taken and verified before the copy is attempted. Throwing it
  // away because somebody else's endpoint was down would turn a small problem
  // into a real one.
  check('a failed copy does not fail the backup', stranded.ok === true, stranded.error);
  check('the dump is still on disk', fs.existsSync(path.join(DIR, stranded.name)));
  check('and the failure is reported rather than swallowed',
    stranded.offsite && stranded.offsite.ok === false && /500/.test(stranded.offsite.error),
    JSON.stringify(stranded.offsite));

  await new Promise((r) => store.close(r));
  for (const k of Object.keys(process.env)) if (k.startsWith('BACKUP_S3_')) delete process.env[k];
  const local = await backup.once('test');
  check('with nowhere configured, a backup is local and says so',
    local.ok === true && local.offsite === null, JSON.stringify(local.offsite));

  console.log('\nswitches');
  process.env.BACKUP_ENABLED = 'off';
  check('backups can be turned off', backup.enabled() === false);
  check('and starting is then a no-op', backup.start() === null);
  process.env.BACKUP_ENABLED = 'on';
  check('and turned back on', backup.enabled() === true);

  fs.rmSync(DIR, { recursive: true, force: true });
  await pool.end();

  console.log('');
  if (failures.length) {
    console.log(passed + ' passed, ' + failures.length + ' failed');
    process.exit(1);
  }
  console.log(passed + ' passed, 0 failed');
})().catch((err) => { console.error(err); process.exit(1); });
