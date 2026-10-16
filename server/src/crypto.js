// Encrypting the credentials one tenant gives us to collect its own money.
//
// A merchant secret key is the one thing in this database that is worth
// stealing on its own: with a tenant's Paystack secret key somebody can
// initiate charges and read that tenant's whole transaction history, without
// touching Profitna at all. So it is encrypted at rest with a key that lives
// in the environment and never in the database — a stolen database dump,
// which is the realistic breach, yields ciphertext.
//
// Three decisions worth stating, because each closes a specific hole:
//
//   AES-256-GCM, not CBC. GCM authenticates: a ciphertext that has been
//   altered fails to decrypt rather than decrypting to something else.
//
//   The organisation id and provider are the additional authenticated data.
//   That binds the ciphertext to one row of one tenant. Copying a ciphertext
//   out of one organisation's row into another's — by a bug, a bad import or
//   somebody with SQL access — produces a decryption failure, not another
//   tenant's live secret key. Tenant isolation that the database alone
//   cannot give, because the database is what leaks.
//
//   No key, no storage. Without CREDENTIALS_KEY this module refuses to
//   encrypt rather than falling back to plaintext. A feature that is clearly
//   switched off is recoverable; a secret key sitting in a text column
//   because the fallback seemed friendlier is not.

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;              // 96 bits, what GCM is specified for
const VERSION = 'v1';

// scrypt, not a bare hash, for the case where the variable holds a passphrase
// rather than 32 random bytes. The salt is fixed and public: it separates this
// use of the variable from any other, which is all a salt can do when there is
// one key and no per-record derivation.
const SALT = Buffer.from('profitna.credentials.v1');

let cached = null;
let cachedFrom = null;

// The raw environment value. Read on each call rather than captured at
// require time, so a test can set it and a deployment that adds it does not
// need the module reloaded.
function configured() {
  const raw = process.env.CREDENTIALS_KEY;
  return typeof raw === 'string' && raw.trim().length > 0;
}

// What an operator has to do, in one sentence, wherever the absence surfaces.
const REQUIREMENT =
  'Set CREDENTIALS_KEY in the server environment to a 32-byte random value — ' +
  "`openssl rand -base64 32` produces one. It encrypts tenants' payment " +
  'credentials, so it must be set before any can be saved, and it must not ' +
  'change afterwards: the credentials already stored can only be read with ' +
  'the key that wrote them.';

// 32 bytes exactly, from base64 or hex, is used as the key. Anything else is
// treated as a passphrase and stretched. Both are supported because an
// operator pasting the output of `openssl rand -base64 32` and one typing a
// long phrase both deserve a working deployment, and guessing which they did
// is cheaper than making them read documentation.
function key() {
  const raw = String(process.env.CREDENTIALS_KEY || '').trim();
  if (!raw) {
    const err = new Error('Payment credentials cannot be stored yet. ' + REQUIREMENT);
    err.status = 503;
    err.code = 'NO_CREDENTIALS_KEY';
    throw err;
  }
  if (cached && cachedFrom === raw) return cached;

  let derived = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    derived = Buffer.from(raw, 'hex');
  } else {
    const asBase64 = Buffer.from(raw, 'base64');
    // Buffer.from is permissive, so the round trip is the test of whether it
    // really was base64 and really was 32 bytes.
    if (asBase64.length === 32 && asBase64.toString('base64').replace(/=+$/, '') === raw.replace(/=+$/, '')) {
      derived = asBase64;
    }
  }
  if (!derived) derived = crypto.scryptSync(raw, SALT, 32);

  cached = derived;
  cachedFrom = raw;
  return derived;
}

// The additional authenticated data. Not secret and not stored: it is
// reconstructed from the row being read, so a ciphertext only decrypts in the
// place it was written.
function aad(context) {
  const org = String((context && context.organizationId) || '');
  const provider = String((context && context.provider) || '');
  if (!org || !provider) {
    throw new Error('crypto: a credential is encrypted against an organisation and a provider');
  }
  return Buffer.from('profitna:' + org + ':' + provider);
}

function encrypt(plaintext, context) {
  const value = String(plaintext === null || plaintext === undefined ? '' : plaintext);
  if (!value) return null;

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
  cipher.setAAD(aad(context));
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Self-describing, so a future algorithm change can read what this wrote
  // instead of needing a migration that cannot decrypt anything.
  return [VERSION, iv.toString('base64'), tag.toString('base64'), body.toString('base64')].join('.');
}

function decrypt(stored, context) {
  if (!stored) return null;
  const parts = String(stored).split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw failure('stored credential is not in a format this server can read');
  }
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key(), Buffer.from(parts[1], 'base64'));
    decipher.setAAD(aad(context));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3], 'base64')),
      decipher.final()
    ]).toString('utf8');
  } catch (err) {
    if (err.code === 'NO_CREDENTIALS_KEY') throw err;
    // Authentication failed. The honest readings are a changed
    // CREDENTIALS_KEY, a row moved between organisations, or tampering — and
    // none of them is "the key is probably fine, carry on".
    throw failure(
      'stored credential could not be decrypted. Either CREDENTIALS_KEY has ' +
      'changed since it was saved, or the credential belongs to a different ' +
      'organisation. Re-enter it to replace it.'
    );
  }
}

function failure(message) {
  const err = new Error(message);
  err.status = 424;
  err.code = 'CREDENTIAL_UNREADABLE';
  return err;
}

// What the settings screen is allowed to show: enough to tell a wrong paste
// from a right one, never enough to use. A short value is masked entirely
// rather than half-revealed, because four characters of a six-character
// secret is most of a secret.
function hint(plaintext) {
  const value = String(plaintext || '').trim();
  if (!value) return null;
  if (value.length < 12) return '•'.repeat(Math.max(value.length, 4));
  // Paystack and Monnify both use a readable prefix (sk_live_, MK_PROD_);
  // keeping it is how an operator spots live keys saved into a test slot.
  const prefix = /^[A-Za-z]{2,3}[_-]/.test(value) ? value.slice(0, value.indexOf('_', 3) + 1 || 3) : '';
  return prefix + '•'.repeat(8) + value.slice(-4);
}

// A stable, non-reversible identifier for a secret. Lets two deployments or
// two environments be compared ("this is the same key you already had")
// without either of them holding the other's secret.
function fingerprint(plaintext) {
  const value = String(plaintext || '').trim();
  if (!value) return null;
  return crypto.createHash('sha256').update('profitna.fingerprint.' + value).digest('hex').slice(0, 16);
}

function warnings() {
  if (configured()) return [];
  return [
    'CREDENTIALS_KEY is not set, so tenants cannot save their own payment ' +
    'credentials and invoice payment links are unavailable. ' + REQUIREMENT
  ];
}

module.exports = { configured, encrypt, decrypt, hint, fingerprint, warnings, REQUIREMENT, ALGORITHM };
