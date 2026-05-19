const express = require('express');
const os = require('os');

const app = express();
const PORT = 3000;

app.get('/', (req, res) => {
  res.json({
    message: 'Hello from backend via Ingress',
    hostname: os.hostname(),
    path: req.path,
    time: new Date().toISOString(),
  });
});

app.get('/api/hello', (req, res) => {
  res.json({ from: 'backend', hostname: os.hostname() });
});

app.get('/health', (req, res) => res.send('ok'));

app.listen(PORT, () => console.log(`backend listening on ${PORT}`));
