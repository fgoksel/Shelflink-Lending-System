const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');

const PORT = process.env.PORT || 3002;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'catalog.db');

const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    total_copies INTEGER NOT NULL,
    available_copies INTEGER NOT NULL
  )
`);

const count = db.prepare('SELECT COUNT(*) AS c FROM books').get().c;
if (count === 0) {
  const seed = db.prepare('INSERT INTO books (title, author, total_copies, available_copies) VALUES (?, ?, ?, ?)');
  seed.run('Clean Code', 'Robert C. Martin', 2, 2);
  seed.run('Designing Data-Intensive Applications', 'Martin Kleppmann', 1, 1);
  seed.run('Building Microservices', 'Sam Newman', 3, 3);
  seed.run('The Pragmatic Programmer', 'David Thomas & Andrew Hunt', 2, 2);
}

const app = express();
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  console.log(`[catalog-service] ${req.method} ${req.path}`);
  next();
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'catalog-service' }));

app.get('/books', (req, res) => {
  const { search } = req.query;
  let rows;
  if (search) {
    const like = `%${String(search).toLowerCase()}%`;
    rows = db.prepare('SELECT * FROM books WHERE LOWER(title) LIKE ? OR LOWER(author) LIKE ?').all(like, like);
  } else {
    rows = db.prepare('SELECT * FROM books').all();
  }
  res.json(rows);
});

app.get('/books/:id', (req, res) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'book not found' });
  res.json(book);
});

// Called by loans-service. The check and the decrement are ONE atomic SQL
// statement, so two concurrent requests for the last copy cannot both win.
app.post('/books/:id/reserve', (req, res) => {
  const info = db
    .prepare('UPDATE books SET available_copies = available_copies - 1 WHERE id = ? AND available_copies > 0')
    .run(req.params.id);
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'book not found' });
  if (info.changes === 0) return res.status(409).json({ error: 'no copies available' });
  res.json(book);
});

app.post('/books/:id/release', (req, res) => {
  db.prepare('UPDATE books SET available_copies = MIN(total_copies, available_copies + 1) WHERE id = ?').run(req.params.id);
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'book not found' });
  res.json(book);
});

app.listen(PORT, () => console.log(`catalog-service listening on ${PORT}`));
