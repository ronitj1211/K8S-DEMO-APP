const express = require('express');
const os = require('os');

const app = express();
const PORT = 3000;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/', (req, res) => {
  res.json({
    message: 'Hello from backend Pod',
    hostname: os.hostname(),
    podIP: process.env.POD_IP || 'unknown',
    time: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => res.send('ok'));

app.listen(PORT, () => console.log(`backend listening on ${PORT}`));
