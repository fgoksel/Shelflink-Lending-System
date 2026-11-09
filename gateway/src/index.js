const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');

const PORT = process.env.PORT || 3000;
const AUTH_URL = process.env.AUTH_URL || 'http://auth:3001';
const CATALOG_URL = process.env.CATALOG_URL || 'http://catalog:3002';
const LOANS_URL = process.env.LOANS_URL || 'http://loans:3003';
const NOTIFICATIONS_URL = process.env.NOTIFICATIONS_URL || 'http://notifications:3004';

const app = express();
app.use(cors());

app.use((req, res, next) => {
  console.log(`[gateway] ${req.method} ${req.originalUrl}`);
  next();
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'api-gateway' }));

// Routing uses `pathFilter` instead of app.use('/prefix', proxy). Mounting on
// a prefix makes Express strip it from req.url, so the downstream service
// would receive "/" instead of "/books" and answer 404.
app.use(createProxyMiddleware({
  target: AUTH_URL,
  changeOrigin: true,
  pathFilter: '/auth',
  pathRewrite: { '^/auth': '' },
}));
app.use(createProxyMiddleware({ target: CATALOG_URL, changeOrigin: true, pathFilter: '/books' }));
app.use(createProxyMiddleware({ target: LOANS_URL, changeOrigin: true, pathFilter: '/loans' }));
app.use(createProxyMiddleware({ target: NOTIFICATIONS_URL, changeOrigin: true, pathFilter: '/notifications' }));

app.listen(PORT, () => console.log(`api-gateway listening on ${PORT}`));
