// src/api/[...route].js
// Central router that forwards /api/<name> to lib/handlers/<name>.js
// Lazily loads only the requested handler. Resolves paths relative to this file.

const path = require('path');
const fs = require('fs');

function sendJSON(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

// Map of route -> filename (inside lib/handlers)
const ROUTE_MAP = {
  // --- auth ---
  'auth-login': 'auth-login.js',
  'auth-register': 'auth-register.js',

  // --- register flow ---
  'register-lead-convert': 'register-lead-convert.js',
  'register-options': 'register-options.js',

  // Preferred short name; long name kept as alias below
  'register-save-educ': 'register-save-educ.js',
  'register-save-education': 'register-save-educ.js', // alias

  'register-upload-proof': 'register-upload-proof.js',
  'register-upload-photo': 'register-upload-photo.js',
  'register-finalize': 'register-finalize.js',
  'register-status': 'register-status.js',
  'register': 'register.js',

  // --- misc ---
  'salesforce-query': 'salesforce-query.js',
  'webtolead': 'webtolead.js',
};

// Extra filename fallbacks for certain routes (in case only the long filename exists)
const FALLBACK_FILENAMES = {
  'register-save-educ': 'register-save-education.js',
  'register-save-education': 'register-save-education.js',
};

function resolveHandlerPath(routeName) {
  // Resolve relative to this file, not process.cwd()
  const baseDir = path.resolve(__dirname, '../../lib/handlers');

  const candidates = [];

  // 1) Mapped filename
  if (ROUTE_MAP[routeName]) {
    candidates.push(path.join(baseDir, ROUTE_MAP[routeName]));
  }
  // 2) Known fallback filename (e.g., education ⇄ educ)
  if (FALLBACK_FILENAMES[routeName]) {
    candidates.push(path.join(baseDir, FALLBACK_FILENAMES[routeName]));
  }
  // 3) Generic guess to allow new handlers without changing this file
  candidates.push(path.join(baseDir, `${routeName}.js`));

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

module.exports = async (req, res) => {
  try {
    // Build URL safely behind proxies
    const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
    const host  = req.headers.host || 'localhost';
    const url   = new URL(req.url, `${proto}://${host}`);

    // /api/foo/ -> "foo"
    const name = url.pathname.replace(/^\/api\//, '').replace(/\/+$/, '');
    if (!name) {
      return sendJSON(res, 404, { success: false, message: 'No API route specified' });
    }

    const handlerPath = resolveHandlerPath(name);
    if (!handlerPath) {
      return sendJSON(res, 404, { success: false, message: `Unknown API route: ${name}` });
    }

    // In dev, clear cache so edits are picked up
    if (process.env.NODE_ENV !== 'production') {
      delete require.cache[require.resolve(handlerPath)];
    }

    const mod = require(handlerPath);
    const handler =
      typeof mod === 'function' ? mod :
      (mod && typeof mod.default === 'function' ? mod.default : null);

    if (!handler) {
      return sendJSON(res, 500, { success: false, message: `Handler is not a function for route: ${name}` });
    }

    return handler(req, res);
  } catch (err) {
    console.error('API router error:', err);
    return sendJSON(res, 500, { success: false, message: err.message || 'Router error' });
  }
};