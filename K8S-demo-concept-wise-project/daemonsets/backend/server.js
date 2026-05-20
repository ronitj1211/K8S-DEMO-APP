const express = require('express');
const os = require('os');
const fs = require('fs');

const app = express();
const PORT = 3000;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

const NODE_NAME = process.env.NODE_NAME || 'unknown';

// Tail the last lines from a host log file (mounted from the node).
function tailHostLog() {
  const path = '/host-logs/messages';
  try {
    const data = fs.readFileSync(path, 'utf8');
    const lines = data.split('\n');
    return lines.slice(-5).join('\n');
  } catch (e) {
    return `(could not read ${path}: ${e.code || e.message})`;
  }
}

app.get('/', (req, res) => {
  res.json({
    message: 'Hello from DaemonSet Pod (one per node)',
    podHostname: os.hostname(),
    nodeName: NODE_NAME,
    sampleHostLog: tailHostLog(),
    time: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => res.send('ok'));

app.listen(PORT, () => console.log(`agent listening on ${PORT}`));
