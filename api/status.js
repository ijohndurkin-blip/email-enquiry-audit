// POST /api/status: checks the access key and says which optional features are switched on.
const ai = require('../lib/ai');
const { guard, send } = require('../lib/http');

module.exports = async function handler(req, res) {
  const body = await guard(req, res);
  if (!body) return;
  return send(res, 200, { ok: true, ai: ai.enabled(), aiModel: ai.enabled() ? ai.MODEL : null });
};
