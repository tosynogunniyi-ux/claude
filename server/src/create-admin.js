require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool, one, many } = require('./db');
const totp = require('./totp');

// Creating the platform owner is a deliberate act at a terminal, not a
// self-service form and not a seeded default. Until this has been run there
// is no owner account, and the Control Center answers 404 to everyone.
//
//   node src/create-admin.js --email you@example.com --name "Your Name"
//   node src/create-admin.js --list
//   node src/create-admin.js --email you@example.com --rotate-totp
//   node src/create-admin.js --email you@example.com --reset-password
//   node src/create-admin.js --email you@example.com --disable
//   node src/create-admin.js --email you@example.com --enable

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[name] = next;
      i++;
    } else {
      out[name] = true;
    }
  }
  return out;
}

// Six words of dictionary-free randomness: long enough that the bcrypt cost
// is the only thing standing between it and a guess, short enough to type in
// once before it is changed in the console.
function suggestPassword() {
  return crypto.randomBytes(18).toString('base64url');
}

function announce(email, password, secret) {
  console.log('');
  console.log('  Control Center owner: ' + email);
  if (password) {
    console.log('  Password:             ' + password);
    console.log('                        Change it after the first sign-in.');
  }
  if (secret) {
    console.log('');
    console.log('  Two-factor secret:    ' + secret);
    console.log('  Add to an authenticator app, by pasting the secret or this link:');
    console.log('  ' + totp.otpauthUrl(secret, email));
    console.log('');
    console.log('  This is the only time the secret is printed. Enrolment completes');
    console.log('  on the first sign-in that uses a code from it.');
  }
  console.log('');
  console.log('  Sign in at  https://<your-domain>/admin');
  console.log('');
}

async function main() {
  const a = args();

  if (a.list) {
    const rows = await many(
      `SELECT email, full_name, status, totp_enrolled_at, last_login_at, created_at
         FROM platform_admins ORDER BY created_at`
    );
    if (!rows.length) {
      console.log('No Control Center accounts exist. The console is switched off until one does.');
      return;
    }
    for (const r of rows) {
      console.log(
        [
          r.email,
          r.full_name || '—',
          r.status,
          r.totp_enrolled_at ? '2FA enrolled' : '2FA pending',
          r.last_login_at ? 'last seen ' + new Date(r.last_login_at).toISOString().slice(0, 16).replace('T', ' ') : 'never signed in'
        ].join('  ·  ')
      );
    }
    return;
  }

  const email = String(a.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('Give an email address: --email you@example.com');
    process.exitCode = 1;
    return;
  }

  const existing = await one('SELECT id, email, status FROM platform_admins WHERE email = $1', [email]);

  if (a.disable || a.enable) {
    if (!existing) {
      console.error('No Control Center account uses ' + email + '.');
      process.exitCode = 1;
      return;
    }
    const status = a.disable ? 'disabled' : 'active';
    await pool.query('UPDATE platform_admins SET status = $2 WHERE id = $1', [existing.id, status]);
    // A disabled owner should not keep a session open on the strength of a
    // cookie issued before they were disabled.
    await pool.query('UPDATE platform_admin_sessions SET revoked_at = now() WHERE admin_id = $1 AND revoked_at IS NULL', [
      existing.id
    ]);
    console.log(email + ' is now ' + status + '.');
    return;
  }

  if (existing) {
    if (!a['rotate-totp'] && !a['reset-password']) {
      console.error(
        email + ' already has a Control Center account.\n' +
          'Use --reset-password or --rotate-totp to change its credentials, or --disable to switch it off.'
      );
      process.exitCode = 1;
      return;
    }

    let password = null;
    let secret = null;

    if (a['reset-password']) {
      password = typeof a.password === 'string' ? a.password : suggestPassword();
      if (password.length < 12) {
        console.error('Choose a password of at least 12 characters.');
        process.exitCode = 1;
        return;
      }
      await pool.query('UPDATE platform_admins SET password_hash = $2, failed_attempts = 0, locked_until = NULL WHERE id = $1', [
        existing.id,
        await bcrypt.hash(password, 12)
      ]);
    }

    if (a['rotate-totp']) {
      secret = totp.randomSecret();
      await pool.query('UPDATE platform_admins SET totp_secret = $2, totp_enrolled_at = NULL WHERE id = $1', [
        existing.id,
        secret
      ]);
    }

    // Changing either credential ends every session opened with the old one.
    await pool.query('UPDATE platform_admin_sessions SET revoked_at = now() WHERE admin_id = $1 AND revoked_at IS NULL', [
      existing.id
    ]);
    announce(email, password, secret);
    return;
  }

  const password = typeof a.password === 'string' ? a.password : suggestPassword();
  if (password.length < 12) {
    console.error('Choose a password of at least 12 characters.');
    process.exitCode = 1;
    return;
  }
  const secret = totp.randomSecret();

  await pool.query(
    `INSERT INTO platform_admins (email, password_hash, full_name, totp_secret)
     VALUES ($1, $2, $3, $4)`,
    [email, await bcrypt.hash(password, 12), String(a.name || '').trim() || null, secret]
  );

  announce(email, typeof a.password === 'string' ? null : password, secret);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err.message);
    pool.end();
    process.exit(1);
  });
