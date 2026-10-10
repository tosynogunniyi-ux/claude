// What Ask Profitna is allowed to read, and nothing else.
//
// The model never writes SQL and never names a table. It chooses from the
// tools below, and each tool builds its own statement from bound parameters
// with `organization_id = $1` already fixed by the route. A question asked on
// one set of books cannot reach another's, however it is phrased.
//
// Two shapes come out of here:
//
//   digest(orgId)  — a small snapshot of the whole book, sent with every
//                    question so the ordinary ones ("how much did we make
//                    this month") need no tool call at all.
//   run(orgId, …)  — one lookup, for the questions the snapshot cannot
//                    answer ("what did we pay Dangote in March").
//
// Every tool also returns a `table`: the rows it actually read, in the shape
// the answer card renders. The figures in that table are therefore the
// database's, never the model's — which is the whole claim the screen makes.

const { many, one } = require('../db');
const banking = require('../routes/banking');

const CAP = 50;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

const cap = (n, fallback) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1) return fallback;
  return Math.min(Math.floor(v), CAP);
};
// A date the model made up in the wrong format is ignored rather than
// errored: the answer is still right, just over a wider window.
const date = (v) => (ISO.test(String(v || '')) ? String(v) : null);
const text = (v) => String(v === undefined || v === null ? '' : v).trim().slice(0, 120);
// null means "the model did not give one", which is not the same as zero. An
// absent max_amount read as 0 would filter every row away and answer a real
// question with an empty list.
const num = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// ---------------------------------------------------------------- the digest

const OPEN_INVOICES = `
  SELECT i.client_name AS party,
         SUM(i.total - COALESCE(p.paid, 0))                                         AS open,
         SUM(CASE WHEN i.due_date < CURRENT_DATE
                  THEN i.total - COALESCE(p.paid, 0) ELSE 0 END)                    AS overdue,
         COUNT(*)::int                                                              AS documents,
         MIN(i.due_date)                                                            AS oldest_due
    FROM invoices i
    LEFT JOIN LATERAL (
      SELECT SUM(amount) AS paid FROM invoice_payments WHERE invoice_id = i.id
    ) p ON true
   WHERE i.organization_id = $1
     AND i.base_status <> 'draft'
     AND i.total - COALESCE(p.paid, 0) > 0
   GROUP BY 1
   ORDER BY 2 DESC
   LIMIT 15`;

const OPEN_BILLS = `
  SELECT b.vendor_name AS party,
         SUM(b.total - COALESCE(p.paid, 0))                                         AS open,
         SUM(CASE WHEN b.due_date < CURRENT_DATE
                  THEN b.total - COALESCE(p.paid, 0) ELSE 0 END)                    AS overdue,
         COUNT(*)::int                                                              AS documents,
         MIN(b.due_date)                                                            AS oldest_due
    FROM bills b
    LEFT JOIN LATERAL (
      SELECT SUM(amount) AS paid FROM bill_payments WHERE bill_id = b.id
    ) p ON true
   WHERE b.organization_id = $1
     AND b.base_status <> 'draft'
     AND b.total - COALESCE(p.paid, 0) > 0
   GROUP BY 1
   ORDER BY 2 DESC
   LIMIT 15`;

function categoryTotals(orgId, type) {
  return many(
    `SELECT CASE WHEN category = '' THEN '(not categorised)' ELSE category END AS category,
            SUM(amount)   AS total,
            COUNT(*)::int AS entries
       FROM transactions
      WHERE organization_id = $1
        AND type = $2
        AND date >= date_trunc('month', CURRENT_DATE) - INTERVAL '11 months'
      GROUP BY 1
      ORDER BY 2 DESC
      LIMIT 12`,
    [orgId, type]
  );
}

async function digest(orgId) {
  const [org, totals, span, monthly, expense, income, receivable, payable, stock, funds, accounts] =
    await Promise.all([
      one(`SELECT name, book_type, business_type, state, vat_rate, opening_cash,
                  owner_contributions, fixed_assets
             FROM organizations WHERE id = $1`, [orgId]),
      one(`SELECT COALESCE(SUM(amount) FILTER (WHERE type = 'income'),  0) AS income,
                  COALESCE(SUM(amount) FILTER (WHERE type = 'expense'), 0) AS expense
             FROM transactions WHERE organization_id = $1`, [orgId]),
      one(`SELECT COUNT(*)::int                               AS entries,
                  MIN(date)                                   AS first_entry,
                  MAX(date)                                   AS last_entry,
                  COUNT(*) FILTER (WHERE category = '')::int  AS not_categorised
             FROM transactions WHERE organization_id = $1`, [orgId]),
      // Every one of the twelve months is listed, including the quiet ones. A
      // month missing from the list reads as "I was not told", and a month
      // that is there with zeros reads as "nothing happened" — which is the
      // honest answer and a different one.
      many(`WITH months AS (
              SELECT generate_series(
                date_trunc('month', CURRENT_DATE) - INTERVAL '11 months',
                date_trunc('month', CURRENT_DATE),
                INTERVAL '1 month'
              ) AS m
            )
            SELECT to_char(months.m, 'YYYY-MM')                                     AS month,
                   COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'income'),  0)     AS income,
                   COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'expense'), 0)     AS expense
              FROM months
              LEFT JOIN transactions t
                ON t.organization_id = $1
               AND date_trunc('month', t.date) = months.m
             GROUP BY 1 ORDER BY 1`, [orgId]),
      categoryTotals(orgId, 'expense'),
      categoryTotals(orgId, 'income'),
      many(OPEN_INVOICES, [orgId]),
      many(OPEN_BILLS, [orgId]),
      many(`SELECT name, sku, cost, price, qty_purchased AS purchased, qty_sold AS sold,
                   qty_purchased - qty_sold                AS on_hand,
                   qty_sold * (price - cost)               AS gross_profit,
                   reorder_level
              FROM inventory_items
             WHERE organization_id = $1
             ORDER BY qty_sold * (price - cost) DESC
             LIMIT 15`, [orgId]),
      many(`SELECT COALESCE(NULLIF(fund, ''), '(no fund)')                          AS fund,
                   COALESCE(SUM(amount) FILTER (WHERE type = 'income'),  0)         AS received,
                   COALESCE(SUM(amount) FILTER (WHERE type = 'expense'), 0)         AS spent
              FROM transactions
             WHERE organization_id = $1 AND fund IS NOT NULL AND fund <> ''
             GROUP BY 1 ORDER BY 2 DESC LIMIT 12`, [orgId]),
      banking.accountsWithBalances(orgId)
    ]);

  const opening = Number((org && org.opening_cash) || 0);
  const cash = opening + Number(totals.income) - Number(totals.expense);

  return {
    // Not a timestamp. A clock in the prompt would change on every request
    // and throw away the cached prefix for no benefit; the date is what the
    // answers actually depend on.
    as_at: new Date().toISOString().slice(0, 10),
    currency: 'NGN',
    basis: 'cash basis — an amount counts on the day the money moved',
    organisation: org && {
      name: org.name,
      books: org.book_type,
      trade: org.business_type,
      state: org.state || null,
      vat_rate_percent: Number(org.vat_rate),
      owner_contributions: Number(org.owner_contributions),
      fixed_assets: Number(org.fixed_assets)
    },
    ledger: {
      entries: span.entries,
      first_entry: span.first_entry,
      last_entry: span.last_entry,
      not_categorised: span.not_categorised,
      income_all_time: Number(totals.income),
      expense_all_time: Number(totals.expense)
    },
    cash: {
      opening_balance: opening,
      balance_today: cash,
      bank_accounts: accounts.map((a) => ({
        name: a.name, bank: a.bankName, balance: Number(a.balance), entries: a.entries
      }))
    },
    monthly: monthly.map((m) => ({
      month: m.month,
      income: Number(m.income),
      expense: Number(m.expense),
      net: Number(m.income) - Number(m.expense)
    })),
    expense_categories_12m: expense.map((c) => ({
      category: c.category, total: Number(c.total), entries: c.entries
    })),
    income_categories_12m: income.map((c) => ({
      category: c.category, total: Number(c.total), entries: c.entries
    })),
    owed_to_us: receivable.map(partyRow),
    we_owe: payable.map(partyRow),
    funds: funds.map((f) => ({
      fund: f.fund, received: Number(f.received), spent: Number(f.spent),
      balance: Number(f.received) - Number(f.spent)
    })),
    stock: stock.map((s) => ({
      name: s.name, sku: s.sku || null,
      cost: Number(s.cost), price: Number(s.price),
      purchased: Number(s.purchased), sold: Number(s.sold),
      on_hand: Number(s.on_hand), gross_profit: Number(s.gross_profit),
      reorder_level: Number(s.reorder_level)
    })),
    // Said out loud so the model does not read a truncated list as the whole
    // truth and announce a total that is only the top fifteen.
    truncation: 'Lists here are the largest 12–15 rows only. Use a tool for the rest.'
  };
}

const partyRow = (r) => ({
  party: r.party,
  open: Number(r.open),
  overdue: Number(r.overdue),
  documents: r.documents,
  oldest_due: r.oldest_due
});

// ----------------------------------------------------------------- the tools

const TOOLS = [
  {
    name: 'search_transactions',
    description:
      'Individual money-in and money-out entries from the cash ledger. Use this ' +
      'for anything about one party, one narration or one window of dates — what ' +
      'was paid to a supplier, what a customer has sent, what a category is made ' +
      'up of. Returns the newest matches first, at most 50.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['income', 'expense'], description: 'Omit for both.' },
        party: { type: 'string', description: 'Customer, supplier or payee. Partial names match.' },
        text: { type: 'string', description: 'Words to look for in the narration or the party.' },
        category: { type: 'string', description: 'Exact category name from the snapshot.' },
        from: { type: 'string', description: 'Earliest date, YYYY-MM-DD.' },
        to: { type: 'string', description: 'Latest date, YYYY-MM-DD.' },
        min_amount: { type: 'number' },
        max_amount: { type: 'number' },
        order: { type: 'string', enum: ['newest', 'largest'], description: 'Default newest.' },
        limit: { type: 'integer', description: '1 to 50. Default 20.' }
      }
    }
  },
  {
    name: 'period_totals',
    description:
      'Income, expenses and net for one window of dates, with the categories ' +
      'that make them up. Use this when the question names a period the ' +
      'snapshot does not already cover — a quarter, a year, two dates.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD. Default the start of this year.' },
        to: { type: 'string', description: 'YYYY-MM-DD. Default today.' },
        type: { type: 'string', enum: ['income', 'expense'], description: 'Which categories to break down. Default expense.' }
      }
    }
  },
  {
    name: 'list_documents',
    description:
      'Invoices raised or bills received, one row per document, with what is ' +
      'still outstanding on each. Use this for who owes what, what is overdue, ' +
      'and what falls due next.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['invoice', 'bill'], description: 'Required.' },
        status: {
          type: 'string',
          enum: ['open', 'overdue', 'paid', 'draft', 'all'],
          description: 'Default open — raised and not yet settled in full.'
        },
        party: { type: 'string', description: 'Partial names match.' },
        from: { type: 'string', description: 'Earliest issue date, YYYY-MM-DD.' },
        to: { type: 'string', description: 'Latest issue date, YYYY-MM-DD.' },
        order: { type: 'string', enum: ['due', 'largest', 'newest'], description: 'Default due.' },
        limit: { type: 'integer', description: '1 to 50. Default 20.' }
      },
      required: ['kind']
    }
  },
  {
    name: 'party_summary',
    description:
      'Everything the books hold on one customer, supplier or payee: what they ' +
      'have been invoiced, what they have paid, what is still open, and the ' +
      'money that has moved either way.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Partial names match.' } },
      required: ['name']
    }
  },
  {
    name: 'list_stock',
    description:
      'Products and services with cost, price, quantities and gross profit. ' +
      'Use this for what sells, what earns, and what is running out.',
    input_schema: {
      type: 'object',
      properties: {
        order: { type: 'string', enum: ['profit', 'low_stock', 'sold', 'name'], description: 'Default profit.' },
        limit: { type: 'integer', description: '1 to 50. Default 20.' }
      }
    }
  }
];

// Each handler returns { data, table }. `data` goes back to the model, `table`
// is what the answer card draws — the rows as the database gave them.
const HANDLERS = {
  async search_transactions(orgId, a) {
    const where = ['organization_id = $1'];
    const args = [orgId];
    // $n stands for "whichever number this parameter lands on", and a clause
    // may mention it twice, so every occurrence is replaced.
    const add = (sql, value) => { args.push(value); where.push(sql.replace(/\$n/g, '$' + args.length)); };

    if (a.type === 'income' || a.type === 'expense') add('type = $n', a.type);
    if (text(a.party)) add('party ILIKE $n', '%' + text(a.party) + '%');
    if (text(a.category)) add('category = $n', text(a.category));
    if (text(a.text)) add('(description ILIKE $n OR party ILIKE $n)', '%' + text(a.text) + '%');
    if (date(a.from)) add('date >= $n', date(a.from));
    if (date(a.to)) add('date <= $n', date(a.to));
    if (num(a.min_amount) !== null) add('amount >= $n', num(a.min_amount));
    if (num(a.max_amount) !== null) add('amount <= $n', num(a.max_amount));

    const limit = cap(a.limit, 20);
    const order = a.order === 'largest' ? 'amount DESC' : 'date DESC, created_at DESC';
    const rows = await many(
      `SELECT date, type, amount, category, party, description, method, fund
         FROM transactions WHERE ${where.join(' AND ')}
        ORDER BY ${order} LIMIT ${limit}`,
      args
    );
    // The matching set is almost always wider than the page of rows, and the
    // difference is the difference between a right answer and a wrong one.
    const all = await one(
      `SELECT COUNT(*)::int AS matched,
              COALESCE(SUM(amount) FILTER (WHERE type = 'income'),  0) AS income,
              COALESCE(SUM(amount) FILTER (WHERE type = 'expense'), 0) AS expense
         FROM transactions WHERE ${where.join(' AND ')}`,
      args
    );
    const net = Number(all.income) - Number(all.expense);
    return {
      data: {
        matched: all.matched,
        showing: rows.length,
        total_income: Number(all.income),
        total_expense: Number(all.expense),
        net,
        entries: rows.map((r) => ({
          date: r.date, type: r.type, amount: Number(r.amount),
          category: r.category || null, party: r.party || null,
          description: r.description || null, method: r.method, fund: r.fund || null
        }))
      },
      table: {
        rows: rows.map((r) => ({
          label: r.description || r.party || r.category || 'Entry',
          sub: r.date + ' · ' + (r.party || r.category || r.method),
          value: Number(r.amount),
          negative: r.type === 'expense'
        })),
        totalLabel: all.matched > rows.length
          ? 'Net across all ' + all.matched + ' matching entries'
          : 'Net',
        total: net
      }
    };
  },

  async period_totals(orgId, a) {
    const from = date(a.from) || new Date().toISOString().slice(0, 4) + '-01-01';
    const to = date(a.to) || new Date().toISOString().slice(0, 10);
    const type = a.type === 'income' ? 'income' : 'expense';

    const [totals, cats] = await Promise.all([
      one(`SELECT COALESCE(SUM(amount) FILTER (WHERE type = 'income'),  0) AS income,
                  COALESCE(SUM(amount) FILTER (WHERE type = 'expense'), 0) AS expense,
                  COUNT(*)::int                                            AS entries
             FROM transactions
            WHERE organization_id = $1 AND date >= $2 AND date <= $3`, [orgId, from, to]),
      many(`SELECT CASE WHEN category = '' THEN '(not categorised)' ELSE category END AS category,
                   SUM(amount) AS total, COUNT(*)::int AS entries
              FROM transactions
             WHERE organization_id = $1 AND type = $4 AND date >= $2 AND date <= $3
             GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, [orgId, from, to, type])
    ]);
    const income = Number(totals.income);
    const expense = Number(totals.expense);
    return {
      data: {
        from, to, entries: totals.entries,
        income, expense, net: income - expense,
        margin_percent: income ? Math.round((income - expense) / income * 1000) / 10 : null,
        [type + '_by_category']: cats.map((c) => ({
          category: c.category, total: Number(c.total), entries: c.entries
        }))
      },
      table: {
        rows: cats.slice(0, 8).map((c) => ({
          label: c.category,
          sub: c.entries + (c.entries === 1 ? ' entry' : ' entries') + ' · ' + from + ' to ' + to,
          value: Number(c.total),
          negative: type === 'expense'
        })),
        totalLabel: type === 'expense' ? 'Total expenses for the period' : 'Total income for the period',
        total: type === 'expense' ? expense : income
      }
    };
  },

  async list_documents(orgId, a) {
    const bill = a.kind === 'bill';
    const t = bill ? 'bills' : 'invoices';
    const party = bill ? 'vendor_name' : 'client_name';
    const payments = bill ? 'bill_payments' : 'invoice_payments';
    const fk = bill ? 'bill_id' : 'invoice_id';

    const where = ['d.organization_id = $1'];
    const args = [orgId];
    // $n stands for "whichever number this parameter lands on", and a clause
    // may mention it twice, so every occurrence is replaced.
    const add = (sql, value) => { args.push(value); where.push(sql.replace(/\$n/g, '$' + args.length)); };
    if (text(a.party)) add(`d.${party} ILIKE $n`, '%' + text(a.party) + '%');
    if (date(a.from)) add('d.issue_date >= $n', date(a.from));
    if (date(a.to)) add('d.issue_date <= $n', date(a.to));

    const status = ['open', 'overdue', 'paid', 'draft', 'all'].includes(a.status) ? a.status : 'open';
    if (status === 'draft') where.push("d.base_status = 'draft'");
    else if (status !== 'all') where.push("d.base_status <> 'draft'");
    if (status === 'open') where.push('d.total - COALESCE(p.paid, 0) > 0');
    if (status === 'paid') where.push('d.total - COALESCE(p.paid, 0) <= 0');
    if (status === 'overdue') where.push('d.total - COALESCE(p.paid, 0) > 0 AND d.due_date < CURRENT_DATE');

    const limit = cap(a.limit, 20);
    const order = a.order === 'largest' ? 'outstanding DESC'
      : a.order === 'newest' ? 'd.issue_date DESC'
        : 'd.due_date';

    const sql = `
      SELECT d.number, d.${party} AS party, d.issue_date, d.due_date,
             d.total, COALESCE(p.paid, 0) AS paid,
             d.total - COALESCE(p.paid, 0) AS outstanding,
             d.base_status,
             (d.total - COALESCE(p.paid, 0) > 0 AND d.due_date < CURRENT_DATE) AS overdue
        FROM ${t} d
        LEFT JOIN LATERAL (
          SELECT SUM(amount) AS paid FROM ${payments} WHERE ${fk} = d.id
        ) p ON true
       WHERE ${where.join(' AND ')}`;

    const [rows, sums] = await Promise.all([
      many(sql + ` ORDER BY ${order} LIMIT ${limit}`, args),
      one(`SELECT COUNT(*)::int AS matched,
                  COALESCE(SUM(total), 0) AS total,
                  COALESCE(SUM(outstanding), 0) AS outstanding
             FROM (${sql}) q`, args)
    ]);

    const word = bill ? 'bill' : 'invoice';
    return {
      data: {
        kind: word, status,
        matched: sums.matched, showing: rows.length,
        total_value: Number(sums.total),
        total_outstanding: Number(sums.outstanding),
        documents: rows.map((r) => ({
          number: r.number, party: r.party,
          issued: r.issue_date, due: r.due_date,
          total: Number(r.total), paid: Number(r.paid),
          outstanding: Number(r.outstanding),
          overdue: r.overdue, draft: r.base_status === 'draft'
        }))
      },
      table: {
        rows: rows.map((r) => ({
          label: r.party,
          sub: r.number + ' · due ' + r.due_date + (r.overdue ? ' · overdue' : ''),
          value: Number(r.outstanding) > 0 ? Number(r.outstanding) : Number(r.total),
          negative: Boolean(r.overdue)
        })),
        totalLabel: status === 'paid' ? 'Settled in total' : 'Outstanding in total',
        total: status === 'paid' ? Number(sums.total) : Number(sums.outstanding)
      }
    };
  },

  async party_summary(orgId, a) {
    const like = '%' + text(a.name) + '%';
    if (!text(a.name)) return { data: { error: 'Give a name to look up.' } };

    const [inv, bills, money, entries] = await Promise.all([
      one(`SELECT COUNT(*)::int AS documents,
                  COALESCE(SUM(i.total), 0) AS invoiced,
                  COALESCE(SUM(COALESCE(p.paid, 0)), 0) AS settled,
                  COALESCE(SUM(i.total - COALESCE(p.paid, 0)), 0) AS outstanding
             FROM invoices i
             LEFT JOIN LATERAL (
               SELECT SUM(amount) AS paid FROM invoice_payments WHERE invoice_id = i.id
             ) p ON true
            WHERE i.organization_id = $1 AND i.client_name ILIKE $2
              AND i.base_status <> 'draft'`, [orgId, like]),
      one(`SELECT COUNT(*)::int AS documents,
                  COALESCE(SUM(b.total), 0) AS billed,
                  COALESCE(SUM(COALESCE(p.paid, 0)), 0) AS settled,
                  COALESCE(SUM(b.total - COALESCE(p.paid, 0)), 0) AS outstanding
             FROM bills b
             LEFT JOIN LATERAL (
               SELECT SUM(amount) AS paid FROM bill_payments WHERE bill_id = b.id
             ) p ON true
            WHERE b.organization_id = $1 AND b.vendor_name ILIKE $2
              AND b.base_status <> 'draft'`, [orgId, like]),
      one(`SELECT COALESCE(SUM(amount) FILTER (WHERE type = 'income'),  0) AS received,
                  COALESCE(SUM(amount) FILTER (WHERE type = 'expense'), 0) AS paid,
                  COUNT(*)::int AS entries,
                  MIN(date) AS first_entry, MAX(date) AS last_entry
             FROM transactions
            WHERE organization_id = $1 AND party ILIKE $2`, [orgId, like]),
      many(`SELECT date, type, amount, category, description
              FROM transactions
             WHERE organization_id = $1 AND party ILIKE $2
             ORDER BY date DESC LIMIT 15`, [orgId, like])
    ]);

    return {
      data: {
        looked_up: text(a.name),
        as_customer: {
          invoices: inv.documents, invoiced: Number(inv.invoiced),
          settled: Number(inv.settled), outstanding: Number(inv.outstanding)
        },
        as_supplier: {
          bills: bills.documents, billed: Number(bills.billed),
          settled: Number(bills.settled), outstanding: Number(bills.outstanding)
        },
        money_moved: {
          received_from_them: Number(money.received),
          paid_to_them: Number(money.paid),
          entries: money.entries,
          first_entry: money.first_entry, last_entry: money.last_entry
        },
        recent_entries: entries.map((r) => ({
          date: r.date, type: r.type, amount: Number(r.amount),
          category: r.category || null, description: r.description || null
        }))
      },
      table: {
        rows: entries.slice(0, 8).map((r) => ({
          label: r.description || text(a.name),
          sub: r.date + ' · ' + (r.type === 'income' ? 'received' : 'paid'),
          value: Number(r.amount),
          negative: r.type === 'expense'
        })),
        totalLabel: 'Still outstanding',
        total: Number(inv.outstanding) || Number(bills.outstanding)
      }
    };
  },

  async list_stock(orgId, a) {
    const order = a.order === 'low_stock' ? '(qty_purchased - qty_sold) ASC'
      : a.order === 'sold' ? 'qty_sold DESC'
        : a.order === 'name' ? 'name'
          : 'qty_sold * (price - cost) DESC';
    const limit = cap(a.limit, 20);
    const rows = await many(
      `SELECT name, sku, kind, cost, price, qty_purchased, qty_sold, reorder_level,
              qty_purchased - qty_sold  AS on_hand,
              qty_sold * (price - cost) AS gross_profit
         FROM inventory_items
        WHERE organization_id = $1
        ORDER BY ${order} LIMIT ${limit}`,
      [orgId]
    );
    const profit = rows.reduce((sum, r) => sum + Number(r.gross_profit), 0);
    return {
      data: {
        lines: rows.length,
        gross_profit_shown: profit,
        items: rows.map((r) => ({
          name: r.name, sku: r.sku || null, kind: r.kind,
          cost: Number(r.cost), price: Number(r.price),
          purchased: Number(r.qty_purchased), sold: Number(r.qty_sold),
          on_hand: Number(r.on_hand), gross_profit: Number(r.gross_profit),
          reorder_level: Number(r.reorder_level),
          below_reorder: Number(r.on_hand) <= Number(r.reorder_level)
        }))
      },
      table: {
        rows: rows.slice(0, 8).map((r) => ({
          label: r.name,
          sub: Number(r.sold) + ' sold · ' + Number(r.on_hand) + ' on hand',
          value: Number(r.gross_profit)
        })),
        totalLabel: 'Gross profit on the rows shown',
        total: profit
      }
    };
  }
};

// A tool the model asks for that does not exist, or one that throws, comes
// back as a plain sentence it can read and work around. Nothing here is
// allowed to end the answer.
async function run(orgId, name, input) {
  const handler = HANDLERS[name];
  if (!handler) return { error: true, data: { error: 'No such lookup: ' + name } };
  try {
    const out = await handler(orgId, input && typeof input === 'object' ? input : {});
    return { error: false, data: out.data, table: out.table };
  } catch (err) {
    return { error: true, data: { error: 'That lookup failed: ' + err.message } };
  }
}

module.exports = { digest, run, TOOLS, CAP };
