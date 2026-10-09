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
