'use strict';

// Vercel serverless entry point. Every /api/* request is rewritten here by
// vercel.json; the static files under public/ are served by Vercel directly.
const { handleApi } = require('../lib/app');

module.exports = async (req, res) => {
  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  await handleApi(req, res, url);
};
