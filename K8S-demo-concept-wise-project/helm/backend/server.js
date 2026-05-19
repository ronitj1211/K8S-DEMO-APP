const express = require('express');
const os = require('os');

const app = express();
const PORT = 3000;

app.get('/', (req, res) => {
  res.json({
    message: process.env.GREETING || 'hello from helm-deployed backend',
    hostname: os.hostname(),
    env: process.env.APP_ENV || 'dev',
    time: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => res.send('ok'));

app.listen(PORT, () => console.log(`backend listening on ${PORT}`));
