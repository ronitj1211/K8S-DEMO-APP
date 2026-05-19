const express = require('express');
const os = require('os');

const app = express();
const PORT = 3000;

// Structured JSON logs to stdout — Fluent Bit will pick these up from
// /var/log/containers/<pod>_<ns>_<container>-<id>.log on each node.
function log(level, msg, extra = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    msg,
    hostname: os.hostname(),
    ...extra,
  }));
}

app.get('/', (req, res) => {
  log('info', 'handled request', { path: req.path, ip: req.ip });
  res.json({ ok: true, hostname: os.hostname() });
});

app.get('/warn', (req, res) => {
  log('warn', 'something looked off', { path: req.path });
  res.json({ ok: true });
});

app.get('/error', (req, res) => {
  log('error', 'simulated error', { path: req.path, code: 'E_DEMO' });
  res.status(500).json({ ok: false });
});

app.get('/health', (req, res) => res.send('ok'));

// Heartbeat so the index has data even without traffic.
setInterval(() => log('info', 'heartbeat', { uptimeSec: Math.round(process.uptime()) }), 10_000);

app.listen(PORT, () => log('info', `backend listening on ${PORT}`));
