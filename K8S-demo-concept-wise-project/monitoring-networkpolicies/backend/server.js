// Backend exposing /metrics for Prometheus + a few demo endpoints.
const express = require('express');
const os = require('os');
const client = require('prom-client');

const app = express();
const PORT = 3000;

// Default Node.js metrics (process_cpu, nodejs_heap, etc.)
client.collectDefaultMetrics({ prefix: 'demo_' });

// Custom counters / histograms.
const requestsTotal = new client.Counter({
  name: 'demo_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['route', 'status'],
});
const requestDuration = new client.Histogram({
  name: 'demo_request_duration_seconds',
  help: 'Request duration',
  labelNames: ['route'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
});

app.use((req, res, next) => {
  const end = requestDuration.startTimer({ route: req.path });
  res.on('finish', () => {
    end();
    requestsTotal.inc({ route: req.path, status: res.statusCode });
  });
  next();
});

app.get('/', (req, res) => res.json({ hostname: os.hostname() }));
app.get('/slow', (req, res) => setTimeout(() => res.json({ ok: true }), 300));
app.get('/error', (req, res) => res.status(500).json({ ok: false }));
app.get('/health', (req, res) => res.send('ok'));

// Prometheus scrape endpoint.
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

app.listen(PORT, () => console.log(`backend on ${PORT}, /metrics ready`));
