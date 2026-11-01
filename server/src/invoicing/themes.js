// Five invoice designs.
//
// One layout, five themes, rather than five copies of the same file — because
// five copies is five places a fix has to be made, and the fourth one always
// gets missed. What differs between them is what actually differs between
// real invoice designs: the colour, the weight of the header, how the table
// is ruled, and the typographic scale. Everything structural is shared.
//
// Deliberately not black and gold, which is the app's own identity and makes
// a poor document: an invoice is read on paper and in a bank's inbox, and it
// should look like the customer's business rather than like ours.

const THEMES = {
  // Refined corporate. Deep navy, hairline rules, nothing shouting.
  executive: {
    label: 'Executive Minimal',
    ink: '#101828',
    muted: '#5A6474',
    faint: '#98A2B3',
    accent: '#1B2A4A',
    accentText: '#FFFFFF',
    rule: '#E4E7EC',
    band: '#F8F9FB',
    // 'bar' fills the top, 'rule' draws a line under it, 'plain' does neither.
    header: 'rule',
    headingSize: 26,
    headingSpacing: 1.4,
    tableHead: 'band',
    radius: 0
  },

  // Clean, confident, technology-led. Teal accent on white.
  fintech: {
    label: 'Modern FinTech',
    ink: '#0B1B2B',
    muted: '#4A6070',
    faint: '#90A4B4',
    accent: '#0E7C86',
    accentText: '#FFFFFF',
    rule: '#D8E6EA',
    band: '#F0F8F9',
    header: 'bar',
    headingSize: 24,
    headingSpacing: 0.6,
    tableHead: 'accent',
    radius: 4
  },

  // What an established firm sends. Serif heading, formal spacing.
  classic: {
    label: 'Professional Classic',
    ink: '#1A1A1A',
    muted: '#555555',
    faint: '#8C8C8C',
    accent: '#2F3E46',
    accentText: '#FFFFFF',
    rule: '#CFCFCF',
    band: '#F4F4F2',
    header: 'rule',
    headingSize: 23,
    headingSpacing: 2.2,
    serifHeading: true,
    tableHead: 'rules',
    radius: 0
  },

  // For studios and agencies. Warm, high contrast, generous.
  creative: {
    label: 'Creative Studio',
    ink: '#241C2E',
    muted: '#5E5470',
    faint: '#9B91AC',
    accent: '#B5446E',
    accentText: '#FFFFFF',
    rule: '#E8DFEE',
    band: '#FBF4F7',
    header: 'bar',
    headingSize: 30,
    headingSpacing: -0.4,
    tableHead: 'accent',
    radius: 6
  },

  // Quiet money. Almost no colour, a lot of air, one gold hairline.
  luxury: {
    label: 'Luxury Business',
    ink: '#14110E',
    muted: '#6B6358',
    faint: '#A79C8C',
    accent: '#8A6A2F',
    accentText: '#FFFFFF',
    rule: '#E6E0D6',
    band: '#FAF8F4',
    header: 'plain',
    headingSize: 21,
    headingSpacing: 4.5,
    tableHead: 'rules',
    radius: 0
  }
};

const NAMES = Object.keys(THEMES);
const DEFAULT = 'executive';

// An unknown name falls back rather than throwing: a template that was
// renamed should not stop an invoice from being issued.
function theme(name, overrides) {
  const base = THEMES[name] || THEMES[DEFAULT];
  if (!overrides) return base;
  // A business can set its own brand colour without forking a theme.
  const clean = {};
  for (const key of ['accent', 'accentText', 'ink']) {
    if (/^#[0-9a-fA-F]{6}$/.test(String(overrides[key] || ''))) clean[key] = overrides[key];
  }
  return Object.assign({}, base, clean);
}

module.exports = { THEMES, NAMES, DEFAULT, theme };
