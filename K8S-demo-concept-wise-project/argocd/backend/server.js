const express = require('express');
const os = require('os');

const app = express();
const PORT = 3000;

// The version field is set via env in the Deployment manifest. Bump it in Git
// and push — Argo CD will detect the drift and roll Pods to the new version.
const VERSION = process.env.APP_VERSION || 'v1';

app.get('/', (req, res) => {
  res.json({
    message: 'Hello from a GitOps-deployed backend',
    version: VERSION,
    hostname: os.hostname(),
    time: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => res.send('ok'));

app.listen(PORT, () => console.log(`backend ${VERSION} listening on ${PORT}`));
