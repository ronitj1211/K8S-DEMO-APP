# Kibana Walkthrough — From Zero to a Working Dashboard

A linear, click-by-click guide for our EFK stack on Colima/k3s. Assumes the ELK stack is up (Elasticsearch + Kibana + Fluent Bit + demo apps) — see [RUN-STEPS.md](RUN-STEPS.md) to start it.

> **Companion doc:** [KIBANA_GUIDE.md](KIBANA_GUIDE.md) is a reference/cheat-sheet. This file is the step-by-step tour.

---

## 0. Open Kibana

```
http://localhost:30092
```

You should see the Kibana home page or a "Welcome to Elastic" modal.

### If you see the "Add integrations" page (the one with 158 options)

**Ignore it.** That page is for Elastic's own agents (Filebeat, Metricbeat, etc.). Our stack uses **Fluent Bit** which writes directly to Elasticsearch — no Kibana integration needed.

The "Kibana cannot connect to the Elastic Package Registry" warning is expected — the cluster is offline from Elastic's servers, and doesn't need to reach them.

### Get out of the Integrations page

- **Top-left hamburger ☰** → any other menu item. **Analytics → Discover** is where you want to be.

If you see a "Welcome to Elastic" modal on first open, click **"Explore on my own"** (bottom of the modal).

---

## 1. Create a Data View (one-time)

Kibana won't show any logs until you tell it which Elasticsearch index to read.

1. **☰ (top-left) → Management → Stack Management**.
2. In the left panel under **Kibana**, click **Data Views**.
3. Click **Create data view** (top-right button).
4. Fill in:

   | Field | Value |
   |---|---|
   | **Name** | `k8s-logs` |
   | **Index pattern** | `k8s-logs-*` |
   | **Timestamp field** | `@timestamp` |

   Under the index pattern box, you should see something like:
   > *Your index pattern matches these sources: `k8s-logs-2026.07.13`, `k8s-logs-2026.05.20`, …*

   If it says "No indices match" — you don't have any logs yet. Generate some (see step 4 below) and retry.

5. Click **Save data view to Kibana**.

You'll be redirected to the data view detail page listing all discovered fields (`kubernetes.pod_name`, `log_processed.level`, etc.).

---

## 2. Open Discover — see raw logs

**☰ → Analytics → Discover**.

You should see:

- **Top bar** — data view selector (`k8s-logs`), KQL query box, and the time picker (right side).
- **Histogram** — bar chart of log volume over time.
- **Document table** — one row per log record.
- **Left sidebar** — every field Kibana detected.

### If the table is empty

1. Check the **time picker (top-right)** — set it to **Last 15 minutes** or **Last 1 hour**.
2. Verify the data view picker (top-left of Discover) says **`k8s-logs`**.
3. Click the **refresh** button (↻ icon next to the time picker).

Still empty? Go to step 4, generate traffic, then come back and refresh.

---

## 3. Make the table readable — pick columns

The default view shows one giant `_source` blob per row. Add columns to get a readable table:

1. In the **left sidebar**, find each of these fields (use the search box at the top of the sidebar):
   - `kubernetes.labels.app`
   - `kubernetes.container_name`
   - `log_processed.level`
   - `log_processed.msg`
2. Hover each field → click the small **+** button next to its name.

Now every row shows: time, app label, container, log level, message.

Optionally drag the column headers to reorder them. Click any column header → **Sort** to sort.

---

## 4. Generate some traffic

From your terminal (outside Kibana):

```bash
# sample-app — most reliable source of logs
for i in $(seq 1 30); do
  curl -s -o /dev/null http://localhost:30090/         # info-level: "handled request"
  curl -s -o /dev/null http://localhost:30090/warn     # warn-level
  curl -s -o /dev/null http://localhost:30090/error    # error-level
done

# orders-service — richer fields (orderId, customerId, amount, action)
for i in $(seq 1 20); do
  curl -s -X POST http://localhost:30099/orders > /dev/null
  curl -s http://localhost:30099/orders/ord_$RANDOM > /dev/null
  curl -s -X POST http://localhost:30099/payments/charge > /dev/null
done
```

Or open <http://localhost:30091> in a browser (the log-generator UI) and click buttons.

Back in Kibana Discover, click **↻ Refresh**. New records should appear within ~5–10 seconds.

---

## 5. The three groups of fields on every record

Every doc carries:

### A. Kubernetes enrichment (added by Fluent Bit's `kubernetes` filter)

| Field | Example | What it is |
|---|---|---|
| `kubernetes.namespace_name` | `demo` | Pod's namespace |
| `kubernetes.pod_name` | `sample-app-5db64f79d6-4fcjq` | Pod name (changes every deploy) |
| `kubernetes.container_name` | `app` | The container's `name:` in the Pod spec |
| `kubernetes.labels.app` | `sample-app` | Pod label `app=…`. **Best for "which service"** — stable across deploys |
| `kubernetes.host` | `colima` | The node the Pod ran on |

### B. Container wrapper (added by the runtime)

| Field | Example |
|---|---|
| `stream` | `stdout` or `stderr` |
| `time` | timestamp the runtime saw the line |

### C. Your app's structured payload (parsed from JSON stdout into `log_processed.*`)

For `sample-app`:

| Field | Values |
|---|---|
| `log_processed.level` | `info`, `warn`, `error` |
| `log_processed.msg` | `handled request`, `simulated error` |
| `log_processed.path` | `/`, `/warn`, `/error` |
| `log_processed.code` | `E_DEMO` (only on error records) |

For `orders-service`:

| Field | Values |
|---|---|
| `log_processed.service` | `orders-service` |
| `log_processed.action` | `create`, `lookup`, `charge`, `cron` |
| `log_processed.orderId` | `ord_1005` |
| `log_processed.customerId` | `cust_alice` |
| `log_processed.amount` | numeric |
| `log_processed.code` | `CARD_DECLINED` (only on failures) |
| `log_processed.gateway` | `stripe` |

**Different services can carry different fields in the same index** — Elasticsearch is schema-flexible.

---

## 6. Filter with KQL

The bar at the top of Discover accepts **KQL** (Kibana Query Language). Try each of these; press Enter to apply:

```text
kubernetes.labels.app : "sample-app"
```
```text
log_processed.level : "error"
```
```text
kubernetes.labels.app : "sample-app" and log_processed.level : "error"
```
```text
kubernetes.namespace_name : "demo" and log_processed.level : ("warn" or "error")
```
```text
log_processed.action : "charge" and log_processed.code : "CARD_DECLINED"
```
```text
kubernetes.pod_name : "sample-app-*"
```

To clear the filter, click the **×** at the right of the KQL box.

### Alternative: click-to-filter

In the document table, hover any cell — small **+** and **−** buttons appear.

- **+** filter *for* this value.
- **−** filter *out* this value.

Filters appear as pills below the KQL box. Click any pill to edit / disable / pin / remove.

---

## 7. Live tail — like `kubectl logs -f`

To watch logs in real-time:

1. Set time range: **Last 5 minutes** (top-right).
2. Click the small **calendar icon** next to the time picker → **Refresh every: 5 seconds** → **Start**.

Combine with a filter (e.g., `kubernetes.pod_name : "sample-app-…"`) to tail one Pod.

Kibana redraws every 5 seconds. Stop with the same menu → **Stop**.

---

## 8. Save the search

After tuning columns, filters, and time range, click **Save** (top-right).

- Name: `sample-app – errors` (or whatever fits)
- Click **Save**.

Later: click **Open** → pick your saved search. Everything (columns, filters, time, sort) restores.

You can also **Share** → **Get link** for a permalink that snapshots the current state.

---

## 9. Build a Lens visualization

Now the fun part — turn logs into charts.

1. **☰ → Analytics → Visualize Library → Create visualization**.
2. Choose **Lens** (the drag-and-drop builder).
3. In the top-left, select the **`k8s-logs`** data view.
4. Set time range (top-right) to **Last 1 hour**.
5. Drag fields onto the canvas:

   - Drag **`@timestamp`** to **Horizontal axis** — Kibana infers "date histogram".
   - Drag **Records (count)** — automatically becomes the Vertical axis.
   - Drag **`kubernetes.labels.app.keyword`** to **Breakdown**.
6. Change chart type on the right — **Bar (stacked)** or **Line**.
7. **Save** (top-right) → name it `Log volume by service`.

You now have a chart showing per-service log volume over time.

Try another:

- Drag `log_processed.level.keyword` to Breakdown instead → see info/warn/error volume by level.
- Filter to one service in the top KQL → the whole chart re-scopes.

---

## 10. Assemble a Dashboard

1. **☰ → Analytics → Dashboard → Create dashboard**.
2. Click **Add from library** (top).
3. Pick the Lens viz you saved (`Log volume by service`).
4. Click **Add from library** again → **Add** saved searches you made (they render as tables inside the dashboard).
5. Resize / rearrange panels by dragging the corners.
6. Set the dashboard's time range (top-right).
7. **Save** (top-right) → name it `Demo apps – logging overview`.

A dashboard is a single URL you can share with your team, refresh live, or bookmark.

---

## 11. Alerts (optional)

To fire on "too many errors":

1. **☰ → Management → Stack Management → Rules and Connectors → Create rule**.
2. Rule type: **Elasticsearch query**.
3. **Data view**: `k8s-logs`.
4. **Query**:
   ```
   kubernetes.labels.app : "sample-app" and log_processed.level : "error"
   ```
5. **Threshold**: `count > 5` over `last 1 minute`.
6. **Action**: **Server log** for testing (or Slack / email / webhook in prod).
7. **Save**.

Trigger it: `for i in $(seq 1 10); do curl -s http://localhost:30090/error; done`. Within a minute the rule fires — visible in **Alerts** view.

---

## 12. Sanity-check from the CLI (no Kibana needed)

Sometimes it's fastest to skip the UI:

```bash
# per-service doc counts
kubectl exec -n logging elasticsearch-0 -- curl -s -H 'Content-Type: application/json' \
  'http://localhost:9200/k8s-logs-*/_search?size=0&pretty' \
  -d '{"aggs":{"by_service":{"terms":{"field":"kubernetes.labels.app.keyword","size":10}}}}'
```

```bash
# latest 3 ERROR-level records
kubectl exec -n logging elasticsearch-0 -- curl -s \
  'http://localhost:9200/k8s-logs-*/_search?pretty&size=3' \
  -H 'Content-Type: application/json' \
  -d '{
    "sort":[{"@timestamp":"desc"}],
    "query":{"term":{"log_processed.level.keyword":"error"}}
  }'
```

If a query works from `curl` but not in Kibana, the KQL syntax is the culprit — not the data.

---

## 13. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| **"Add integrations" page insists on being shown** | Ignore it — click ☰ → Discover instead. Not needed for our setup. |
| **"No results found"** with fresh data | Time picker is set too narrow. Widen to Last 1 hour. |
| **Data view creation says "No indices match"** | No logs in ES yet. Run traffic first, then retry. |
| **Fields don't appear in sidebar** | ☰ → Stack Management → Data Views → your view → **Refresh field list** (top). |
| **KQL says "0 hits" but curl finds it** | You probably used the wrong case or missing quotes. Values are case-sensitive. |
| **`.keyword` vs no `.keyword`** | In KQL, use the field name directly. In Lens/aggregations, use `.keyword` for exact-match grouping. |
| **Filter pill has red icon (➖)** | It's an *exclude* filter — click and remove if you meant to include. |
| **Slow queries / laggy Kibana** | Elasticsearch is under memory pressure. Shrink the time range; single-node ES on Colima is not fast. |

---

## 14. Known parsing gap in this session

In today's run, log records from these containers are not yet landing in ES:

- `orders-service` (container `orders`)
- `log-generator-ui` (container `ui`)

But these ARE landing:

- `sample-app` (container `app`) — full JSON parsed
- `coredns`, `kibana`, `elasticsearch` (system pods)
- `fluent-bit` (its own logs)

Which means you can practice the Kibana workflow with plenty of data — just prefer `kubernetes.labels.app : "sample-app"` as your primary demo target for now. The orders-service parsing needs a separate debug session on Fluent Bit's tail + kubernetes filter.

To generate rich sample-app traffic (info + warn + error):

```bash
for i in $(seq 1 40); do
  curl -s http://localhost:30090/ > /dev/null
  curl -s http://localhost:30090/warn > /dev/null
  curl -s http://localhost:30090/error > /dev/null
done
```

Then refresh Discover.

---

## 15. Cheat sheet

| Goal | Path / KQL |
|---|---|
| Get past welcome / integrations | ☰ → Discover |
| Create Data View | ☰ → Stack Management → Data Views → Create → `k8s-logs-*` / `@timestamp` |
| See readable rows | Add columns: `kubernetes.labels.app`, `kubernetes.container_name`, `log_processed.level`, `log_processed.msg` |
| Filter to one service | `kubernetes.labels.app : "sample-app"` |
| Filter to errors | `log_processed.level : "error"` |
| Filter to one Pod | `kubernetes.pod_name : "sample-app-..."` |
| Combine | `kubernetes.labels.app : "sample-app" and log_processed.level : "error"` |
| Live tail | Last 5 min + Refresh every 5s |
| Save search | Save (top-right) |
| Build chart | Visualize Library → Lens |
| Dashboard | Analytics → Dashboard → Create |
| Alert | Stack Management → Rules → Create (Elasticsearch query) |

---

**Next stop:** [KIBANA_GUIDE.md](KIBANA_GUIDE.md) for the reference version, or [RUN-STEPS.md](RUN-STEPS.md) if you need to restart the stack.
