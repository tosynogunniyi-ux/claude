const express = require('express');
const bcrypt = require('bcryptjs');
const { one, query, tx } = require('../db');
const { issue, recordLogin, SUSPENDED_MESSAGE } = require('../auth');
const { sessionFor } = require('./auth');
const google = require('../integrations/google');
const team = require('../team');

// The other end of an invitation link. Unauthenticated by necessity — the
// person following it has no account yet, or has one on entirely different
// books — so every route here is keyed on the token and nothing else.

const router = express.Router();

function bad(res, message) {
  return res.status(400).json({ error: message });
}

// What the acceptance screen renders itself from. Deliberately thin: the
// organisation's name and the role on offer, and nothing about its books or
// its other people, because anyone holding the link can read this.
router.get('/:token', async (req, res, next) => {
  try {
    const row = await team.findByToken(req.params.token);
    const state = team.invitationState(row);
    if (state === 'unknown') return res.status(404).json({ error: 'That invitation link is not valid.' });

    const existing = row.email
      ? await one('SELECT id, full_name, auth_provider FROM users WHERE lower(email) = lower($1)', [row.email])
      : null;

    res.json({
      invitation: {
        state,
        orgName: row.org_name,
        book: row.book_type,
        email: row.email,
        name: row.full_name,
        role: row.role,
        roleNote: team.ROLE_NOTE[row.role],
        invitedBy: row.invited_by_name,
        expiresAt: row.expires_at,
        // Tells the screen whether to ask for a new password or for the one
        // they already use on Profitna.
        hasAccount: Boolean(existing),
        suggestedName: (existing && existing.full_name) || row.full_name || ''
      }
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:token/accept', async (req, res, next) => {
  try {
    const row = await team.findByToken(req.params.token);
    const state = team.invitationState(row);

    if (state === 'unknown') return res.status(404).json({ error: 'That invitation link is not valid.' });
    if (state === 'accepted') return bad(res, 'That invitation has already been used. Sign in instead.');
    if (state === 'cancelled') return bad(res, 'That invitation was cancelled. Ask for a new link.');
    if (state === 'expired') return bad(res, 'That invitation has expired. Ask for a new link.');

    const b = req.body || {};
    const existing = await one(
      'SELECT id, email, password_hash, google_sub, status FROM users WHERE lower(email) = lower($1)',
      [row.email]
    );

    let userId;

    if (existing) {
      // An account already uses this address. It has to prove it is theirs
      // before it is joined to somebody else's books — an invitation is not
      // a way into an existing account.
      if (existing.status !== 'active') {
        return res.status(403).json({ error: SUSPENDED_MESSAGE[existing.status] || SUSPENDED_MESSAGE.suspended });
      }

      if (b.googleCredential) {
        const profile = await google.verify(b.googleCredential);
        if (!profile) return res.status(501).json({ error: 'Google sign-in is not configured on this server.' });
        if (profile.email.toLowerCase() !== String(row.email).toLowerCase()) {
          return bad(res, 'That Google account is not the one this invitation was sent to.');
        }
      } else {
        const ok = existing.password_hash && (await bcrypt.compare(String(b.password || ''), existing.password_hash));
        if (!ok) return res.status(401).json({ error: 'That password does not match the account for ' + row.email + '.' });
      }
      userId = existing.id;
    } else {
      let googleSub = null;
      let passwordHash = null;

      if (b.googleCredential) {
        const profile = await google.verify(b.googleCredential);
        if (!profile) return res.status(501).json({ error: 'Google sign-in is not configured on this server.' });
        if (profile.email.toLowerCase() !== String(row.email).toLowerCase()) {
          return bad(res, 'That Google account is not the one this invitation was sent to.');
        }
        googleSub = profile.sub;
      } else {
        const password = String(b.password || '');
        if (password.length < 8) return bad(res, 'Choose a password of at least 8 characters.');
        passwordHash = await bcrypt.hash(password, 12);
      }

      const name = String(b.name || row.full_name || '').trim();
      if (!name) return bad(res, 'Enter your full name.');

      userId = (await one(
        `INSERT INTO users (email, password_hash, full_name, auth_provider, google_sub)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [String(row.email).toLowerCase(), passwordHash, name, googleSub ? 'google' : 'password', googleSub]
      )).id;
    }

    // The seat is checked again here, not only when the invitation was sent:
    // seats may have been reduced, or filled by someone else, in between.
    const use = await team.seatUse(row.organization_id);
    const alreadyMember = await one(
      'SELECT 1 AS yes FROM memberships WHERE organization_id = $1 AND user_id = $2',
      [row.organization_id, userId]
    );
    if (!alreadyMember && use.members >= use.seats) {
      return res.status(409).json({
        error: 'There is no free seat on these books any more. Ask ' + row.org_name + ' to add one.'
      });
    }

    await tx(async (client) => {
      await client.query(
        `INSERT INTO memberships (user_id, organization_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, organization_id) DO UPDATE SET role = EXCLUDED.role`,
        [userId, row.organization_id, row.role]
      );
      await client.query(
        'UPDATE invitations SET accepted_at = now(), accepted_user_id = $2 WHERE id = $1',
        [row.id, userId]
      );
      await client.query(
        `INSERT INTO audit_log (organization_id, user_id, action, entity_type, entity_id, detail)
         VALUES ($1, $2, 'member.joined', 'user', $2, $3)`,
        [row.organization_id, userId, JSON.stringify({ role: row.role, email: row.email })]
      );
    });

    const user = await one('SELECT id, email FROM users WHERE id = $1', [userId]);
    await recordLogin(req, userId);
    issue(req, res, user);

    // Loaded through the same session shape as any other sign-in, pointed at
    // the books just joined — an accountant with their own Profitna account
    // should land on the client's books they just accepted, not their own.
    res.status(201).json({ session: await sessionFor(userId, row.organization_id) });
  } catch (err) {
    next(err);
  }
});

module.exports = { router };
