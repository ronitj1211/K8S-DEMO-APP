# Interview Questions — EFK / ELK Logging

---

## Basic

### Q1. What's the difference between ELK and EFK?
- **ELK** — Elasticsearch + **L**ogstash + Kibana.
- **EFK** — Elasticsearch + **F**luent Bit (or Fluentd) + Kibana.

EFK is more common in Kubernetes because Fluent Bit is lightweight (~10–30 MB RAM, C-based) and runs as a DaemonSet. Logstash is heavier (JVM) and typically used between Fluent Bit and Elasticsearch for complex transformations.

### Q2. Why centralized logging in K8s?
- Pods are ephemeral — when they die, `kubectl logs` is gone.
- Logs are spread across nodes — hard to grep across.
- No search, no time-range, no aggregation.
- Audit/compliance often requires log retention.

### Q3. Where do container logs live on a node?
The kubelet writes container stdout/stderr to `/var/log/containers/<pod>_<ns>_<container>-<id>.log` (symlinks to `/var/log/pods/...`). Fluent Bit tails these files.

### Q4. Why does Fluent Bit run as a DaemonSet?
Each node has its own container logs in `/var/log/containers`. One Fluent Bit Pod per node is the simplest way to read them — no node misses coverage. The Pod mounts the host's `/var/log` via `hostPath`.

### Q5. What's the Fluent Bit pipeline?
```
INPUT (tail container log files)
  -> FILTER (parse JSON, add K8s metadata via API)
  -> OUTPUT (ship to Elasticsearch / S3 / Kafka / Loki)
```
Configured in `fluent-bit.conf`.

### Q6. How does Fluent Bit enrich logs with Pod labels?
The `kubernetes` filter calls the K8s API to look up the Pod that owns the log file (file name encodes the Pod), then adds `kubernetes.labels.*`, `kubernetes.namespace_name`, `kubernetes.pod_name`, `kubernetes.container_name` to every record. That's why Fluent Bit needs a ServiceAccount with `list/get pods`.

### Q7. What's Elasticsearch in this stack?
A distributed search and storage engine. Logs go into time-stamped indices (e.g., `k8s-logs-2026.05.20`). Stores documents as JSON, indexed by field for fast filter/search.

### Q8. What's Kibana?
The web UI for Elasticsearch. "Discover" lets you search and filter raw log records; "Dashboard" builds visualizations; "Alerting" lets you alert on conditions.

---

## Intermediate

### Q9. Why log to stdout instead of files inside containers?
- The kubelet captures stdout/stderr — no extra wiring needed.
- File-based logs require either a sidecar log shipper or a volume mount — complications.
- 12-factor: treat logs as event streams to stdout.

### Q10. What's structured logging and why does it matter?
Logging in JSON instead of free-form text. Fluent Bit's `Merge_Log On` filter parses the JSON inline, exposing each field as a queryable column in Kibana. With structured logs you can filter `level: "error"`, `customer_id: "x"`, `service: "orders"` directly — no regex.

### Q11. What's an Elasticsearch index template?
A template that defines how new indices should be configured (shards, replicas, field mappings). Set it once, and `k8s-logs-2026.05.20`, `k8s-logs-2026.05.21`, etc. inherit it. Without templates, every field defaults to `keyword`/`text` and your `numeric_field: 42` becomes a string.

### Q12. How do you handle log retention?
- **Index Lifecycle Management (ILM)** in Elasticsearch — auto-rotate, age out, and delete old indices.
- **Curator** — older standalone tool; ILM replaced it.
- Without retention, ES disks fill up and the cluster goes red.

### Q13. CRI vs Docker log format?
- **Docker JSON** — `{"log": "...", "stream": "stdout", "time": "..."}`.
- **CRI (containerd, CRI-O)** — `<time> <stream> <logtag> <log>` plain-text.

Fluent Bit's `multiline.parser docker, cri` auto-detects whichever the node uses.

### Q14. How would you scale this in production?
- **Elasticsearch**: 3+ master nodes, 3+ data nodes, hot/warm/cold tiers, dedicated ingest nodes, real PVCs.
- **Fluent Bit**: still DaemonSet, but with `Mem_Buf_Limit`, `storage.type: filesystem` (durable on-disk buffer), and a backpressure-aware downstream.
- **Buffer**: insert Kafka between Fluent Bit and Elasticsearch — if ES is down, logs pile in Kafka, not on the nodes.
- **Auth**: turn on `xpack.security`, role-based access in Kibana.

### Q15. Fluentd vs Fluent Bit?
- **Fluentd** — bigger, plugin-rich, Ruby-based.
- **Fluent Bit** — smaller, faster, fewer plugins, C-based.

Pattern: Fluent Bit on nodes (collection), Fluentd in a central Deployment for heavy transformation, then Elasticsearch.

### Q16. What about Loki?
**Loki** (Grafana Labs) is a Prometheus-like log storage system — indexes labels only, content is gzipped. Cheap on disk and integrates natively with Grafana. Trade-off: full-text search isn't as fast as Elasticsearch. Common modern stack: **PLG** (Promtail + Loki + Grafana) instead of EFK.

---

## Scenario-based

### S1. Logs aren't showing up in Kibana. Where do you look?
Walk the pipeline:
1. **App** — `kubectl logs <pod>` — is the app actually logging?
2. **Fluent Bit DaemonSet** — running on every node? `kubectl logs -n logging ds/fluent-bit`. Errors there?
3. **Elasticsearch** — reachable? `curl http://es:9200/_cat/indices`.
4. **Index template** — match the index name Fluent Bit writes to?
5. **Kibana data view** — created for `k8s-logs-*`? Time field set?

### S2. One Pod's logs are missing while others on the same node are fine.
- That Pod might be in a namespace excluded by Fluent Bit's filter.
- File rotation — kubelet rotates log files at 10Mi by default; very chatty Pods can outpace Fluent Bit's `Refresh_Interval`, losing some lines.
- Pod logs to a file inside the container (not stdout) — needs a sidecar.

### S3. Elasticsearch disk is full and cluster goes red.
Immediate:
- Delete oldest indices: `curl -XDELETE http://es:9200/k8s-logs-2026.04.*`.
- Lower replica count on indices: `_settings/number_of_replicas=0`.

Long-term:
- Set up ILM with delete-phase based on age or size.
- Add data nodes / disk.
- Drop high-cardinality fields at Fluent Bit (filter out request_id labels you don't need to search).

### S4. Sensitive PII is being logged. How do you scrub it?
- **At the app**: best — never log PII.
- **At Fluent Bit**: use the `modify` or `record_modifier` filter to mask/remove fields before shipping.
- **At Logstash** (if in path): more powerful regex/grok scrubbing.
- **At Elasticsearch**: too late; some clients have seen the data.

Compliance-wise, scrub upstream.

### S5. Kibana queries are slow.
- Time range too wide — narrow it.
- Searching free-text on `message` instead of a specific keyword field.
- Index has too few shards / too much data per shard. Rebalance.
- ES is under-provisioned for query load — add ingest/query nodes.

### S6. JSON logs from an app are showing up as a single `log` field, not parsed into separate fields.
- The `Merge_Log On` filter isn't applied to that Pod's source.
- The log line isn't valid JSON (truncated, multi-line).
- The Kubernetes filter ordering — `Merge_Log` must come after JSON detection.

Debug with `kubectl exec -it <fluent-bit-pod> -- /fluent-bit/bin/fluent-bit --dry-run`.

### S7. You need to alert on "more than 10 errors per minute from `orders-service`".
- Elasticsearch + Kibana: create an alert rule on a query like `service: "orders-service" AND level: "error"` with threshold.
- Or: send errors to Prometheus as a counter, alert via Prometheus Alertmanager. Common pattern when you have both stacks.
