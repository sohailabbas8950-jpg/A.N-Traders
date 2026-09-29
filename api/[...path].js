'use strict';

// Vercel serverless entry point for every /api/* request. This uses Vercel's
// native filesystem-based catch-all route (the [...path] segment) instead of
// a vercel.json rewrite -- a rewrite to a fixed destination like "/api/index"
// stopped preserving the real incoming path (Vercel started handing the
// function the literal destination path instead of the original request
// path, e.g. "/api/index" instead of "/api/login"), which made every route
// in lib/app.js's router fail to match. The catch-all filename guarantees
// req.url always carries the real, original request path, which is what our
// own router in lib/app.js needs to do its own routing.
const { handleApi } = require('../lib/app');

module.exports = async (req, res) => {
  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  await handleApi(req, res, url);
};
