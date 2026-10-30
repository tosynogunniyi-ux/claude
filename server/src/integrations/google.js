// Google Identity Services. The browser runs the sign-in flow and hands us an
// ID token; this verifies it against Google before we trust any claim in it.

function configured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID);
}

async function verify(credential) {
  if (!configured() || !credential) return null;

  const res = await fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential)
  );
  if (!res.ok) return null;
  const claims = await res.json();

  // Audience check is what stops a token minted for another application from
  // being replayed here.
  if (claims.aud !== process.env.GOOGLE_CLIENT_ID) return null;
  if (claims.email_verified !== 'true' && claims.email_verified !== true) return null;
  if (Number(claims.exp) * 1000 < Date.now()) return null;

  return { sub: claims.sub, email: String(claims.email).toLowerCase(), name: claims.name || null };
}

// For /api/health. A client id is public — it is in the page source of every
// site that offers Google sign-in — but the useful fact is the shape, not the
// value: a project number pasted where a client id belongs is the commonest
// way this is set wrong, and it fails at Google with a message about the
// origin rather than about the id.
function describe() {
  const id = String(process.env.GOOGLE_CLIENT_ID || '').trim();
  if (!id) return { state: 'off', requirement: REQUIREMENT };
  if (!/\.apps\.googleusercontent\.com$/.test(id)) {
    return {
      state: 'misconfigured',
      requirement: 'GOOGLE_CLIENT_ID does not end in .apps.googleusercontent.com, so it is ' +
        'not an OAuth client id. A project number or a Firebase project id will not work here: ' +
        'take the Web client id from Google Cloud Console, APIs & Services, Credentials.'
    };
  }
  // The project number prefix only, which is already public and lets you tell
  // two projects apart without printing the whole credential.
  return { state: 'on', client: id.split('-')[0] + '-…apps.googleusercontent.com' };
}

const REQUIREMENT =
  'Set GOOGLE_CLIENT_ID to the Web OAuth client id from Google Cloud Console, APIs & Services, ' +
  'Credentials. Sign-in also needs the site\'s origins listed there, and the OAuth consent ' +
  'screen published — while it is in Testing, only listed test users can sign in.';

function warnings() {
  const d = describe();
  return d.state === 'misconfigured' ? [d.requirement] : [];
}

module.exports = { configured, verify, describe, warnings, REQUIREMENT };
