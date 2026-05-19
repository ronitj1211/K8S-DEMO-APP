const express = require('express');
const os = require('os');
const fs = require('fs');

const app = express();
const PORT = 3000;

// Config from env vars (sourced from ConfigMap + Secret).
const APP_NAME = process.env.APP_NAME || 'unknown';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const GREETING = process.env.GREETING || 'hi';
const API_KEY = process.env.API_KEY || '(none)';

// Config from a mounted file (ConfigMap mounted as a volume).
function readMountedConfig() {
  try {
    return fs.readFileSync('/etc/config/app.conf', 'utf8');
  } catch {
    return '(no /etc/config/app.conf mounted)';
  }
}

app.get('/', (req, res) => {
  res.json({
    message: `${GREETING} from ${APP_NAME}`,
    hostname: os.hostname(),
    logLevel: LOG_LEVEL,
    // never log a real secret in production — this is only for the demo.
    apiKeyPreview: API_KEY.slice(0, 4) + '***',
    mountedConfigFile: readMountedConfig(),
  });
});

app.get('/health', (req, res) => res.send('ok'));

app.listen(PORT, () => console.log(`backend listening on ${PORT}`));
