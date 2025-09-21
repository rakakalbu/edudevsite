// src/api/[...route].js
const path = require('path');
const fs = require('fs');

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

function notFound(res, message = 'Unknown API route') {
  return json(res, 404, { success: false, message });
}

function allowCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-requested-with');
}

module.exports = async (req, res) => {
  try {
    allowCORS(res);
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }

    // Compute route name from URL after "/api/"
    // Example: /api/register-lead-convert?x=1  -> "register-lead-convert"
    const url = new URL(req.url, 'http://localhost');
    let slug = url.pathname.replace(/^\/+/, ''); // e.g. "api/register-lead-convert"
    if (!slug.toLowerCase().startsWith('api/')) {
      return notFound(res);
    }
    const name = slug.slice(4); // remove "api/"

    if (!name) return notFound(res);

    const handlerPath = path.join(process.cwd(), 'lib', 'handlers', `${name}.js`);
    if (!fs.existsSync(handlerPath)) {
      // Optional: allow ping in src/api if you keep it
      if (name === 'ping') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return json(res, 200, {
          ok: true,
          env_ready: Boolean(process.env.SF_LOGIN_URL && process.env.SF_USERNAME && process.env.SF_PASSWORD),
          now: new Date().toISOString(),
          route: 'ping (src/api)'
        });
      }
      return notFound(res, `Unknown API route: ${name}`);
    }

    // Load the handler (CommonJS)
    // Each file in lib/handlers/* exports: module.exports = async (req, res) => { ... }
    const handler = require(handlerPath);
    if (typeof handler !== 'function') {
      return json(res, 500, { success: false, message: `Handler ${name} is not a function` });
    }

    // Run the handler; it should send its own JSON response.
    // Wrap to ensure a JSON error if it throws.
    let finished = false;
    const originalEnd = res.end;
    res.end = function () { finished = true; return originalEnd.apply(this, arguments); };

    await handler(req, res);

    if (!finished) {
      // If a handler forgot to end the response, end with a generic OK.
      return json(res, 200, { success: true });
    }
  } catch (err) {
    console.error('Router error:', err);
    return json(res, 500, { success: false, message: err.message || 'Internal error' });
  }
};