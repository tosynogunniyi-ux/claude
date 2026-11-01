const express = require('express');
const { one, query } = require('../db');
const { requireOrg, audit } = require('../auth');
const team = require('../team');

const router = express.Router({ mergeParams: true });

function bad(res, message) {
  return res.status(400).json({ error: message });
}

// Everyone on the books can see who else is on them and what they may do —
// that is not privileged information, and hiding it only makes it harder to
// work out why a button is refusing. Changing any of it is admin-only.
router.get('/members', requireOrg(), async (req, res, next) => {
  try {
    const [people, invitations, seats] = await Promise.all([
      team.members(req.orgId),
      team.pendingInvitations(req.orgId),
      team.seatUse(req.orgId)
    ]);

    res.json({
      members: people.map((m) => Object.assign(m, { you: m.id === req.user.id })),
      invitations,
      seats,
      roles: team.ROLES.map((r) => ({ role: r, note: team.ROLE_NOTE[r] })),
      canManage: req.role === 'admin'
    });
  } catch (err) {
    next(err);
  }
});

router.post('/members', requireOrg('admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const role = team.normaliseRole(b.role, null);
    if (!role) return bad(res, 'Choose a role: admin, accountant or viewer.');

    const use = await team.seatUse(req.orgId);
    // A reissue to somebody already invited does not need a new seat, so the
    // seat check only applies to addresses that are not already pending.
    const reissuing = (await team.pendingInvitations(req.orgId)).some(
      (i) => i.email.toLowerCase() === String(b.email || '').trim().toLowerCase()
    );
    if (!reissuing && use.free < 1) return res.status(409).json({ error: team.seatMessage(use) });

    const result = await team.invite({
      organizationId: req.orgId,
      email: b.email,
      name: b.name,
      role,
      invitedBy: req.user.id
    });
    if (result.error) return bad(res, result.error);

    await audit(req.orgId, req.user.id, 'member.invited', 'invitation', result.invitation.id, {
      email: result.invitation.email,
      role
    });

    res.status(201).json({
      invitation: result.invitation,
      // Shown once. Nothing stores the raw token, so this is the only time the
      // link can be read; "New link" issues another and cancels this one.
      link: team.inviteLink(req, result.token),
      seats: await team.seatUse(req.orgId)
    });
  } catch (err) {
    next(err);
  }
});

// A fresh link for an invitation whose link was lost. The previous one stops
// working the moment this succeeds.
router.post('/members/invitations/:id/link', requireOrg('admin'), async (req, res, next) => {
  try {
    const existing = await one(
      `SELECT * FROM invitations
        WHERE id = $1 AND organization_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [req.params.id, req.orgId]
    );
    if (!existing) return res.status(404).json({ error: 'No invitation waiting for that person.' });

    const token = team.newToken();
    await query(
      `UPDATE invitations SET token_hash = $2, created_at = now(), expires_at = now() + interval '14 days'
        WHERE id = $1`,
      [existing.id, team.hashToken(token)]
    );
    await audit(req.orgId, req.user.id, 'member.invite_relinked', 'invitation', existing.id, {
      email: existing.email
    });

    res.json({ link: team.inviteLink(req, token) });
  } catch (err) {
    next(err);
  }
});

router.delete('/members/invitations/:id', requireOrg('admin'), async (req, res, next) => {
  try {
    const row = await one(
      `UPDATE invitations SET revoked_at = now()
        WHERE id = $1 AND organization_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL
    RETURNING id, email`,
      [req.params.id, req.orgId]
    );
    if (!row) return res.status(404).json({ error: 'No invitation waiting for that person.' });

    await audit(req.orgId, req.user.id, 'member.invite_cancelled', 'invitation', row.id, { email: row.email });
    res.json({ ok: true, seats: await team.seatUse(req.orgId) });
  } catch (err) {
    next(err);
  }
});

router.patch('/members/:userId', requireOrg('admin'), async (req, res, next) => {
  try {
    const role = team.normaliseRole((req.body || {}).role, null);
    if (!role) return bad(res, 'Choose a role: admin, accountant or viewer.');

    const membership = await one(
      `SELECT m.role, u.email FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1 AND m.user_id = $2`,
      [req.orgId, req.params.userId]
    );
    if (!membership) return res.status(404).json({ error: 'That person is not on these books.' });

    if (membership.role === 'admin' && role !== 'admin' && !(await team.otherAdmins(req.orgId, req.params.userId))) {
      return bad(res, 'These books need at least one admin. Make somebody else an admin first.');
    }

    await query('UPDATE memberships SET role = $3 WHERE organization_id = $1 AND user_id = $2', [
      req.orgId,
      req.params.userId,
      role
    ]);
    await audit(req.orgId, req.user.id, 'member.role_changed', 'user', req.params.userId, {
      email: membership.email,
      from: membership.role,
      to: role
    });

    res.json({ ok: true, role });
  } catch (err) {
    next(err);
  }
});

// Removing somebody frees their seat and ends their access at their next
// request; it does not touch anything they entered, which belongs to the books
// rather than to them.
router.delete('/members/:userId', requireOrg('admin'), async (req, res, next) => {
  try {
    const membership = await one(
      `SELECT m.role, u.email FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1 AND m.user_id = $2`,
      [req.orgId, req.params.userId]
    );
    if (!membership) return res.status(404).json({ error: 'That person is not on these books.' });

    if (membership.role === 'admin' && !(await team.otherAdmins(req.orgId, req.params.userId))) {
      return bad(res, 'These books need at least one admin. Make somebody else an admin first.');
    }

    await query('DELETE FROM memberships WHERE organization_id = $1 AND user_id = $2', [
      req.orgId,
      req.params.userId
    ]);
    await audit(req.orgId, req.user.id, 'member.removed', 'user', req.params.userId, {
      email: membership.email,
      role: membership.role
    });

    res.json({ ok: true, seats: await team.seatUse(req.orgId) });
  } catch (err) {
    next(err);
  }
});

module.exports = { router };
