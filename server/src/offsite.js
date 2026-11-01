// Getting the backups off the machine.
//
// The nightly dump covers a bad migration or a wrong DELETE. It does not
// cover losing the server, because it is on the server. This copies each
// verified dump to object storage somewhere else, as soon as it is taken.
//
// Anything that speaks the S3 API will do — Backblaze B2, Cloudflare R2,
// Wasabi, DigitalOcean Spaces, MinIO, AWS itself. That is deliberate: the
// point of a second copy is that it does not share a fate with the first, so
// it should not have to share a supplier with it either.
//
// No SDK. The AWS signature is sixty lines of HMAC and this process already
// has crypto and fetch, so the alternative was a dependency tree larger than
// the rest of the server for one PUT. `signature()` is exported and checked
// against a vector produced by AWS's own signer — see test/offsite.js.

const fs = require('fs');
const crypto = require('crypto');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// Same cleaning as the payment keys get: a value pasted with quotes, brackets
// or a stray newline around it is the commonest way a correct secret fails.
function conf(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return '';
  let v = String(raw).trim();
  const pairs = [['"', '"'], ["'", "'"], ['<', '>'], ['(', ')'], ['[', ']'], ['{', '}']];
  for (const [open, close] of pairs) {
    while (v.length > 2 && v.startsWith(open) && v.endsWith(close)) v = v.slice(1, -1).trim();
  }
  return v;
}

const bucket = () => conf('BACKUP_S3_BUCKET');
const region = () => conf('BACKUP_S3_REGION') || 'us-east-1';
const accessKey = () => conf('BACKUP_S3_ACCESS_KEY_ID');
const secretKey = () => conf('BACKUP_S3_SECRET_ACCESS_KEY');
const timeoutMs = () => Number(process.env.BACKUP_S3_TIMEOUT_MS || 120000);
// Anything larger than this is not uploaded in one piece, and this code does
// not do multipart. Said out loud rather than discovered at 2am.
const maxBytes = () => Number(process.env.BACKUP_S3_MAX_BYTES || 200 * 1024 * 1024);

function prefix() {
  const p = conf('BACKUP_S3_PREFIX');
  if (!p) return '';
  return p.replace(/^\/+/, '').replace(/\/*$/, '/');
}

// AWS needs no endpoint; everyone else gives you one.
function endpoint() {
  const given = conf('BACKUP_S3_ENDPOINT');
  if (given) return given.replace(/\/+$/, '').replace(/^(?!https?:)/, 'https://');
  return 'https://s3.' + region() + '.amazonaws.com';
}

// Where the bucket name goes. AWS wants it in the hostname; most of the
// others want it in the path, and MinIO only works that way.
function pathStyle() {
  const set = String(conf('BACKUP_S3_PATH_STYLE') || '').toLowerCase();
  if (set === 'on' || set === 'true') return true;
  if (set === 'off' || set === 'false') return false;
  return !/(^|\.)amazonaws\.com$/.test(new URL(endpoint()).hostname);
}

function configured() {
  return Boolean(bucket() && accessKey() && secretKey());
}

// Each path segment is encoded, the slashes between them are not.
const encodePath = (p) => p.split('/').map((s) => encodeURIComponent(s)).join('/');

function target(key) {
  const base = new URL(endpoint());
  const host = pathStyle() ? base.host : bucket() + '.' + base.host;
  const canonical = (pathStyle() ? '/' + bucket() : '') + '/' + encodePath(key);
  return { host, canonical, url: base.protocol + '//' + host + canonical };
}

// AWS Signature Version 4, the single-request form. Exported so a test can
// hold it against a signature AWS produced for the same inputs.
function signature(opts) {
  const { method, host, canonicalPath, payloadHash, amzDate, service } = opts;
  const scopeDate = amzDate.slice(0, 8);
  const scope = [scopeDate, opts.region, service || 's3', 'aws4_request'].join('/');

  const headers = Object.assign({
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate
  }, opts.extraHeaders || {});

  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = names
    .map((n) => n + ':' + String(headers[Object.keys(headers).find((k) => k.toLowerCase() === n)]).trim() + '\n')
    .join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [
    method,
    canonicalPath,
    opts.query || '',
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256(canonicalRequest)
  ].join('\n');

  const kDate = hmac('AWS4' + opts.secretKey, scopeDate);
  const kRegion = hmac(kDate, opts.region);
  const kService = hmac(kRegion, service || 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signed = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    authorization: 'AWS4-HMAC-SHA256 Credential=' + opts.accessKey + '/' + scope +
      ', SignedHeaders=' + signedHeaders + ', Signature=' + signed,
    signature: signed,
    signedHeaders,
    canonicalRequest,
    stringToSign,
    headers
  };
}

function amzNow(at) {
  return (at || new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

async function request(method, key, body, contentType) {
  const { host, canonical, url } = target(key);
  const payloadHash = sha256(body === undefined || body === null ? '' : body);
  const amzDate = amzNow();

  const extra = {};
  if (contentType) extra['content-type'] = contentType;

  const signed = signature({
    method,
    host,
    canonicalPath: canonical,
    payloadHash,
    amzDate,
    region: region(),
    accessKey: accessKey(),
    secretKey: secretKey(),
    extraHeaders: extra
  });

  const headers = Object.assign({}, signed.headers, { authorization: signed.authorization });

  const res = await fetch(url, {
    method,
    headers,
    body: method === 'PUT' ? body : undefined,
    signal: AbortSignal.timeout(timeoutMs())
  });

  return res;
}

// Copies one finished dump up, then asks the far end how big it thinks the
// object is. A PUT that answers 200 and stored nothing is a thing that
// happens; "I uploaded it" is not the same claim as "it is there".
async function put(localPath, name) {
  if (!configured()) return { ok: false, skipped: true, error: 'off-site copies are not configured' };

  let body;
  try {
    const st = fs.statSync(localPath);
    if (st.size > maxBytes()) {
      return {
        ok: false,
        error: 'the dump is ' + Math.round(st.size / 1048576) + 'MB, over the ' +
          Math.round(maxBytes() / 1048576) + 'MB single-request limit',
        fix: 'Raise BACKUP_S3_MAX_BYTES only if your provider accepts a PUT that large; ' +
          'otherwise this needs multipart upload, which this code does not do. Copying ' +
          'the directory off with a scheduled rsync is the simpler answer at that size.'
      };
    }
    body = fs.readFileSync(localPath);
  } catch (err) {
    return { ok: false, error: 'could not read the dump to send it: ' + err.message };
  }

  const key = prefix() + name;
  const startedAt = Date.now();

  let res;
  try {
    res = await request('PUT', key, body, 'application/octet-stream');
  } catch (err) {
    // One retry. The commonest failure by far is a single dropped connection,
    // and the second copy is worth one more attempt before it is given up on.
    try {
      res = await request('PUT', key, body, 'application/octet-stream');
    } catch (again) {
      return { ok: false, key, error: 'could not reach the store: ' + again.message };
    }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return {
      ok: false,
      key,
      status: res.status,
      error: 'the store refused it (' + res.status + ')' + (text ? ': ' + text.slice(0, 300) : ''),
      fix: res.status === 403
        ? 'Usually the key, the secret or the region. Some providers need the region ' +
          'that appears in their endpoint rather than us-east-1.'
        : res.status === 404
          ? 'The bucket was not found at that endpoint. Check BACKUP_S3_BUCKET, and ' +
            'whether this provider wants the bucket in the path (BACKUP_S3_PATH_STYLE=on).'
          : undefined
    };
  }

  const check = await verify(key, body.length);
  if (!check.ok) return Object.assign({ key, sentBytes: body.length }, check);

  return {
    ok: true,
    key,
    bytes: body.length,
    seconds: Math.round((Date.now() - startedAt) / 1000),
    etag: res.headers.get('etag') || null
  };
}

async function verify(key, expectedBytes) {
  let res;
  try {
    res = await request('HEAD', key);
  } catch (err) {
    return { ok: false, error: 'uploaded, but could not confirm it is there: ' + err.message };
  }
  if (!res.ok) return { ok: false, error: 'uploaded, but the store does not list it (' + res.status + ')' };
  const got = Number(res.headers.get('content-length'));
  if (Number.isFinite(got) && expectedBytes && got !== expectedBytes) {
    return { ok: false, error: 'uploaded ' + expectedBytes + ' bytes but the store holds ' + got };
  }
  return { ok: true, bytes: got };
}

// For the owner's console. Says where copies go without saying how to get in.
function describe() {
  if (!configured()) return { configured: false };
  const k = accessKey();
  return {
    configured: true,
    endpoint: new URL(endpoint()).host,
    bucket: bucket(),
    region: region(),
    prefix: prefix() || '(bucket root)',
    pathStyle: pathStyle(),
    keyId: k.length > 8 ? k.slice(0, 4) + '…' + k.slice(-2) + ' (' + k.length + ' chars)' : '(short)'
  };
}

// Said at boot, where whoever just set these is watching.
function warnings() {
  const out = [];
  const some = bucket() || accessKey() || secretKey() || conf('BACKUP_S3_ENDPOINT');
  if (some && !configured()) {
    out.push('off-site backup copies are half-configured and will not run: ' +
      ['BACKUP_S3_BUCKET', 'BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY']
        .filter((n) => !conf(n)).join(', ') + ' missing.');
  }
  if (configured()) {
    try { new URL(endpoint()); } catch (e) {
      out.push('BACKUP_S3_ENDPOINT is not a URL, so off-site copies will fail: ' + endpoint());
    }
  }
  return out;
}

module.exports = { configured, put, verify, describe, warnings, signature, target, prefix, endpoint, pathStyle };
