// orders-service: a SECOND app, on purpose log-shaped differently from sample-app.
// We log fields like orderId / customerId / action / amount — so in Kibana you
// can practice filtering by service AND by app-specific fields.
const express = require('express');
const os = require('os');

const app = express();
const PORT = 3000;

// 'service' is a fixed field on every log line — easiest way to tell apps apart
// in Kibana when an org has dozens of microservices.
function log(level, msg, extra = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: 'orders-service',
    msg,
    hostname: os.hostname(),
    ...extra,
  }));
}

let nextOrderId = 1000;
const customers = ['cust_alice', 'cust_bob', 'cust_carol', 'cust_dan'];

app.get('/health', (req, res) => res.send('ok'));

app.post('/orders', (req, res) => {
  const orderId = `ord_${++nextOrderId}`;
  const customerId = customers[Math.floor(Math.random() * customers.length)];
  const amount = Math.round(Math.random() * 10000) / 100;
  log('info', 'order created', { orderId, customerId, amount, action: 'create' });
  res.status(201).json({ orderId, customerId, amount });
});

app.get('/orders/:id', (req, res) => {
  const found = Math.random() > 0.2;
  if (!found) {
    log('warn', 'order not found', { orderId: req.params.id, action: 'lookup' });
    return res.status(404).json({ error: 'not found' });
  }
  log('info', 'order fetched', { orderId: req.params.id, action: 'lookup' });
  res.json({ orderId: req.params.id, status: 'shipped' });
});

app.post('/payments/charge', (req, res) => {
  const orderId = `ord_${1000 + Math.floor(Math.random() * 200)}`;
  // Roll a fake failure 1 in 4
  const failed = Math.random() < 0.25;
  if (failed) {
    log('error', 'payment declined', {
      orderId,
      action: 'charge',
      code: 'CARD_DECLINED',
      gateway: 'stripe',
    });
    return res.status(402).json({ error: 'declined' });
  }
  log('info', 'payment captured', {
    orderId,
    action: 'charge',
    amount: Math.round(Math.random() * 5000) / 100,
    gateway: 'stripe',
  });
  res.json({ orderId, status: 'paid' });
});

// Periodic background log so the service has data even without traffic.
setInterval(() => log('info', 'pending orders scan', {
  action: 'cron',
  pendingCount: Math.floor(Math.random() * 10),
}), 15_000);

app.listen(PORT, () => log('info', `orders-service listening on ${PORT}`));
