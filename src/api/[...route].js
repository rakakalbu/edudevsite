// src/api/[...route].js
// One unified API entrypoint for Vercel Hobby plan (bypasses 12 function limit)

import authLogin from '../../lib/handlers/auth-login.js';
import authRegister from '../../lib/handlers/auth-register.js';
import registerFinalize from '../../lib/handlers/register-finalize.js';
import registerLeadConvert from '../../lib/handlers/register-lead-convert.js';
import registerOptions from '../../lib/handlers/register-options.js';
import registerSaveEducation from '../../lib/handlers/register-save-education.js';
import registerStatus from '../../lib/handlers/register-status.js';
import registerUploadPhoto from '../../lib/handlers/register-upload-photo.js';
import registerUploadProof from '../../lib/handlers/register-upload-proof.js';
import registerMain from '../../lib/handlers/register.js';
import salesforceQuery from '../../lib/handlers/salesforce-query.js';
import webtolead from '../../lib/handlers/webtolead.js';
import ping from './ping.js'; // you kept ping in /src/api

// Map route names to handlers
const routes = {
  'auth-login': authLogin,
  'auth-register': authRegister,
  'register-finalize': registerFinalize,
  'register-lead-convert': registerLeadConvert,
  'register-options': registerOptions,
  'register-save-education': registerSaveEducation,
  'register-status': registerStatus,
  'register-upload-photo': registerUploadPhoto,
  'register-upload-proof': registerUploadProof,
  'register': registerMain,
  'salesforce-query': salesforceQuery,
  'webtolead': webtolead,
  'ping': ping,
};

export default async function handler(req, res) {
  try {
    const [name] = req.query.route || [];
    const fn = routes[name];

    if (!fn) {
      res.status(404).json({ success: false, message: `Unknown API route: ${name}` });
      return;
    }

    // Delegate to the matching handler
    return fn(req, res);
  } catch (err) {
    console.error('Router error:', err);
    res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
}