// src/api/[...route].js
// Central router that forwards /api/<name> to lib/handlers/<name>.js

function sendJSON(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

let handlers;
function getHandlers() {
  if (!handlers) {
    handlers = {
      // --- auth ---
      'auth-login': require('../../lib/handlers/auth-login.js'),
      'auth-register': require('../../lib/handlers/auth-register.js'),

      // --- register flow ---
      'register-lead-convert': require('../../lib/handlers/register-lead-convert.js'),
      'register-options': require('../../lib/handlers/register-options.js'),

      // ✅ correct route name (matches your file lib/handlers/register-save-educ.js)
      'register-save-educ': require('../../lib/handlers/register-save-educ.js'),

      // ✅ backward-compat alias (both routes hit the same handler)
      'register-save-education': require('../../lib/handlers/register-save-educ.js'),

      'register-upload-proof': require('../../lib/handlers/register-upload-proof.js'),
      'register-upload-photo': require('../../lib/handlers/register-upload-photo.js'),
      'register-finalize': require('../../lib/handlers/register-finalize.js'),
      'register-status': require('../../lib/handlers/register-status.js'),
      'register': require('../../lib/handlers/register.js'),

      // --- misc still used ---
      'salesforce-query': require('../../lib/handlers/salesforce-query.js'),
      'webtolead': require('../../lib/handlers/webtolead.js'),
    };
  }
  return handlers;
}

module.exports = async (req, res) => {
  try {
    // Build a URL safely even in dev servers without HTTPS
    const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
    const base  = `${proto}://${req.headers.host || 'localhost'}`;
    const url   = new URL(req.url, base);

    // e.g. /api/register-save-educ/ -> "register-save-educ"
    const name = url.pathname.replace(/^\/api\//, '').replace(/\/+$/, '');

    const map = getHandlers();
    const handler = map[name];

    if (!name || !handler) {
      return sendJSON(res, 404, { success: false, message: `Unknown API route: ${name || ''}` });
    }

    // Delegate to the selected handler (CommonJS (req,res)=>{} module)
    return handler(req, res);
  } catch (err) {
    console.error('API router error:', err);
    return sendJSON(res, 500, { success: false, message: err.message || 'Router error' });
  }
};