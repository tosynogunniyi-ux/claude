// Ask Profitna — the question box on the AI screen.
//
// Read-only, so every role including viewer may use it: it answers from the
// same figures the screens already show that person.
//
// Every failure here answers in the 4xx range. That is not cosmetic: a
// reverse proxy replaces a 5xx body with its own HTML error page, so a
// carefully worded 502 reaches the browser as "Unexpected token '<'". The
// cost of learning that once was five rounds of debugging on the payment
// path; it is not being paid again here.

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { one } = require('../db');
const { requireOrg, audit } = require('../auth');
const ask = require('../ai/ask');

const router = express.Router({ mergeParams: true });

// Questions cost money to answer, so there is a ceiling per set of books per
// day. Counted from the audit log rather than from memory, so a container
// restart does not reset it.
const dailyLimit = () => Number(process.env.ASK_DAILY_LIMIT || 200);

async function askedToday(orgId) {
  const row = await one(
    `SELECT COUNT(*)::int AS n
       FROM audit_log
      WHERE organization_id = $1 AND action = 'ai.asked'
        AND created_at >= CURRENT_DATE`,
    [orgId]
  );
  return row ? row.n : 0;
}

// One question at a time per set of books. A double-clicked Ask button would
// otherwise run the whole thing twice and bill for both.
const inFlight = new Set();

router.get('/ai/status', requireOrg(), async (req, res, next) => {
  try {
    const configured = ask.configured();
    res.json({
      configured,
      // The name is worth showing: "connected" means nothing if nobody can
      // tell which model answered.
      model: configured ? ask.model() : null,
      limit: dailyLimit(),
      askedToday: configured ? await askedToday(req.orgId) : 0
    });
  } catch (err) {
    next(err);
  }
});

router.post('/ai/ask', requireOrg(), async (req, res, next) => {
  const orgId = req.orgId;
  try {
    const question = String((req.body && req.body.question) || '').trim();
    if (!question) return res.status(400).json({ error: 'Type a question first.' });

    if (!ask.configured()) {
      return res.status(424).json({
        configured: false,
        error: 'No model is connected to this deployment, so Profitna is answering ' +
          'from the figures on screen. Set ANTHROPIC_API_KEY to turn it on.'
      });
    }

    if (inFlight.has(orgId)) {
      return res.status(429).json({ error: 'Still working on the last question. One at a time.' });
    }

    const used = await askedToday(orgId);
    if (used >= dailyLimit()) {
      return res.status(429).json({
        error: 'That is ' + used + ' questions today, which is the daily limit on this ' +
          'workspace. It resets at midnight.'
      });
    }

    inFlight.add(orgId);
    let out;
    try {
      out = await ask.ask({
        orgId,
        question,
        history: req.body && req.body.history,
        book: req.bookType
      });
    } finally {
      inFlight.delete(orgId);
    }

    // The question itself is not recorded. The count is what the limit needs,
    // and nobody operating this server has a reason to read what a customer
    // asked about their own books.
    await audit(orgId, req.user.id, 'ai.asked', 'organization', orgId, {
      chars: question.length,
      rounds: out.rounds,
      lookups: out.used,
      inputTokens: out.usage.input,
      outputTokens: out.usage.output,
      cachedTokens: out.usage.cacheRead
    });

    res.json({
      answer: out.answer,
      // Present only when a lookup ran. These rows came out of the database,
      // not out of the model.
      table: out.table || null,
      lookups: out.used,
      model: out.model,
      truncated: out.truncated,
      askedToday: used + 1,
      limit: dailyLimit()
    });
  } catch (err) {
    inFlight.delete(orgId);

    // Anything the processor says about the key, the quota or the connection
    // is said back in the customer's own words, in a status that survives the
    // proxy.
    if (err instanceof Anthropic.AuthenticationError) {
      return res.status(424).json({
        error: 'The key this server holds was refused. Profitna AI is off until it is replaced.'
      });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({
        error: 'Profitna AI is at its rate limit for the moment. Try again in a minute.'
      });
    }
    if (err instanceof Anthropic.APIConnectionTimeoutError) {
      return res.status(424).json({
        error: 'That question took too long to answer. A shorter one usually comes back.'
      });
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return res.status(424).json({
        error: 'Could not reach the model from this server. The books are unaffected.'
      });
    }
    if (err instanceof Anthropic.APIError) {
      return res.status(424).json({ error: 'The model refused that request: ' + err.message });
    }
    if (err && err.expose) return res.status(424).json({ error: err.message });
    next(err);
  }
});

module.exports = { router, askedToday };
