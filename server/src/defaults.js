// Chart of accounts seeded onto a new organisation. Mirrors the prototype's
// SME_INCOME / SME_EXPENSE / CH_INCOME / CH_EXPENSE constants, including the
// deductibility percentages from the tax rules sheet.

const SME_INCOME = ['Product Sales', 'Service Fees', 'Consulting', 'Subscription Revenue', 'Other Income'];

const SME_EXPENSE = [
  ['Rent - Business Premises', 100], ['Salaries & Wages', 100], ['Inventory Purchases', 100],
  ['Utilities', 100], ['Transport & Fuel', 100], ['Professional Fees', 100],
  ['Marketing & Advertising', 100], ['Internet & Telephone', 100], ['Repairs & Maintenance', 100],
  ['Insurance', 100], ['Bank Charges', 100], ['Staff Training', 100],
  ['Entertainment', 50], ['Owner Drawings', 0], ['Fines & Penalties', 0]
];

const CH_INCOME = ['Tithes', 'Sunday Offering', 'Special Offering', 'Building Fund Giving', 'Missions Giving', 'Donations & Grants'];

const CH_EXPENSE = [
  ['Pastoral Salaries', 100], ['Benevolence & Welfare', 100], ['Missions Support', 100],
  ['Building Maintenance', 100], ['Utilities', 100], ['Church Programmes', 100],
  ['Media & Sound', 100], ['Transport', 100], ['Administrative', 100], ['Bank Charges', 100]
];

const FUNDS = ['General Fund', 'Building Fund', 'Missions Fund', 'Benevolence Fund'];

async function seedChartOfAccounts(client, orgId, bookType) {
  const church = bookType === 'church';
  const income = church ? CH_INCOME : SME_INCOME;
  const expense = church ? CH_EXPENSE : SME_EXPENSE;

  for (let i = 0; i < income.length; i++) {
    await client.query(
      'INSERT INTO income_categories (organization_id, name, sort_order) VALUES ($1, $2, $3)',
      [orgId, income[i], i]
    );
  }
  for (let i = 0; i < expense.length; i++) {
    await client.query(
      'INSERT INTO expense_categories (organization_id, name, deductible_pct, sort_order) VALUES ($1, $2, $3, $4)',
      [orgId, expense[i][0], expense[i][1], i]
    );
  }
  if (church) {
    for (let i = 0; i < FUNDS.length; i++) {
      await client.query(
        'INSERT INTO funds (organization_id, name, sort_order) VALUES ($1, $2, $3)',
        [orgId, FUNDS[i], i]
      );
    }
  }
}

module.exports = { SME_INCOME, SME_EXPENSE, CH_INCOME, CH_EXPENSE, FUNDS, seedChartOfAccounts };
