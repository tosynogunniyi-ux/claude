// Row -> UI shape. The prototype's field names are kept exactly as they are so
// the screens, calculations and CSV exports keep working untouched.

const txShape = (r) => ({
  id: r.id,
  date: r.date,
  type: r.type,
  category: r.category,
  fund: r.fund || undefined,
  party: r.party || '',
  description: r.description || '',
  amount: r.amount,
  method: r.method,
  source: r.source
});

const docShape = (r) => ({
  id: r.id,
  number: r.number,
  partyId: r.party_id || null,
  party: r.party_name,
  issue: r.issue_date,
  due: r.due_date,
  total: r.total,
  paid: r.paid || 0,
  base: r.base_status
});

const contactShape = (r) => ({
  id: r.id,
  name: r.name,
  email: r.email || '',
  phone: r.phone || ''
});

const itemShape = (r) => ({
  id: r.id,
  name: r.name,
  sku: r.sku || '',
  supplier: r.supplier || '',
  cost: r.cost,
  price: r.price,
  purchased: r.qty_purchased,
  sold: r.qty_sold,
  reorder: r.reorder_level
});

const bankShape = (r) => ({
  id: r.id,
  date: r.date,
  narration: r.narration || '',
  amount: r.amount,
  matched: r.matched_transaction_id
});

// The settings screen binds to strings, so numbers go back out as strings.
const orgShape = (r) => ({
  id: r.id,
  name: r.name,
  book: r.book_type,
  type: r.business_type,
  state: r.state || '',
  vatRate: String(r.vat_rate),
  openingCash: String(r.opening_cash),
  contributions: String(r.owner_contributions),
  fixedAssets: String(r.fixed_assets),
  // Whether there is a logo, and when it last changed — the bytes come from
  // /logo, and this timestamp is what busts the browser's cache for them.
  hasLogo: Boolean(r.logo_mime),
  logoUpdatedAt: r.logo_updated_at || null
});

module.exports = { txShape, docShape, contactShape, itemShape, bankShape, orgShape };
