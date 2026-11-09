const amqp = require('amqplib');

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://rabbitmq';
const EXCHANGE = 'library_events';

let channel = null;

// RabbitMQ's container is usually still starting when this service boots,
// so connect with retries.
async function connectWithRetry(retries = 10, delayMs = 3000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const conn = await amqp.connect(RABBITMQ_URL);
      channel = await conn.createChannel();
      await channel.assertExchange(EXCHANGE, 'fanout', { durable: false });
      console.log('[loans-service] connected to RabbitMQ');
      return;
    } catch (err) {
      console.log(`[loans-service] RabbitMQ not ready (attempt ${attempt}/${retries}): ${err.message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  console.log('[loans-service] giving up on RabbitMQ -- events will be skipped');
}

function publishEvent(type, payload) {
  if (!channel) {
    console.log(`[loans-service] no channel, dropping event ${type}`);
    return;
  }
  const message = JSON.stringify({ type, payload, ts: new Date().toISOString() });
  channel.publish(EXCHANGE, '', Buffer.from(message));
  console.log(`[loans-service] published event: ${type}`);
}

module.exports = { connectWithRetry, publishEvent };
