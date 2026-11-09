const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const path = require('path');

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'auth.db');

const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

const app = express();
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  console.log(`[auth-service] ${req.method} ${req.path}`);
  next();
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'auth-service' }));

app.post('/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(409).json({ error: 'username already taken' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
  return res.status(201).json({ id: info.lastInsertRowid, username });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = username ? db.prepare('SELECT * FROM users WHERE username = ?').get(username) : null;
  if (!user || !password || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const token = jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: '12h' });
  return res.json({ token, username: user.username });
});

// Lets other services verify a token without sharing the database.
app.post('/verify', (req, res) => {
  const { token } = req.body || {};
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return res.json({ valid: true, payload });
  } catch (err) {
    return res.status(401).json({ valid: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`auth-service listening on ${PORT}`));
