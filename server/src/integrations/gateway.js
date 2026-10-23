// Which payment processor is in use.
//
// The rest of the app asks this module, never a named provider, so adding or
// swapping one is a change here rather than a change in every route. Both
// providers expose the same four functions and verify() returns the same
// shape, with the reusable credential — Paystack's authorization code or
// Monnify's card token — in the same field.
//
// Selection is explicit when PAYMENT_PROVIDER says so, otherwise it is
// whichever one has its keys set. Monnify wins a tie because a deployment
// that has configured both has almost certainly just moved to it, and the
// old Paystack keys are left behind rather than removed.

const paystack = require('./paystack');
const monnify = require('./monnify');

const PROVIDERS = { paystack, monnify };

function active() {
  const named = String(process.env.PAYMENT_PROVIDER || '').trim().toLowerCase();
  if (named) {
    const chosen = PROVIDERS[named];
    // A named provider that is not set up is a misconfiguration worth seeing,
    // not something to quietly paper over by billing through the other one.
    if (!chosen) return null;
    return chosen.configured() ? chosen : null;
  }
  if (monnify.configured()) return monnify;
  if (paystack.configured()) return paystack;
  return null;
}

function configured() { return active() !== null; }

// The provider's own name, for the payments table and the audit log. 'none'
// never reaches the database: nothing writes a payment row without a charge,
// and a charge cannot happen while configured() is false.
function name() {
  const a = active();
  return a ? a.name : 'none';
}

function required() {
  const a = active();
  if (!a) throw new Error('No payment provider is configured');
  return a;
}

async function verify(reference, email) {
  const a = active();
  return a ? a.verify(reference, email) : null;
}

function chargeAuthorization(args) {
  return required().chargeAuthorization(args);
}

module.exports = { active, configured, name, required, verify, chargeAuthorization, PROVIDERS };
