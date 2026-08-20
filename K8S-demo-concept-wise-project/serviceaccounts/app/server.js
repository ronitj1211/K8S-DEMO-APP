// Identity lab — a Pod that inspects its OWN ServiceAccount identity and
// then tries to use it against the Kubernetes API.
//
// Three endpoints do the teaching:
//   /whoami   -> is a token even mounted? what are its JWT claims?
//   /api/...  -> call the K8s API with that token and show allow vs 403
//   /canio    -> ask the API what this identity is permitted to do
const express = require('express');
const fs = require('fs');
const https = require('https');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

// The kubelet projects these three files into every Pod that has a token.
const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
const TOKEN_PATH = `${SA_DIR}/token`;
const CA_PATH = `${SA_DIR}/ca.crt`;
const NS_PATH = `${SA_DIR}/namespace`;

const read = (p) => {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; }
};

// Decode a JWT payload WITHOUT verifying it. We only want to read the claims;
// the API server is the thing that actually verifies the signature.
function decodeJwt(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return { error: 'not a JWT (legacy opaque token?)' };
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (e) {
    return { error: `could not decode: ${e.message}` };
  }
}

// Call the in-cluster API server. Kubernetes injects KUBERNETES_SERVICE_HOST
// and _PORT into every Pod, so no address needs configuring.
function callApi(path, token, ca) {
  return new Promise((resolve) => {
    const opts = {
      host: process.env.KUBERNETES_SERVICE_HOST || 'kubernetes.default.svc',
      port: process.env.KUBERNETES_SERVICE_PORT || 443,
      path,
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      ca: ca ? Buffer.from(ca) : undefined,
      // Verify the API server using the CA the kubelet mounted for us.
      rejectUnauthorized: !!ca,
    };
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = body.slice(0, 300); }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.end();
  });
}

// --------------------------------------------------------------------------
// /whoami — the identity this Pod was given
// --------------------------------------------------------------------------
app.get('/whoami', (req, res) => {
  const token = read(TOKEN_PATH);
  const namespace = read(NS_PATH);
  const ca = read(CA_PATH);

  if (!token) {
    // This is what automountServiceAccountToken: false looks like from inside.
    return res.json({
      pod: os.hostname(),
      token_mounted: false,
      note: 'No token at ' + SA_DIR + '. Either automountServiceAccountToken '
          + 'is false on the Pod/ServiceAccount, or the token volume was removed.',
      files_present: fs.existsSync(SA_DIR) ? fs.readdirSync(SA_DIR) : [],
    });
  }

  const claims = decodeJwt(token);
  const now = Math.floor(Date.now() / 1000);

  res.json({
    pod: os.hostname(),
    token_mounted: true,
    namespace,
    ca_mounted: !!ca,
    files_present: fs.readdirSync(SA_DIR),
    token_bytes: token.length,
    claims: {
      // "sub" is the canonical identity string the API server authenticates as.
      sub: claims.sub,
      // "aud" is who the token is FOR. A bound token is only valid for these
      // audiences — presenting it elsewhere is rejected.
      aud: claims.aud,
      iss: claims.iss,
      exp: claims.exp,
      iat: claims.iat,
      expires_in_seconds: claims.exp ? claims.exp - now : null,
      expires_in_hours: claims.exp ? +((claims.exp - now) / 3600).toFixed(2) : null,
      // Present only on BOUND tokens: which Pod/SA this token was issued for.
      // A legacy (pre-1.24 Secret-based) token has no pod binding at all.
      bound_object: claims['kubernetes.io'] || null,
    },
    // Naming this accurately matters. A kubelet-projected token IS bound
    // (it carries kubernetes.io pod/node claims) but its `exp` is often a
    // YEAR away, not an hour, because the API server runs with
    // --service-account-extend-token-expiration=true by default. The
    // *intended* lifetime is the `warnafter` claim; past that point the
    // API server records a metric/audit warning that the client is
    // reusing a stale token. So `exp` is the migration safety net and
    // `warnafter` is the real rotation deadline.
    token_type: !claims.exp
      ? 'legacy Secret-based token (NO expiry, not bound — avoid)'
      : claims['kubernetes.io']?.warnafter
        ? 'bound + projected, expiry EXTENDED by the API server (see intended_lifetime)'
        : 'bound + projected, explicit expirationSeconds (no extension)',
    intended_lifetime: claims['kubernetes.io']?.warnafter
      ? {
          warnafter_seconds_after_issue: claims['kubernetes.io'].warnafter - claims.iat,
          actual_exp_seconds_after_issue: claims.exp - claims.iat,
          note: 'kubelet rotates the file at ~80% of the intended lifetime. '
              + 'Re-read the file on every use; never cache it at startup.',
        }
      : { actual_exp_seconds_after_issue: claims.exp ? claims.exp - claims.iat : null },
  });
});

// --------------------------------------------------------------------------
// /api/pods, /api/secrets, /api/nodes — does this identity have permission?
// --------------------------------------------------------------------------
const tryApi = (label, pathFn) => async (req, res) => {
  const token = read(TOKEN_PATH);
  const ca = read(CA_PATH);
  const ns = read(NS_PATH) || 'default';
  const result = await callApi(pathFn(ns), token, ca);

  const verdict =
    result.status === 200 ? 'ALLOWED'
    : result.status === 403 ? 'FORBIDDEN (RBAC denied)'
    : result.status === 401 ? 'UNAUTHENTICATED (no/invalid token)'
    : `status ${result.status}`;

  res.json({
    target: label,
    verdict,
    status: result.status,
    // On a 403 the API server explains exactly which verb/resource was denied.
    message: result.body?.message || undefined,
    item_count: Array.isArray(result.body?.items) ? result.body.items.length : undefined,
    error: result.error,
  });
};

app.get('/api/pods', tryApi('pods in own namespace', (ns) => `/api/v1/namespaces/${ns}/pods`));
app.get('/api/secrets', tryApi('secrets in own namespace', (ns) => `/api/v1/namespaces/${ns}/secrets`));
app.get('/api/nodes', tryApi('nodes (cluster-scoped)', () => '/api/v1/nodes'));
app.get('/api/allpods', tryApi('pods in ALL namespaces', () => '/api/v1/pods'));

// --------------------------------------------------------------------------
// /canido — SelfSubjectRulesReview: ask the API "what am I allowed to do?"
// This is the same mechanism behind `kubectl auth can-i --list`.
// --------------------------------------------------------------------------
app.get('/canido', async (req, res) => {
  const token = read(TOKEN_PATH);
  const ca = read(CA_PATH);
  const ns = read(NS_PATH) || 'default';

  const payload = JSON.stringify({
    apiVersion: 'authorization.k8s.io/v1',
    kind: 'SelfSubjectRulesReview',
    spec: { namespace: ns },
  });

  const opts = {
    host: process.env.KUBERNETES_SERVICE_HOST || 'kubernetes.default.svc',
    port: process.env.KUBERNETES_SERVICE_PORT || 443,
    path: '/apis/authorization.k8s.io/v1/selfsubjectrulesreviews',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
    ca: ca ? Buffer.from(ca) : undefined,
    rejectUnauthorized: !!ca,
  };

  const out = await new Promise((resolve) => {
    const r = https.request(opts, (rs) => {
      let b = '';
      rs.on('data', (c) => (b += c));
      rs.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({ raw: b.slice(0, 300) }); } });
    });
    r.on('error', (e) => resolve({ error: e.message }));
    r.write(payload);
    r.end();
  });

  res.json({
    namespace: ns,
    resourceRules: out.status?.resourceRules || out,
  });
});

app.get('/', (req, res) =>
  res.json({
    pod: os.hostname(),
    endpoints: ['/whoami', '/canido', '/api/pods', '/api/secrets', '/api/nodes', '/api/allpods'],
  })
);
app.get('/healthz', (req, res) => res.send('ok'));

app.listen(PORT, () => console.log(`identity-lab on ${PORT}`));
