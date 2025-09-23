// src/api/[...route].js
// Central router that forwards /api/<name> to lib/handlers/<name>.js
// Lazily loads only the requested handler and supports safe aliases.

const path = require('path');
const fs = require('fs');

function sendJSON(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

// Map of route -> filename (relative to lib/handlers).
// Values are *filenames*, not required modules. We'll require lazily.
const ROUTE_MAP = {
  // --- auth ---
  'auth-login': 'auth-login.js',
  'auth-register': 'auth-register.js',

  // --- register flow ---
  'register-lead-convert': 'register-lead-convert.js',
  'register-options': 'register-options.js',

  // Prefer the short name. We'll also alias the long name below.
  'register-save-educ': 'register-save-educ.js',
  'register-save-education': 'register-save-educ.js', // alias to the same file

  'register-upload-proof': 'register-upload-proof.js',
  'register-upload-photo': 'register-upload-photo.js',
  'register-finalize': 'register-finalize.js',
  'register-status': 'register-status.js',
  'register': 'register.js',

  // --- misc still used ---
  'salesforce-query': 'salesforce-query.js',
  'webtolead': 'webtolead.js',
};

// Some deployments may only contain the longer filename.
// Provide a secondary filename fallback per route if the primary isn't found.
const FALLBACK_FILENAMES = {
  'register-save-educ': 'register-save-education.js',
  'register-save-education': 'register-save-education.js',
};

function resolveHandlerPath(routeName) {
  const baseDir = path.join(process.cwd(), 'lib', 'handlers');

  // Candidates in order of preference:
  const candidates = [];

  // 1) Explicit mapping if present
  if (ROUTE_MAP[routeName]) {
    candidates.push(path.join(baseDir, ROUTE_MAP[routeName]));
  }

  // 2) Fallback filename for known aliases (e.g., education ⇄ educ)
  if (FALLBACK_FILENAMES[routeName]) {
    candidates.push(path.join(baseDir, FALLBACK_FILENAMES[routeName]));
  }

  // 3) Generic guess: <routeName>.js (lets you add new files without updating this map)
  candidates.push(path.join(baseDir, `${routeName}.js`));

  // Pick the first that exists
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

    // /api/foo/bar -> "foo/bar" (we only support top-level files, but keep this robust)
    const name = url.pathname.replace(/^\/api\//, '').replace(/\/+$/, '');

    if (!name) {
      return sendJSON(res, 404, { success: false, message: 'No API route specified' });
    }

    const handlerPath = resolveHandlerPath(name);
    if (!handlerPath) {
      return sendJSON(res, 404, { success: false, message: `Unknown API route: ${name}` });
    }

    // Clear cache in dev to reflect file changes without restarts
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