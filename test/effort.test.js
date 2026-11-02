const test = require('node:test');
const assert = require('node:assert');
const { estimate, stripSignature, words } = require('../lib/effort');

test('signatures and sign-offs are not counted as writing', () => {
  assert.strictEqual(stripSignature('Hi Jo,\nYes we can.\nKind regards\nDarryn\n0151 000 0000'), 'Hi Jo,\nYes we can.');
  assert.strictEqual(words('500 cards for £45, ok?'), 5);
});

test('words alone: reading, writing and admin', () => {
  const reply = Array(100).fill('word').join(' '); // 100 words -> 5 min writing
  const e = estimate({ customerText: Array(240).fill('w').join(' '), replies: [{ text: reply }] });
  assert.deepStrictEqual(e.parts, { reading: 1, writing: 5, lookup: 0, admin: 1 });
  assert.strictEqual(e.minutes, 7);
});

test('context adds the hidden work; templates write faster', () => {
  const reply = Array(100).fill('word').join(' ');
  const quote = estimate({ customerText: '', replies: [{ text: reply, attachments: ['quote.pdf'], flags: { custom_quote: true, price_lookup: true, availability_check: true } }] });
  assert.strictEqual(quote.parts.lookup, 8 + 2 + 3); // custom quote replaces the plain price lookup
  assert.deepStrictEqual(quote.notes.sort(), ['attached a document', 'checked dates', 'worked out a quote']);
  const template = estimate({ customerText: '', replies: [{ text: reply, flags: { mostly_template: true } }] });
  assert.strictEqual(template.parts.writing, 1.5);
});
