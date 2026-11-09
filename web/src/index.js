const express = require('express');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');

const PORT = process.env.PORT || 8080;
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://gateway:3000';

const app = express();

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'web-client' }));

// The browser only ever talks to this origin. Anything under /api is forwarded
// to the API gateway with the "/api" prefix removed, so there is no CORS
// configuration to maintain and the browser never learns the gateway address.
app.use(createProxyMiddleware({
  target: GATEWAY_URL,
  changeOrigin: true,
  pathFilter: '/api',
  pathRewrite: { '^/api': '' },
}));

app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => console.log(`web-client listening on ${PORT}`));
