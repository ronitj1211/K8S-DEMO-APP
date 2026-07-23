# EFK / ELK Logging — Deep Dive for Interviews

The narrative on centralized logging in Kubernetes. Why the classic ELK stack morphed into EFK, and how Loki changes the tradeoff.

---

## The origin story

Log files were fine when you had one server. `tail /var/log/nginx/access.log` and grep. But even with two servers, you're SSHing to both and correlating manually.

Elasticsearch (2010) + Logstash (2011) + Kibana (2013) — the **ELK stack** — became the standard centralized logging stack for the pre-container era. Logstash ran on every host, tailing files and shipping to Elasticsearch, which indexed everything and made it searchable via Kibana.

Kubernetes broke this in a specific way: **containers are ephemeral**. When a Pod dies, its container's stdout is still in `/var/log/containers/*.log` on the node — but only until the log rotates or the Pod's replacement writes over it. Also, Logstash was heavy (JVM, 500+ MB RAM) — not a fit for running on every node in a big cluster.

**Fluent Bit** (from Treasure Data, later CNCF) replaced Logstash for K8s. Written in C, ~10-30 MB RAM, first-class K8s metadata enrichment, deployed as a DaemonSet — one Pod per node, tailing that node's log files. Same L (Logstash) → F (Fluent Bit), yielding **EFK**.

Same three-tier pattern: Fluent Bit collects, Elasticsearch stores, Kibana visualizes.

## The mental model

Three concerns, three components:

- **Collection** (Fluent Bit) — reads container log files from each node, parses them, adds K8s metadata, ships to a backend.
- **Storage + Search** (Elasticsearch) — indexes log documents by field, supports full-text search + aggregations.
- **Visualization** (Kibana) — web UI on top of Elasticsearch. Discover for searching, Dashboards for graphs, Alerting for thresholds.

Every K8s log record travels this path:
```
app writes to stdout
    ↓
container runtime writes to /var/log/containers/<pod>_<ns>_<container>-<id>.log
    ↓
Fluent Bit DaemonSet reads the file (inotify)
    ↓
Fluent Bit parses the outer JSON (docker / CRI format)
    ↓
Fluent Bit enriches with K8s metadata (namespace, pod, labels, container_name)
    ↓
Fluent Bit merges the app's inner JSON payload
    ↓
Fluent Bit ships to Elasticsearch as a JSON document
    ↓
Elasticsearch indexes it
    ↓
Kibana queries it
```

## How it actually works

### The kubelet's log format

Container runtimes (containerd, CRI-O, or Docker via cri-dockerd) each write logs in slightly different formats:
- **Docker JSON**: `{"log":"the message","stream":"stdout","time":"..."}`.
- **CRI**: `<time> <stream> <logtag> <message>` plain-text.

Both formats wrap the app's stdout in an outer envelope. Fluent Bit's `multiline.parser docker, cri` auto-detects and strips.

### The kubernetes filter

Fluent Bit's Kubernetes filter parses the log file's *path* (which encodes pod/namespace/container in the filename) to identify the source Pod. Then it calls the K8s API to fetch the Pod's labels, annotations, etc. That metadata gets attached to every log record from that Pod.

Also, `Merge_Log On` unpacks the app's JSON payload — if your app logs `{"level":"info","msg":"..."}`, Fluent Bit parses that JSON and merges the fields to top-level (or under `log_processed`). Now you can query `log_processed.level:error` in Kibana.

### Elasticsearch index model

Fluent Bit typically writes to time-based indices: `k8s-logs-2026.07.23`, `k8s-logs-2026.07.24`. This makes retention manageable (delete old indices instead of individual documents) and search fast (only scan relevant days).

**Index templates** in Elasticsearch define how new indices should be configured — shards, replicas, field mappings. Without templates, ES infers field types from the first document, which can cause weird typing errors later (`"42"` interpreted as string vs int).

### Storage lifecycle

**ILM (Index Lifecycle Management)** rotates and deletes old indices automatically. Typical:
- Hot phase (0-3 days) — heavy read/write, fast SSD.
- Warm phase (3-30 days) — read-heavy, cheaper storage.
- Cold phase (30+ days) — rarely accessed, cheapest.
- Delete phase (90+ days) — gone.

Without ILM, ES fills up disk and turns red.

## When to use EFK

Every non-trivial cluster. If you have more than one Pod, you need centralized logging. Options:

- **Self-hosted EFK** — full control, full ops burden.
- **Managed** — AWS OpenSearch, Elastic Cloud, Datadog, New Relic. Pay for someone to run it.
- **Loki + Promtail + Grafana (PLG)** — Grafana Labs' alternative. Loki indexes only labels (not content), so it's much cheaper on disk. Trade-off: full-text search isn't as fast as ES. Great fit if you have labels-first querying and use Grafana already for metrics.

## When EFK might not be the right tool

- **Structured event tracking** — analytics events, business events. Send those to a data warehouse (BigQuery, Redshift, Snowflake), not the log stack.
- **Traces** — distributed tracing has its own stack (Jaeger, Tempo, Datadog APM). Don't force traces through logs.
- **Metrics** — Prometheus. Don't log gauge values that update every second — use Prometheus counter/gauge.

Logs are for events with variable structure that need arbitrary querying. Not everything is a log.

## Common misunderstandings

**"Fluent Bit only reads Docker JSON logs."** With `multiline.parser docker, cri`, it handles both. Modern K8s runs containerd (CRI format), not Docker.

**"K8s labels enrich logs automatically."** Only because Fluent Bit's kubernetes filter calls the API and does the enrichment. If you deploy Fluent Bit without the RBAC to read Pods, no labels appear.

**"Elasticsearch is a database."** It's a search engine that happens to store data. Different mental model from relational or key-value stores. Querying is JSON-DSL, results are ranked by relevance by default, and consistency is *eventual*.

**"More shards = better performance."** More shards = more parallelism, up to a point, but each shard has overhead. Rule of thumb: shard size 20-50 GB. Under-shard for small indices; add shards if daily volume grows past that.

**"Grafana can only visualize Prometheus."** It supports Elasticsearch, Loki, CloudWatch, Postgres, and dozens of others as datasources. Many orgs use one Grafana for metrics + logs.

**"Search-all-time is fine."** Elasticsearch queries scan every shard in the time range. A "search last 30 days" over 30 daily indices is 30× more work than "search today." Always constrain by time range.

## The war stories

**"Elasticsearch went red and everything backed up."** Disk full. No ILM configured. Fix immediately: delete oldest indices. Fix permanently: set up ILM with a delete phase.

**"Cardinality explosion crashed Prometheus."** Same lesson applies to Elasticsearch's field count. If every log line has a unique `request_id` and you don't drop it, ES creates a mapping entry for every unique value. Fix: `metric_relabel_configs` in Prometheus / Fluent Bit's `record_modifier` filter to drop or hash high-cardinality fields.

**"Sensitive data leaked into logs."** App logged the full request body including passwords. Now that data is in ES. Sanitization has to happen upstream: never log secrets; if you must, scrub in Fluent Bit's `modify` filter before shipping. Once it's in ES, PII exposure is compliance-relevant.

**"Fluent Bit ate all node memory."** `Mem_Buf_Limit` too high or a downstream slowdown backing up. With a slow Elasticsearch, Fluent Bit buffers in memory. Solution: buffer to disk (`storage.type: filesystem`), and/or insert Kafka between Fluent Bit and ES.

**"Logs from one Pod are missing."** Common causes: log rotation is faster than Fluent Bit's read cursor; app writes to a file inside the container instead of stdout; namespace excluded by a filter. Debug with Fluent Bit's HTTP metrics endpoint (`:2020/api/v1/metrics`).

**"Kibana query is slow."** Time range too wide, or free-text search on `message` instead of a specific field. Constrain time range, use keyword-typed fields for exact matching, and consider adding index templates to type frequently-queried fields correctly.

## What to actually say in an interview

If asked "how do you handle logging in K8s?":

> Centralized log aggregation. On each node, a Fluent Bit DaemonSet reads container stdout/stderr from `/var/log/containers/*.log`, parses the outer runtime wrapper (Docker JSON or CRI format), enriches each record with Kubernetes metadata — namespace, Pod name, labels, container name via the K8s API — and ships to Elasticsearch. Kibana provides search and dashboards on top. That's EFK. The alternative is Loki + Promtail + Grafana, which indexes only labels and is cheaper for log-heavy workloads — trade-off is slower full-text search.

If asked why not Logstash:

> Logstash is JVM-based, 500 MB RAM per instance, and doesn't fit the "one collector per node" DaemonSet pattern well. Fluent Bit is 10-30 MB, in C, first-class K8s metadata enrichment. The evolution went ELK → EFK exactly for this. If you need heavy transformation, you can still put Logstash *between* Fluent Bit and Elasticsearch — Fluent Bit for cheap collection, Logstash for expensive processing. But most orgs don't need that.

If asked about scaling ES:

> Time-based indices are the trick — one per day (or hour if volume is high). ILM auto-rotates and deletes old indices. Shard size around 20-50 GB per shard. Cluster runs multiple data nodes; hot/warm/cold tiers if you want cost-optimized storage. For serious scale, use OpenSearch or Elastic Cloud managed. Cardinality is the enemy — don't index high-cardinality fields like request_id unless you really need to query them; drop or hash them at Fluent Bit before ingest.

If asked structured vs unstructured logs:

> Structured JSON logs are much better. Log `{"level":"error", "user_id":42, "error":"timeout"}` instead of `[ERROR] user 42: timeout`. Fluent Bit's `Merge_Log On` parses the JSON and exposes each field for querying in Kibana. Filter by `user_id`, aggregate by `level`, chart by `error` — trivial. Unstructured logs work but you're doing regex extraction at query time, which is slow and fragile.

Say the words: **stdout to /var/log/containers**, **DaemonSet collection**, **K8s metadata enrichment via API**, **structured JSON logs + Merge_Log**, **time-based indices + ILM**, **cardinality is the enemy**, **Fluent Bit not Logstash on K8s**, **Loki as alternative**.
