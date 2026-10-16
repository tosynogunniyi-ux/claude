// Do the backups actually leave the machine?
//   npm run test:offsite
//
// Two halves, and the first is the one that matters.
//
// The AWS signature is the whole of the authentication. Testing it against my
// own understanding of it would prove only that I am consistent, so the
// vectors below were produced by **botocore — AWS's own signer** — for fixed
// inputs, and this suite asserts byte equality against them. If the signing
// here ever drifts, these fail without needing a bucket, a network or a key.
//
// The second half runs a real upload against a stub that speaks S3 back,
// so the request that goes over the wire is the one a provider would see.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const offsite = require('../src/offsite');

let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
};

// --------------------------------------------------------- the AWS vectors
//
// Produced by botocore 1.43.111: SigV4Auth(creds, 's3', region) over the same
// canonical request, with the timestamp pinned so the vector does not expire.
// Nothing in this block was written by hand.

const AWS = {
  accessKey: 'AKIAIOSFODNN7EXAMPLE',
  secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  cases: [
    {
      label: 'a Backblaze PUT, bucket in the path',
      method: 'PUT',
      host: 's3.us-west-004.backblazeb2.com',
      canonicalPath: '/profitna-backups/nightly/profitna-2026-10-09T02-00-00Z.dump',
      region: 'us-west-004',
      amzDate: '20261009T123456Z',
      payloadHash: 'e155dd64794e03980e5d0989057c3188dfb598a13cc44edc58da28208a43cd2a',
      contentType: 'application/octet-stream',
      signature: 'c2f7e0a87e2b808e5930869bd619a7b7cfe6c5b326e7f91226e785918fb1d2dc'
    },
    {
      label: 'an AWS HEAD with no body, bucket in the hostname',
      method: 'HEAD',
      host: 'profitna-backups.s3.eu-west-1.amazonaws.com',
      canonicalPath: '/profitna-2026-10-09T02-00-00Z.dump',
      region: 'eu-west-1',
      amzDate: '20261009T123456Z',
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      contentType: null,
      signature: 'da5daae7bb677fbc23ef86aac899f2bdc46f0ac835574cc827b618abc3237e74'
    }
  ]
};

const signAws = (c) => offsite.signature({
  method: c.method,
  host: c.host,
  canonicalPath: c.canonicalPath,
  payloadHash: c.payloadHash,
  amzDate: c.amzDate,
  region: c.region,
  accessKey: AWS.accessKey,
  secretKey: AWS.secretKey,
  extraHeaders: c.contentType ? { 'content-type': c.contentType } : {}
});

// ------------------------------------------------------------ the stub store

// Answers like S3: remembers what was PUT, and reports it on HEAD. Enough to
// prove the request is well formed and that a short write is caught.
function store(behaviour) {
  const objects = new Map();
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method, url: req.url, headers: req.headers, bytes: body.length });

      if (behaviour && behaviour.refuse) {
        res.writeHead(behaviour.refuse, { 'content-type': 'application/xml' });
        return res.end('<Error><Code>AccessDenied</Code></Error>');
      }
      if (req.method === 'PUT') {
        // A store that accepts the PUT and keeps less than it was given is
        // exactly the failure the HEAD afterwards exists to catch.
        const kept = behaviour && behaviour.truncateTo !== undefined
          ? body.slice(0, behaviour.truncateTo) : body;
        objects.set(req.url, kept);
        res.writeHead(200, { etag: '"' + crypto.createHash('md5').update(kept).digest('hex') + '"' });
        return res.end();
      }
      if (req.method === 'HEAD') {
        const held = objects.get(req.url);
        if (!held) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'content-length': String(held.length) });
        return res.end();
      }
      res.writeHead(405);
      res.end();
    });
  });
  return { server, objects, seen };
}

const listen = (s) => new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve(s.address().port)));
const close = (s) => new Promise((resolve) => s.close(resolve));

function configure(port, extra) {
  // From clean each time: a limit left behind by one case quietly decides the
  // next one, which is how a suite ends up testing something else.
  unconfigure();
  Object.assign(process.env, {
    BACKUP_S3_ENDPOINT: 'http://127.0.0.1:' + port,
    BACKUP_S3_BUCKET: 'profitna-backups',
    BACKUP_S3_REGION: 'us-west-004',
    BACKUP_S3_ACCESS_KEY_ID: AWS.accessKey,
    BACKUP_S3_SECRET_ACCESS_KEY: AWS.secretKey,
    BACKUP_S3_PREFIX: 'nightly',
    BACKUP_S3_PATH_STYLE: 'on'
  }, extra || {});
}

function unconfigure() {
  for (const k of Object.keys(process.env)) if (k.startsWith('BACKUP_S3_')) delete process.env[k];
}

(async () => {
  console.log('\nthe signature, against vectors produced by AWS\'s own signer');
  for (const c of AWS.cases) {
    const got = signAws(c);
    check(c.label, got.signature === c.signature, got.signature);
  }
  check('the Authorization header is assembled the way AWS reads it',
    /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20261009\/us-west-004\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/
      .test(signAws(AWS.cases[0]).authorization),
    signAws(AWS.cases[0]).authorization);
  check('a different secret gives a different signature',
    offsite.signature(Object.assign({}, {
      method: 'PUT', host: AWS.cases[0].host, canonicalPath: AWS.cases[0].canonicalPath,
      payloadHash: AWS.cases[0].payloadHash, amzDate: AWS.cases[0].amzDate,
      region: AWS.cases[0].region, accessKey: AWS.accessKey, secretKey: 'something else',
      extraHeaders: { 'content-type': 'application/octet-stream' }
    })).signature !== AWS.cases[0].signature);
  check('and so does a different payload',
    offsite.signature(Object.assign({}, {
      method: 'PUT', host: AWS.cases[0].host, canonicalPath: AWS.cases[0].canonicalPath,
      payloadHash: crypto.createHash('sha256').update('tampered').digest('hex'),
      amzDate: AWS.cases[0].amzDate, region: AWS.cases[0].region,
      accessKey: AWS.accessKey, secretKey: AWS.secretKey,
      extraHeaders: { 'content-type': 'application/octet-stream' }
    })).signature !== AWS.cases[0].signature,
    'the body is signed, so a dump cannot be swapped in flight');

  console.log('\nwhere the bucket goes');
  unconfigure();
  process.env.BACKUP_S3_BUCKET = 'profitna-backups';
  process.env.BACKUP_S3_ACCESS_KEY_ID = 'x';
  process.env.BACKUP_S3_SECRET_ACCESS_KEY = 'y';
  process.env.BACKUP_S3_REGION = 'eu-west-1';
  check('AWS gets it in the hostname', offsite.pathStyle() === false, offsite.endpoint());
  check('and the endpoint is derived from the region',
    offsite.endpoint() === 'https://s3.eu-west-1.amazonaws.com', offsite.endpoint());
  check('the target reads as AWS expects',
    offsite.target('a/b.dump').url === 'https://profitna-backups.s3.eu-west-1.amazonaws.com/a/b.dump',
    offsite.target('a/b.dump').url);

  process.env.BACKUP_S3_ENDPOINT = 'https://s3.us-west-004.backblazeb2.com';
  check('everyone else gets it in the path', offsite.pathStyle() === true);
  check('and the bucket leads the path',
    offsite.target('a/b.dump').url === 'https://s3.us-west-004.backblazeb2.com/profitna-backups/a/b.dump',
    offsite.target('a/b.dump').url);

  process.env.BACKUP_S3_ENDPOINT = 's3.wasabisys.com';
  check('an endpoint pasted without https:// still works',
    offsite.endpoint() === 'https://s3.wasabisys.com', offsite.endpoint());
  process.env.BACKUP_S3_SECRET_ACCESS_KEY = '"quoted-secret"';
  check('a secret pasted with quotes around it is cleaned, like the payment keys',
    offsite.describe().configured === true);

  console.log('\nwhat counts as configured');
  unconfigure();
  check('nothing set is off, quietly', offsite.configured() === false);
  check('and says so rather than warning', offsite.warnings().length === 0);
  process.env.BACKUP_S3_BUCKET = 'half-done';
  check('half-set is off', offsite.configured() === false);
  check('but says so loudly, naming what is missing',
    offsite.warnings().length === 1 && /ACCESS_KEY_ID/.test(offsite.warnings()[0]),
    JSON.stringify(offsite.warnings()));
  check('a skipped copy is not reported as a success',
    (await offsite.put('/nowhere', 'x.dump')).ok === false);

  console.log('\na real upload, against a store that speaks S3 back');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profitna-offsite-'));
  const file = path.join(dir, 'profitna-2026-10-09T02-00-00Z.dump');
  const payload = crypto.randomBytes(40000);
  fs.writeFileSync(file, payload);

  const good = store();
  const port = await listen(good.server);
  configure(port);

  const sent = await offsite.put(file, 'profitna-2026-10-09T02-00-00Z.dump');
  check('it reports success', sent.ok === true, sent.error);
  check('under the prefix it was given',
    sent.key === 'nightly/profitna-2026-10-09T02-00-00Z.dump', sent.key);
  check('and the store holds every byte',
    good.objects.get('/profitna-backups/nightly/profitna-2026-10-09T02-00-00Z.dump').equals(payload));

  const put = good.seen.find((r) => r.method === 'PUT');
  check('the request is signed', /^AWS4-HMAC-SHA256 Credential=/.test(put.headers.authorization || ''));
  check('with the hash of the body, not a shortcut',
    put.headers['x-amz-content-sha256'] === crypto.createHash('sha256').update(payload).digest('hex'),
    put.headers['x-amz-content-sha256']);
  check('and the secret never appears in it',
    !JSON.stringify(put.headers).includes(AWS.secretKey));
  check('the upload is confirmed by asking the store, not by assuming',
    good.seen.some((r) => r.method === 'HEAD'));

  console.log('\nwhen the store misbehaves');
  const short = store({ truncateTo: 10 });
  const shortPort = await listen(short.server);
  configure(shortPort);
  const truncated = await offsite.put(file, 'short.dump');
  check('a store that keeps less than it was sent is caught',
    truncated.ok === false && /40000 bytes but the store holds 10/.test(truncated.error),
    truncated.error);

  const denied = store({ refuse: 403 });
  const deniedPort = await listen(denied.server);
  configure(deniedPort);
  const refused = await offsite.put(file, 'denied.dump');
  check('a refusal is reported with its status', refused.ok === false && refused.status === 403, refused.error);
  check('and with the likeliest cause', /key, the secret or the region/.test(refused.fix || ''), refused.fix);

  configure(deniedPort, { BACKUP_S3_MAX_BYTES: '1000' });
  const tooBig = await offsite.put(file, 'big.dump');
  check('a dump too large for one request is refused before it is sent',
    tooBig.ok === false && /single-request limit/.test(tooBig.error), tooBig.error);
  check('and says what to do instead', /multipart|rsync/.test(tooBig.fix || ''), tooBig.fix);

  configure(port);
  process.env.BACKUP_S3_ENDPOINT = 'http://127.0.0.1:1';   // nothing listening there
  const unreachable = await offsite.put(file, 'gone.dump');
  check('an unreachable store fails without throwing',
    unreachable.ok === false && /could not reach the store/.test(unreachable.error), unreachable.error);

  console.log('\nwhat the owner\'s console is told');
  configure(port);
  const described = offsite.describe();
  check('where copies go', described.bucket === 'profitna-backups' && described.endpoint === '127.0.0.1:' + port,
    JSON.stringify(described));
  check('and enough of the key to spot a bad paste',
    /^AKIA…LE \(20 chars\)$/.test(described.keyId), described.keyId);
  check('but never the secret', !JSON.stringify(described).includes(AWS.secretKey));

  await close(good.server);
  await close(short.server);
  await close(denied.server);
  fs.rmSync(dir, { recursive: true, force: true });
  unconfigure();

  console.log('');
  if (failures.length) {
    console.log(passed + ' passed, ' + failures.length + ' failed');
    process.exit(1);
  }
  console.log(passed + ' passed, 0 failed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
