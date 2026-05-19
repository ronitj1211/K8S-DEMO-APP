# Kibana — First-Time Setup & Per-Service Log Inspection

This guide assumes the EFK stack is already up (see the main [README](./README.md)) and that at least two services are logging — **`sample-app`** and **`orders-service`** (added in [`orders-service/`](./orders-service/)).

By the end you'll know how to:

1. Get past the Kibana welcome screens.
2. Create a **Data View** so Kibana can see your logs.
3. Use **Discover** to inspect logs.
4. **Tell services apart**: see only the logs of one service, two services side-by-side, or one container.
5. Save useful searches and pin filters.

> The screenshots aren't included — Kibana's UI changes often. Menu paths use the **top-left hamburger ☰**.

---

## 0. Open Kibana

```
http://localhost:5601
```

(If you closed your terminal, restart the port-forward: `kubectl port-forward -n logging svc/kibana 5601:5601 &`.)

The first time it loads:

- **"Welcome to Elastic"** modal → click **Explore on my own**.
- **"Add integrations"** banner → ignore it. We're using Fluent Bit, not Elastic Agent.

---

## 1. Create a Data View

Kibana doesn't auto-show your logs. You first tell it which Elasticsearch index pattern to read from.

1. **☰ → Stack Management → Data Views**.
2. Click **Create data view** (top right).
3. Fill in:
   - **Name**: `k8s-logs`
   - **Index pattern**: `k8s-logs-*`
     You should see "Your index pattern matches **1 source**" — that's your daily `k8s-logs-2026.05.19` index.
   - **Timestamp field**: `@timestamp`
4. Click **Save data view to Kibana**.

Done — Kibana now treats every log in any `k8s-logs-*` index as one queryable dataset.

> Why the wildcard? Fluent Bit writes one index per day (`k8s-logs-2026.05.19`, `k8s-logs-2026.05.20`, …). The `*` makes Kibana query across all of them.

---

## 2. Open Discover

**☰ → Discover.**

What you'll see:

- **Top bar**: the data view selector (should say `k8s-logs`), the **KQL query box**, and the **time picker** (top right).
- **Histogram**: a bar chart of log volume over time.
- **Document table**: one row per log line.
- **Left sidebar**: every field Kibana detected in the data.

If the table is empty:

- Click the time picker (top right) → choose **Last 15 minutes** or **Last 1 hour**.
- Make sure you've generated some traffic: `curl http://localhost:30090/` and `curl -X POST http://localhost:30099/orders`.
- Click the refresh icon next to the time picker.

---

## 3. Make the table readable: pick columns

The default `_source` column dumps the whole JSON — unreadable. Add columns:

1. In the **left sidebar**, find these fields (use the search box at the top of the sidebar):
   - `kubernetes.labels.app`
   - `kubernetes.container_name`
   - `log_processed.level`
   - `log_processed.msg`
2. Hover each field → click the **+ Add** button next to its name.

Now the table shows: time + service label + container + level + message. That's the bread-and-butter view for log debugging.

> Tip: drag the column headers to reorder them. Click the column header → **Sort A→Z / Z→A**.

---

## 4. Field anatomy — what each log carries

Every doc has three groups of fields:

### Kubernetes enrichment (added by Fluent Bit's K8s filter)

| Field | Example | What it is |
|-------|---------|------------|
| `kubernetes.namespace_name` | `demo` | Pod's namespace. |
| `kubernetes.pod_name` | `orders-service-7d6-abc` | Pod name (changes every deploy). |
| `kubernetes.container_name` | `orders` | The `name:` you gave the container in the Pod spec. |
| `kubernetes.labels.app` | `orders-service` | The Pod label `app=…` you set in the manifest. **Best field for "which service?"** because it's stable across deploys. |
| `kubernetes.host` | `colima` | The node the Pod ran on. |

### Container wrapper (added by Docker / containerd)

| Field | Example |
|-------|---------|
| `stream` | `stdout` or `stderr` |
| `time` | timestamp the runtime saw the line |

### Your app's payload (parsed from your JSON log line into `log_processed.*`)

For `sample-app`:

| Field | Example |
|-------|---------|
| `log_processed.level` | `info` / `warn` / `error` |
| `log_processed.msg` | `simulated error` |
| `log_processed.path` | `/error` |
| `log_processed.code` | `E_DEMO` |

For `orders-service` (different fields — same index!):

| Field | Example |
|-------|---------|
| `log_processed.level` | `info` / `warn` / `error` |
| `log_processed.service` | `orders-service` *(explicit, since the app emits it)* |
| `log_processed.action` | `create` / `lookup` / `charge` / `cron` |
| `log_processed.orderId` | `ord_1003` |
| `log_processed.customerId` | `cust_alice` |
| `log_processed.amount` | `42.50` |
| `log_processed.code` | `CARD_DECLINED` |
| `log_processed.gateway` | `stripe` |

Different services can write different fields — Elasticsearch is schema-flexible. Kibana shows whatever exists for each row.

---

## 5. Filtering by service (the main goal)

Three good ways. Each has different ergonomics.

### Way A — KQL query box (fastest)

The bar at the top of Discover. Type:

```text
kubernetes.labels.app : "orders-service"
```

Press Enter. The histogram and table redraw with only that service's logs.

Other examples (KQL syntax):

```text
kubernetes.labels.app : "sample-app"
kubernetes.labels.app : "sample-app" and log_processed.level : "error"
kubernetes.labels.app : ("sample-app" or "orders-service")
log_processed.level : ("warn" or "error")
log_processed.action : "charge" and log_processed.code : "CARD_DECLINED"
log_processed.orderId : ord_1005
```

### Way B — sidebar filter (no typing)

1. In the left sidebar, scroll to **`kubernetes.labels.app`**.
2. Click it → Kibana shows the **top values** in the current time range (e.g. `sample-app : 325`, `orders-service : 50`).
3. Click the **+** next to the value you want → adds a pinned filter pill above the table.
4. The **−** filters everything **except** that value.

Filter pills are easier to toggle off without retyping a query.

### Way C — click a value in the table

In the document table, hover any cell — two little buttons appear:

- **🔍 +** filter for this value
- **🔍 −** filter out this value

Click on a `kubernetes.labels.app` value of `orders-service` → instant filter.

---

## 6. Distinguishing services in a single view

Sometimes you don't want to filter to one — you want to **see them together but distinct**.

### Option 1: color-coded histogram

Above the histogram you'll see a **Break down by** dropdown.

- Set it to **`kubernetes.labels.app`** → the bar chart now stacks each service in a different color. You can immediately see which service is generating most of the volume.

### Option 2: side-by-side bar columns

Same **Break down by** but switch the chart type (bar → bar grouped) using the chart-options menu (⋯ next to the histogram).

### Option 3: split into two saved searches

Save one filtered view per service:

1. With `kubernetes.labels.app : "orders-service"` applied, click **Save** (top right) → name it `orders – all logs`.
2. Clear the filter, apply `kubernetes.labels.app : "sample-app"`, **Save** as `sample-app – all logs`.

Now **Open** lets you flip between them instantly.

---

## 7. Drilling into a specific container

A Pod can have multiple containers (sidecar pattern). To see only one container's logs:

```text
kubernetes.pod_name : "orders-service-*" and kubernetes.container_name : "orders"
```

Or:

```text
kubernetes.namespace_name : "demo" and kubernetes.container_name : "orders"
```

To see one **specific Pod** (good for "this one pod is acting up"):

```text
kubernetes.pod_name : "orders-service-7d6cbb88f7-abcde"
```

---

## 8. Practical service-debugging recipes

### "Show me all payment failures"

```text
kubernetes.labels.app : "orders-service" and log_processed.code : "CARD_DECLINED"
```

Add `log_processed.orderId` as a column → you have a paste-able list of failing orders.

### "Which customer has the most failed payments?"

In Discover, click on the **`log_processed.customerId`** field in the sidebar (with the filter above already applied). Kibana shows the **top values** — that's your answer in 3 clicks.

### "Compare error rate across services"

1. Clear filters; set time range to **Last 1 hour**.
2. Set the histogram **Break down by** to `kubernetes.labels.app`.
3. Apply filter `log_processed.level : "error"`.
4. The chart now shows error volume per service over time. Spikes are obvious.

### "Tail logs for one Pod, live"

Discover has a **Refresh** dropdown next to the time picker:

- Set time range: **Last 5 minutes**.
- Click the refresh interval → **5 seconds**.
- Apply filter `kubernetes.pod_name : "sample-app-…"`.

Kibana auto-refreshes — effectively `kubectl logs -f` with structured search.

---

## 9. Saving and sharing

- **Save** (top right) saves the **whole** Discover state: query, filters, columns, time range, sort order.
- **Open** brings any saved search back.
- **Share** gives a permalink that snapshots the current state — great for pasting into a ticket.

---

## 10. Quick verification from the command line

Sometimes it's faster to confirm what's in Elasticsearch without opening Kibana:

```bash
# Count by service in the last whatever-Fluent-Bit-has-flushed
curl -s -H 'Content-Type: application/json' \
  'http://localhost:9200/k8s-logs-*/_search?size=0' \
  -d '{"aggs":{"by_service":{"terms":{"field":"kubernetes.labels.app.keyword"}}}}' \
  | python3 -m json.tool

# Pull the latest 3 ERROR logs from orders-service
curl -s 'http://localhost:9200/k8s-logs-*/_search?pretty&size=3' \
  -H 'Content-Type: application/json' \
  -d '{
    "sort":[{"@timestamp":"desc"}],
    "query":{"bool":{"must":[
      {"term":{"kubernetes.labels.app.keyword":"orders-service"}},
      {"term":{"log_processed.level.keyword":"error"}}
    ]}}
  }'
```

If a query works here but doesn't work in Kibana, the issue is in your Kibana KQL syntax, not the data.

---

## 11. Cheat sheet

| You want to… | Do this |
|---|---|
| Get past welcome screens | "Explore on my own" |
| See logs at all | Create Data View `k8s-logs-*`, time field `@timestamp` |
| See readable rows | Add columns: `kubernetes.labels.app`, `kubernetes.container_name`, `log_processed.level`, `log_processed.msg` |
| Filter to one service | KQL: `kubernetes.labels.app : "orders-service"` |
| Filter to errors only | KQL: `log_processed.level : "error"` |
| Combine | KQL: `kubernetes.labels.app : "orders-service" and log_processed.level : "error"` |
| Filter to one Pod | KQL: `kubernetes.pod_name : "sample-app-…"` |
| Live tail | Time range "Last 5 m" + refresh interval "5s" |
| Compare volumes | Break down by `kubernetes.labels.app` above histogram |
| Save the view | "Save" top right → name it |

---

## Common pitfalls

- **"No results found"** with a non-empty time range → check if the filter pill is **excluded** (red icon, ➖). Hover and remove.
- **`.keyword` vs no `.keyword`** — Elasticsearch indexes strings two ways: full-text (`field`) and exact (`field.keyword`). KQL handles this for you, but raw Elasticsearch queries and Lens aggregations need `.keyword` for grouping. Example: `kubernetes.labels.app.keyword`.
- **Fields not appearing in the sidebar** — click the **Refresh field list** button on the data view (Stack Management → Data Views → your view → Refresh). Happens after a new app starts logging a field for the first time.
- **Old time range** — Kibana remembers the last time range. If you see no recent logs, the time picker is usually the culprit.

---

## Next steps

- Build a **Lens visualization**: ☰ → Visualize Library → Create → Lens. Drag `@timestamp` to the X axis, `Count of records` to Y, drag `kubernetes.labels.app` to Break down. Add to a Dashboard.
- Set up an **alert rule**: ☰ → Stack Management → Rules → Create rule of type *Elasticsearch query* — e.g. "alert if `log_processed.level:error` for `orders-service` exceeds 5/min".
- For production, install [ECK](https://www.elastic.co/guide/en/cloud-on-k8s/current/) or the [kube-prometheus-stack + Loki/ES via Helm](https://github.com/grafana/helm-charts) instead of hand-rolled manifests.

**Back to** [elk-logging README](./README.md)
