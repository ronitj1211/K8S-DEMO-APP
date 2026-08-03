const express = require('express');
const os = require('os');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST');
  next();
});

const DATA_DIR = process.env.DATA_DIR || '/data';
const COUNTER_FILE = path.join(DATA_DIR, 'counter.txt');
const NOTES_FILE = path.join(DATA_DIR, 'notes.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(COUNTER_FILE)) fs.writeFileSync(COUNTER_FILE, '0');
if (!fs.existsSync(NOTES_FILE)) fs.writeFileSync(NOTES_FILE, '[]');

function readCounter() {
  return parseInt(fs.readFileSync(COUNTER_FILE, 'utf8'), 10) || 0;
}

function writeCounter(n) {
  fs.writeFileSync(COUNTER_FILE, String(n));
}

function readNotes() {
  return JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
}

function writeNotes(notes) {
  fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2));
}

app.get('/', (req, res) => {
  res.json({
    podHostname: os.hostname(),
    counter: readCounter(),
    notes: readNotes(),
    dataDir: DATA_DIR,
    counterFile: COUNTER_FILE,
    notesFile: NOTES_FILE,
  });
});

app.post('/inc', (req, res) => {
  const next = readCounter() + 1;
  writeCounter(next);
  res.json({ podHostname: os.hostname(), counter: next });
});

app.post('/notes', express.json(), (req, res) => {
  const text = (req.body && req.body.text) || '';
  if (!text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  const notes = readNotes();
  const entry = { id: Date.now(), text: text.trim(), pod: os.hostname() };
  notes.unshift(entry);
  writeNotes(notes.slice(0, 50));
  res.json({ podHostname: os.hostname(), note: entry, total: notes.length });
});

app.get('/health', (req, res) => res.send('ok'));

app.listen(PORT, () => console.log(`pv-demo backend on ${PORT}, data at ${DATA_DIR}`));
