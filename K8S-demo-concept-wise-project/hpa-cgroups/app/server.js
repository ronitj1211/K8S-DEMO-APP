// Workload for exploring cgroups, throttling, OOMKills and autoscaling.
//
// The interesting endpoint is /cgroup — it reads the container's OWN cgroup
// files and reports what the kernel is actually enforcing. That turns
// "limits are enforced by cgroups" from a claim into something you can see.
const express = require('express');
const fs = require('fs');
const os = require('os');
const client = require('prom-client');

const app = express();
const PORT = process.env.PORT || 3000;

const register = new client.Registry();
register.setDefaultLabels({ pod: os.hostname() });
client.collectDefaultMetrics({ register });

// A queue-depth gauge — the metric the custom-metrics HPA scales on.
// Real systems read this from SQS/Kafka/Redis; here you set it by hand so
// you can drive the HPA without needing a message broker.
let queueDepth = 0;
const queueDepthGauge = new client.Gauge({
  name: 'app_queue_depth',
  help: 'Pending jobs in the queue',
  registers: [register],
  collect() { this.set(queueDepth); },
});

const httpRequests = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['route', 'status'],
  registers: [register],
});

app.use((req, res, next) => {
  res.on('finish', () =>
    httpRequests.inc({ route: req.path, status: res.statusCode })
  );
  next();
});

// ---------------------------------------------------------------------------
// cgroup introspection
//
// cgroup v2 (modern: unified hierarchy at /sys/fs/cgroup)
//   memory.max      -> the memory limit ("max" if unlimited)
//   memory.current  -> bytes currently charged
//   cpu.max         -> "<quota> <period>" in microseconds ("max" if unlimited)
//   cpu.stat        -> nr_periods / nr_throttled / throttled_usec
//
// cgroup v1 (older: one hierarchy per controller)
//   memory/memory.limit_in_bytes
//   cpu/cpu.cfs_quota_us  +  cpu/cpu.cfs_period_us
// ---------------------------------------------------------------------------
const read = (p) => {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; }
};

const isV2 = fs.existsSync('/sys/fs/cgroup/cgroup.controllers');

function cgroupInfo() {
  if (isV2) {
    const cpuMax = read('/sys/fs/cgroup/cpu.max');           // e.g. "50000 100000"
    const [quota, period] = (cpuMax || 'max 100000').split(/\s+/);
    const stat = Object.fromEntries(
      (read('/sys/fs/cgroup/cpu.stat') || '')
        .split('\n')
        .map((l) => l.split(/\s+/))
        .filter((p) => p.length === 2)
    );
    const memMax = read('/sys/fs/cgroup/memory.max');
    return {
      cgroup_version: 'v2',
      cpu: {
        raw: cpuMax,
        // quota/period is the number of CPUs you may use. 50000/100000 = 0.5 CPU.
        limit_cores: quota === 'max' ? 'unlimited' : +quota / +period,
        period_us: +period,
        nr_periods: +(stat.nr_periods || 0),
        nr_throttled: +(stat.nr_throttled || 0),
        throttled_seconds: (+(stat.throttled_usec || 0)) / 1e6,
        // The number that matters: what % of scheduling periods were cut short.
        throttled_pct: stat.nr_periods > 0
          ? +((stat.nr_throttled / stat.nr_periods) * 100).toFixed(2)
          : 0,
      },
      memory: {
        limit_bytes: memMax === 'max' ? 'unlimited' : +memMax,
        limit_mib: memMax === 'max' ? 'unlimited' : Math.round(+memMax / 1048576),
        current_bytes: +read('/sys/fs/cgroup/memory.current'),
        current_mib: Math.round(+read('/sys/fs/cgroup/memory.current') / 1048576),
      },
    };
  }

  const quota = +read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us');
  const period = +read('/sys/fs/cgroup/cpu/cpu.cfs_period_us');
  const stat = Object.fromEntries(
    (read('/sys/fs/cgroup/cpu/cpu.stat') || '')
      .split('\n')
      .map((l) => l.split(/\s+/))
      .filter((p) => p.length === 2)
  );
  const memLimit = +read('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  return {
    cgroup_version: 'v1',
    cpu: {
      cfs_quota_us: quota,
      cfs_period_us: period,
      limit_cores: quota === -1 ? 'unlimited' : quota / period,
      nr_periods: +(stat.nr_periods || 0),
      nr_throttled: +(stat.nr_throttled || 0),
      throttled_seconds: (+(stat.throttled_time || 0)) / 1e9,
    },
    memory: {
      // v1 reports a huge sentinel value when unlimited
      limit_bytes: memLimit > 1e15 ? 'unlimited' : memLimit,
      limit_mib: memLimit > 1e15 ? 'unlimited' : Math.round(memLimit / 1048576),
      usage_bytes: +read('/sys/fs/cgroup/memory/memory.usage_in_bytes'),
    },
  };
}

app.get('/cgroup', (req, res) => {
  res.json({
    pod: os.hostname(),
    // What the RUNTIME sees vs what the CGROUP allows — these disagree, and
    // that disagreement is why unaware runtimes size their thread pools wrong.
    runtime_view: {
      os_cpus: os.cpus().length,           // the NODE's core count, not your limit
      os_total_mem_mib: Math.round(os.totalmem() / 1048576),
      node_available_parallelism: os.availableParallelism?.() ?? 'n/a',
    },
    cgroup_view: cgroupInfo(),
  });
});

// ---------------------------------------------------------------------------
// Load generators
// ---------------------------------------------------------------------------

// Burn CPU synchronously — drives HPA CPU utilisation and CFS throttling.
app.get('/burn-cpu', (req, res) => {
  const ms = Math.min(Number(req.query.ms) || 200, 10000);
  const start = Date.now();
  let n = 0;
  while (Date.now() - start < ms) { n += Math.sqrt(Math.random()); }
  res.json({ burned_ms: Date.now() - start, checksum: n.toFixed(0) });
});

// Allocate and HOLD memory — walk this up to the limit to trigger an OOMKill.
const ballast = [];
app.get('/alloc-mem', (req, res) => {
  const mib = Math.min(Number(req.query.mib) || 10, 2048);
  try {
    // Fill the buffer so pages are actually touched. An untouched allocation
    // is virtual only and never charged to the cgroup.
    const buf = Buffer.alloc(mib * 1048576, 1);
    ballast.push(buf);
    const held = ballast.length * 0 + ballast.reduce((a, b) => a + b.length, 0);
    res.json({ allocated_mib: mib, total_held_mib: Math.round(held / 1048576) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/free-mem', (req, res) => {
  const n = ballast.length;
  ballast.length = 0;
  if (global.gc) global.gc();
  res.json({ freed_buffers: n });
});

// Queue depth — the custom metric the HPA scales on.
app.post('/queue/:depth', (req, res) => {
  queueDepth = Number(req.params.depth) || 0;
  res.json({ queue_depth: queueDepth });
});
app.get('/queue', (req, res) => res.json({ queue_depth: queueDepth }));

app.get('/', (req, res) =>
  res.json({ pod: os.hostname(), cgroup: cgroupInfo().cgroup_version })
);
app.get('/healthz', (req, res) => res.send('ok'));
app.get('/ready', (req, res) => res.send('ready'));

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.listen(PORT, () =>
  console.log(`load-lab on ${PORT} — cgroup ${isV2 ? 'v2' : 'v1'} detected`)
);
