# How the ELK Stack & Apps Connect

This document traces **every link** in the EFK demo — which Pod talks to which, **what address** it uses, and **where in the YAML** that address lives. If you've ever wondered "why does Kibana resolve `elasticsearch` to the right Pod?" — this is the answer.

---

## 1. The one mechanism behind it all: Service DNS

Every `Service` in Kubernetes gets an automatic DNS name:

```
<service-name>.<namespace>.svc.cluster.local
```

So when you create:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: elasticsearch
  namespace: logging
```

…any Pod in the cluster can reach it at:

- `elasticsearch.logging.svc.cluster.local` (full)
- `elasticsearch.logging` (short)
- `elasticsearch` (shortest — only works **from inside the same namespace**)

The Service's IP is virtual (stable forever) and Kubernetes load-balances each connection across the matching Pods. **You don't need to know Pod IPs, ever.**

This is the rule the rest of the document is just applying.

---

## 2. The big picture

```
                        ┌──────────────┐
                        │  Your laptop │  http://localhost:5601   ────► Kibana port-forward
                        │   (browser)  │  http://localhost:30090  ────► sample-app PF
                        └──────┬───────┘  http://localhost:30099  ────► orders-service PF
                               │          http://localhost:8091   ────► frontend UI PF
                               │
                               │  port-forward (kubectl) — talks to apiserver, who tunnels
                               │  the TCP stream to the right Pod
                               ▼
   ╔════════════════════════ Kubernetes cluster (colima / k3s) ═════════════════════════╗
   ║                                                                                  ║
   ║   namespace: demo                                                                ║
   ║   ┌─────────────┐    ┌──────────────────────┐     ┌────────────────────────┐    ║
   ║   │  frontend   │    │  Service: sample-app │     │  Service: orders-svc   │    ║
   ║   │  (nginx UI) │    │  ClusterIP +NodePort │     │  ClusterIP +NodePort   │    ║
   ║   └──────┬──────┘    └──────────┬───────────┘     └───────────┬────────────┘    ║
   ║          │                      │ load-balances               │ load-balances    ║
   ║          │                      ▼                             ▼                  ║
   ║       served as static HTML;    sample-app Pods (×2)         orders-service Pods (×2)
   ║       calls the apps via the    ↳ logs JSON to stdout         ↳ logs JSON to stdout
   ║       user's BROWSER (laptop),  ↳ kubelet writes those logs to /var/log/containers/*.log
   ║       not from inside the Pod                                                    ║
   ║                                                                                  ║
   ║                                       ▲ tails files on the host                  ║
   ║                                       │                                          ║
   ║   namespace: logging                  │                                          ║
   ║   ┌──────────────┐   ClusterRole      │                                          ║
   ║   │  Fluent Bit  ├───────────────────►│ Kubernetes API (https://kubernetes.default.svc)
   ║   │ (DaemonSet,  │   reads pod labels │  ↳ enriches each log with k8s.* fields    ║
   ║   │ 1 per node)  │                                                                ║
   ║   └──────┬───────┘                                                                ║
   ║          │ ships logs via http to:                                                ║
   ║          ▼                                                                        ║
   ║   ┌──────────────────────────┐                                                    ║
   ║   │  Service: elasticsearch  │  ◄────── reads from ────── ┌─────────────┐         ║
   ║   │  (ClusterIP, port 9200)  │                            │   Kibana    │         ║
   ║   └──────────┬───────────────┘                            │  (Pod 5601) │         ║
   ║              │ load-balances to:                          └─────────────┘         ║
   ║              ▼                                                                    ║
   ║   ┌──────────────────────────┐                                                    ║
   ║   │ elasticsearch-0          │                                                    ║
   ║   │ (StatefulSet Pod)        │                                                    ║
   ║   └──────────────────────────┘                                                    ║
   ║                                                                                  ║
   ╚══════════════════════════════════════════════════════════════════════════════════╝
```

Now let's walk every arrow in that diagram and show **exactly where the connection is configured**.

---

## 3. Browser → sample-app  (laptop → cluster, via port-forward)

**Who:** your browser, when you click "Generate INFO" in the UI.

**Address:** `http://localhost:30090`

**How:** `kubectl port-forward -n demo svc/sample-app 30090:80` tunnels port 30090 on your laptop to the Service's port 80, which targets container port 3000 on a sample-app Pod.

**Configured in:**

- The default input value in the UI HTML: [frontend/index.html:19](./frontend/index.html#L19)
- The Service definition (port 80, targetPort 3000): [backend/sample-app.yaml:35-37](./backend/sample-app.yaml#L35-L37)

The frontend HTML runs **in your browser**, not inside any Pod — so `localhost` means *your laptop*, not "inside the Pod". That's why the input field needs `localhost:30090` and not `sample-app.demo.svc.cluster.local`.

The same wiring applies to **orders-service** at `localhost:30099` — see [orders-service/orders-service.yaml:35-37](./orders-service/orders-service.yaml#L35-L37).

---

## 4. Apps → /var/log on the node  (no network at all)

**Who:** the sample-app or orders-service container.

**Address:** none — they write to **stdout**, full stop.

```js
console.log(JSON.stringify({ level: 'info', msg: 'heartbeat', ... }));
```

That's all the app does — see [backend/server.js:6-15](./backend/server.js#L6-L15) and [orders-service/server.js:9-20](./orders-service/server.js#L9-L20).

**What happens behind the scenes** (no code on your side):

1. The container's `stdout` is hooked by the container runtime (Docker / containerd).
2. The runtime writes the line to a file at `/var/log/containers/<pod>_<ns>_<container>-<id>.log` **on the node** — the same place `kubectl logs` reads from.
3. That file lives on the node's filesystem, not inside the Pod.

That's the magic that lets Fluent Bit see logs **without the app knowing anything about logging infrastructure**.

---

## 5. Fluent Bit → /var/log on the node  (hostPath volume, not a network call)

**Who:** Fluent Bit DaemonSet.

**Address:** the local file `/var/log/containers/*.log`.

**How:** the DaemonSet mounts the node's `/var/log` directory into the Pod as a **`hostPath` volume**. The Fluent Bit `tail` input watches those files.

**Configured in:**

- The tail input + path: [stack/31-fluent-bit-config.yaml:21-30](./stack/31-fluent-bit-config.yaml#L21-L30)
- The hostPath volume + mount: [stack/32-fluent-bit-daemonset.yaml:30-44](./stack/32-fluent-bit-daemonset.yaml#L30-L44)

Because it's `hostPath`, this is **not a network call** — Fluent Bit reads files on the same machine the kubelet wrote them on. That's why it must be a DaemonSet (one Pod per node).

---

## 6. Fluent Bit → Kubernetes API  (for Pod-metadata enrichment)

**Who:** Fluent Bit's `kubernetes` filter.

**Address:** `https://kubernetes.default.svc:443`

**Configured in:**

- The filter block: [stack/31-fluent-bit-config.yaml:33-41](./stack/31-fluent-bit-config.yaml#L33-L41)

`kubernetes.default.svc` is a **built-in Service** that always points at the apiserver. Every Pod in every cluster can reach it.

**Authentication:** the kubelet auto-mounts a token at `/var/run/secrets/kubernetes.io/serviceaccount/token` inside the Pod. Fluent Bit reads it and presents it as a bearer token. The token is for the **ServiceAccount** the Pod runs as — here, `fluent-bit`:

- ServiceAccount + ClusterRole + Binding: [stack/30-fluent-bit-rbac.yaml](./stack/30-fluent-bit-rbac.yaml)
- DaemonSet uses it via `serviceAccountName: fluent-bit`: [stack/32-fluent-bit-daemonset.yaml:21](./stack/32-fluent-bit-daemonset.yaml#L21)

Without the RBAC, the call to the API would return 403 and you'd see no `kubernetes.*` fields on your logs.

---

## 7. Fluent Bit → Elasticsearch  (the actual log shipping)

**Who:** Fluent Bit's `es` output.

**Address:** `elasticsearch.logging.svc.cluster.local:9200`

**Configured in:**

- The es output block: [stack/31-fluent-bit-config.yaml:43-50](./stack/31-fluent-bit-config.yaml#L43-L50)

This is pure Service DNS. The hostname resolves to the **`elasticsearch`** Service in the **`logging`** namespace, which routes to the **`elasticsearch-0`** Pod:

- The Service ([stack/10-elasticsearch.yaml:53-62](./stack/10-elasticsearch.yaml#L53-L62)) selects `app=elasticsearch`.
- The StatefulSet ([stack/10-elasticsearch.yaml:5-50](./stack/10-elasticsearch.yaml#L5-L50)) creates Pods with that label.

Fluent Bit POSTs records here as bulk indexing requests, into a daily index `k8s-logs-YYYY.MM.DD` (the `Logstash_Format On` + `Logstash_Prefix k8s-logs` settings).

---

## 8. Kibana → Elasticsearch  (datasource lookup)

**Who:** the Kibana Pod.

**Address:** `http://elasticsearch:9200`

**Configured in:**

- Env var on the Kibana container: [stack/20-kibana.yaml:22-23](./stack/20-kibana.yaml#L22-L23)

Notice it's the **short name** `elasticsearch`. Because Kibana runs in the **same namespace** (`logging`) as Elasticsearch, the short name works — Kubernetes appends `.logging.svc.cluster.local` for you via the Pod's `/etc/resolv.conf` search list.

> Cross-namespace example: Fluent Bit is in `logging` and Elasticsearch is in `logging` too, but we used the FQDN there (`elasticsearch.logging.svc.cluster.local`) anyway. Both styles work; FQDN is **always** safe.

---

## 9. Browser → Kibana  (laptop → cluster, via port-forward)

**Who:** your browser.

**Address:** `http://localhost:5601`

**How:** `kubectl port-forward -n logging svc/kibana 5601:5601`.

**Configured in:**

- The Kibana Service: [stack/20-kibana.yaml:45-49](./stack/20-kibana.yaml#L45-L49) — exposes port 5601 (NodePort 30092 if your cluster supports it).

If you weren't using port-forward, you'd hit `http://<node-ip>:30092` instead (works on minikube; **doesn't work on colima** because colima doesn't expose NodePorts to the host).

---

## 10. Browser → Frontend UI  (the same port-forward pattern)

**Who:** your browser.

**Address:** `http://localhost:8091`

**How:** `kubectl port-forward -n demo svc/log-generator-ui 8091:80`.

**Configured in:**

- The Service: [frontend/frontend.yaml:31-35](./frontend/frontend.yaml#L31-L35)

The UI is just static HTML served by nginx — nothing inside the Pod needs to know about Elasticsearch or Kibana.

---

## 11. How to find a connection string in any K8s app

When you onboard to a new K8s workload, finding what talks to what is mostly grepping. The patterns:

1. **Env vars in the Pod spec:**
   ```bash
   kubectl get deploy <name> -o yaml | grep -A1 -E 'name: .*(URL|HOST|HOSTS|ENDPOINT|URI)'
   ```
2. **Mounted ConfigMaps and Secrets:** look at `envFrom` and `volumeMounts` — connection strings often live in those.
3. **Cluster DNS:** if you see a hostname like `redis`, `db-postgres`, `kafka-bootstrap` — that's a Service name. Find it with:
   ```bash
   kubectl get svc -A | grep <name>
   ```
4. **Outbound to internet** (e.g. Stripe, Slack): just a regular hostname, resolved via the cluster's upstream DNS.

---

## 12. Verifying connections from inside the cluster

The fastest debugging tool — a one-off curl Pod:

```bash
kubectl run dbg --rm -it --image=curlimages/curl -n logging -- sh
```

Once you're in the shell:

```sh
# DNS — does the name resolve?
nslookup elasticsearch
nslookup elasticsearch.logging.svc.cluster.local
nslookup kubernetes.default.svc

# Reachability + a real query
curl http://elasticsearch:9200/_cluster/health?pretty
curl http://elasticsearch:9200/_cat/indices

# Kibana
curl -I http://kibana:5601/api/status

# From the demo namespace, hit a backend
kubectl run dbg --rm -it --image=curlimages/curl -n demo -- sh
curl http://sample-app
curl -X POST http://orders-service/orders
```

If `nslookup` fails: it's a DNS problem (typo in Service name, wrong namespace).
If DNS resolves but `curl` hangs: it's a connectivity problem (NetworkPolicy, Pod not ready, wrong port).

---

## 13. Cheat sheet — addresses used in this demo

| From | To | Address | Where it's set |
|------|----|--------|----------------|
| Browser | Frontend | `http://localhost:8091` | port-forward |
| Browser | sample-app | `http://localhost:30090` | port-forward (also as the default in [`index.html:19`](./frontend/index.html#L19)) |
| Browser | orders-service | `http://localhost:30099` | port-forward |
| Browser | Kibana | `http://localhost:5601` | port-forward |
| Apps | (logs) | `stdout` | [`backend/server.js:6-15`](./backend/server.js#L6-L15), [`orders-service/server.js:9-20`](./orders-service/server.js#L9-L20) |
| Fluent Bit | log files | `/var/log/containers/*.log` (hostPath) | [`32-fluent-bit-daemonset.yaml:30-44`](./stack/32-fluent-bit-daemonset.yaml#L30-L44) |
| Fluent Bit | K8s API | `https://kubernetes.default.svc:443` | [`31-fluent-bit-config.yaml:36`](./stack/31-fluent-bit-config.yaml#L36) |
| Fluent Bit | Elasticsearch | `elasticsearch.logging.svc.cluster.local:9200` | [`31-fluent-bit-config.yaml:45-46`](./stack/31-fluent-bit-config.yaml#L45-L46) |
| Kibana | Elasticsearch | `http://elasticsearch:9200` | [`20-kibana.yaml:22-23`](./stack/20-kibana.yaml#L22-L23) |

---

## 14. Key takeaways

1. **Service DNS** is the connective tissue. Every connection between Pods uses `<svc>.<ns>.svc.cluster.local` — or the short form when in the same namespace.
2. App logs reach Elasticsearch with **zero networking in the app**. Logs go to `stdout` → kubelet writes to `/var/log/containers/*.log` → Fluent Bit (DaemonSet, `hostPath`) tails them → ships via HTTP to Elasticsearch.
3. The **Kubernetes API itself** is exposed in every cluster as `kubernetes.default.svc` — Fluent Bit uses it to look up Pod labels.
4. ServiceAccounts + RBAC are the **authentication layer** when a Pod talks to the K8s API. Without them, the API call gets a 403.
5. From your laptop, the easiest cross-platform way to reach an in-cluster Service is `kubectl port-forward`. NodePorts work too where the runtime exposes them (minikube ✓, Docker Desktop ✓, colima ✗ by default).

**Back to** [elk-logging README](./README.md) · [Kibana guide](./KIBANA_GUIDE.md)
