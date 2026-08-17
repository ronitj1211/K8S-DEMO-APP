// Demo API instrumented for Prometheus.
//
// Exposes the three RED signals (Rate, Errors, Duration) plus a business
// counter, and a /alerts webhook so you can watch Alertmanager deliver a
// firing alert end-to-end with `kubectl logs`.
const express = require('express');
const os = require('os');
const client = require('prom-client');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SERVICE = process.env.SERVICE_NAME || 'demo-api';

// ---------------------------------------------------------------------------
// Registry + default process metrics (process_cpu_seconds_total, nodejs_*, ...)
// ---------------------------------------------------------------------------
const register = new client.Registry();
register.setDefaultLabels({ service: SERVICE });
client.collectDefaultMetrics({ register });

// --- R: how many requests (a Counter — only ever goes up) -------------------
const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

// --- D: how long they take (a Histogram — buckets let you compute quantiles)
const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  // Buckets must straddle your SLO. p95 is only as precise as the bucket edges.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

// --- Saturation: work happening right now (a Gauge — goes up and down) ------
const httpRequestsInFlight = new client.Gauge({
  name: 'http_requests_in_flight',
  help: 'Requests currently being served',
  labelNames: ['route'],
  registers: [register],
});

// --- A business metric. These are the ones leadership actually cares about. -
const ordersProcessedTotal = new client.Counter({
  name: 'orders_processed_total',
  help: 'Orders processed',
  labelNames: ['status'],
  registers: [register],
});

// Readiness is flipped by /toggle-ready so you can watch a pod leave and
// re-join the Service endpoints (and the Prometheus target list) live.
let isReady = true;

// ---------------------------------------------------------------------------
// Middleware: record every request against all three RED metrics.
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Use the route pattern, never req.path — a label per unique URL is the
  // classic cardinality explosion that kills a Prometheus server.
  const route = req.route?.path || req.path;
  const stopTimer = httpRequestDuration.startTimer({ method: req.method });
  httpRequestsInFlight.inc({ route });

  res.on('finish', () => {
    const labels = { method: req.method, route, status: res.statusCode };
    stopTimer({ route, status: res.statusCode });
    httpRequestsTotal.inc(labels);
    httpRequestsInFlight.dec({ route });
  });

  next();
});

// ---------------------------------------------------------------------------
// Demo endpoints — each one exists to make a specific graph move.
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({ service: SERVICE, pod: os.hostname(), ready: isReady });
});

// Normal traffic with realistic jitter.
app.get('/api/orders', (req, res) => {
  const delay = Math.random() * 120;
  setTimeout(() => {
    ordersProcessedTotal.inc({ status: 'success' });
    res.json({ orders: 3, pod: os.hostname() });
  }, delay);
});

// Drives p95/p99 latency up — use this to fire the HighLatency alert.
app.get('/slow', (req, res) => {
  const delay = Number(req.query.ms) || 1500;
  setTimeout(() => res.json({ slept_ms: delay }), delay);
});

// Always 500 — use this to fire the HighErrorRate alert.
app.get('/error', (req, res) => {
  ordersProcessedTotal.inc({ status: 'failed' });
  res.status(500).json({ error: 'intentional failure' });
});

// Fails ~10% of the time, like a real dependency would.
app.get('/flaky', (req, res) => {
  if (Math.random() < 0.1) {
    ordersProcessedTotal.inc({ status: 'failed' });
    return res.status(500).json({ error: 'flaky failure' });
  }
  ordersProcessedTotal.inc({ status: 'success' });
  res.json({ ok: true });
});

// Burns CPU so you can watch container_cpu_usage and the HPA react.
app.get('/burn', (req, res) => {
  const until = Date.now() + (Number(req.query.ms) || 500);
  while (Date.now() < until) { Math.sqrt(Math.random()); }
  res.json({ burned: true });
});

// Liveness: shallow on purpose. Never check a database here — a DB blip
// would restart every pod at once and turn degradation into an outage.
app.get('/healthz', (req, res) => res.send('ok'));

// Readiness: this is where dependency checks belong.
app.get('/ready', (req, res) =>
  isReady ? res.send('ready') : res.status(503).send('not ready')
);

app.post('/toggle-ready', (req, res) => {
  isReady = !isReady;
  console.log(`[readiness] now ${isReady ? 'READY' : 'NOT READY'}`);
  res.json({ ready: isReady });
});

// Alertmanager posts here. Watch it with: kubectl logs -l app=demo-api -f
app.post('/alerts', (req, res) => {
  const { status, alerts = [] } = req.body || {};
  for (const a of alerts) {
    console.log(
      `[ALERT ${status}] ${a.labels?.alertname} severity=${a.labels?.severity} ` +
      `summary="${a.annotations?.summary}"`
    );
  }
  res.sendStatus(200);
});

// The scrape endpoint. Prometheus GETs this every scrape_interval.
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.listen(PORT, () =>
  console.log(`${SERVICE} listening on ${PORT} — /metrics ready`)
);
