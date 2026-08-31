// Keyword matcher ported from the prototype's KEYWORDS table. It runs first
// because it is instant and free; the model is only consulted for narrations
// it cannot place.

const KEYWORDS = [
  [/rent|landlord|lease/i, 'Rent - Business Premises'],
  [/salar|payroll|wages|staff pay/i, 'Salaries & Wages'],
  [/ikeja electric|eko disco|phcn|nepa|electric|water board|generator diesel/i, 'Utilities'],
  [/uber|bolt|fuel|petrol|diesel|transport|logistics|gig/i, 'Transport & Fuel'],
  [/audit|legal|solicitor|consult fee|accountant|advisory/i, 'Professional Fees'],
  [/facebook|meta ads|google ads|billboard|flyer|advert|marketing|radio spot/i, 'Marketing & Advertising'],
  [/mtn|airtel|glo|spectranet|starlink|internet|airtime|data bundle/i, 'Internet & Telephone'],
  [/insur|axa|leadway/i, 'Insurance'],
  [/repair|maintenance|servicing|spare part/i, 'Repairs & Maintenance'],
  [/bank charge|sms alert|stamp duty|transfer fee|commission on turnover|cot/i, 'Bank Charges'],
  [/training|seminar|course|workshop/i, 'Staff Training'],
  [/restaurant|lunch|dinner|hotel|client entertain/i, 'Entertainment'],
  [/stock|goods|supplier|wholesale|purchase of/i, 'Inventory Purchases'],
  [/tithe/i, 'Tithes'],
  [/offering/i, 'Sunday Offering'],
  [/building/i, 'Building Fund Giving'],
  [/mission/i, 'Missions Giving'],
  [/donat|grant/i, 'Donations & Grants'],
  [/stipend|payroll|salar/i, 'Pastoral Salaries'],
  [/welfare|benevolen|relief/i, 'Benevolence & Welfare'],
  [/remittance|missionary|mission/i, 'Missions Support'],
  [/roof|facility|building maint|caretaker/i, 'Building Maintenance'],
  [/print|flyer|programme|convention|outreach|crusade/i, 'Church Programmes'],
  [/sound|console|camera|stream|media/i, 'Media & Sound'],
  [/stationery|bookshop|office|admin/i, 'Administrative']
];

function byKeyword(text, allowed) {
  for (const [re, category] of KEYWORDS) {
    if (re.test(text) && allowed.includes(category)) return category;
  }
  return null;
}

module.exports = { KEYWORDS, byKeyword };
