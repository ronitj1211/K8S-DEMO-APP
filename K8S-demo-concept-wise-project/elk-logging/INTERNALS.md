# EFK / ELK Logging — Internals

Fluent Bit's input → filter → output pipeline, K8s metadata enrichment mechanics, Elasticsearch indexing.

---

## Purpose

Centralize container logs from every Pod on every node into a searchable, queryable store. The classic stack:

- **F**luent Bit (collect + parse + enrich + ship) — one DaemonSet Pod per node.
- **E**lasticsearch (store + index + search) — the DB.
- **K**ibana (visualize + query) — the UI.

## Where container logs actually live

Every container's stdout/stderr is captured by the container runtime and written to a file. On a containerd node:

```
/var/log/pods/<namespace>_<pod>_<pod-uid>/<container>/<restart-count>.log
```

Kubelet creates a friendly symlink to it:

```
/var/log/containers/<pod>_<namespace>_<container>-<container-id>.log
```

The filename encodes pod, namespace, container. Fluent Bit uses this to know what each log line came from — the Kubernetes filter parses the filename.

## Log formats

Two formats you'll see depending on the runtime:

**Docker JSON** (Docker or cri-dockerd):
```json
{"log":"handled request\n","stream":"stdout","time":"2026-07-30T14:15:22.123Z"}
```

**CRI** (containerd, CRI-O):
```
2026-07-30T14:15:22.123456Z stdout F handled request
```

- Fields: timestamp, stream (stdout/stderr), tag (`F` for full line, `P` for partial), then the actual log.

Fluent Bit's `multiline.parser docker, cri` auto-detects and strips the outer wrapper.

## Fluent Bit's pipeline

```
[INPUT] tail
    │  reads /var/log/containers/*.log
    │  strips runtime wrapper via multiline.parser
    │  emits records with a tag like kube.var.log.containers.<pod>_<ns>_<container>-<id>.log
    ▼
[FILTER] kubernetes
    │  parses the filename to get namespace/pod/container
    │  calls K8s API to fetch pod labels, annotations, uid
    │  attaches kubernetes.* fields to each record
    │
    │  if Merge_Log On:
    │    detects JSON in the log line, parses it, merges fields
    │    into log_processed (or top-level)
    ▼
[FILTER] modify / record_modifier / lua (optional)
    │  scrubbing, renaming, adding constant fields
    ▼
[OUTPUT] es (Elasticsearch)
    │  batches records, sends bulk write to ES
    │  Logstash_Prefix + date suffix → k8s-logs-2026.07.30
    │  on failure, retries with backoff
```

## Input — the tail plugin's mechanics

```
[INPUT]
    Name              tail
    Tag               kube.*
    Path              /var/log/containers/*.log
    multiline.parser  docker, cri
    DB                /var/log/flb_kube.db
    Mem_Buf_Limit     5MB
    Skip_Long_Lines   On
    Refresh_Interval  5
```

- **`Path`**: glob for files to watch. Uses `inotify` to detect new files, deleted files, and appends.
- **`DB`**: SQLite file storing per-file offsets. Survives Fluent Bit restarts — resume tailing from where it left off.
- **`Mem_Buf_Limit`**: max in-memory buffer per input. If exceeded, Fluent Bit pauses reading until downstream drains.
- **`Refresh_Interval`**: how often to re-scan the Path for new files (in seconds).

On startup, Fluent Bit walks the Path, opens each file, seeks to the offset stored in the DB (or tail = end of file, by default), then inotify-watches for appends.

**Why `flb_kube.db` matters**: without it, a restart of Fluent Bit re-reads every log file from scratch (or from tail, depending on config). With it, tailing is resumed cleanly.

## Filter — kubernetes plugin

The magic that adds K8s metadata:

```
[FILTER]
    Name              kubernetes
    Match             kube.*
    Kube_URL          https://kubernetes.default.svc:443
    Merge_Log         On
    Merge_Log_Key     log_processed
    K8S-Logging.Parser   On
    K8S-Logging.Exclude  Off
```

**What it does per record:**

1. **Parse the tag** — `kube.var.log.containers.mypod_myns_container-abc123.log` → namespace=myns, pod=mypod, container=container.
2. **API lookup**: cache lookup by `myns/mypod`; if miss, call the K8s API (using the Pod's SA token in `/var/run/secrets/kubernetes.io/serviceaccount/token`).
3. **Enrich**: add `kubernetes.namespace_name`, `kubernetes.pod_name`, `kubernetes.container_name`, `kubernetes.labels.*`, `kubernetes.annotations.*`, `kubernetes.pod_id`.
4. **Merge log** (if `Merge_Log On`): try to parse the log line's content as JSON. If it's valid JSON, merge fields into `log_processed` (or a configured key).

**API caching**: metadata is cached per Pod for the pod's lifetime. When a Pod is deleted, its cache entry is evicted. On new Pods, one API call, then all subsequent records for that Pod hit the cache.

## Merge_Log — structured log flattening

Say your app logs:
```json
{"level":"error","msg":"payment declined","orderId":"ord_1234"}
```

After the outer runtime wrapper is stripped, that JSON becomes the record's `log` field.

With `Merge_Log On`:
- Fluent Bit tries to parse `log` as JSON.
- If it succeeds, adds each key as a field under `log_processed`:
  ```json
  {
    "log": "{...}",
    "log_processed": {
      "level": "error",
      "msg": "payment declined",
      "orderId": "ord_1234"
    },
    "kubernetes": { "namespace_name": ..., "pod_name": ..., "labels": { ... } }
  }
  ```

Elasticsearch indexes each field individually. Now you can query `log_processed.level:error` in Kibana.

## Output — the ES plugin

```
[OUTPUT]
    Name              es
    Match             *
    Host              elasticsearch.logging.svc.cluster.local
    Port              9200
    Logstash_Format   On
    Logstash_Prefix   k8s-logs
    Suppress_Type_Name On
    Retry_Limit       False
```

- **`Logstash_Format On`** — appends a date suffix to the index name: `k8s-logs-2026.07.30`. Time-based indices for retention.
- **`Retry_Limit False`** — retry forever. If ES is down, Fluent Bit buffers in memory (up to `Mem_Buf_Limit`), then pauses inputs.
- **Bulk writes**: Fluent Bit batches records and sends `POST /_bulk` — much cheaper than one write per record.

## Elasticsearch — indexing internals

An **index** in ES is like a table. Each **document** (log record) has a JSON structure.

For each field:
- **`text`** fields — tokenized and indexed for full-text search.
- **`keyword`** fields — exact-match, used for aggregations and filtering.
- **`date`** — parsed as timestamp.
- **`long` / `double`** — numeric.

By default, ES **auto-maps** field types based on the first document. If the first `orderId` value is `"ord_1234"` (string), all future `orderId` values are text/keyword. If the first was `1234` (number), it's numeric — and later string values fail indexing.

**Fix**: use an **index template** to specify field mappings upfront.

## Index templates

```json
{
  "index_patterns": ["k8s-logs-*"],
  "template": {
    "settings": {
      "number_of_shards": 1,
      "number_of_replicas": 1
    },
    "mappings": {
      "properties": {
        "@timestamp": { "type": "date" },
        "log_processed": {
          "properties": {
            "level": { "type": "keyword" },
            "orderId": { "type": "keyword" },
            "amount": { "type": "double" }
          }
        },
        "kubernetes": {
          "properties": {
            "namespace_name": { "type": "keyword" },
            "pod_name": { "type": "keyword" }
          }
        }
      }
    }
  }
}
```

New `k8s-logs-*` indices use this template. Predictable field types → reliable queries.

## Sharding and shards-per-node

Each index has one or more **shards** (default 1 primary + 1 replica in newer ES). A shard is a Lucene index — an atomic unit of parallelism.

Query cost scales with shard count. Too many shards = per-shard overhead dominates.

**Rule of thumb**: aim for **20-50 GB per shard**. For a 10 GB/day index, one shard is fine. For a 500 GB/day index, use ~10-20 primary shards.

## ILM — Index Lifecycle Management

```json
{
  "policy": {
    "phases": {
      "hot":  { "actions": { "rollover": { "max_size": "50GB", "max_age": "1d" } } },
      "warm": { "min_age": "3d",  "actions": { "shrink": { "number_of_shards": 1 }, "forcemerge": { "max_num_segments": 1 } } },
      "cold": { "min_age": "30d", "actions": { "allocate": { "require": { "data": "cold" } } } },
      "delete": { "min_age": "90d", "actions": { "delete": {} } }
    }
  }
}
```

- **hot**: writing + querying heavy. Fast SSDs.
- **warm**: read-mostly. Slower disks OK.
- **cold**: rarely accessed. Object storage tier.
- **delete**: gone.

Without ILM, ES fills up disk and goes red. First thing to set up in production.

## Fluent Bit vs Fluentd

- **Fluent Bit**: 10-30 MB RAM, C-based, ~fewer plugins. First-class K8s enrichment. Runs as DaemonSet on every node.
- **Fluentd**: 500+ MB RAM, Ruby-based, many more plugins. Better for heavy transformation.

Common pattern: **Fluent Bit** as node-level collector; **Fluentd** as central aggregator/transformer between Fluent Bit and ES.

## Loki — the alternative

Grafana's Loki takes a different approach:

- **Indexes labels only**, not log content. Storage is much cheaper (compressed chunks in object storage).
- **LogQL** query language, similar syntax to PromQL.
- **PLG stack**: Promtail (collector) + Loki + Grafana.
- Trade-off: full-text search is slower than ES because Loki has to scan chunks matching label filters.

For log-heavy environments (100s of GB/day), Loki costs much less than ES. For search-heavy workflows (support looking up specific error signatures), ES is faster.

---

## The 30-second summary

- Container stdout → runtime writes to `/var/log/pods/<...>.log` → kubelet symlinks to `/var/log/containers/*.log` → Fluent Bit tails these.
- Fluent Bit's Kubernetes filter parses the filename + calls the K8s API to enrich with pod/namespace/labels.
- `Merge_Log On` flattens the app's JSON payload into queryable fields.
- Elasticsearch stores docs in time-based indices; index templates fix field types; ILM handles rotation and deletion.
- Cardinality/high-uniqueness labels blow up ES memory the same way they blow up Prometheus.
- Fluent Bit is the modern node-level collector (DaemonSet); Fluentd fills the central-processing niche.
- Loki (PLG stack) is the newer alternative — cheaper storage, label-only indexing.
