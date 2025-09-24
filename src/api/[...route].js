// src/api/[...route].js
// Central router that forwards /api/<name> -> lib/handlers/<name>.js
// - Uses ROUTE_MAP first (aliases kept)
// - Falls back to generic "<name>.js"
// - Resolves relative to this file and process.cwd() (Vercel-safe)
// - Supports module.exports and default export

const path = require('path');
const fs = require('fs');

function sendJSON(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

const ROUTE_MAP = {
  // --- auth ---
  'auth-login'   : 'auth-login.js',
  'auth-register': 'auth-register.js',

  // --- register flow ---
  'register-lead-convert': 'register-lead-convert.js',
  'register-options'     : 'register-options.js',

  // Preferred short; long alias kept
  'register-save-educ'      : 'register-save-educ.js',
  'register-save-education' : 'register-save-educ.js',

  'register-upload-proof': 'register-upload-proof.js',
  'register-upload-photo': 'register-upload-photo.js',
  'register-finalize'    : 'register-finalize.js',
  'register-status'      : 'register-status.js',
  'register'             : 'register.js',

  // --- misc ---
  'salesforce-query': 'salesforce-query.js',
  'webtolead'       : 'webtolead.js',
};

const FALLBACK_FILENAMES = {
  'register-save-educ'     : 'register-save-education.js',
  'register-save-education': 'register-save-education.js',
};

function getRouteName(req) {
  const url = req.url || '';
  const m = url.match(/\/api\/([^/?#]+)/i);
  return (m && m[1]) ? m[1].toLowerCase() : '';
}

function handlerCandidates(routeName) {
  const relBase = path.resolve(__dirname, '../../lib/handlers');
  const cwdBase = path.join(process.cwd(), 'lib', 'handlers');

  const names = new Set();

  if (ROUTE_MAP[routeName]) names.add(ROUTE_MAP[routeName]);
  if (FALLBACK_FILENAMES[routeName]) names.add(FALLBACK_FILENAMES[routeName]);
  names.add(`${routeName}.js`);
  names.add(`${routeName}.mjs`);

  const files = Array.from(names);
  const paths = [];
  for (const f of files) {
    paths.push(path.join(relBase, f));
    paths.push(path.join(cwdBase, f));
  }
  return paths;
}

function tryLoadModule(routeName) {
  const candidates = handlerCandidates(routeName);
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      if (process.env.NODE_ENV !== 'production') {
        try { delete require.cache[require.resolve(p)]; } catch {}
      }
      return require(p);
    }
  }
  return null;
}

module.exports = async (req, res) => {
  try {
    const routeName = getRouteName(req);
    if (!routeName) {
      return sendJSON(res, 404, { success: false, message: 'No API route specified' });
    }

    const mod = tryLoadModule(routeName);
    if (!mod) {
      return sendJSON(res, 404, { success: false, message: `Unknown API route: ${routeName}` });
    }

    const handler =
      (typeof mod === 'function' && mod) ||
      (mod && typeof mod.default === 'function' && mod.default) ||
      null;

    if (!handler) {
      return sendJSON(res, 500, { success: false, message: `Handler is not a function for route: ${routeName}` });
    }

    return await handler(req, res);
  } catch (err) {
    console.error('API router error:', err);
    return sendJSON(res, 500, { success: false, message: err.message || 'Router error' });
  }
};