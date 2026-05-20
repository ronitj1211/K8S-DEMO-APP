// A tiny "API" so the frontend has something to call.
// The real demos in this folder are the Jobs / CronJobs (see backend/jobs/).
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
    message: 'Jobs/RBAC demo backend',
    hostname: os.hostname(),
    namespace: process.env.MY_NAMESPACE || 'unknown',
  });
});
app.get('/health', (req, res) => res.send('ok'));
app.listen(PORT, () => console.log(`backend on ${PORT}`));
