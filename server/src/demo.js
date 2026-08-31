// Sample books, ported from the prototype's seedSME() / seedChurch() so a
// development account opens onto the same populated screens the design was
// built against. Only runs when SEED_DEMO_DATA=true.

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const iso = (d) =>
  d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

const SME = {
  clients: [
    ['Prime Foods Ltd', 'accounts@primefoods.ng', '0803 441 9920'],
    ['Bella Fashion House', 'finance@bellafashion.com', '0802 118 7734'],
    ['Delta Fresh Mart', 'accounts@deltafresh.ng', '0706 552 3318'],
    ['Warri Tech Solutions', 'ap@warritech.ng', '0809 220 4471'],
    ['Lagos Home Supplies', 'billing@lagoshome.com.ng', '0812 663 9005'],
    ['Chinedu Okafor', 'chinedu.okafor@gmail.com', '0705 889 2214']
  ],
  vendors: [
    ['Ikeja Electric Plc', 'support@ikejaelectric.com', '0700 022 2222'],
    ['Spectranet Ltd', 'care@spectranet.com.ng', '0700 773 2872'],
    ['Rosewood Properties', 'lease@rosewoodprop.ng', '0803 900 1122'],
    ['Adekunle & Co (Chartered Accountants)', 'audit@adekunleco.ng', '0806 771 4400'],
    ['Lagos Wholesale Depot', 'orders@lwdepot.ng', '0813 220 9911'],
    ['Leadway Assurance', 'policy@leadway.com', '01 280 0700']
  ],
  income: [
    ['Product Sales', 'Bulk order — dry goods'], ['Product Sales', 'Counter sales, week ending'],
    ['Service Fees', 'Installation and setup'], ['Consulting', 'Operations review retainer'],
    ['Subscription Revenue', 'Annual support plan'], ['Other Income', 'Equipment hire']
  ],
  expense: [
    ['Rent - Business Premises', 'Quarterly shop rent', 'Rosewood Properties'],
    ['Salaries & Wages', 'Monthly staff payroll', 'Payroll'],
    ['Inventory Purchases', 'Restock — wholesale purchase', 'Lagos Wholesale Depot'],
    ['Utilities', 'Electricity bill', 'Ikeja Electric Plc'],
    ['Transport & Fuel', 'Delivery fuel and logistics', 'Fuel station'],
    ['Professional Fees', 'Statutory audit fee', 'Adekunle & Co (Chartered Accountants)'],
    ['Marketing & Advertising', 'Meta ads campaign', 'Meta Platforms'],
    ['Internet & Telephone', 'Office internet subscription', 'Spectranet Ltd'],
    ['Repairs & Maintenance', 'Generator servicing', 'Mikano Service'],
    ['Insurance', 'Goods-in-transit cover', 'Leadway Assurance'],
    ['Bank Charges', 'Account maintenance and stamp duty', 'GTBank'],
    ['Entertainment', 'Client lunch meeting', 'Terra Kulture'],
    ['Staff Training', 'Inventory software training', 'Sidebrief Academy']
  ],
  inventory: [
    ['Solar Inverter 3.5kVA', 'SLR-035', 'Lagos Wholesale Depot', 385000, 520000, 60, 47, 8],
    ['Deep Cycle Battery 220Ah', 'BAT-220', 'Lagos Wholesale Depot', 195000, 268000, 120, 96, 20],
    ['Monocrystalline Panel 400W', 'PNL-400', 'Sunlink Imports', 132000, 189000, 200, 158, 30],
    ['Charge Controller 60A', 'CTL-060', 'Sunlink Imports', 54000, 82000, 90, 88, 15],
    ['Installation Cable (100m roll)', 'CBL-100', 'Kadco Engineering', 41000, 62000, 75, 41, 12],
    ['Mounting Rail Kit', 'MNT-KIT', 'Kadco Engineering', 28500, 44000, 140, 62, 25]
  ],
  invoices: [
    [0, '2026-06-02', '2026-07-02', 3850000, 3850000], [1, '2026-06-21', '2026-07-21', 1420000, 600000],
    [2, '2026-07-04', '2026-08-03', 2260000, 0], [3, '2026-07-18', '2026-08-17', 5100000, 5100000],
    [4, '2026-07-29', '2026-08-28', 940000, 0], [5, '2026-08-05', '2026-09-04', 3320000, 1200000],
    [0, '2026-08-12', '2026-09-11', 1780000, 0], [2, '2026-08-17', '2026-09-16', 620000, 0]
  ],
  bills: [
    [4, '2026-06-10', '2026-07-10', 2180000, 2180000], [2, '2026-07-01', '2026-07-31', 1500000, 1500000],
    [3, '2026-07-15', '2026-08-14', 850000, 0], [0, '2026-08-02', '2026-08-25', 410000, 0],
    [5, '2026-08-08', '2026-09-07', 268000, 0], [4, '2026-08-14', '2026-09-13', 1930000, 500000],
    [1, '2026-08-18', '2026-09-17', 139500, 0]
  ],
  uncoded: [
    ['2026-08-18', 'Spectranet Ltd', 'Spectranet monthly internet renewal', 46500, 'Bank transfer'],
    ['2026-08-19', 'Bolt Nigeria', 'Bolt rides — client site visits', 28400, 'Card'],
    ['2026-08-20', 'Ikeja Electric Plc', 'Ikeja Electric prepaid token', 155000, 'Bank transfer']
  ],
  bank: [
    ['2026-08-20', 'POS/IKEJA ELECTRIC PREPAID TOKEN', -155000],
    ['2026-08-19', 'CARD/BOLT NG RIDE HAILING', -28400],
    ['2026-08-18', 'TRF/SPECTRANET LTD/INTERNET', -46500],
    ['2026-08-17', 'TRF FRM SAPPHIRE HOTELS ABUJA', 5100000],
    ['2026-08-16', 'COMMISSION ON TURNOVER + VAT', -3750],
    ['2026-08-14', 'TRF/LAGOS WHOLESALE DEPOT INV 2093', -500000],
    ['2026-08-12', 'TRF FRM HALOGEN RETAIL STORES', 600000],
    ['2026-08-09', 'ATM WDL LEKKI BRANCH', -120000],
    ['2026-08-06', 'TRF/META PLATFORMS ADS', -274000],
    ['2026-08-04', 'TRF FRM BLUECREST LOGISTICS LTD', 1200000]
  ]
};

const CHURCH = {
  clients: [
    ['Deacon Emeka Obi', 'emeka.obi@mail.com', '0803 220 1145'],
    ['Mrs Folake Adeniyi', 'folake.a@mail.com', '0805 771 9932'],
    ['Bro. Samuel Danjuma', 'sdanjuma@mail.com', '0812 004 5567'],
    ['Sis. Grace Uzoma', 'grace.u@mail.com', '0706 118 2290'],
    ['Chief Bayo Ogunlesi', 'bayo.o@mail.com', '0802 993 4410'],
    ['Youth Fellowship Group', 'youth@gracechapel.ng', '0809 442 7781']
  ],
  vendors: [
    ['Eko Electricity Distribution', 'care@ekedp.com', '0700 023 4567'],
    ['Harvest Print & Media', 'jobs@harvestprint.ng', '0803 552 1109'],
    ['Sound Depot Nigeria', 'sales@sounddepot.ng', '0806 220 7745'],
    ['Ogun Water Corporation', 'billing@ogunwater.gov.ng', '039 220 114'],
    ['Bethel Bookshop', 'orders@bethelbooks.ng', '0813 665 2200'],
    ['Citiserve Facility Care', 'ops@citiserve.ng', '0807 331 8890']
  ],
  income: [
    ['Tithes', 'General Fund', 'Weekly tithe collection'],
    ['Sunday Offering', 'General Fund', 'Sunday service offering'],
    ['Special Offering', 'General Fund', 'Thanksgiving service offering'],
    ['Building Fund Giving', 'Building Fund', 'Auditorium project pledge redeemed'],
    ['Missions Giving', 'Missions Fund', 'Missions Sunday collection'],
    ['Donations & Grants', 'General Fund', 'Corporate donation received']
  ],
  expense: [
    ['Pastoral Salaries', 'General Fund', 'Monthly pastoral stipends', 'Payroll'],
    ['Benevolence & Welfare', 'Benevolence Fund', 'Member welfare support', 'Welfare committee'],
    ['Missions Support', 'Missions Fund', 'Remittance to field missionary', 'Missions board'],
    ['Building Maintenance', 'Building Fund', 'Auditorium roofing works', 'Citiserve Facility Care'],
    ['Utilities', 'General Fund', 'Electricity bill', 'Eko Electricity Distribution'],
    ['Church Programmes', 'General Fund', 'Youth convention logistics', 'Harvest Print & Media'],
    ['Media & Sound', 'General Fund', 'Sound console repair', 'Sound Depot Nigeria'],
    ['Transport', 'General Fund', 'Bus fuel for outreach', 'Fuel station'],
    ['Administrative', 'General Fund', 'Office stationery and printing', 'Bethel Bookshop']
  ],
  pledges: [
    [4, '2026-05-10', '2026-08-10', 5000000, 3000000], [0, '2026-06-14', '2026-09-14', 1200000, 400000],
    [1, '2026-07-05', '2026-10-05', 800000, 800000], [5, '2026-07-19', '2026-09-19', 450000, 0],
    [2, '2026-08-02', '2026-11-02', 600000, 150000], [3, '2026-08-16', '2026-10-16', 300000, 0]
  ],
  bills: [
    [0, '2026-07-02', '2026-08-01', 620000, 620000], [2, '2026-07-22', '2026-08-21', 1150000, 0],
    [5, '2026-08-05', '2026-09-04', 480000, 200000], [1, '2026-08-11', '2026-09-10', 265000, 0],
    [3, '2026-08-15', '2026-09-14', 92000, 0]
  ],
  uncoded: [
    ['income', '2026-08-19', 'Building Fund', 'Chief Bayo Ogunlesi', 'Transfer marked "building project pledge"', 2000000],
    ['expense', '2026-08-20', 'General Fund', 'Eko Electricity Distribution', 'EKEDC electricity prepayment', 310000]
  ],
  bank: [
    ['2026-08-20', 'TRF/EKEDC ELECTRICITY PREPAYMENT', -310000],
    ['2026-08-19', 'TRF FRM CHIEF BAYO OGUNLESI BUILDING PROJECT', 2000000],
    ['2026-08-16', 'CASH DEP/SUNDAY OFFERING 16 AUG', 640000],
    ['2026-08-14', 'TRF/CITISERVE FACILITY CARE ROOFING', -480000],
    ['2026-08-12', 'COMMISSION ON TURNOVER + VAT', -2100],
    ['2026-08-09', 'TRF FRM DEACON EMEKA OBI TITHE', 450000],
    ['2026-08-06', 'TRF/HARVEST PRINT MEDIA PROGRAMME FLYERS', -145000],
    ['2026-08-03', 'TRF/MISSIONS REMITTANCE FIELD SUPPORT', -600000]
  ]
};

async function insertContacts(client, orgId, table, rows) {
  const ids = [];
  for (const [name, email, phone] of rows) {
    const res = await client.query(
      'INSERT INTO ' + table + ' (organization_id, name, email, phone) VALUES ($1, $2, $3, $4) RETURNING id, name',
      [orgId, name, email, phone]
    );
    ids.push(res.rows[0]);
  }
  return ids;
}

async function insertTx(client, orgId, t) {
  await client.query(
    `INSERT INTO transactions
       (organization_id, type, date, amount, category, fund, party, description, method, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'manual')`,
    [orgId, t.type, t.date, t.amount, t.category, t.fund || null, t.party, t.description, t.method]
  );
}

async function insertDoc(client, orgId, kind, number, contact, issue, due, total, paid) {
  const isBill = kind === 'bill';
  const doc = (await client.query(
    isBill
      ? `INSERT INTO bills (organization_id, number, vendor_id, vendor_name, issue_date, due_date, total)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`
      : `INSERT INTO invoices (organization_id, number, client_id, client_name, issue_date, due_date, total)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [orgId, number, contact.id, contact.name, issue, due, total]
  )).rows[0];

  if (paid > 0) {
    await client.query(
      isBill
        ? 'INSERT INTO bill_payments (bill_id, amount, date) VALUES ($1, $2, $3)'
        : 'INSERT INTO invoice_payments (invoice_id, amount, date) VALUES ($1, $2, $3)',
      [doc.id, paid, issue]
    );
  }
}

async function insertBank(client, orgId, rows) {
  for (const [date, narration, amount] of rows) {
    await client.query(
      `INSERT INTO bank_statement_lines (organization_id, date, narration, amount, source)
       VALUES ($1, $2, $3, $4, 'seed')`,
      [orgId, date, narration, amount]
    );
  }
}

async function seedSME(client, orgId) {
  const r = rng(20260821);
  const clients = await insertContacts(client, orgId, 'clients', SME.clients);
  const vendors = await insertContacts(client, orgId, 'vendors', SME.vendors);

  for (let m = 0; m <= 7; m++) {
    const incomeCount = 5 + Math.floor(r() * 3);
    for (let i = 0; i < incomeCount; i++) {
      const d = SME.income[Math.floor(r() * SME.income.length)];
      const c = clients[Math.floor(r() * clients.length)];
      await insertTx(client, orgId, {
        type: 'income', date: iso(new Date(2026, m, 1 + Math.floor(r() * 27))),
        category: d[0], party: c.name, description: d[1],
        amount: Math.round((250000 + r() * 2600000) / 1000) * 1000,
        method: r() > 0.4 ? 'Bank transfer' : 'Cash'
      });
    }
    const expenseCount = 7 + Math.floor(r() * 4);
    for (let i = 0; i < expenseCount; i++) {
      const d = SME.expense[Math.floor(r() * SME.expense.length)];
      await insertTx(client, orgId, {
        type: 'expense', date: iso(new Date(2026, m, 1 + Math.floor(r() * 27))),
        category: d[0], party: d[2], description: d[1],
        amount: Math.round((35000 + r() * 780000) / 1000) * 1000,
        method: r() > 0.3 ? 'Bank transfer' : 'Cash'
      });
    }
  }

  // Left without a category on purpose: these are what the AI categoriser codes.
  for (const [date, party, description, amount, method] of SME.uncoded) {
    await insertTx(client, orgId, { type: 'expense', date, category: '', party, description, amount, method });
  }

  for (let i = 0; i < SME.invoices.length; i++) {
    const s = SME.invoices[i];
    await insertDoc(client, orgId, 'invoice', 'INV-' + (1041 + i), clients[s[0]], s[1], s[2], s[3], s[4]);
  }
  for (let i = 0; i < SME.bills.length; i++) {
    const s = SME.bills[i];
    await insertDoc(client, orgId, 'bill', 'BILL-' + (2087 + i), vendors[s[0]], s[1], s[2], s[3], s[4]);
  }

  for (const x of SME.inventory) {
    await client.query(
      `INSERT INTO inventory_items
         (organization_id, name, sku, supplier, cost, price, qty_purchased, qty_sold, reorder_level)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [orgId, x[0], x[1], x[2], x[3], x[4], x[5], x[6], x[7]]
    );
  }

  await insertBank(client, orgId, SME.bank);
}

async function seedChurch(client, orgId) {
  const r = rng(771026);
  const members = await insertContacts(client, orgId, 'clients', CHURCH.clients);
  const vendors = await insertContacts(client, orgId, 'vendors', CHURCH.vendors);

  for (let m = 0; m <= 7; m++) {
    for (let i = 0; i < 6; i++) {
      const g = CHURCH.income[Math.floor(r() * CHURCH.income.length)];
      const c = members[Math.floor(r() * members.length)];
      await insertTx(client, orgId, {
        type: 'income', date: iso(new Date(2026, m, 1 + Math.floor(r() * 27))),
        category: g[0], fund: g[1], party: c.name, description: g[2],
        amount: Math.round((120000 + r() * 1400000) / 1000) * 1000,
        method: r() > 0.5 ? 'Bank transfer' : 'Cash'
      });
    }
    for (let i = 0; i < 6; i++) {
      const s = CHURCH.expense[Math.floor(r() * CHURCH.expense.length)];
      await insertTx(client, orgId, {
        type: 'expense', date: iso(new Date(2026, m, 1 + Math.floor(r() * 27))),
        category: s[0], fund: s[1], party: s[3], description: s[2],
        amount: Math.round((45000 + r() * 620000) / 1000) * 1000,
        method: 'Bank transfer'
      });
    }
  }

  for (const [type, date, fund, party, description, amount] of CHURCH.uncoded) {
    await insertTx(client, orgId, { type, date, category: '', fund, party, description, amount, method: 'Bank transfer' });
  }

  for (let i = 0; i < CHURCH.pledges.length; i++) {
    const s = CHURCH.pledges[i];
    await insertDoc(client, orgId, 'invoice', 'PLG-' + (312 + i), members[s[0]], s[1], s[2], s[3], s[4]);
  }
  for (let i = 0; i < CHURCH.bills.length; i++) {
    const s = CHURCH.bills[i];
    await insertDoc(client, orgId, 'bill', 'BILL-' + (441 + i), vendors[s[0]], s[1], s[2], s[3], s[4]);
  }

  await insertBank(client, orgId, CHURCH.bank);
}

async function seedDemoBooks(client, orgId, bookType) {
  const church = bookType === 'church';
  await client.query(
    `UPDATE organizations
        SET state = $2, opening_cash = $3, owner_contributions = $4, fixed_assets = $5
      WHERE id = $1`,
    church ? [orgId, 'Ogun', 2750000, 0, 31000000] : [orgId, 'Lagos', 4200000, 6000000, 8500000]
  );
  if (church) await seedChurch(client, orgId);
  else await seedSME(client, orgId);
}

module.exports = { seedDemoBooks };
