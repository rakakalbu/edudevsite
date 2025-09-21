// src/api/[...route].js
// Single serverless entry that dispatches to your handlers in lib/handlers

import authLogin from '../../lib/handlers/auth-login.js';
import authRegister from '../../lib/handlers/auth-register.js';
import ping from '../../lib/handlers/ping.js';
import registerFinalize from '../../lib/handlers/register-finalize.js';
import registerLeadConvert from '../../lib/handlers/register-lead-convert.js';
import registerOptions from '../../lib/handlers/register-options.js';
import registerSaveEducation from '../../lib/handlers/register-save-education.js';
import registerStatus from '../../lib/handlers/register-status.js';
import registerUploadPhoto from '../../lib/handlers/register-upload-photo.js';
import registerUploadProof from '../../lib/handlers/register-upload-proof.js';
import register from '../../lib/handlers/register.js';
import salesforceQuery from '../../lib/handlers/salesforce-query.js';
import webtolead from '../../lib/handlers/webtolead.js';

const routes = {
  // auth
  'auth-login': authLogin,
  'auth-register': authRegister,

  // register flows
  'register': register,
  'register-finalize': registerFinalize,
  'register-lead-convert': registerLeadConvert,
  'register-options': registerOptions,
  'register-save-education': registerSaveEducation,
  'register-status': registerStatus,
  'register-upload-photo': registerUploadPhoto,
  'register-upload-proof': registerUploadProof,

  // misc
  'salesforce-query': salesforceQuery,
  'webtolead': webtolead,
  'ping': ping,
};

export default async function handler(req, res) {
  try {
    // 1) First try the standard catch-all param from Vercel
    let segs = req.query?.route;

    // 2) Fallback: parse from req.url in case (some hosts/tools) don't populate req.query.route
    if (!segs || (Array.isArray(segs) && segs.length === 0)) {
      // req.url is like: /api/register-lead-convert?x=1
      const m = req.url.match(/\/api\/([^/?#]+)/i);
      if (m) segs = [decodeURIComponent(m[1])];
    }

    const routeKey = Array.isArray(segs) ? segs[0] : segs;

    // Helpful debug header so you can see what the router observed
    res.setHeader('x-router-route', String(routeKey ?? 'null'));
    res.setHeader('x-router-url', req.url || '');

    const fn = routes[routeKey];
    if (!fn) {
      res.status(404).json({ success: false, message: `Unknown API route: ${String(routeKey)}` });
      return;
    }

    return await fn(req, res);
  } catch (err) {
    console.error('Router error:', err);
    res.status(500).json({ success: false, message: err?.message || 'Router failed' });
  }
}