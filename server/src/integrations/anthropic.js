const Anthropic = require('@anthropic-ai/sdk');

// Category suggestions from Claude. The API key lives here, server-side, so it
// never reaches browser code.

let client = null;

function configured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

const SYSTEM = [
  'You code bank transactions to a chart of accounts for a Nigerian business.',
  'You will be given a transaction and the exact list of accounts available.',
  'Reply with one account name copied exactly from that list, and nothing else.',
  'If none of them fit the transaction, reply with the single word NONE.'
].join(' ');

async function suggestCategory({ type, party, description, amount, allowed }) {
  if (!configured() || !allowed.length) return null;

  const prompt = [
    'Transaction type: ' + type,
    'Counterparty: ' + (party || 'unknown'),
    'Narration: ' + (description || 'none'),
    'Amount: NGN ' + amount,
    '',
    'Available accounts:',
    allowed.map((a) => '- ' + a).join('\n')
  ].join('\n');

  const response = await getClient().messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
    max_tokens: 256,
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();

  // Only ever return an account that actually exists on this organisation's
  // chart — a hallucinated name would post to nothing.
  return allowed.find((a) => a.toLowerCase() === text.toLowerCase()) || null;
}

module.exports = { configured, suggestCategory };
