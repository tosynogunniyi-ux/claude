const crypto = require('crypto');

// RFC 4648 base32 + RFC 6238 TOTP, in the ~60 lines it actually takes. A
// dependency for this would be a third party with a permanent seat in the
// second factor of the platform owner's login, which is not a trade worth
// making.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// 160 bits, which is what authenticator apps expect and what RFC 4226
// recommends as the minimum.
function randomSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretBuf, counter) {
  const block = Buffer.alloc(8);
  block.writeUInt32BE(Math.floor(counter / 4294967296), 0);
  block.writeUInt32BE(counter >>> 0, 4);

  const digest = crypto.createHmac('sha1', secretBuf).update(block).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

function generate(secretB32, at = Date.now()) {
  return hotp(base32Decode(secretB32), Math.floor(at / 1000 / STEP_SECONDS));
}

// One step either side, so a clock a few seconds out does not lock the owner
// out of their own platform. Compared in constant time: the comparison itself
// should not tell an attacker how much of a guess was right.
function verify(secretB32, token, window = 1) {
  const clean = String(token || '').replace(/\D/g, '');
  if (clean.length !== DIGITS || !secretB32) return false;

  const secret = base32Decode(secretB32);
  const step = Math.floor(Date.now() / 1000 / STEP_SECONDS);
  let matched = false;
  for (let i = -window; i <= window; i++) {
    const candidate = Buffer.from(hotp(secret, step + i));
    const given = Buffer.from(clean);
    if (candidate.length === given.length && crypto.timingSafeEqual(candidate, given)) {
      matched = true;
    }
  }
  return matched;
}

// What an authenticator app scans or accepts pasted. The label carries the
// issuer twice by convention, so the entry reads "Profitna (owner@…)".
function otpauthUrl(secretB32, email, issuer = 'Profitna Control Center') {
  const label = encodeURIComponent(issuer) + ':' + encodeURIComponent(email);
  const params = new URLSearchParams({
    secret: secretB32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS)
  });
  return 'otpauth://totp/' + label + '?' + params.toString();
}

module.exports = { randomSecret, generate, verify, otpauthUrl, base32Encode, base32Decode };
