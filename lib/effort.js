// Estimates how long a person spent handling an enquiry by hand, from the real emails.
// Words give reading and writing time; the context of each reply (prices, quotes, dates,
// attachments, templates) adds the hidden work. Every figure is a simple, visible rule.

const RATES = {
  readWordsPerMin: 240,  // reading the customer's emails
  writeWordsPerMin: 20,  // composing a reply (thinking + typing), not copy-typing
  adminPerReply: 1,      // opening it, finding the email, sending
  priceLookup: 2,        // quoted prices from a price list
  customQuote: 8,        // worked out a bespoke quote (sizes, quantities, several items)
  availability: 2,       // checked the diary / dates / stock
  technical: 2,          // answered a technical or product question
  attachment: 3,         // attached a quote, document or photos
  templateWriting: 0.3,  // a mostly standard reply: writing takes ~30% of the time
};

const words = (text) => (String(text || '').match(/[A-Za-z0-9£$€][\w'’£$€.,%-]*/g) || []).length;

/** Drop the sign-off and signature: the business didn't write those afresh each time. */
function stripSignature(text) {
  const lines = String(text || '').split(/\r?\n/);
  const at = lines.findIndex((l, i) => i >= 1 && /^\s*(kind regards|best regards|warm regards|regards|many thanks|thanks( again)?|thank you|cheers|best wishes|all the best|--)\s*[,!.]?\s*$/i.test(l));
  return (at === -1 ? lines : lines.slice(0, at)).join('\n');
}

/**
 * @param {{ customerText: string, replies: { text: string, attachments?: string[], flags?: object }[] }} enquiry
 *   flags (from AI, optional): price_lookup, custom_quote, availability_check, technical_answer, mostly_template
 * @returns {{ minutes, parts: { reading, writing, lookup, admin }, customerWords, replyWords, notes: string[] }}
 */
function estimate({ customerText, replies }) {
  const customerWords = words(customerText);
  const reading = customerWords / RATES.readWordsPerMin;
  let writing = 0; let lookup = 0; let admin = 0; let replyWords = 0;
  const notes = new Set();
  for (const r of replies) {
    const w = words(stripSignature(r.text));
    replyWords += w;
    const f = r.flags || {};
    writing += (w / RATES.writeWordsPerMin) * (f.mostly_template ? RATES.templateWriting : 1);
    admin += RATES.adminPerReply;
    if (f.custom_quote) { lookup += RATES.customQuote; notes.add('worked out a quote'); } else if (f.price_lookup) { lookup += RATES.priceLookup; notes.add('looked up prices'); }
    if (f.availability_check) { lookup += RATES.availability; notes.add('checked dates'); }
    if (f.technical_answer) { lookup += RATES.technical; notes.add('technical answer'); }
    if ((r.attachments || []).length) { lookup += RATES.attachment; notes.add('attached a document'); }
    if (f.mostly_template) notes.add('mostly a standard reply');
  }
  const round = (x) => Math.round(x * 10) / 10;
  const parts = { reading: round(reading), writing: round(writing), lookup: round(lookup), admin: round(admin) };
  return { minutes: round(reading + writing + lookup + admin), parts, customerWords, replyWords, notes: [...notes] };
}

module.exports = { estimate, stripSignature, words, RATES };
