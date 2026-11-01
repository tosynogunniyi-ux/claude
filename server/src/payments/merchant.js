// A tenant's own merchant account: storing it, proving it, and handing the
// credentials to whichever provider needs them.
//
// The contract this module keeps, in order of what it would cost to break:
//
//   A secret key is written encrypted and is never returned. There is no
//   function here that gives a secret to a caller outside this file's own
//   provider calls — `describe()` returns a mask, and the routes have nothing
//   else to reach for. A browser cannot be sent what the server will not
//   produce.
//
//   Credentials are resolved by organisation id, never by anything a request
//   body can say. `credentials(orgId)` is the only way in, and the webhook
//   finds its organisation from a token in its own URL rather than from a
//   field in the payload it has not yet authenticated.
//
//   Nothing is active until the gateway itself has accepted it. Saving sets
//   `active = false`; only a successful ping flips it. An invoice does not
//   offer a Pay button on the strength of somebody having typed something
//   into a form.

const crypto = require('crypto');
const { pool, one, many } = require('../db');
const vault = require('../crypto');
const providers = require('./providers');

// Monnify needs a bearer token per call, bought with the tenant's key and
// secret. One per organisation, held for a little less than its stated life,
// because the subscription path learned that buying one per request turns a
// batch of charges into a batch of logins. Keyed by merchant row id, so
// changing a credential cannot keep using the old token.
const tokens = new Map();
const TOKEN_SKEW_MS = 60 * 1000;

async function tokenFor(account, creds) {
  const provider = providers.get(account.provider);
  if (typeof provider.token !== 'function') return undefined;
  const held = tokens.get(account.id);
  if (held && held.fingerprint === account.secret_fingerprint && held.expiresAt > Date.now()) {
    return held.token;
  }
  const fresh = await provider.token(creds);
  tokens.set(account.id, {
    token: fresh.token,
    fingerprint: account.secret_fingerprint,
    expiresAt: Date.now() + fresh.expiresIn * 1000 - TOKEN_SKEW_MS
  });
  return fresh.token;
}

function forgetToken(accountId) { tokens.delete(accountId); }

// ------------------------------------------------------------------ reading

// Every merchant account on one organisation, as the settings screen sees
// them: no ciphertext, no secret, no webhook secret.
async function describe(orgId, { baseUrl } = {}) {
  const rows = await many(
    `SELECT * FROM merchant_accounts WHERE organization_id = $1 ORDER BY provider`, [orgId]
  );
  const byProvider = new Map(rows.map((r) => [r.provider, r]));

  return {
    // Said plainly, because without it nothing on this screen can be saved
    // and the reason is a missing server variable the tenant cannot set.
    storageReady: vault.configured(),
    storageRequirement: vault.configured() ? null : vault.REQUIREMENT,
    providers: providers.describe().map((p) => {
      const row = byProvider.get(p.name);
      return Object.assign({}, p, {
        configured: Boolean(row),
        environment: row ? row.environment : 'test',
        publicKey: row ? row.public_key : null,
        contractCode: row ? row.contract_code : null,
        secretHint: row ? row.secret_hint : null,
        hasSecret: Boolean(row && row.secret_cipher),
        verifiedAt: row ? row.verified_at : null,
        verifiedMode: row ? row.verified_mode : null,
        lastError: row ? row.last_error : null,
        active: Boolean(row && row.active),
        // The URL to paste into the provider's dashboard. One per tenant per
        // provider, so a webhook arriving on it can only be about this
        // organisation — guessing another tenant's id gets you nowhere
        // because the path segment is a 256-bit token, not an id.
        webhookUrl: row && baseUrl ? webhookUrl(baseUrl, row.webhook_token) : null,
        // What this provider can actually be used for right now, in one
        // sentence, rather than a flag the screen has to interpret.
        state: !vault.configured() ? 'storage-unavailable'
          : !row ? 'not-set-up'
            : !row.secret_cipher ? 'incomplete'
              : !row.verified_at ? 'unverified'
                : !row.active ? 'off'
                  : 'live'
      });
    })
  };
}

function webhookUrl(baseUrl, token) {
  return String(baseUrl).replace(/\/+$/, '') + '/api/pay/hook/' + token;
}

// The decrypted credentials for one organisation and provider. The only
// producer of a plaintext secret in the codebase, and it is not exported.
async function credentials(orgId, providerName) {
  const row = await one(
    'SELECT * FROM merchant_accounts WHERE organization_id = $1 AND provider = $2',
    [orgId, providerName]
  );
  if (!row) return null;
  return { account: row, creds: unlock(row) };
}

function unlock(row) {
  return {
    environment: row.environment,
    publicKey: row.public_key,
    contractCode: row.contract_code,
    secretKey: row.secret_cipher
      ? vault.decrypt(row.secret_cipher, { organizationId: row.organization_id, provider: row.provider })
      : null
  };
}

// Which provider an organisation collects with. Explicit choice is not
// offered: an organisation with one live account uses it, and one with two
// uses whichever was proved most recently, because that is the one somebody
// was last setting up.
async function activeAccount(orgId) {
  return one(
    `SELECT * FROM merchant_accounts
      WHERE organization_id = $1 AND active = true AND verified_at IS NOT NULL
        AND secret_cipher IS NOT NULL
      ORDER BY verified_at DESC LIMIT 1`,
    [orgId]
  );
}

// Can this organisation ask a customer to pay online at all, and if not, why
// not — in a sentence a business owner can act on.
async function collectionState(orgId) {
  if (!vault.configured()) {
    return {
      ready: false, reason: 'storage',
      // What a tenant is told, which is not what the operator is told. A
      // customer reading "the server is not configured" learns nothing they
      // can act on and something they should not have to think about; what
      // they need to know is that recording payments by hand still works and
      // the books are right either way. `requirement` carries the operator's
      // half, and nothing tenant-facing renders it.
      message: 'Online payment links are not switched on yet. Record payments here as they ' +
        'arrive — the invoice is settled and the books are right either way.',
      requirement: vault.REQUIREMENT
    };
  }
  const account = await activeAccount(orgId);
  if (account) {
    return {
      ready: true, provider: account.provider, environment: account.environment,
      message: 'Customers can pay invoices online through your ' +
        providers.get(account.provider).label + ' account' +
        (account.environment === 'live' ? '.' : ' (test mode — no real money moves).')
    };
  }
  const any = await one('SELECT provider, verified_at, secret_cipher FROM merchant_accounts WHERE organization_id = $1 LIMIT 1', [orgId]);
  return {
    ready: false,
    reason: any ? (any.verified_at ? 'inactive' : 'unverified') : 'none',
    message: !any
      ? 'Connect your own Paystack or Monnify account in Settings and customers can pay your ' +
        'invoices online. The money goes straight to you — Profitna never holds it.'
      : any.verified_at
        ? 'Your payment account is connected but switched off. Turn it on in Settings.'
        : 'Your payment credentials have been saved but not yet proved against the provider. ' +
          'Press Test in Settings.'
  };
}

// ------------------------------------------------------------------ writing

// Save or replace one provider's credentials. The secret is optional on an
// update: a settings screen that sends back the mask it was shown must not
// overwrite a working key with eight bullet characters.
async function save(orgId, providerName, input, { userId } = {}) {
  const provider = providers.get(providerName);
  if (!vault.configured()) {
    const err = new Error('Payment credentials cannot be stored yet. ' + vault.REQUIREMENT);
    err.status = 503;
    err.code = 'NO_CREDENTIALS_KEY';
    throw err;
  }

  const environment = input.environment === 'live' ? 'live' : 'test';
  // Pasting adds things — a trailing newline from a copied line, the quotes a
  // setup guide wrapped the value in. They travel into the Authorization
  // header and come back as "invalid credentials", with nothing on screen to
  // say the value merely has a space on the end.
  const clean = (v) => {
    if (v === undefined || v === null) return undefined;
    let s = String(v).trim();
    for (const [open, close] of [['"', '"'], ["'", "'"], ['<', '>'], ['(', ')'], ['[', ']']]) {
      while (s.length > 2 && s.startsWith(open) && s.endsWith(close)) s = s.slice(1, -1).trim();
    }
    return s;
  };

  const publicKey = clean(input.publicKey);
  const contractCode = clean(input.contractCode);
  const secret = clean(input.secretKey);
  // The mask coming back from the form is not a new secret. It contains
  // bullet characters because describe() put them there, and a real
  // credential never does — so any bullet at all means this is the
  // placeholder being round-tripped, not somebody typing a key. Matching only
  // an all-bullets string missed `sk_test_••••••••9f2c`, which is the exact
  // shape the screen shows, and quietly replaced a working key with it.
  const secretGiven = secret !== undefined && secret !== '' && !/[•*]/.test(secret);

  const existing = await one(
    'SELECT * FROM merchant_accounts WHERE organization_id = $1 AND provider = $2',
    [orgId, providerName]
  );

  if (!existing && !secretGiven) {
    const err = new Error('Enter the secret key from your ' + provider.label + ' dashboard.');
    err.status = 400;
    throw err;
  }

  for (const field of provider.fields) {
    if (!field.required || field.secret) continue;
    const value = field.key === 'publicKey' ? publicKey : field.key === 'contractCode' ? contractCode : undefined;
    const kept = value !== undefined ? value : existing ? existing[field.key === 'publicKey' ? 'public_key' : 'contract_code'] : null;
    if (!kept) {
      const err = new Error('Enter the ' + field.label.toLowerCase() + ' from your ' + provider.label + ' dashboard.');
      err.status = 400;
      throw err;
    }
  }

  const cipher = secretGiven
    ? vault.encrypt(secret, { organizationId: orgId, provider: providerName })
    : undefined;

  const row = await one(
    `INSERT INTO merchant_accounts
       (organization_id, provider, environment, public_key, contract_code,
        secret_cipher, secret_hint, secret_fingerprint, webhook_token, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false)
     ON CONFLICT (organization_id, provider) DO UPDATE SET
       environment = $3,
       public_key = COALESCE($4, merchant_accounts.public_key),
       contract_code = COALESCE($5, merchant_accounts.contract_code),
       secret_cipher = COALESCE($6, merchant_accounts.secret_cipher),
       secret_hint = COALESCE($7, merchant_accounts.secret_hint),
       secret_fingerprint = COALESCE($8, merchant_accounts.secret_fingerprint),
       -- Changing a credential un-proves it. The old verification was of the
       -- old key, and leaving the tick in place would let a Pay button go on
       -- an invoice backed by a credential nothing has ever accepted.
       verified_at = CASE WHEN $6 IS NULL AND merchant_accounts.environment = $3
                          THEN merchant_accounts.verified_at ELSE NULL END,
       verified_mode = CASE WHEN $6 IS NULL AND merchant_accounts.environment = $3
                           THEN merchant_accounts.verified_mode ELSE NULL END,
       active = CASE WHEN $6 IS NULL AND merchant_accounts.environment = $3
                     THEN merchant_accounts.active ELSE false END,
       last_error = NULL,
       updated_at = now()
     RETURNING *`,
    [orgId, providerName, environment, publicKey === undefined ? null : publicKey,
      contractCode === undefined ? null : contractCode,
      cipher === undefined ? null : cipher,
      secretGiven ? vault.hint(secret) : null,
      secretGiven ? vault.fingerprint(secret) : null,
      crypto.randomBytes(32).toString('hex')]
  );

  forgetToken(row.id);

  // Said before anything is charged: a live key in a test slot, two keys from
  // different modes, a missing contract code. Each is a mismatch that
  // otherwise shows up as a customer's failed payment.
  const notes = provider.review({
    environment,
    publicKey: publicKey !== undefined ? publicKey : row.public_key,
    contractCode: contractCode !== undefined ? contractCode : row.contract_code,
    secretKey: secretGiven ? secret : null
  });

  return { account: row, notes };
}

// Prove the credentials against the provider, and only then let them be used.
async function verifyAccount(orgId, providerName) {
  const found = await credentials(orgId, providerName);
  if (!found) {
    const err = new Error('No ' + providers.get(providerName).label + ' credentials are saved.');
    err.status = 404;
    throw err;
  }
  const { account, creds } = found;
  if (!creds.secretKey) {
    const err = new Error('Enter the secret key before testing.');
    err.status = 400;
    throw err;
  }

  forgetToken(account.id);
  try {
    const result = await providers.get(providerName).ping(creds);
    const row = await one(
      `UPDATE merchant_accounts
          SET verified_at = now(), verified_mode = $3, last_error = NULL, active = true, updated_at = now()
        WHERE organization_id = $1 AND provider = $2 RETURNING *`,
      [orgId, providerName, result.mode || null]
    );
    return {
      ok: true,
      mode: result.mode || null,
      // The gateway's own word on which mode the key is in, against what the
      // account says it is. A dashboard toggle states an intention; this
      // states a fact, and they are not always the same.
      mismatch: result.mode && result.mode !== account.environment
        ? 'These are ' + result.mode + ' credentials but the account is set to ' +
          account.environment + '. ' + (result.mode === 'live'
            ? 'Real cards will be charged.'
            : 'No real money will move until live credentials are saved.')
        : null,
      account: row
    };
  } catch (err) {
    await pool.query(
      `UPDATE merchant_accounts SET last_error = $3, verified_at = NULL, active = false, updated_at = now()
        WHERE organization_id = $1 AND provider = $2`,
      [orgId, providerName, String(err.message).slice(0, 500)]
    );
    throw err;
  }
}

// Switched off without being forgotten: the credentials stay, so turning it
// back on does not mean finding the dashboard again.
async function setActive(orgId, providerName, active) {
  const row = await one(
    `UPDATE merchant_accounts SET active = $3, updated_at = now()
      WHERE organization_id = $1 AND provider = $2
        AND ($3 = false OR (verified_at IS NOT NULL AND secret_cipher IS NOT NULL))
      RETURNING *`,
    [orgId, providerName, Boolean(active)]
  );
  if (!row) {
    const err = new Error(
      'Test the credentials first — Profitna will not offer a Pay button backed by a ' +
      'credential the provider has not accepted.'
    );
    err.status = 409;
    throw err;
  }
  return row;
}

async function remove(orgId, providerName) {
  const row = await one(
    'DELETE FROM merchant_accounts WHERE organization_id = $1 AND provider = $2 RETURNING id, provider',
    [orgId, providerName]
  );
  if (row) forgetToken(row.id);
  return row;
}

// ------------------------------------------------------- the webhook's way in
//
// A webhook arrives on a URL containing a 256-bit token and nothing else.
// That token is the only thing that decides which organisation it is about —
// never a field in the body, which has not been authenticated at the point
// the organisation has to be known.
async function byWebhookToken(token) {
  if (!/^[0-9a-f]{64}$/.test(String(token || ''))) return null;
  const row = await one('SELECT * FROM merchant_accounts WHERE webhook_token = $1', [token]);
  if (!row) return null;
  return { account: row, creds: unlock(row) };
}

// Everything a gateway call needs, resolved for one organisation: the
// provider, its credentials, and a bearer token where the provider uses one.
async function connection(orgId, providerName) {
  const name = providerName || (await activeAccount(orgId) || {}).provider;
  if (!name) {
    const err = new Error(
      'No payment account is connected. Connect your own Paystack or Monnify account in ' +
      'Settings — the money goes straight to you.'
    );
    err.status = 409;
    err.code = 'NO_MERCHANT_ACCOUNT';
    throw err;
  }
  const found = await credentials(orgId, name);
  if (!found || !found.creds.secretKey) {
    const err = new Error('The ' + providers.get(name).label + ' credentials are incomplete.');
    err.status = 409;
    throw err;
  }
  const provider = providers.get(name);
  return {
    provider,
    account: found.account,
    creds: found.creds,
    token: await tokenFor(found.account, found.creds)
  };
}

module.exports = {
  describe, save, verifyAccount, setActive, remove,
  credentials, connection, activeAccount, collectionState,
  byWebhookToken, webhookUrl, unlock, forgetToken
};
