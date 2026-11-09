const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const Database = require('better-sqlite3');
const path = require('path');
const { connectWithRetry, publishEvent } = require('./events');

const PORT = process.env.PORT || 3003;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const CATALOG_URL = process.env.CATALOG_URL || 'http://catalog:3002';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'loans.db');
const LOAN_DAYS = 14;

const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS loans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    book_id INTEGER NOT NULL,
    book_title TEXT,
    borrowed_at TEXT DEFAULT CURRENT_TIMESTAMP,
    due_at TEXT NOT NULL,
    returned_at TEXT
  )
`);

const app = express();
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  console.log(`[loans-service] ${req.method} ${req.path}`);
  next();
});

// Verifies the JWT locally with the shared secret instead of calling
// auth-service on every request: fewer network hops, but every service that
// verifies tokens must hold the secret.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
}

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'loans-service' }));

app.post('/loans', requireAuth, async (req, res) => {
  const bookId = Number((req.body || {}).bookId);
  if (!bookId) return res.status(400).json({ error: 'bookId is required' });

  // Synchronous call: the caller needs a real answer before anything is saved.
  let book;
  try {
    const reserveRes = await axios.post(`${CATALOG_URL}/books/${bookId}/reserve`, {}, { timeout: 2000 });
    book = reserveRes.data;
  } catch (err) {
    if (err.response && err.response.status === 409) return res.status(409).json({ error: 'no copies available' });
    if (err.response && err.response.status === 404) return res.status(404).json({ error: 'book not found' });
    return res.status(503).json({ error: 'catalog-service unavailable, try again shortly' });
  }

  const dueAt = new Date(Date.now() + LOAN_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let loan;
  try {
    const info = db
      .prepare('INSERT INTO loans (user_id, book_id, book_title, due_at) VALUES (?, ?, ?, ?)')
      .run(req.user.sub, bookId, book.title, dueAt);
    loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(info.lastInsertRowid);
  } catch (err) {
    // Compensating action: the copy was reserved but the loan could not be
    // saved, so give the copy back instead of leaking it.
    console.log(`[loans-service] saving loan failed, releasing copy: ${err.message}`);
    await axios.post(`${CATALOG_URL}/books/${bookId}/release`, {}, { timeout: 2000 }).catch(() => {});
    return res.status(500).json({ error: 'could not save loan' });
  }

  publishEvent('loan.created', {
    loanId: loan.id,
    userId: req.user.sub,
    username: req.user.username,
    bookId,
    bookTitle: book.title,
    dueAt,
  });

  res.status(201).json(loan);
});

app.post('/loans/:id/return', requireAuth, async (req, res) => {
  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
  if (!loan) return res.status(404).json({ error: 'loan not found' });
  if (loan.user_id !== req.user.sub) return res.status(403).json({ error: 'not your loan' });
  if (loan.returned_at) return res.status(409).json({ error: 'already returned' });

  try {
    await axios.post(`${CATALOG_URL}/books/${loan.book_id}/release`, {}, { timeout: 2000 });
  } catch (err) {
    console.log(`[loans-service] warning: failed to release copy in catalog: ${err.message}`);
  }

  const returnedAt = new Date().toISOString();
  db.prepare('UPDATE loans SET returned_at = ? WHERE id = ?').run(returnedAt, loan.id);
  const updated = db.prepare('SELECT * FROM loans WHERE id = ?').get(loan.id);

  publishEvent('loan.returned', {
    loanId: loan.id,
    userId: req.user.sub,
    username: req.user.username,
    bookId: loan.book_id,
    bookTitle: loan.book_title,
  });

  res.json(updated);
});

app.get('/loans/mine', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM loans WHERE user_id = ? ORDER BY id DESC').all(req.user.sub);
  res.json(rows);
});

connectWithRetry().then(() => {
  app.listen(PORT, () => console.log(`loans-service listening on ${PORT}`));
});
