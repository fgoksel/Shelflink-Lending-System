const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const amqp = require('amqplib');
const Database = require('better-sqlite3');
const path = require('path');

const PORT = process.env.PORT || 3004;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://rabbitmq';
const EXCHANGE = 'library_events';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'notifications.db');

const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

function messageFor(event) {
  const p = event.payload;
  if (event.type === 'loan.created') {
    return `You borrowed "${p.bookTitle}". Due back ${new Date(p.dueAt).toDateString()}.`;
  }
  if (event.type === 'loan.returned') {
    return `Thanks for returning "${p.bookTitle || 'book #' + p.bookId}".`;
  }
  return `Event: ${event.type}`;
}

// notification-service does not know loans-service exists: it only listens to
// the exchange. The queue is durable, so events published while this service
// is down are delivered when it reconnects.
async function startConsumer(retries = 10, delayMs = 3000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const conn = await amqp.connect(RABBITMQ_URL);
      const channel = await conn.createChannel();
      await channel.assertExchange(EXCHANGE, 'fanout', { durable: false });
      const q = await channel.assertQueue('notifications_queue', { durable: true });
      await channel.bindQueue(q.queue, EXCHANGE, '');
      channel.consume(q.queue, (msg) => {
        if (!msg) return;
        const event = JSON.parse(msg.content.toString());
        const message = messageFor(event);
        db.prepare('INSERT INTO notifications (user_id, message) VALUES (?, ?)').run(event.payload.userId, message);
        console.log(`[notification-service] stored notification for user ${event.payload.userId}: ${message}`);
        channel.ack(msg);
      });
      console.log('[notification-service] consuming events from RabbitMQ');
      return;
    } catch (err) {
      console.log(`[notification-service] RabbitMQ not ready (attempt ${attempt}/${retries}): ${err.message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  console.log('[notification-service] giving up on RabbitMQ connection');
}

const app = express();
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  console.log(`[notification-service] ${req.method} ${req.path}`);
  next();
});

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

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'notification-service' }));

// Polled by the web client.
app.get('/notifications/mine', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 20')
    .all(req.user.sub);
  res.json(rows);
});

startConsumer();
app.listen(PORT, () => console.log(`notification-service listening on ${PORT}`));
