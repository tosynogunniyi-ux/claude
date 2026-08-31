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

module.exports = { configured, verify };
