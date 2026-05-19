// Backend with an endpoint that BURNS CPU on demand — so we can trigger the HPA.
const express = require('express');
const os = require('os');

const app = express();
const PORT = 3000;

app.get('/', (req, res) => {
  res.json({ hostname: os.hostname(), msg: 'hit /burn?ms=500 to drive CPU up' });
});

// Burn the event loop for `ms` milliseconds. Synchronous on purpose.
app.get('/burn', (req, res) => {
  const ms = Math.min(parseInt(req.query.ms, 10) || 200, 5000);
  const end = Date.now() + ms;
  let x = 0;
  while (Date.now() < end) { x = Math.sqrt(x + Math.random()); }
  res.json({ hostname: os.hostname(), burnedMs: ms, x });
});

app.get('/health', (req, res) => res.send('ok'));
app.listen(PORT, () => console.log(`cpu-burner on ${PORT}`));
