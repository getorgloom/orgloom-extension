const MAX_BYTES = 4 * 1024 * 1024;
const allowedKey = key => typeof key === 'string' && (key.startsWith('orgloom') || key.startsWith('org-loom'));
function validateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) return null;
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_BYTES) return null;
  const output = { version: 1, local: {}, session: {} };
  for (const kind of ['local', 'session']) {
    if (!value[kind] || typeof value[kind] !== 'object' || Array.isArray(value[kind])) return null;
    for (const [key, text] of Object.entries(value[kind])) {
      if (!allowedKey(key) || typeof text !== 'string') return null;
      output[kind][key] = text;
    }
  }
  return output;
}
module.exports = { validateState, MAX_BYTES };
