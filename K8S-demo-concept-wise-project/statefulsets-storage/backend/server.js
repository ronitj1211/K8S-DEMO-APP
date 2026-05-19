const express = require('express');
const os = require('os');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const DATA_DIR = process.env.DATA_DIR || '/data';
const COUNTER_FILE = path.join(DATA_DIR, 'counter.txt');

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(COUNTER_FILE)) fs.writeFileSync(COUNTER_FILE, '0');

function readCounter() {
  return parseInt(fs.readFileSync(COUNTER_FILE, 'utf8'), 10) || 0;
}
function writeCounter(n) {
  fs.writeFileSync(COUNTER_FILE, String(n));
}

app.get('/', (req, res) => {
  res.json({
    podHostname: os.hostname(),
    counter: readCounter(),
    counterFile: COUNTER_FILE,
  });
});

app.post('/inc', (req, res) => {
  const next = readCounter() + 1;
  writeCounter(next);
  res.json({ podHostname: os.hostname(), counter: next });
});

app.get('/health', (req, res) => res.send('ok'));

app.listen(PORT, () => console.log(`stateful backend on ${PORT}, data at ${DATA_DIR}`));
