// src/api/[...route].js
// Central router that forwards /api/<name> -> lib/handlers/<name>.js
// - Uses your ROUTE_MAP first (aliases kept)
// - Falls back to generic "<name>.js" so new handlers work without editing this file
// - Resolves paths relative to this file and process.cwd() (Vercel-safe)
// - Supports both module.exports and default export

const path = require('path');
const fs = require('fs');

function sendJSON(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

// ---------- Route map (your aliases preserved) ----------
const ROUTE_MAP = {
  // --- auth ---
  'auth-login'   : 'auth-login.js',
  'auth-register': 'auth-register.js',

  // --- register flow ---
  'register-lead-convert': 'register-lead-convert.js',
  'register-options'     : 'register-options.js',

  // Short + long name kept as aliases
  'register-save-educ'      : 'register-save-educ.js',
  'register-save-education' : 'register-save-educ.js', // alias -> same file

  'register-upload-proof': 'register-upload-proof.js',
  'register-upload-photo': 'register-upload-photo.js',
  'register-finalize'    : 'register-finalize.js',
  'register-status'      : 'register-status.js',
  'register'             : 'register.js',

  // --- misc ---
  'salesforce-query': 'salesforce-query.js',
  'webtolead'       : 'webtolead.js'
};

// Extra filename fallbacks for historical names
const FALLBACK_FILENAMES = {
  'register-save-educ'     : 'register-save-education.js',
  'register-save-education': 'register-save-education.js'
};

// ---------- Utils ----------
function getRouteName(req) {
  // Be robust to proxies and query strings
  // Extract only the first segment after /api/
  const url = req.url || '';
  const m = url.match(/\/api\/([^/?#]+)/i);
  return (m && m[1]) ? m[1].toLowerCase() : '';
}

function handlerCandidates(routeName) {
  const relBase = path.resolve(__dirname, '../../lib/handlers'); // relative to this file
  const cwdBase = path.join(process.cwd(), 'lib', 'handlers');   // process root (Vercel)

  const names = new Set();

  // 1) Mapped filename (primary)
  if (ROUTE_MAP[routeName]) names.add(ROUTE_MAP[routeName]);

  // 2) Known fallbacks
  if (FALLBACK_FILENAMES[routeName]) names.add(FALLBACK_FILENAMES[routeName]);

  // 3) Generic guesses
  names.add(`${routeName}.js`);
  names.add(`${routeName}.mjs`); // just in case

  // Build full path candidates across both bases
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
      // In dev, clear require cache so edits are picked up immediately
      if (process.env.NODE_ENV !== 'production') {
        try { delete require.cache[require.resolve(p)]; } catch {}
      }
      return require(p);
    }
  }
  return null;
}

// ---------- Router ----------
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
    return sendJSON(res, 500, { success: false, message: err?.message || 'Router error' });
  }
};