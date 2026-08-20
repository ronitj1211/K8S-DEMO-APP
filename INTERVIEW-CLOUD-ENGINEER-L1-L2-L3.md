# Cloud / DevOps Engineer Interview — L1, L2, L3 (Full Answers)

Format used for every question: **What it is → How it works → How to answer it in the interview.**

- **L1 — Abhishek Kumar (Lead Cloud Engineer):** project, monitoring, Kubernetes basics, Terraform.
- **L2 — Akhil:** probes, PDB, ALB/NLB, health checks, throttling, API Gateway, CloudFront.
- **L3 — Abhishek Kumar & Siva (Head of Engineering):** architecture design + real-world troubleshooting.

---

# L1 — Abhishek Kumar (Lead Cloud Engineer)

## Q1. Introduce yourself

**What it is:** A 90-second positioning statement, not a biography. The interviewer is deciding what to ask you next, so the intro should plant the hooks you *want* to be asked about.

**How it works:** Present → Past → Why here. Name concrete tech, one number, one outcome.

**Answer (template — swap in your numbers):**

> I'm a Cloud/DevOps engineer with ~X years of experience, currently working primarily on AWS and Kubernetes. In my current role I own the infrastructure and delivery pipeline for a microservices platform running on EKS — roughly N services across dev/stage/prod.
>
> My day-to-day is in three buckets:
> 1. **Infrastructure as Code** — Terraform for VPC, EKS, RDS, ALB, IAM, S3, CloudFront; everything is modular with remote state in S3 and DynamoDB locking.
> 2. **Kubernetes & delivery** — Helm charts, Argo CD for GitOps, rolling and canary deployments, HPA/Cluster Autoscaler, ALB Ingress Controller for exposure.
> 3. **Observability & reliability** — Prometheus + Grafana for metrics, Loki + Promtail for logs, Alertmanager into Slack/PagerDuty. I handle production incidents — 5xx spikes, pod crash loops, node pressure, target group health issues.
>
> Recently I migrated <X> from <EC2/ECS> to EKS, which cut deployment time from ~30 minutes to under 5 and reduced infra cost by ~N% through right-sizing and Spot node groups.
>
> I'm interested in this role because it's a deeper AWS + Kubernetes ownership position, which is exactly the direction I've been growing in.

**Interview tips:** Do not narrate your degree, your college, or every past employer. End on why *this* role. Keep it under two minutes.

---

## Q2. Explain your most recent project and its overall architecture

**What it is:** The anchor question of the whole loop. Every later question (Ingress, ALB, RDS, monitoring, troubleshooting) will be traced back to what you say here — so describe an architecture you can defend end-to-end.

**How it works:** Explain in the direction traffic flows: user → edge → load balancer → compute → data → observability → CI/CD.

**Answer:**

> It's a multi-tenant SaaS platform — a React frontend and around N backend microservices (Node.js/Python/Java) — running on AWS EKS.
>
> **Network layer:** A single VPC per environment with a /16 CIDR, spread over 3 AZs. Three subnet tiers:
> - **Public subnets** — ALB / NAT Gateways only.
> - **Private app subnets** — EKS worker nodes and pods.
> - **Private data subnets** — RDS PostgreSQL, ElastiCache Redis. No route to the internet at all.
>
> **Edge & exposure:** Route 53 → CloudFront (static assets, TLS, WAF, caching) → ALB in the public subnets. The ALB is provisioned by the **AWS Load Balancer Controller** from Kubernetes Ingress resources. ACM certificates terminate TLS at CloudFront and the ALB. Some partner-facing APIs go through **API Gateway → VPC Link → internal ALB** instead, so we get throttling, API keys, and usage plans.
>
> **Compute:** EKS with managed node groups — an on-demand group for system/critical workloads and a Spot group for stateless services. Karpenter/Cluster Autoscaler for node scaling, HPA for pod scaling. Workloads are namespaced per team, with ResourceQuotas, NetworkPolicies, and IRSA (IAM Roles for Service Accounts) so pods get scoped AWS permissions instead of node roles.
>
> **Data:** RDS PostgreSQL Multi-AZ in private data subnets, accessed via a DB subnet group; a custom parameter group for `max_connections`, `log_min_duration_statement`, and SSL enforcement. Redis for caching/sessions. S3 for user uploads and artifacts, with bucket policies, versioning, and SSE-KMS.
>
> **Secrets & config:** ConfigMaps for non-sensitive config; AWS Secrets Manager / SSM Parameter Store pulled into the cluster via External Secrets Operator, mounted as Kubernetes Secrets.
>
> **CI/CD:** GitHub Actions (or Jenkins) builds and tests, pushes images to ECR with the git SHA as the tag, updates the Helm values in a separate GitOps repo; **Argo CD** syncs that repo into the cluster. Infrastructure is Terraform, applied via a pipeline with `plan` on PR and `apply` on merge.
>
> **Observability:** Prometheus (kube-prometheus-stack) for metrics, Grafana for dashboards, Loki + Promtail for logs, Alertmanager → Slack/PagerDuty. CloudWatch for AWS-native signals (ALB 5xx, RDS CPU, node status checks).

**Interview tips:** Draw it if you're on a whiteboard/screen share. Be ready for the immediate follow-ups: *why EKS over ECS*, *why CloudFront in front of ALB*, *how do pods get IPs*, *how do you handle secrets*.

---

## Q3. Explain how monitoring was implemented — dashboards, metrics, alerts

In my project, we implemented monitoring using Prometheus and Grafana, and centralized logging using the EFK stack.

For monitoring, Prometheus was responsible for collecting metrics from our Kubernetes EKS cluster and applications. We monitored infrastructure and application-level metrics such as node CPU and memory usage, disk usage, Pod CPU and memory usage, Pod restarts, Pod status, container resource utilization, and application metrics.

We deployed exporters and configured Prometheus to collect these metrics. For example, Node Exporter collected metrics from EKS worker nodes, while Kubernetes metrics helped us monitor Pods, Deployments, and containers.

Grafana was connected to Prometheus as a data source, and we created dashboards to visualize the metrics. For example, we had dashboards for EKS node health, CPU and memory utilization, Pod resource usage, Pod restarts, and application performance. This allowed us to quickly identify issues such as high CPU usage or a frequently restarting Pod.

For alerting, we configured alert rules based on important thresholds. For example, if CPU or memory usage exceeded a defined threshold, or if a Pod was continuously restarting or unavailable, an alert was triggered and sent to the relevant team.

For logging, we used the EFK stack. Fluentd collected logs from Kubernetes Pods and nodes, processed them, and sent them to Elasticsearch. Kibana was used to search and visualize the logs.

This gave us a centralized logging solution. Instead of logging into individual EKS nodes or checking each Pod separately, we could search logs in Kibana based on namespace, Pod name, container, timestamp, or error message.

Overall, Prometheus and Grafana helped us understand "what is happening" through metrics and dashboards, while EFK helped us understand "why it happened" by analyzing the logs.

## Q4. Explain the architecture of Kubernetes

**What it is:** Kubernetes is a declarative container orchestrator built on a **control plane** (decides desired state) and **worker nodes** (run the workload), with everything mediated through the **API server** and stored in **etcd**.

**How it works:** You submit desired state → API server validates and writes it to etcd → controllers observe the difference between desired and actual → they act to close the gap. This is the **reconciliation loop**, and it is the single most important idea in Kubernetes.

**Answer:**

> **Control plane components:**
>
> - **kube-apiserver** — the only component that talks to etcd, and the front door for everything else. Handles authentication, authorization (RBAC), admission control (validating/mutating webhooks, quotas), then persists to etcd. Stateless, so it scales horizontally behind a load balancer.
> - **etcd** — distributed, consistent key-value store (Raft). The single source of truth for all cluster state. Runs in odd-numbered quorum (3 or 5). Backing it up is mandatory — losing etcd is losing the cluster.
> - **kube-scheduler** — watches for Pods with no `nodeName`. Runs **filtering** (predicates: does the node have enough CPU/memory, does it satisfy nodeSelector/affinity/taints, are the required volumes attachable in that zone) then **scoring** (prioritize: least requested, balanced allocation, spread across zones), then binds the Pod to the winning node.
> - **kube-controller-manager** — runs the built-in control loops: Deployment, ReplicaSet, Node, Job, EndpointSlice, ServiceAccount, PV controllers. Each loop watches its objects and reconciles.
> - **cloud-controller-manager** — the cloud-specific loops: provisioning load balancers for `type: LoadBalancer` Services, attaching EBS volumes, labelling nodes with zone/instance-type, removing node objects when the EC2 instance goes away.
>
> **Worker node components:**
>
> - **kubelet** — the node agent. Watches the API server for Pods bound to its node, calls the container runtime to start them, mounts volumes, runs liveness/readiness/startup probes, and reports node and pod status back.
> - **Container runtime** — containerd or CRI-O, spoken to over the **CRI** interface. (Docker/dockershim was removed in v1.24.)
> - **kube-proxy** — implements Service networking on each node by programming iptables or IPVS rules so that ClusterIP traffic gets DNAT'd to a healthy backend pod IP. Newer clusters may use eBPF-based dataplanes (Cilium) instead.
> - **CNI plugin** — gives each pod a real IP and wires up pod-to-pod networking. On EKS this is the **AWS VPC CNI**, which hands pods real VPC IPs from the subnet's ENIs.
>
> **Add-ons:** CoreDNS for service discovery, metrics-server for `kubectl top` and HPA, the CSI drivers for storage, and an Ingress controller.
>
> **End-to-end flow of `kubectl apply -f deployment.yaml`:**
> 1. kubectl sends the manifest to the API server.
> 2. API server authenticates (certs/OIDC/IAM), authorizes via RBAC, runs admission controllers, writes the Deployment to etcd.
> 3. Deployment controller sees a Deployment with no matching ReplicaSet → creates a ReplicaSet.
> 4. ReplicaSet controller sees 0 pods vs 3 desired → creates 3 Pod objects (unscheduled).
> 5. Scheduler filters and scores nodes, binds each Pod to a node.
> 6. That node's kubelet sees a Pod bound to it, pulls the image, asks containerd to start the container, sets up networking via CNI, mounts volumes.
> 7. kubelet runs probes; once readiness passes, the EndpointSlice controller adds the pod IP to the Service's endpoints.
> 8. kube-proxy programs iptables/IPVS on every node so ClusterIP traffic now reaches the new pod.
>
> **On EKS specifically:** AWS manages and runs the control plane (API server, etcd, scheduler, controller-manager) across 3 AZs — you never see or patch those nodes. You own the worker nodes (managed node groups, self-managed, or Fargate), the CNI, and the add-ons.

**Interview tips:** The reconciliation loop and the apply-to-running flow are what separates a memorized answer from a real one. Always mention that on EKS the control plane is AWS-managed.

---

## Q5. What are the different types of Kubernetes Services?

**What it is:** A Service is a stable virtual IP + DNS name that load-balances to a dynamic set of pods. Pods are ephemeral and their IPs change on every restart; a Service is the stable abstraction in front of them.

**How it works:** A Service selects pods by label. The EndpointSlice controller keeps a live list of the IPs of **ready** pods matching that selector. kube-proxy programs iptables/IPVS rules on every node so traffic to the Service's ClusterIP is DNAT'd to one of those pod IPs. CoreDNS resolves `svc-name.namespace.svc.cluster.local` to the ClusterIP.

**Answer:**

> There are four types, plus two special cases:
>
> **1. ClusterIP (default)** — an internal-only virtual IP reachable from inside the cluster. Used for service-to-service traffic (frontend → backend, backend → cache).
>
> **2. NodePort** — opens the same high port (30000–32767 by default) on *every* node; traffic to `NodeIP:NodePort` is forwarded to the Service, then to a pod. It's the building block that LoadBalancer types are built on. Rarely used directly in production — no TLS, ugly ports, and you must know node IPs.
>
> **3. LoadBalancer** — asks the cloud provider for an external load balancer that fronts the NodePorts. On AWS this creates an **NLB** (or a classic ELB in older setups) via the cloud controller / AWS Load Balancer Controller. Its weakness is one load balancer per Service, which gets expensive fast.
>
> **4. ExternalName** — no proxying at all; CoreDNS just returns a CNAME to an external DNS name. Used to alias an external managed service (e.g. `db.internal` → the RDS endpoint) behind a Kubernetes name so app config doesn't change between environments.
>
> **Special cases:**
> - **Headless Service (`clusterIP: None`)** — no virtual IP; DNS returns the individual pod IPs (A records). This is how StatefulSets give each pod a stable DNS identity (`pod-0.svc...`), and how clients that do their own load balancing or need direct pod addressing (Kafka, Cassandra, gRPC) work.
> - **Service without a selector + manual Endpoints** — point a Kubernetes Service at an IP outside the cluster.
>
> **Two important behaviours to mention:**
> - **`externalTrafficPolicy: Local` vs `Cluster`** — `Cluster` (default) may hop to a pod on another node, which SNATs and loses the client IP; `Local` only sends to pods on the receiving node, preserving the client source IP but risking imbalance.
> - **`sessionAffinity: ClientIP`** — sticky sessions based on source IP.
>
> In practice: ClusterIP for everything internal, and a single ALB via **Ingress** for external HTTP(S) traffic rather than many LoadBalancer Services.

---

## Q6. How do you expose an application on Kubernetes? What is an Ingress and how does it work?

**What it is:** "Exposing" means giving traffic from outside the cluster a path to a pod. An **Ingress** is a Kubernetes API object that declares L7 (HTTP/HTTPS) routing rules — hosts, paths, TLS certs. By itself an Ingress object does nothing; an **Ingress Controller** is the pod/component that watches Ingress objects and configures a real proxy or cloud load balancer to match.

**How it works:**
1. You create an Ingress with rules like `api.example.com/orders → orders-svc:80`.
2. The Ingress controller (NGINX, Traefik, AWS Load Balancer Controller) watches the API server for Ingress objects.
3. **NGINX Ingress Controller:** renders those rules into an `nginx.conf`, reloads NGINX. Traffic arrives at the NGINX pods (fronted by an NLB), and NGINX proxies directly to pod IPs.
4. **AWS Load Balancer Controller:** instead of running a proxy, it calls the AWS API to create/update a real **ALB** — listeners, rules, target groups — and registers pod IPs (IP mode) or node ports (instance mode) as targets.

**Answer:**

> There are several ways to expose an app, in increasing order of production-readiness:
>
> 1. **`kubectl port-forward`** — local debugging only.
> 2. **NodePort** — works, but exposes raw node IPs and high ports; no TLS, no host/path routing.
> 3. **`type: LoadBalancer`** — one cloud LB per Service. Correct for non-HTTP (TCP/UDP) workloads; expensive and flat for HTTP.
> 4. **Ingress** — the standard for HTTP/HTTPS. One load balancer fronts many services with host and path routing, TLS termination, and redirects.
> 5. **Gateway API** — the successor to Ingress, with richer, role-separated resources (GatewayClass/Gateway/HTTPRoute). Worth naming as "where the ecosystem is heading."
>
> **What I used:** the **AWS Load Balancer Controller** on EKS. I annotate the Ingress and it provisions an ALB:
>
> ```yaml
> apiVersion: networking.k8s.io/v1
> kind: Ingress
> metadata:
>   name: app-ingress
>   annotations:
>     alb.ingress.kubernetes.io/scheme: internet-facing
>     alb.ingress.kubernetes.io/target-type: ip
>     alb.ingress.kubernetes.io/listen-ports: '[{"HTTP":80},{"HTTPS":443}]'
>     alb.ingress.kubernetes.io/ssl-redirect: '443'
>     alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:...:certificate/xxxx
>     alb.ingress.kubernetes.io/healthcheck-path: /healthz
>     alb.ingress.kubernetes.io/group.name: shared-alb
> spec:
>   ingressClassName: alb
>   rules:
>   - host: app.example.com
>     http:
>       paths:
>       - path: /api
>         pathType: Prefix
>         backend:
>           service:
>             name: backend-svc
>             port:
>               number: 8080
>       - path: /
>         pathType: Prefix
>         backend:
>           service:
>             name: frontend-svc
>             port:
>               number: 80
> ```
>
> **Key details worth volunteering:**
> - **`target-type: ip` vs `instance`** — `ip` mode registers pod IPs directly in the target group (possible because the VPC CNI gives pods real VPC IPs). That removes the extra kube-proxy hop, preserves the client IP, and makes health checks hit the pod directly. `instance` mode registers nodes on the NodePort.
> - **`group.name`** — lets several Ingress objects share one ALB, which is a major cost saving.
> - **TLS** is terminated at the ALB using an ACM certificate; the health check path is configured with the `healthcheck-path` annotation — this exact setting is the one that caused the L3 unhealthy-target scenario.
> - **DNS** — ExternalDNS watches Ingresses and creates the Route 53 records automatically.

---

## Q7. Deployment strategies — Blue-Green vs Canary

**What it is:** A deployment strategy defines how new code replaces old code, and what happens to live traffic during the switch. The trade-off axis is **risk exposure vs cost vs rollback speed**.

**How it works (all the main ones):**

| Strategy | Mechanism | Downtime | Rollback | Cost |
|---|---|---|---|---|
| **Recreate** | Kill all old pods, then start new | Yes | Redeploy old | 1× |
| **Rolling update** (K8s default) | Replace pods incrementally using `maxSurge`/`maxUnavailable` | No | Roll back to previous ReplicaSet | ~1.25× |
| **Blue-Green** | Two full environments; flip 100% of traffic at once | No | Flip back instantly | 2× |
| **Canary** | Send a small % of traffic to the new version, increase gradually | No | Drop the canary | ~1.1× |
| **A/B testing** | Route by header/cookie/user attribute, not percentage | No | Change routing rule | ~1.1× |
| **Shadow / mirroring** | Duplicate real traffic to the new version, discard responses | No | Stop mirroring | 2× |

**Blue-Green vs Canary — the actual answer:**

> **Blue-Green** runs two identical production environments. "Blue" is live and serving 100% of traffic; "Green" is the new version, fully deployed and warmed up but receiving no user traffic. You smoke-test Green, then flip the router — Service selector, ALB listener rule, or a Route 53 weight — so 100% of traffic instantly goes to Green. Blue stays running as the rollback target for a while, then becomes the target for the next release.
>
> - **Pros:** instant cutover, instant rollback, you test the real production environment before exposing users, no version-mixing.
> - **Cons:** double the infrastructure cost during the release, and *all* users hit the new version at once — so a bug that only appears under real production load hits 100% of traffic immediately. Database schema changes are hard, since both versions may need to work against one DB.
>
> **Canary** deploys the new version alongside the old one but routes only a small slice of live traffic to it — 5%, then 25%, then 50%, then 100% — while you watch error rate, latency, and business metrics at each step. If the metrics degrade, you stop and shift traffic back.
>
> - **Pros:** blast radius is limited to a small fraction of users; you validate against genuine production traffic; low extra cost.
> - **Cons:** slower rollout; two versions run simultaneously so the code and the DB schema must be backward-compatible; you need good metrics and automated analysis for it to be meaningful.
>
> **The core difference in one line:** Blue-Green switches *all* traffic at *one moment* (risk is concentrated in time, exposure is total); Canary switches *some* traffic *gradually* (risk is spread over time, exposure is partial). Blue-Green optimizes for rollback speed; Canary optimizes for blast radius.
>
> **How I'd implement each on Kubernetes:**
> - Blue-Green natively: two Deployments labelled `version: blue` / `version: green`, one Service, and you flip `spec.selector.version`. With the ALB controller you can flip listener rules or weighted target groups instead.
> - Canary natively: run N replicas of stable and 1 of canary so the ratio approximates the split — crude but works. Properly: **Argo Rollouts** or **Flagger** with an ALB/NGINX/Istio traffic split, plus automated metric analysis against Prometheus that aborts the rollout if the error rate crosses a threshold.
>
> **What we used:** rolling updates by default for most services (with proper readiness probes, `maxUnavailable: 0`, and a PDB), and canary via Argo Rollouts for the high-risk customer-facing services. Blue-Green for the one stateful component where we needed an instant, clean cutover.

**Interview tips:** If they ask "which is better," the correct answer is "it depends on blast-radius tolerance vs cost vs schema compatibility" — then give a concrete recommendation.

---

## Q8. What are Terraform modules? Write Terraform to create an EC2 instance

**What it is:** A Terraform **module** is a reusable, parameterised container of `.tf` files — inputs (`variables`), resources, and outputs. Every Terraform configuration is already a module (the *root module*); calling others makes them *child modules*.

**How it works:** You define inputs in `variables.tf`, resources in `main.tf`, and exported values in `outputs.tf`. A caller uses a `module` block with a `source` (local path, Terraform Registry, Git URL, S3) and a pinned `version`. Terraform builds a dependency graph across modules and applies it. Modules give you DRY code, consistent standards (tagging, encryption, naming), versioned infrastructure, and a clean blast-radius boundary.

**Answer — module structure:**

```
terraform/
├── modules/
│   └── ec2/
│       ├── main.tf
│       ├── variables.tf
│       ├── outputs.tf
│       └── versions.tf
└── envs/
    ├── dev/main.tf
    └── prod/main.tf
```

**`modules/ec2/variables.tf`**

```hcl
variable "name"          { type = string }
variable "instance_type" { type = string  default = "t3.micro" }
variable "subnet_id"     { type = string }
variable "vpc_id"        { type = string }
variable "key_name"      { type = string  default = null }
variable "allowed_ssh_cidrs" {
  type    = list(string)
  default = []
}
variable "tags" {
  type    = map(string)
  default = {}
}
```

**`modules/ec2/main.tf`**

```hcl
data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]
  filter {
    name   = "name"
    values = ["al2023-ami-*-x86_64"]
  }
}

resource "aws_security_group" "this" {
  name        = "${var.name}-sg"
  description = "Security group for ${var.name}"
  vpc_id      = var.vpc_id

  dynamic "ingress" {
    for_each = length(var.allowed_ssh_cidrs) > 0 ? [1] : []
    content {
      description = "SSH"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = var.allowed_ssh_cidrs
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, { Name = "${var.name}-sg" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_instance" "this" {
  ami                    = data.aws_ami.al2023.id
  instance_type          = var.instance_type
  subnet_id              = var.subnet_id
  vpc_security_group_ids = [aws_security_group.this.id]
  key_name               = var.key_name

  metadata_options {
    http_tokens = "required"   # enforce IMDSv2
  }

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = <<-EOF
    #!/bin/bash
    dnf update -y
    dnf install -y nginx
    systemctl enable --now nginx
  EOF

  tags = merge(var.tags, { Name = var.name })
}
```

**`modules/ec2/outputs.tf`**

```hcl
output "instance_id"       { value = aws_instance.this.id }
output "private_ip"        { value = aws_instance.this.private_ip }
output "security_group_id" { value = aws_security_group.this.id }
```

**`envs/prod/main.tf` — calling the module**

```hcl
terraform {
  required_version = ">= 1.5"
  backend "s3" {
    bucket         = "acme-tfstate-prod"
    key            = "app/ec2/terraform.tfstate"
    region         = "ap-south-1"
    dynamodb_table = "terraform-locks"
    encrypt        = true
  }
}

provider "aws" { region = "ap-south-1" }

module "app_server" {
  source = "../../modules/ec2"

  name          = "prod-app-01"
  instance_type = "t3.medium"
  vpc_id        = data.aws_vpc.main.id
  subnet_id     = data.aws_subnet.private_a.id

  tags = {
    Environment = "prod"
    Owner       = "platform"
    ManagedBy   = "terraform"
  }
}
```

**Points to mention out loud:** remote state in S3 with DynamoDB locking; pin provider and module versions; `terraform fmt`/`validate`/`plan` in CI and `apply` only on merge; use `for_each` over `count` when creating multiple instances so removing one doesn't reshuffle indices; never commit `.tfvars` with secrets.

---

## Q9. A Security Group was modified manually in the AWS Console. How do you bring it into Terraform code/state?

**What it is:** This is **configuration drift** — real infrastructure no longer matches what Terraform's state and code describe. There are two distinct sub-cases and you should separate them explicitly, because interviewers are checking whether you know the difference:

- **Case A:** The SG *is already managed by Terraform*, and someone edited it in the console.
- **Case B:** The SG (or a rule) was *created entirely outside* Terraform and is not in state at all.

**How it works:** Terraform compares three things — your **code** (desired), the **state file** (last-known), and the **real API** (actual). `terraform plan` refreshes state from the API, so drift shows as a diff. `terraform import` writes an existing real resource into state; `import` blocks (Terraform ≥1.5) do this declaratively.

**Answer:**

> **Step 1 — Detect and inspect the drift.**
>
> ```bash
> terraform plan -refresh-only        # shows what changed in reality vs state
> terraform show -json | jq ...       # inspect current state
> aws ec2 describe-security-groups --group-ids sg-0abc123   # the real truth
> ```
>
> `-refresh-only` is the safe way to see drift without proposing to destroy anything.
>
> **Step 2 — Make the business decision.** Either the manual change was legitimate (someone opened a port for a real reason) or it was unauthorized.
>
> **Path A — the change should be kept (adopt it into code):**
> 1. Read the actual rule from the console/CLI.
> 2. Add the equivalent block to the Terraform code so the code now describes reality:
>    ```hcl
>    resource "aws_security_group_rule" "allow_monitoring" {
>      type              = "ingress"
>      from_port         = 9090
>      to_port           = 9090
>      protocol          = "tcp"
>      cidr_blocks       = ["10.0.0.0/16"]
>      security_group_id = aws_security_group.app.id
>      description       = "Prometheus scrape - added manually 2026-08, adopted into IaC"
>    }
>    ```
> 3. Run `terraform plan` and confirm it reports **"No changes"** — that proves code, state, and reality now agree.
>
> **Path B — the change should be reverted (code is the source of truth):**
> Just run `terraform apply`. Terraform sees the extra rule, sees it's not in the config, and removes it — the SG snaps back to the declared state. This is exactly the value of IaC.
>
> **Case B — the SG was created entirely outside Terraform (not in state):**
> Terraform doesn't know it exists, so I have to **import** it.
>
> *Modern approach (Terraform ≥ 1.5) — `import` block, reviewable in a PR:*
> ```hcl
> import {
>   to = aws_security_group.app
>   id = "sg-0abc123def456"
> }
>
> resource "aws_security_group" "app" {
>   # generate a starting point with:
>   #   terraform plan -generate-config-out=generated.tf
> }
> ```
> Then `terraform plan -generate-config-out=generated.tf` writes the HCL for me, I clean it up, and `terraform apply` performs the import.
>
> *Classic approach — CLI import:*
> ```bash
> terraform import aws_security_group.app sg-0abc123def456
> terraform state show aws_security_group.app     # read the imported attributes
> # write matching HCL, then:
> terraform plan                                   # must show "No changes"
> ```
>
> **The golden rule for imports:** after importing, keep editing the HCL until `terraform plan` shows **zero changes**. If the plan still wants to modify or replace the resource, my code doesn't match reality yet, and applying would break production.
>
> **Important gotcha with security groups:** inline `ingress`/`egress` blocks inside `aws_security_group` fight with separate `aws_security_group_rule` / `aws_vpc_security_group_ingress_rule` resources — Terraform will delete rules it doesn't know about. Pick one style per SG and stay consistent.
>
> **Step 3 — Prevent it happening again.**
> - Remove or tighten console write permissions in prod; make Terraform's pipeline role the only writer (IAM policy denying `ec2:AuthorizeSecurityGroupIngress` to humans).
> - Run `terraform plan` on a schedule (nightly CI job / Atlantis / Terraform Cloud drift detection) and alert on any non-empty plan.
> - Use **AWS Config rules** and **CloudTrail** alerts on `AuthorizeSecurityGroupIngress` to catch manual changes in near real time.
> - Enable break-glass access with an audited, time-bound role rather than standing console access.

---

## Q10. What is Terraform drift? How do you identify and manage it?

**What it is:** **Drift** is any divergence between the real infrastructure and what Terraform's state/configuration says it should be. It happens through manual console changes, other automation (auto-scaling, cloud-side defaults), out-of-band scripts, or a partially failed apply.

**How it works:** Terraform holds three views:

| View | Where it lives | Meaning |
|---|---|---|
| **Configuration** | `.tf` files | What you *want* |
| **State** | `terraform.tfstate` (S3) | What Terraform *last knew* |
| **Reality** | The cloud provider API | What actually *is* |

Drift is any mismatch between **state** and **reality**. `terraform refresh` (now folded into `plan`) updates state from reality; `plan` then diffs configuration against that refreshed state.

**Answer:**

> **Identifying drift:**
>
> ```bash
> terraform plan                    # any non-empty plan on an unchanged repo = drift
> terraform plan -refresh-only      # shows ONLY reality-vs-state drift, no config changes
> terraform plan -detailed-exitcode # exit 0 = no change, 1 = error, 2 = changes -> perfect for CI
> terraform state list              # what Terraform manages
> terraform state show <addr>       # attributes Terraform believes are current
> ```
>
> In CI I run a scheduled drift-detection job:
> ```bash
> terraform plan -detailed-exitcode -lock=false -out=drift.tfplan
> # exit code 2 -> post the plan to Slack and open a ticket
> ```
> Terraform Cloud/Enterprise, Atlantis, Env0, and driftctl do this natively. On the AWS side, **AWS Config** conformance rules and **CloudTrail** alerts on write API calls catch drift even for resources Terraform doesn't manage.
>
> **Managing drift — four options, chosen deliberately:**
> 1. **Revert reality to code** — `terraform apply`. The default and correct choice for prod. Code stays the source of truth.
> 2. **Adopt reality into code** — update the HCL to match the change, then confirm `plan` is clean. Right when the manual change was a legitimate fix.
> 3. **Accept and update state only** — `terraform apply -refresh-only` accepts the new reality into state without changing infrastructure. Useful for provider-side computed defaults.
> 4. **Exclude from management** — `lifecycle { ignore_changes = [...] }` for fields that are legitimately mutated outside Terraform:
>    ```hcl
>    lifecycle {
>      ignore_changes = [
>        desired_count,      # managed by application autoscaling
>        tags["LastScanned"] # written by a security tool
>      ]
>    }
>    ```
>
> **Preventing drift (the part interviewers actually care about):**
> - Read-only console access in production; all writes go through the pipeline role.
> - Remote state in S3 with DynamoDB state locking so concurrent applies can't corrupt state.
> - Scheduled drift detection with alerting, so drift is caught in hours not months.
> - `terraform plan` on every PR, `apply` only on merge, with required review.
> - `prevent_destroy` on critical resources (RDS, S3 buckets, KMS keys).
> - Break-glass emergency access that is time-bound and audited — and a rule that any emergency console change must be back-ported into Terraform within 24 hours.
>
> **The related failure mode worth naming:** state file drift/corruption — someone runs `terraform apply` locally without the remote backend, or state is deleted. Mitigations: S3 versioning on the state bucket, DynamoDB locking, and never letting anyone run apply outside CI.

---

# L2 — Akhil

## Q1. Introduce yourself
## Q2. Explain your most recent project and its architecture
## Q3. Explain the architecture of Kubernetes

Same as **L1 Q1, Q2, Q4** above — but tighten them. In L2 the interviewer has already read your L1 feedback, so repeat the *same* story with the *same* numbers (inconsistency between rounds is a red flag) and go one level deeper on whatever L1 probed lightly. For Kubernetes architecture in L2, lead with the reconciliation loop and the `kubectl apply` end-to-end flow rather than reciting the component list.

---

## Q4. What are readiness and liveness probes? What's the difference?

**What it is:** Probes are health checks that the **kubelet** runs *against a container* to answer two different questions: "should this container receive traffic?" (readiness) and "is this container broken and in need of a restart?" (liveness). There is a third — **startup** — that protects slow-booting apps from the other two.

**How it works:** Each probe has a handler and timing knobs.

**Handlers:**
- `httpGet` — HTTP request to a path/port; any 200–399 status is a pass.
- `tcpSocket` — TCP connection opens successfully.
- `exec` — run a command in the container; exit code 0 is a pass.
- `grpc` — the standard gRPC health-checking protocol.

**Timing fields:**
| Field | Meaning |
|---|---|
| `initialDelaySeconds` | wait this long after container start before probing |
| `periodSeconds` | how often to probe |
| `timeoutSeconds` | probe fails if no response in this time |
| `failureThreshold` | consecutive failures before the probe is considered failed |
| `successThreshold` | consecutive successes to be considered passing again (must be 1 for liveness) |

**Answer:**

> **Liveness probe** — "is the process alive and healthy?" If it fails `failureThreshold` times, the **kubelet kills the container and restarts it** per the pod's restart policy. It exists to recover from unrecoverable states: deadlocks, a wedged event loop, an internal thread pool that's stuck. The pod stays in the same place; only the container restarts, and you see `RESTARTS` climb in `kubectl get pods`.
>
> **Readiness probe** — "can this container serve requests *right now*?" If it fails, the kubelet marks the pod **NotReady** and the EndpointSlice controller **removes the pod IP from the Service endpoints**, so it stops receiving traffic. The container is **not** restarted. When the probe passes again, the IP is added back. This handles temporary conditions: warming caches, waiting on a downstream dependency, being mid-migration, or shedding load while overloaded.
>
> **Startup probe** — "has the app finished booting?" While it's running, liveness and readiness probes are **disabled**. Once it succeeds once, it never runs again and the other two take over. It exists for slow starters (JVM apps, apps that load a large model or run migrations) so that you don't have to set a huge `initialDelaySeconds` on liveness — which would also delay real failure detection for the whole life of the pod.
>
> **The difference in one line:** a failed **liveness** probe *restarts the container*; a failed **readiness** probe *removes it from load balancing*. Liveness is about recovery, readiness is about traffic routing.

```yaml
containers:
- name: api
  image: myapp:1.2.3
  ports:
  - containerPort: 8080
  startupProbe:            # gives the app up to 5 minutes to boot
    httpGet: { path: /healthz, port: 8080 }
    periodSeconds: 10
    failureThreshold: 30
  livenessProbe:           # cheap, dependency-free
    httpGet: { path: /healthz, port: 8080 }
    periodSeconds: 10
    timeoutSeconds: 2
    failureThreshold: 3
  readinessProbe:          # checks dependencies too
    httpGet: { path: /ready, port: 8080 }
    periodSeconds: 5
    timeoutSeconds: 2
    failureThreshold: 2
```

**The mistakes to call out (this is what impresses):**
1. **Never point liveness at a deep dependency check.** If `/healthz` checks the database and the DB has a blip, *every* pod fails liveness simultaneously and the whole fleet enters CrashLoopBackOff — you've turned a degraded dependency into a total outage. Liveness should test only the process itself; readiness is where dependency checks belong.
2. **Same path for both is a common anti-pattern** — separate `/healthz` (liveness, shallow) from `/ready` (readiness, deep).
3. **Too-aggressive timings cause restart storms** under load, when the app is slow but not dead.
4. **No readiness probe means traffic hits pods that aren't listening yet** — that's a classic source of 502s during a rolling update.
5. Pair readiness with a `preStop` hook + `terminationGracePeriodSeconds` so pods drain cleanly on shutdown.

---

## Q5. What is a PodDisruptionBudget (PDB) and why is it used?

**What it is:** A PDB is a policy object that limits how many pods of an application can be **voluntarily** taken down at the same time. It's the contract between the app owner ("I need at least 2 replicas serving at all times") and the cluster operator ("I need to drain this node for patching").

**How it works:** Kubernetes distinguishes two kinds of disruption:

- **Voluntary** — actions initiated through the API: `kubectl drain`, node upgrades, cluster autoscaler scale-down, Karpenter consolidation, node group rotation. **PDBs apply here.**
- **Involuntary** — hardware failure, kernel panic, node OOM, Spot instance reclamation, someone deleting a pod directly. **PDBs cannot prevent these.**

The **Eviction API** (which `kubectl drain` uses) checks every matching PDB before evicting a pod. If evicting would violate the budget, the API returns `429 Too Many Requests` and the drain blocks and retries until enough replacements become Ready. That backpressure is the whole mechanism.

**Answer:**

> A PDB says "at most N of my pods may be voluntarily disrupted at once" — expressed either as `minAvailable` or `maxUnavailable`:
>
> ```yaml
> apiVersion: policy/v1
> kind: PodDisruptionBudget
> metadata:
>   name: api-pdb
> spec:
>   minAvailable: 2          # or: maxUnavailable: 1  (or a percentage: "50%")
>   selector:
>     matchLabels:
>       app: api
> ```
>
> **Why it's used:** without a PDB, draining a node evicts every pod on it immediately. If the cluster autoscaler is consolidating nodes, or you're doing a rolling node-group upgrade across the fleet, you can end up with zero healthy replicas of a service even though the Deployment says 3 — because all three were on nodes being drained at the same time. The PDB forces the drain to proceed **one pod at a time**, waiting for replacements to become Ready in between. It converts a potential outage into a slower, safe rollout.
>
> **Practical guidance:**
> - Prefer `maxUnavailable: 1` for most services — it stays correct when you scale replicas up or down. `minAvailable: 2` on a 2-replica Deployment means **nothing can ever be evicted** and node drains hang forever; that's the classic PDB deadlock.
> - Single-replica workloads plus a PDB will block node maintenance entirely. Either scale to 2+ or accept the disruption.
> - PDBs matter enormously for **stateful** workloads — quorum systems like etcd, Kafka, Zookeeper, or a Postgres cluster where losing two members at once loses quorum.
> - A PDB does not replace `maxUnavailable` in the Deployment's rolling-update strategy — that governs *your own* rollouts; the PDB governs *cluster-initiated* disruptions.
> - Check status with `kubectl get pdb` — `ALLOWED DISRUPTIONS: 0` tells you immediately why a drain is stuck.

---

## Q6. Explain ALB and NLB in detail. Key differences?

**What it is:** Both are AWS Elastic Load Balancing products, but they operate at different layers of the OSI model. **ALB is Layer 7 (HTTP/HTTPS)** — it understands requests, headers, paths, and hosts. **NLB is Layer 4 (TCP/UDP/TLS)** — it forwards connections and knows nothing about their contents.

**How ALB works:**
1. Lives in ≥2 subnets across ≥2 AZs; AWS runs elastic ENIs in each and scales them automatically.
2. A **listener** (port 80/443) receives connections and terminates them, so the ALB is a full reverse proxy — the client's TCP/TLS session ends at the ALB and a *new* connection is made to the target.
3. **Listener rules** are evaluated in priority order, matching on host header, path, HTTP method, query string, source IP, or arbitrary headers → forward to a **target group**, redirect, or return a fixed response.
4. **Target groups** hold the backends (instance ID, IP, or Lambda) and carry the **health check** configuration — protocol, path, port, interval, timeout, healthy/unhealthy thresholds, and expected status codes.
5. Routing algorithm: round robin by default, or least-outstanding-requests. Supports sticky sessions via a cookie.
6. Because it terminates the connection, the client IP is lost at L4 — it's preserved in the **`X-Forwarded-For`** header instead.

**How NLB works:**
1. Operates at the connection level with flow hashing (protocol, source IP/port, destination IP/port) — no request parsing at all.
2. Preserves the **client source IP** natively for instance/IP targets, so the backend sees the real client address with no header needed.
3. Can have a **static IP per AZ**, and supports Elastic IPs — this is why it's used for firewall allow-listing and DNS setups that need fixed IPs.
4. Handles millions of requests per second with ultra-low latency, and requires no pre-warming for traffic spikes.
5. Supports **TCP, UDP, TLS**, and TCP_UDP; can terminate TLS if you want, or pass it straight through.
6. Health checks can be TCP, HTTP, or HTTPS.

**Key differences:**

| Dimension | ALB (Layer 7) | NLB (Layer 4) |
|---|---|---|
| OSI layer | 7 — application | 4 — transport |
| Protocols | HTTP, HTTPS, gRPC, WebSocket | TCP, UDP, TLS, TCP_UDP |
| Routing | host, path, header, method, query, source IP | flow hash only |
| Client IP | via `X-Forwarded-For` | preserved natively |
| IP addressing | DNS name only, IPs change | static IP per AZ, Elastic IP supported |
| Latency | higher (~ms, full proxy) | very low (~100µs) |
| Throughput | high, scales with warming | extremely high, instant scaling |
| TLS | terminate, SNI, multiple certs, ACM | terminate or pass through |
| WAF integration | yes | no |
| Auth | built-in Cognito/OIDC authentication | no |
| Redirects / fixed responses | yes | no |
| Targets | instance, IP, Lambda | instance, IP, ALB |
| Cost model | LCU based on requests/connections/bandwidth/rules | LCU, generally cheaper at high volume |

**Answer:**

> **When I pick ALB:** any HTTP/HTTPS application. Microservices where one load balancer must route `/api` to one service and `/` to another, host-based multi-tenant routing, WebSocket or gRPC backends, anywhere I want WAF, TLS with ACM, redirects, or OIDC auth at the edge. On EKS this is what the AWS Load Balancer Controller creates from an Ingress.
>
> **When I pick NLB:** non-HTTP protocols (a database proxy, MQTT, DNS, game traffic), when a client requires a **static IP** to allow-list, when I need the true client IP without touching headers, when latency budget is extremely tight, or for extreme, spiky throughput. On EKS, a `type: LoadBalancer` Service creates an NLB by default — that's how the NGINX Ingress Controller is typically fronted.
>
> **A pattern worth mentioning:** NLB in front of ALB. You get the NLB's static IP and PrivateLink compatibility with the ALB's L7 routing behind it — commonly used when exposing an ALB through AWS PrivateLink or to satisfy a partner's fixed-IP requirement.
>
> **Gateway Load Balancer (GWLB)** is the third type — Layer 3, used to transparently insert virtual appliances (firewalls, IDS/IPS) into the traffic path via GENEVE encapsulation. Worth naming to show completeness.

---

## Q7. What are health checks? How are they implemented in Kubernetes? How do you configure them in the AWS Console?

**What it is:** A health check is a periodic, automated probe that determines whether a component should keep receiving traffic (or be replaced). The critical insight — and the exact thing the L3 round tested — is that **there are multiple independent layers of health checking**, each with its own configuration, and they can disagree.

**How it works — the layers:**

| Layer | Who checks | What it controls |
|---|---|---|
| **EC2 status checks** | AWS hypervisor & instance OS | Whether the instance is impaired |
| **ASG health check** | ASG (EC2 or ELB type) | Whether to terminate & replace the instance |
| **Target group health check** | ALB/NLB | Whether to send traffic to that target |
| **Route 53 health check** | Route 53 (global checkers) | Whether to return that endpoint in DNS |
| **Kubernetes probes** | kubelet | Restart the container / remove from Service endpoints |
| **Kubernetes node conditions** | kubelet → node controller | Whether the node is schedulable / pods get evicted |

**Answer — Kubernetes implementation:**

> In Kubernetes, health checks are the three probes — **liveness**, **readiness**, **startup** — run by the kubelet against each container (see Q4). Readiness drives Service endpoint membership; liveness drives container restarts. Node-level health is separate: the kubelet reports conditions (`Ready`, `MemoryPressure`, `DiskPressure`, `PIDPressure`) and the node controller marks a node `NotReady` and starts evicting pods if it stops heartbeating.
>
> **Answer — AWS Console configuration:**
>
> **Target group health check (the one that matters most for EKS behind an ALB):**
> EC2 → Target Groups → select the group → **Health checks** tab → **Edit**:
> - **Protocol** — HTTP or HTTPS
> - **Path** — e.g. `/healthz` (default is `/`, which is exactly what breaks so many setups)
> - **Port** — "traffic port" or an explicit override
> - **Healthy threshold** — consecutive successes to mark healthy (default 5)
> - **Unhealthy threshold** — consecutive failures to mark unhealthy (default 2)
> - **Timeout** — seconds to wait for a response (default 5)
> - **Interval** — seconds between checks (default 30)
> - **Success codes** — e.g. `200` or `200-299`
>
> You can watch the result live under the target group's **Targets** tab, where each target shows `healthy` / `unhealthy` / `initial` / `draining` plus a reason code like `Health checks failed with these codes: [404]` or `Request timed out`.
>
> **Auto Scaling Group health check:** EC2 → Auto Scaling Groups → Edit → **Health check type: EC2 or ELB** + **Health check grace period**. Setting it to **ELB** means the ASG will terminate and replace an instance the load balancer considers unhealthy — not just one the hypervisor considers impaired.
>
> **Route 53 health check:** Route 53 → Health checks → Create, pointing at an endpoint or a CloudWatch alarm, then attach it to a record for DNS failover.
>
> **The critical caveat for EKS:** if the ALB is managed by the AWS Load Balancer Controller, **do not edit the health check in the console**. The controller continuously reconciles the ALB against the Ingress/TargetGroupBinding spec and will revert your console change within minutes. The correct place to change it is the Ingress annotation:
>
> ```yaml
> alb.ingress.kubernetes.io/healthcheck-path: /healthz
> alb.ingress.kubernetes.io/healthcheck-protocol: HTTP
> alb.ingress.kubernetes.io/healthcheck-interval-seconds: '15'
> alb.ingress.kubernetes.io/healthcheck-timeout-seconds: '5'
> alb.ingress.kubernetes.io/healthy-threshold-count: '2'
> alb.ingress.kubernetes.io/unhealthy-threshold-count: '3'
> alb.ingress.kubernetes.io/success-codes: '200'
> ```
>
> Console editing is fine for debugging (change it temporarily to confirm a hypothesis) but the fix must go into the manifest — same drift principle as the Terraform question.

---

## Q8. What is throttling? Where can it be implemented?

**What it is:** Throttling (rate limiting) is deliberately restricting how many requests a client may make in a time window, rejecting or delaying the excess — normally with **HTTP 429 Too Many Requests**. It's a protection mechanism, not a performance one: it stops one noisy client, a bug, or an attack from consuming capacity that belongs to everyone else.

**How it works — the algorithms:**
- **Token bucket** — a bucket refills at a steady *rate* and holds up to a *burst* capacity; each request removes a token; empty bucket = reject. This is what API Gateway uses (`rate` + `burst`), and it allows short bursts while bounding the sustained rate.
- **Leaky bucket** — requests queue and drain at a fixed rate; smooths traffic.
- **Fixed window** — N requests per calendar minute; simple, but allows 2N at a window boundary.
- **Sliding window** — rolling counter; smoother and more accurate, slightly more expensive.
- **Concurrency limiting** — cap simultaneous in-flight requests rather than rate.

**Answer — where it can be implemented (edge inward):**

> 1. **CloudFront / WAF** — AWS WAF rate-based rules block a source IP that exceeds N requests in a 5-minute window, right at the edge, before traffic ever reaches your infrastructure. Cheapest place to shed abusive traffic.
> 2. **API Gateway** — the richest option. Account-level limits, **stage-level** throttling, **per-method** throttling, and **usage plans + API keys** giving each consumer their own rate/burst and daily quota. Returns 429 with `Retry-After`.
> 3. **Load balancer** — ALB doesn't rate-limit natively; you attach WAF to it for that.
> 4. **Ingress controller** — NGINX Ingress supports per-Ingress annotations: `nginx.ingress.kubernetes.io/limit-rps`, `limit-connections`, `limit-rpm`, `limit-whitelist`.
> 5. **Service mesh** — Istio/Envoy local and global rate limiting per route, per header, per identity.
> 6. **Application level** — middleware backed by Redis (e.g. a sliding-window counter keyed by user/tenant/API key). This is the only layer that can throttle on *business* identity — per-tenant plan tier, per-user quotas.
> 7. **Kubernetes resource level** — not rate limiting exactly, but the same protective idea: CPU limits throttle a container's CPU via cgroup quota, ResourceQuotas cap a namespace, and the API server has its own **API Priority and Fairness** throttling for client requests.
> 8. **Database / downstream** — connection pool limits and PgBouncer act as concurrency throttles protecting RDS from connection exhaustion.
>
> **How I'd design it in practice:** WAF rate rules at the edge for abuse, API Gateway usage plans for partner/tenant quotas, NGINX/Istio limits as a safety net inside the cluster, and application-level per-tenant limits in Redis for anything tied to a billing plan. Then I'd make sure 429s are monitored — a spike in 429s is a signal, either of an attack or of a limit set too low for legitimate growth.
>
> **Related concepts to mention:** back-pressure, circuit breakers, exponential backoff with jitter on the client side, and the difference between throttling (protect the service) and quota (enforce commercial limits).

---

## Q9. What is API Gateway? What are its advantages?

**What it is:** Amazon API Gateway is a fully managed front door for APIs. It sits between clients and backends and handles the cross-cutting concerns — authentication, throttling, caching, transformation, validation, versioning, and observability — so individual services don't each reimplement them.

**How it works:**
1. A client calls the gateway endpoint (custom domain via ACM + Route 53).
2. The gateway matches the request to a **resource + method** (REST API) or **route** (HTTP API).
3. It runs **authorization** — IAM SigV4, a Cognito user pool, or a Lambda authorizer that returns an IAM policy.
4. It applies **request validation** (schema/params), **throttling**, and checks the **cache**.
5. It performs the **integration**: Lambda proxy, HTTP proxy, AWS service integration (e.g. straight to SQS/DynamoDB/StepFunctions), **VPC Link** to a private ALB/NLB, or a mock.
6. **Mapping templates** (VTL) can transform request/response payloads.
7. The response goes back, optionally cached, and access logs + metrics land in CloudWatch, with traces in X-Ray.

**Three flavours:**
| Type | Use for | Notes |
|---|---|---|
| **REST API** | Full-featured | Usage plans, API keys, caching, WAF, request validation, VTL. Most expensive. |
| **HTTP API** | Simple proxying | ~70% cheaper, lower latency, JWT authorizers built in, fewer features. |
| **WebSocket API** | Bidirectional | Persistent connections, `$connect`/`$disconnect`/custom routes. |

**Endpoint types:** Regional, Edge-optimized (via CloudFront), and Private (accessible only from a VPC via an interface endpoint).

**Answer — advantages:**

> - **Single entry point** — clients hit one domain, and routing to many backends (Lambda, EKS via VPC Link, other AWS services) is handled centrally.
> - **Authentication/authorization offloaded** — Cognito, IAM, or Lambda authorizers, so backend services don't each implement token validation.
> - **Throttling and quotas** — usage plans with API keys give per-consumer rate, burst, and daily quota; this is how you monetize or protect an API.
> - **Caching** — a response cache with configurable TTL cuts backend load and latency dramatically for read-heavy endpoints.
> - **Request/response transformation and validation** — reject malformed requests before they touch the backend; reshape legacy payloads without changing the service.
> - **Versioning and staged deploys** — stages (`dev`/`prod`), stage variables, and **canary deployments** with a percentage of traffic to a new deployment.
> - **Security** — WAF integration, TLS with ACM certs, mutual TLS, private endpoints, and it keeps backends off the public internet entirely.
> - **Observability** — CloudWatch metrics (`Count`, `4XXError`, `5XXError`, `Latency`, `IntegrationLatency`), access logs, and X-Ray tracing out of the box.
> - **Fully managed and auto-scaling** — no servers to patch or scale.
>
> **Trade-offs I'd mention unprompted:** it adds latency (typically tens of ms), it has hard limits (29-second integration timeout, 10 MB payload), REST APIs get expensive at very high volume, and complex VTL mapping templates become a maintenance burden. For pure internal service-to-service traffic inside a cluster I'd use a service mesh or direct Service calls instead — API Gateway earns its cost at the *external/partner* boundary.
>
> **How it fit our architecture:** partner-facing APIs went **API Gateway (HTTP API) → VPC Link → internal ALB → EKS Ingress → service**, which gave us API keys, per-partner throttling, and WAF while keeping the ALB internal and completely off the public internet.

---

## Q10. What is CloudFront?

**What it is:** Amazon CloudFront is AWS's global **Content Delivery Network** — a network of hundreds of edge locations and regional edge caches that terminate user connections close to the user, serve cached content locally, and proxy cache misses back to your origin over AWS's optimized backbone network.

**How it works:**
1. A user resolves your domain to a CloudFront edge location via anycast DNS — they hit the *nearest* PoP.
2. TLS terminates at that edge (ACM cert in **us-east-1** for CloudFront — a classic gotcha), so the handshake is fast and local.
3. CloudFront checks its cache using the **cache key** (by default the URL path; optionally query strings, headers, cookies — controlled by a **cache policy**).
4. **Cache hit** → served immediately from the edge.
5. **Cache miss** → the request goes to the regional edge cache, then to the **origin** (S3 bucket, ALB, EC2, API Gateway, or any HTTP server) over AWS's private backbone rather than the open internet. **Origin Shield** can add one more centralized caching layer to further collapse origin requests.
6. The response is cached per the **TTL** (`Cache-Control`/`Expires` headers or the cache policy) and returned.
7. **Behaviors** map path patterns (`/static/*`, `/api/*`) to different origins and different caching/policy settings — so one distribution can serve a static SPA from S3 and dynamic API calls from an ALB.
8. **CloudFront Functions** (lightweight, viewer request/response, sub-ms) and **Lambda@Edge** (heavier, all four trigger points) let you run code at the edge for redirects, header manipulation, auth checks, and A/B routing.

**Answer — why we used it:**

> - **Latency** — static assets served from an edge PoP near the user instead of a single region.
> - **Origin offload** — cached responses never reach the ALB or EKS, which cuts both load and cost. Data transfer out via CloudFront is also cheaper than direct from EC2/ALB.
> - **TLS termination at the edge** — faster handshakes; certificates managed by ACM; HTTP/2 and HTTP/3 support with no app changes.
> - **Security** — AWS **Shield Standard** DDoS protection is included; **WAF** attaches at the distribution; **OAC (Origin Access Control)** locks an S3 bucket so it's reachable *only* through CloudFront; signed URLs/cookies for private content; geo-restriction.
> - **Single domain for a whole app** — `/` → S3 (React build), `/api/*` → ALB (EKS services), with one certificate and one domain, which also removes CORS problems.
> - **Custom error pages and SPA routing** — map 403/404 from S3 to `/index.html` with a 200, which is how you make client-side routing work.
>
> **Operational points:** invalidations (`aws cloudfront create-invalidation --paths "/*"`) are how you force-refresh cached content, but the better practice is **versioned/fingerprinted asset filenames** so you rarely need to invalidate. Distribution changes take several minutes to propagate. Logs go to S3 or CloudWatch (real-time logs), and the key metrics are cache hit ratio, origin latency, and 4xx/5xx rate.

---

## Q11. What are VPC Origins in CloudFront, and when would you use them?

**What it is:** **CloudFront VPC Origins** (launched November 2024) let a CloudFront distribution send origin requests directly to resources in a **private subnet** — a private ALB, NLB, or EC2 instance — over AWS's internal network. Before this feature, a CloudFront origin had to be publicly routable, which meant your ALB had to be internet-facing even when you only ever wanted CloudFront to reach it.

**How it works:**
1. You create a **VPC origin** resource pointing at a private ALB/NLB/EC2 in your VPC.
2. AWS provisions a managed, private connection between the CloudFront edge network and that resource — traffic never traverses the public internet.
3. You attach the VPC origin to a distribution behavior like any other origin.
4. Your ALB stays `internal` with **no public IP**, and its security group only needs to allow the VPC origin's traffic.

**The problem it solves:**

> Historically, the standard pattern was CloudFront → **internet-facing** ALB. The ALB was publicly addressable, so anyone who discovered its DNS name could bypass CloudFront entirely — skipping WAF, skipping caching, skipping your edge auth. The usual workaround was messy: restrict the ALB security group to CloudFront's published IP ranges (which change, and required a Lambda to sync the `AWS_IP_RANGES` prefix list), and/or have CloudFront inject a secret custom header that the ALB checks in a listener rule. Both work, both are extra machinery to maintain.
>
> **VPC Origins removes that entirely** — the ALB is private, unreachable from the internet by construction, and CloudFront is the only possible path in.

**Answer — when I'd use it:**

> - **Any CloudFront → ALB → EKS/ECS architecture** where the ALB should not be publicly reachable. This is the main case, and it's exactly the pattern in my project.
> - **When you need a hard guarantee that WAF and edge controls can't be bypassed** — with a public ALB, bypass is a DNS lookup away; with a VPC origin it's impossible.
> - **Compliance requirements** (PCI, HIPAA, internal security policy) that mandate no public-facing compute or load balancers.
> - **Replacing the header-secret / prefix-list workarounds** — less code, no rotation, no Lambda syncing IP ranges.
> - **Simplifying security groups** — fewer wide-open rules to justify in an audit.
>
> **Limitations to acknowledge:** the VPC origin must be an ALB, NLB, or EC2 instance in the same account and region as the distribution; it doesn't cover every origin type; and there's an additional charge. Also note the ALB still needs subnets in ≥2 AZs, and cross-AZ considerations still apply.
>
> **The resulting flow:** `User → Route 53 → CloudFront (TLS, WAF, cache) → VPC Origin → internal ALB (private subnet) → EKS pod`. Nothing in that path after CloudFront has a public IP.

---

# L3 — Abhishek Kumar & Siva (Head of Engineering)

> **Round character:** Abhishek repeated most of his L1/L2 questions — keep your answers *identical in substance* to earlier rounds. Siva drove scenario-based troubleshooting. For every troubleshooting question, answer with a **layered, top-down method** ("I'd work the request path from the edge inward, eliminating a layer at each step"), not a random list of commands. State your hypothesis, name the command that tests it, and say what result would confirm or eliminate it.

## Q1. Design a 3-tier AWS architecture — public subnets for LB/CloudFront, private for app, private for RDS. Explain the security rationale.

**What it is:** The classic 3-tier design — presentation, application, data — mapped onto AWS subnet tiers so that each layer is only reachable from the layer directly above it. The security principle is **defense in depth with a reduced attack surface**: only the thing that *must* be public is public.

**How it works:** Reachability from the internet is determined by two things: whether the subnet's route table has a route to an **Internet Gateway** (that's the actual definition of a "public" subnet), and whether security groups/NACLs permit the traffic. Private subnets have no IGW route, so no packet from the internet can ever reach them — regardless of any security-group misconfiguration. That's a structural guarantee, not a policy one.

**Answer — the design:**

```
                         Internet
                            │
                     Route 53 (DNS)
                            │
                   CloudFront + AWS WAF          ← edge: TLS, cache, DDoS, geo/rate rules
                            │
╔═══════════════════════════╪═══════════════════════════════════╗
║  VPC 10.0.0.0/16          │                                   ║
║                           ▼                                   ║
║  ┌──── PUBLIC SUBNETS (3 AZs) — 10.0.0.0/24, 1.0/24, 2.0/24 ─┐ ║
║  │   Internet-facing ALB   +   NAT Gateway (one per AZ)      │ ║
║  │   Route: 0.0.0.0/0 → Internet Gateway                     │ ║
║  └───────────────────────┬───────────────────────────────────┘ ║
║                          │  (ALB SG → App SG on 8080)          ║
║  ┌──── PRIVATE APP SUBNETS (3 AZs) — 10.0.10.0/23, 12.0/23 ──┐ ║
║  │   EKS worker nodes / ECS tasks / EC2 app servers          │ ║
║  │   Route: 0.0.0.0/0 → NAT Gateway (egress only)            │ ║
║  └───────────────────────┬───────────────────────────────────┘ ║
║                          │  (App SG → DB SG on 5432)           ║
║  ┌──── PRIVATE DATA SUBNETS (3 AZs) — 10.0.20.0/24, 21.0/24 ─┐ ║
║  │   RDS PostgreSQL Multi-AZ  +  ElastiCache Redis           │ ║
║  │   Route: LOCAL ONLY — no NAT, no IGW                      │ ║
║  └───────────────────────────────────────────────────────────┘ ║
║                                                                ║
║   VPC Endpoints: S3/DynamoDB (Gateway), ECR/STS/SSM/Logs (Iface)║
╚════════════════════════════════════════════════════════════════╝
```

**Security rationale — layer by layer (this is the part they're grading):**

> **1. Only the ALB and NAT live in public subnets.** They are the only components that legitimately need an internet route. The ALB is a hardened, AWS-managed appliance with no shell, no OS to patch, and no application code — so even though it's exposed, its attack surface is minimal. Nothing that runs *my* code is ever in a public subnet.
>
> **2. Application tier in private subnets with NAT egress only.** The app servers have **no inbound path from the internet at all** — not "blocked by a rule," but *unroutable*. NAT Gateway allows outbound calls (pulling images from ECR, calling third-party APIs, OS patching) while being strictly one-way: NAT does not accept unsolicited inbound connections. So even if an attacker knows a pod's IP, there is no network path to it.
>
> **3. Database tier in isolated private subnets with no NAT at all.** RDS needs no internet access whatsoever, so I give it none. Route table contains only the local VPC route. Even if the application tier is fully compromised, the database cannot be used to exfiltrate data directly to the internet or to pull down attacker tooling — the attacker has to pivot back through the app tier, which is monitored. This is the layer most people get wrong by reusing the app subnets.
>
> **4. Security groups are chained by reference, not by CIDR.** The DB security group allows 5432 **from the app security group ID**, not from `10.0.10.0/23`. That means the rule stays correct as subnets change, and it's impossible for something in the app subnet that isn't in that SG to reach the database. Similarly the app SG allows 8080 only from the ALB SG. Security groups are stateful, so return traffic is automatic and I never open ephemeral port ranges.
>
> **5. NACLs as a coarse second layer.** Stateless, subnet-level, and useful for broad denies (e.g. block a known-bad CIDR) — defense in depth behind the security groups, which do the fine-grained work.
>
> **6. Multi-AZ everywhere.** Three AZs for the ALB, the node groups, and RDS Multi-AZ. NAT Gateway per AZ so a single AZ failure doesn't take out egress for the others (and to avoid cross-AZ data charges).
>
> **7. VPC Endpoints instead of NAT for AWS services.** Gateway endpoints for S3 and DynamoDB, interface endpoints for ECR, STS, SSM, CloudWatch Logs, Secrets Manager. Traffic to those services never leaves the AWS network, which is both cheaper (no NAT data processing charges) and more secure. It also means nodes can pull images even if I lock egress down further.
>
> **8. No SSH bastion.** Access is via **SSM Session Manager** — IAM-authenticated, fully logged to CloudTrail/S3, no open port 22, no key management.
>
> **9. Encryption everywhere.** TLS in transit (CloudFront→ALB→pod, and `rds.force_ssl=1` for the DB), KMS at rest for RDS, EBS, and S3.
>
> **10. Least-privilege IAM.** IRSA on EKS so each pod gets only the AWS permissions its service needs, rather than every pod inheriting the node's instance profile.
>
> **The one-sentence summary:** each tier can only be reached from the tier immediately above it, the blast radius of any single compromise is bounded by the next tier's controls, and the components that hold data have no route to the internet in either direction.

---

## Q2. How would you decide between ECS and EKS? What factors?

**What it is:** Both are AWS container orchestrators. **ECS** is AWS-proprietary, simpler, deeply integrated with AWS primitives. **EKS** is managed upstream Kubernetes — far more capable and portable, but with real operational and cognitive cost.

**How they work:**
- **ECS:** you define **task definitions** (container specs) and **services** (desired count + load balancer + deployment config). The ECS control plane is free and invisible. Runs on **EC2** (you manage instances) or **Fargate** (serverless — no nodes at all). Integrations are native: IAM task roles, ALB target groups, CloudWatch, Service Discovery via Cloud Map, App Mesh.
- **EKS:** AWS runs the Kubernetes control plane (~$0.10/hr per cluster) across 3 AZs. You get the full Kubernetes API — Deployments, StatefulSets, DaemonSets, CRDs, operators, Helm, admission webhooks — plus the entire CNCF ecosystem. You own worker nodes (managed node groups, Karpenter, or Fargate), the CNI, and the add-ons.

**Answer — the decision framework:**

| Factor | Points to **ECS** | Points to **EKS** |
|---|---|---|
| **Number of services** | Few (≲10–15), simple topology | Many (tens to hundreds), multi-team |
| **Team skill** | No Kubernetes experience; small team | Existing K8s expertise, or willing to invest |
| **Operational overhead** | Want minimal — especially ECS+Fargate | Have (or will build) a platform team |
| **Complexity of workloads** | Stateless web/API/workers | StatefulSets, operators, jobs, batch, ML, custom CRDs |
| **Portability / multi-cloud** | AWS-only is fine, lock-in acceptable | Must run on-prem/other clouds, or avoid lock-in |
| **Ecosystem needs** | ALB + CloudWatch is enough | Need Istio, Argo CD, Prometheus operator, KEDA, cert-manager, OPA/Kyverno |
| **Deployment sophistication** | Rolling + CodeDeploy blue-green is enough | Canary with metric analysis, progressive delivery, GitOps |
| **Multi-tenancy** | Account/cluster separation is fine | Namespaces + RBAC + quotas + NetworkPolicies |
| **Cost** | No control-plane fee; Fargate = zero node ops | $73/mo per cluster + node overhead + engineer time |
| **Expected growth** | Stable scope | Rapid growth in services and teams |
| **Time to first deploy** | Days | Weeks |

**Answer — how I'd actually reason about it:**

> I'd frame it as **total cost of ownership vs required capability**, not as "which is better."
>
> **I'd choose ECS (usually with Fargate) when:** it's a small-to-medium number of stateless services, the team has no Kubernetes background, the company is all-in on AWS, and the requirements are covered by ALB routing, autoscaling, and CloudWatch. ECS gets you to production far faster and there is genuinely less to break — no CNI to debug, no control-plane version upgrades every few months, no operator sprawl. For a startup with 8 services and 3 engineers, EKS is usually over-engineering: you'll spend more time running the platform than the product.
>
> **I'd choose EKS when:** there are many services across multiple teams needing namespace-level isolation and RBAC; workloads are diverse (stateful databases, batch jobs, DaemonSet agents, ML training); the org needs the CNCF ecosystem — GitOps with Argo CD, service mesh, Prometheus operator, KEDA event-driven scaling, policy enforcement with Kyverno; portability or an existing on-prem Kubernetes footprint matters; or the team is already Kubernetes-fluent, which flips the "operational overhead" factor entirely.
>
> **On the growth question specifically:** the migration cost from ECS to EKS later is real but not catastrophic — containers and images carry over; you rewrite task definitions as Deployments and re-plumb CI/CD. So I don't think "we might grow" alone justifies starting on EKS. What *does* justify it early is knowing you'll need multi-team isolation or the K8s ecosystem within the next year, because retrofitting those onto ECS means building them yourself.
>
> **What I chose and why:** we went with EKS because we had ~N services across multiple teams, needed GitOps and progressive delivery, ran stateful components, and the team already had Kubernetes experience — so the ecosystem benefit outweighed the operational cost. If it had been 5 stateless services I'd have argued for ECS Fargate without hesitation.
>
> **Third option worth naming:** for genuinely simple, spiky, or event-driven workloads, neither — **Lambda** or **App Runner** removes the orchestration question entirely.

---

## Q3. How does scaling work in EKS? HPA, node autoscaling, CPU/memory scaling, traffic routing.

**What it is:** Scaling in EKS operates on **two independent axes** that must work together: **pod scaling** (more replicas of your app) and **node scaling** (more EC2 capacity to place those replicas on). A pod-scaling event that has nowhere to land just produces `Pending` pods — which is exactly the failure people hit when they configure only one axis.

**How it works — the layers:**

**1. HPA (Horizontal Pod Autoscaler) — more pods**
- A control loop runs every 15s (`--horizontal-pod-autoscaler-sync-period`).
- It reads current metrics from **metrics-server** (resource metrics) or the **custom/external metrics API** (Prometheus Adapter, KEDA).
- Formula: `desiredReplicas = ceil(currentReplicas × (currentMetricValue / targetMetricValue))`.
- A 10% tolerance prevents flapping; scale-down has a 5-minute stabilization window by default, and `behavior` policies let you tune scale-up/scale-down rates independently.
- **Critical detail:** CPU/memory utilization is measured **as a percentage of the pod's `requests`**, not of the node. If requests are wrong, HPA is wrong.

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api
  minReplicas: 3
  maxReplicas: 30
  metrics:
  - type: Resource
    resource:
      name: cpu
      target: { type: Utilization, averageUtilization: 70 }
  - type: Resource
    resource:
      name: memory
      target: { type: Utilization, averageUtilization: 80 }
  - type: Pods                       # custom metric from Prometheus Adapter
    pods:
      metric: { name: http_requests_per_second }
      target: { type: AverageValue, averageValue: "100" }
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
      - type: Percent
        value: 100
        periodSeconds: 30            # can double every 30s
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 25
        periodSeconds: 60            # shrink slowly
```

**2. VPA (Vertical Pod Autoscaler) — right-sized pods.** Adjusts requests/limits based on observed usage. Useful in `Off`/recommendation mode to *set* your requests correctly; in `Auto` mode it evicts and recreates pods, and it conflicts with HPA on the same CPU/memory metric — so run HPA on CPU and VPA in recommendation mode only.

**3. Cluster Autoscaler / Karpenter — more nodes**
- **Cluster Autoscaler** watches for **Pending** pods that fail to schedule due to insufficient resources, then increases the desired capacity of a matching Auto Scaling Group. It scales down nodes that have been under-utilized (default <50%) for 10 minutes and whose pods can be relocated. It works within fixed node-group shapes, so you must pre-define instance types.
- **Karpenter** is the newer, better approach: it watches Pending pods and **provisions right-sized EC2 instances directly** (no ASG), choosing instance types from a broad set based on the actual pod requirements, in seconds rather than minutes. It also **consolidates** — proactively replacing under-used nodes with cheaper/smaller ones — and handles Spot interruption gracefully. This is what I'd recommend on a new cluster.

**4. KEDA — event-driven scaling.** Scales on queue depth (SQS, Kafka lag, RabbitMQ), cron schedules, Redis list length, or any Prometheus query — and can scale to **zero**, which HPA can't. Essential for worker/consumer workloads where CPU is a poor proxy for demand.

**5. Fargate.** No nodes at all — each pod gets its own micro-VM. Node scaling disappears; you only scale pods. More expensive per unit and lacks DaemonSet support, but zero node management.

**Answer — how the pieces fit, plus traffic routing:**

> Traffic rises → pod CPU passes the HPA target → HPA raises replica count → new pods are created → if existing nodes have capacity they schedule immediately; if not they sit **Pending** → Karpenter/Cluster Autoscaler sees the Pending pods and launches nodes → pods schedule → **readiness probes pass** → the EndpointSlice controller adds the pod IPs to the Service → the AWS Load Balancer Controller registers those pod IPs into the **ALB target group** (in `target-type: ip` mode) → the target passes its ALB health check → the ALB starts sending it traffic.
>
> That last chain is the part people forget: **scaling isn't complete until the ALB target group says the new pod is healthy.** With `ip` target-type the controller registers pod IPs directly; with `instance` type it registers nodes on the NodePort and kube-proxy does the final hop. For a `type: LoadBalancer` Service it's an NLB doing the same thing at L4.
>
> **What I tune in practice:**
> - **Set requests accurately** — everything (HPA percentages, scheduler decisions, autoscaler math) keys off requests. I use VPA recommendations or Prometheus history to set them.
> - **Set memory limits = requests** for predictability, and generally avoid CPU limits (CPU throttling under cgroup quota causes latency spikes even when the node is idle).
> - **Scale up fast, scale down slow** — asymmetric `behavior` policies, so a traffic spike is absorbed quickly but a dip doesn't cause thrash.
> - **Over-provisioning with pause pods** — low-priority placeholder pods that get preempted instantly when real pods need space, so scale-up doesn't wait for an EC2 launch (~60–90s).
> - **PDBs + `topologySpreadConstraints`** so scale-down and node consolidation never take out all replicas of a service or concentrate them in one AZ.
> - **Graceful shutdown** — `preStop` sleep plus a termination grace period longer than the ALB deregistration delay, so scale-down doesn't produce 502s.
> - **Custom metrics over CPU where CPU lies** — an I/O-bound API scales far better on requests-per-second or queue depth than on CPU.

---

## Q4. How is observability implemented in EKS with Prometheus, Grafana, and Loki? How are logs collected and shipped with Promtail?

**What it is:** The three pillars — **metrics** (Prometheus/Grafana), **logs** (Loki/Promtail *or* ELK/EFK), **traces** (Tempo/Jaeger/X-Ray) — correlated so you can move from "the graph spiked" to "here is the log line and the trace that caused it."

> **Consistency note:** the interviewer named Loki in the question, so answer it on those terms. But if you described **ELK/EFK** in L1 (see L1 Q3), say so explicitly — *"we actually ran EFK; here's how the same pipeline maps onto Loki, and why you'd pick one over the other."* Interviewers compare notes between rounds, and a stack that changes story between L1 and L3 is a red flag. Owning the difference and explaining the trade-off scores better than either answer alone.

**How it works — metrics:** covered in L1 Q3. Prometheus Operator + ServiceMonitors, node-exporter, kube-state-metrics, Alertmanager routing.

**How it works — logs (the Promtail pipeline in detail):**

> 1. **Container writes to stdout/stderr.** That's the contract — apps should never write to files inside the container.
> 2. **The container runtime** (containerd) writes those streams to `/var/log/pods/<namespace>_<pod>_<uid>/<container>/0.log` on the node, in CRI format (`timestamp stream flags message`), with symlinks under `/var/log/containers/`.
> 3. **Promtail runs as a DaemonSet** — one pod on every node — with `/var/log` and `/var/lib/docker/containers` mounted read-only via hostPath, and a ServiceAccount with RBAC to list/watch pods.
> 4. **Service discovery:** Promtail uses `kubernetes_sd_configs` with `role: pod` to discover pods **on its own node** (filtered by `NODE_NAME` from the downward API), so each Promtail only tails its local files.
> 5. **Relabeling** turns Kubernetes metadata into Loki labels: `namespace`, `pod`, `container`, `app`, `node_name`. This is the single most important design decision — **Loki indexes only labels**, so labels must be low-cardinality. Never label by request ID, user ID, or trace ID; that explodes the index.
> 6. **Pipeline stages** parse each line: `cri` to strip the runtime wrapper, then `json`/`regex` to extract fields, `timestamp` to use the app's own timestamp, `labels` to promote selected fields, `drop` to discard noisy lines, and `multiline` to stitch Java stack traces into a single entry.
> 7. **Promtail pushes** batches to Loki's `/loki/api/v1/push` over HTTP, tracking file offsets in a `positions.yaml` file so a restart doesn't re-send or lose lines.
> 8. **Loki** stores the label index and compressed log chunks in **S3** (with a boltdb-shipper/TSDB index), which makes retention cheap. Retention and compaction are configured per tenant.
> 9. **Grafana** queries Loki with **LogQL** — `{namespace="prod", app="api"} |= "error" | json | status >= 500` — and can even build metrics from logs (`rate({app="api"} |= "error" [5m])`).

```yaml
# promtail scrape config (essential parts)
scrape_configs:
- job_name: kubernetes-pods
  kubernetes_sd_configs:
  - role: pod
  pipeline_stages:
  - cri: {}                            # strip CRI wrapper
  - json:                              # parse structured app logs
      expressions:
        level: level
        msg: message
        trace_id: trace_id
  - labels:
      level:                           # low-cardinality -> safe as a label
  - timestamp:
      source: time
      format: RFC3339
  relabel_configs:
  - source_labels: [__meta_kubernetes_pod_node_name]
    action: keep
    regex: ${NODE_NAME}                # only this node's pods
  - source_labels: [__meta_kubernetes_namespace]
    target_label: namespace
  - source_labels: [__meta_kubernetes_pod_label_app]
    target_label: app
  - source_labels: [__meta_kubernetes_pod_name]
    target_label: pod
  - source_labels: [__meta_kubernetes_pod_container_name]
    target_label: container
  - source_labels: [__meta_kubernetes_pod_uid, __meta_kubernetes_pod_container_name]
    target_label: __path__
    separator: /
    replacement: /var/log/pods/*$1/*.log
```

**Answer:**

> We deployed the `kube-prometheus-stack` and `loki-stack` Helm charts. Grafana is the single pane of glass, with Prometheus, Loki, and CloudWatch all added as data sources, so a dashboard panel can show ALB 5xx from CloudWatch next to pod restarts from Prometheus next to the actual error logs from Loki.
>
> **The correlation workflow is the real payoff.** An alert fires for high 5xx on the checkout service. In Grafana I look at the RED dashboard, see the p99 latency spike, and click straight through to a Loki query pre-filtered to `{namespace="prod", app="checkout"} |= "error"` for that exact time window — Grafana passes the time range and labels along. Because both use the same `namespace`/`pod`/`app` labels, the correlation is one click, not a manual search. If tracing is wired up, the `trace_id` in the log line links to the trace in Tempo showing which downstream call was slow.
>
> **Why Loki over ELK for us:** Loki indexes only labels rather than full text, so storage and operational cost are dramatically lower, it stores chunks in S3, and it shares Grafana and the same label vocabulary with Prometheus. Elasticsearch gives richer full-text search and aggregation but is significantly heavier to run and much more expensive at volume. Alternatives worth naming: **Fluent Bit** instead of Promtail (lighter, more output plugins, better for shipping to multiple destinations like S3 + OpenSearch), and **CloudWatch Container Insights** or **AWS Managed Prometheus/Grafana** if you want AWS to run it.
>
> **Operational details I'd mention:** we set Loki retention to 30 days hot in S3 with longer-term archival; we monitor Promtail itself (dropped lines, push failures, positions lag); we enforce structured JSON logging in application libraries so parsing is reliable; and we scrub PII in a pipeline stage before it ever reaches Loki.

---

## Q5. A Pod is stuck in Pending or becomes unhealthy. How do you troubleshoot it?

**What it is:** Pod lifecycle problems fall into distinct phases, and the phase tells you which subsystem to look at. **Pending** = the scheduler could not place it, or it's placed but images/volumes aren't ready. **CrashLoopBackOff / not Ready** = it was placed and started but the container or its probes are failing.

**How it works:** Every phase transition writes an **Event**. `kubectl describe pod` is the single highest-value command because it shows the container statuses *and* the events together, and the events almost always name the exact cause.

**Answer — the method:**

> **Step 0 — Get the lay of the land.**
> ```bash
> kubectl get pods -n <ns> -o wide            # STATUS, RESTARTS, node, IP
> kubectl describe pod <pod> -n <ns>          # events + container state + reason  ← start here
> kubectl get events -n <ns> --sort-by=.lastTimestamp | tail -30
> ```
>
> ### Branch A — Pod is `Pending` (never scheduled)
>
> The events section will literally say `0/5 nodes are available: ...`. Read the reason string:
>
> | Event message | Cause | Fix |
> |---|---|---|
> | `Insufficient cpu` / `Insufficient memory` | No node has enough allocatable capacity for the pod's **requests** | Lower requests, or scale nodes (Cluster Autoscaler/Karpenter) |
> | `node(s) had untolerated taint` | Taints on nodes, no matching toleration | Add toleration or use a different node group |
> | `node(s) didn't match Pod's node affinity/selector` | `nodeSelector`/affinity doesn't match any node labels | Fix labels or the selector |
> | `pod has unbound immediate PersistentVolumeClaims` | PVC not bound — no matching PV, wrong StorageClass, or zone mismatch | `kubectl get pvc`, `describe pvc`; use `WaitForFirstConsumer` |
> | `node(s) had volume node affinity conflict` | EBS volume in a different AZ than the candidate node | `volumeBindingMode: WaitForFirstConsumer` |
> | `too many pods` | Node hit its max-pods limit (on EKS this is **ENI/IP-driven**) | Bigger instance type, or enable VPC CNI prefix delegation |
> | `Insufficient <ext-resource>` (e.g. `nvidia.com/gpu`) | No node with that resource | Add the right node group / device plugin |
> | `didn't match pod topology spread constraints` | Spread rules can't be satisfied | Relax to `ScheduleAnyway` or add capacity in the missing zone |
>
> Supporting commands:
> ```bash
> kubectl describe node <node> | grep -A8 "Allocated resources"   # requests vs allocatable
> kubectl get nodes -o wide                                        # any NotReady?
> kubectl top nodes                                                # actual usage
> kubectl get pvc,pv -n <ns>
> kubectl logs -n kube-system -l app=cluster-autoscaler --tail=50  # is it trying to add nodes?
> ```
> A very common EKS-specific cause: **IP exhaustion**. The VPC CNI can't allocate a pod IP because the subnet is out of addresses. Check `kubectl describe pod` for `failed to assign an IP address to container`, then check free IPs in the subnet and the `aws-node` DaemonSet logs.
>
> ### Branch B — Pod is `ContainerCreating` (scheduled, not started)
>
> ```bash
> kubectl describe pod <pod>     # look at the events at the bottom
> ```
> Common causes: image pull in progress, **volume mount failing** (`Unable to attach or mount volumes` — EBS attach failure, wrong AZ, or a stuck multi-attach), **secret/configmap not found** (`MountVolume.SetUp failed ... secret "x" not found`), or a CNI failure (`failed to set up sandbox`).
>
> ### Branch C — `ImagePullBackOff` / `ErrImagePull`
>
> ```bash
> kubectl describe pod <pod> | grep -A5 Events
> ```
> - **Wrong image name/tag** — typo, or the tag doesn't exist. Verify with `aws ecr describe-images --repository-name <repo>`.
> - **Auth failure on a private registry** — missing `imagePullSecrets`, or on EKS the node role/IRSA lacks `ecr:GetAuthorizationToken`, `BatchGetImage`, `GetDownloadUrlForLayer`.
> - **No network path to the registry** — private nodes with no NAT and no ECR VPC endpoint. This one masquerades as an auth problem.
> - **Rate limiting** — Docker Hub anonymous pull limits.
> - **Architecture mismatch** — `exec format error` when an amd64 image lands on Graviton/arm64 nodes.
>
> ### Branch D — `CrashLoopBackOff`
>
> ```bash
> kubectl logs <pod> -n <ns>                    # current attempt
> kubectl logs <pod> -n <ns> --previous         # ← the crashed instance; this is the money command
> kubectl describe pod <pod> | grep -A5 "Last State"    # exit code + reason
> ```
> Read the **exit code**:
> - `0` — the process exited cleanly; the container has no long-running foreground process (a command/entrypoint problem).
> - `1` / `2` — application error, bad config, missing env var, failed DB connection at startup. The logs will say.
> - `137` — SIGKILL, almost always **OOMKilled**. Confirm: `kubectl describe pod | grep -i oom` shows `Reason: OOMKilled`. Fix by raising the memory limit or fixing the leak; check `container_memory_working_set_bytes` in Prometheus for the real usage curve.
> - `139` — SIGSEGV, segfault in the app.
> - `143` — SIGTERM, graceful shutdown (often a failed liveness probe killing it).
>
> **Also check whether the liveness probe is the killer** — if the app is slow to start and there's no startup probe, liveness kills it mid-boot, forever. `describe` shows `Liveness probe failed:` events. That's a config bug, not an app bug.
>
> ### Branch E — Running but `0/1 Ready` (readiness failing)
>
> ```bash
> kubectl describe pod <pod> | grep -i readiness      # exact failure message
> kubectl exec -it <pod> -- curl -v localhost:8080/ready
> kubectl get endpoints <svc> -n <ns>                 # is the pod IP listed? (it won't be)
> ```
> Causes: the probe path returns non-2xx, the app listens on a different port or only on `127.0.0.1` instead of `0.0.0.0`, a dependency the readiness check requires is down, or the probe timeout is too short under load. This is also the state that produces "pods look fine but the ALB target group is unhealthy" — see L3 Q12.
>
> ### Branch F — `Evicted` / `Terminating` forever
>
> - **Evicted** → node pressure (`kubectl describe node` shows `DiskPressure`/`MemoryPressure`). The kubelet evicts lowest-QoS pods first — pods with no requests/limits (`BestEffort`) die first. Fix: set requests, clean up disk (image garbage collection, log rotation), add capacity.
> - **Stuck Terminating** → a finalizer, a stuck volume detach, or a node that's gone. Check `kubectl get pod <pod> -o yaml | grep finalizers`; force delete only as a last resort with `--grace-period=0 --force`.
>
> ### Deeper tools
> ```bash
> kubectl debug -it <pod> --image=nicolaka/netshoot --target=<container>   # ephemeral debug container
> kubectl exec -it <pod> -- sh                                            # if the image has a shell
> kubectl get pod <pod> -o yaml                                           # full spec + status
> journalctl -u kubelet -f            # on the node, via SSM Session Manager
> crictl ps -a && crictl logs <id>    # container runtime level
> ```
>
> **How I'd summarize the method in the interview:** I go **phase-first** — the pod's phase tells me which subsystem owns the problem. Pending is a *scheduler/capacity* question, ContainerCreating is a *storage/CNI/secrets* question, ImagePull is a *registry/auth/network* question, CrashLoop is an *application/probe* question, and NotReady is a *readiness/dependency* question. `kubectl describe pod` answers which branch I'm in within seconds, and `kubectl logs --previous` closes out the crash cases.

---

## Q6. Explain EKS networking — pod IPs with AWS VPC CNI, and Service ↔ Pod communication.

**What it is:** EKS uses the **AWS VPC CNI** plugin, which is unusual among Kubernetes networking solutions: instead of giving pods addresses on an overlay network, it gives every pod a **real, routable VPC IP address** from the node's subnet. A pod is a first-class citizen of the VPC — security groups, VPC flow logs, route tables, and direct connectivity from anything else in the VPC all apply to it natively, with **no encapsulation and no NAT** between pods.

**How it works — IP assignment:**

> 1. Each EC2 worker node has a primary **ENI** (Elastic Network Interface) and can attach more, up to a limit set by its instance type.
> 2. Each ENI can hold a limited number of **secondary private IPs**, again per instance type.
> 3. The `aws-node` DaemonSet (the VPC CNI) runs on every node. Its **ipamd** component pre-allocates a warm pool of ENIs and secondary IPs from the subnet so pod startup doesn't wait on an EC2 API call.
> 4. When a pod is scheduled, the CNI takes a free secondary IP from the pool, creates a veth pair, moves one end into the pod's network namespace, assigns the IP, and adds host routes.
> 5. The pod now has a genuine VPC IP. Pod-to-pod traffic across nodes is routed by the VPC itself — no VXLAN, no IP-in-IP, near-native performance.
>
> **The max-pods formula (the classic EKS gotcha):**
> ```
> max_pods = (ENIs_per_instance × (IPs_per_ENI − 1)) + 2
> ```
> A `t3.medium` gets 3 ENIs × 6 IPs → `3 × (6−1) + 2 = 17` pods. So on EKS your pod density is limited by **networking**, not CPU/memory — and pods stick in `Pending` with `too many pods` long before the node runs out of compute.
>
> **Prefix delegation** fixes this: with `ENABLE_PREFIX_DELEGATION=true`, the CNI assigns a **/28 prefix (16 IPs)** per ENI slot instead of one IP, pushing a `t3.medium` from 17 to ~110 pods and dramatically reducing EC2 API calls. Requires Nitro instances.
>
> **The other consequence: subnet IP exhaustion.** Because every pod eats a real VPC IP, a /24 app subnet (251 usable) is exhausted by a few hundred pods. Mitigations: large subnets (/19 or bigger) for node subnets, **custom networking** (`AWS_VPC_K8S_CNI_CUSTOM_NETWORK_CFG`) to place pods in a *secondary* CIDR such as the `100.64.0.0/10` CGNAT range, or prefix delegation. Custom networking is the standard answer when you're out of RFC1918 space.
>
> **Alternatives worth naming:** Cilium or Calico in overlay mode gives pods non-VPC IPs, removing the exhaustion problem at the cost of losing native VPC routability and adding encapsulation overhead. Many orgs run **Cilium for NetworkPolicy/eBPF alongside** the VPC CNI for IPAM.

**How it works — Service to Pod:**

> 1. **DNS:** the app resolves `backend.prod.svc.cluster.local`. **CoreDNS** (a Deployment in `kube-system`) answers with the Service's **ClusterIP** — a virtual IP from the cluster's service CIDR (e.g. `172.20.0.0/16`), which exists in *no* network interface anywhere. It's purely a routing token.
> 2. **Endpoint tracking:** the EndpointSlice controller watches pods matching the Service selector and maintains a list of the IPs of **Ready** pods only. Failing a readiness probe removes you from this list — that's the mechanism.
> 3. **Data path — kube-proxy:** on every node, kube-proxy watches Services and EndpointSlices and programs the dataplane:
>    - **iptables mode (default):** a chain of `KUBE-SERVICES` → `KUBE-SVC-XXX` → `KUBE-SEP-XXX` rules. Traffic destined for the ClusterIP is **DNAT'd** to a randomly chosen backend pod IP (statistically weighted so the distribution is even). Connection tracking (conntrack) makes the return path work. Rule evaluation is O(n), so it degrades with thousands of services.
>    - **IPVS mode:** kernel-level L4 load balancing with a hash table — O(1) lookups and real algorithms (rr, lc, sh). Better at scale.
>    - **eBPF (Cilium) replacement:** removes kube-proxy entirely, doing the lookup in eBPF programs at the socket layer — lowest latency.
> 4. **Delivery:** the packet, now addressed to a real pod IP, is routed by the VPC (if cross-node) or delivered locally via the veth pair. No overlay, no NAT between pods.
>
> **Important nuances:**
> - There is **no service proxy pod** — the "load balancer" is just kernel rules on every node. Traffic goes node → pod directly.
> - Load balancing is **per-connection**, not per-request. Long-lived HTTP/2 or gRPC connections pin to one pod, which is why gRPC services need a headless Service + client-side load balancing, or a service mesh.
> - **Headless Services** (`clusterIP: None`) skip all of this — DNS returns pod IPs directly.
> - **Security groups for pods** (`ENABLE_POD_ENI`) let you attach an actual EC2 security group to specific pods via a `SecurityGroupPolicy` CRD — useful for locking a single service's access to RDS at the VPC level rather than only with NetworkPolicy.
> - **NetworkPolicies** are enforced by the VPC CNI (v1.14+) or Calico/Cilium; without a policy engine installed, NetworkPolicy objects are silently ignored — a dangerous false sense of security worth mentioning.

**Debugging commands to quote:**
```bash
kubectl get svc,endpointslice -n <ns>                 # does the Service have endpoints?
kubectl exec -it <pod> -- nslookup backend.prod.svc.cluster.local
kubectl exec -it <pod> -- curl -v backend.prod:8080
kubectl logs -n kube-system -l k8s-app=aws-node       # CNI / IPAM errors
kubectl get pods -n kube-system -l k8s-app=kube-dns   # CoreDNS healthy?
kubectl describe node <node> | grep -i "pods:"        # max pods on this node
```

---

## Q7. How would you expose applications on EKS publicly? ALB, API Gateway, CloudFront, VPC Link, SSL termination.

**What it is:** "Exposing publicly" means choosing a path from the internet to a pod, and each component in that path buys you a specific capability — caching and DDoS protection (CloudFront), L7 routing and TLS (ALB), API management and throttling (API Gateway), private connectivity (VPC Link/VPC Origins).

**How each component contributes:**

| Component | What it adds |
|---|---|
| **Route 53** | DNS, health-check failover, weighted/latency routing |
| **CloudFront** | Edge caching, TLS at the edge, Shield DDoS, WAF, HTTP/3, geo-restriction |
| **AWS WAF** | Managed rule groups, rate limiting, SQLi/XSS filtering |
| **API Gateway** | API keys, usage plans, per-consumer throttling, request validation, authorizers |
| **VPC Link** | Private connectivity from API Gateway into a VPC (to an NLB for REST APIs, or an ALB/NLB/Cloud Map for HTTP APIs) |
| **ALB** | Host/path routing, target groups, health checks, TLS termination with ACM, OIDC auth |
| **AWS Load Balancer Controller** | Creates and reconciles the ALB from Kubernetes Ingress objects |
| **ACM** | Free, auto-renewing TLS certificates |

**Answer — the common traffic flows:**

> **Flow 1 — Standard web app (what I used most):**
> ```
> User → Route 53 → CloudFront (+WAF, TLS, cache) → ALB (public or VPC Origin)
>      → EKS Ingress/target group → pod
> ```
> CloudFront caches static assets and terminates TLS at the edge; behaviors split `/static/*` to an S3 origin and `/api/*` to the ALB. The ALB does host/path routing into Services. With **VPC Origins** the ALB stays internal and private.
>
> **Flow 2 — Managed/partner API:**
> ```
> Client → API Gateway (auth, API keys, throttling) → VPC Link → internal ALB/NLB
>        → EKS → pod
> ```
> This is the right shape when consumers are external partners needing per-key quotas, or when you want request validation and authorizers outside the app. **VPC Link** is the key piece: it's a managed elastic network path that lets a public API Gateway endpoint reach a **private** load balancer without exposing it. REST APIs use a VPC Link to an **NLB**; HTTP APIs support VPC Links to an **ALB**, NLB, or Cloud Map service.
>
> **Flow 3 — Both combined (maximum control):**
> ```
> User → CloudFront (cache, WAF, DDoS) → API Gateway (throttle, auth)
>      → VPC Link → internal ALB → EKS → pod
> ```
> Every layer adds latency, so I'd only stack all of them when each one is earning its place.
>
> **Flow 4 — Simplest, internal or dev:**
> ```
> User → ALB (from Ingress, ACM cert) → pod
> ```
>
> **Flow 5 — Non-HTTP:**
> ```
> Client → NLB (type: LoadBalancer Service) → pod
> ```
>
> **SSL/TLS termination — where and why:**
> - **At CloudFront** — always, using an ACM cert in **us-east-1** (CloudFront's requirement). Fastest handshake for the user because it happens at the nearest PoP.
> - **At the ALB** — with an ACM cert in the ALB's own region. CloudFront re-encrypts to the origin, so the hop from edge to ALB is HTTPS too (`Origin Protocol Policy: HTTPS Only`). This is the standard **TLS termination + re-encryption** pattern.
> - **ALB → pod** — usually plain HTTP inside the private VPC, which is acceptable because that traffic never leaves the VPC. For strict/regulated environments I'd do **end-to-end TLS** with the `alb.ingress.kubernetes.io/backend-protocol: HTTPS` annotation, or terminate mTLS in a service mesh (Istio/Linkerd with automatic mTLS between pods).
> - **HTTP → HTTPS redirect** at the ALB via `alb.ingress.kubernetes.io/ssl-redirect: '443'`, and HSTS headers from the app or CloudFront.
> - **Certificate automation:** ACM for anything AWS-terminated (auto-renews); **cert-manager** with Let's Encrypt if terminating inside the cluster at an NGINX Ingress.
>
> **How I'd choose:** start with ALB via Ingress. Add CloudFront when you need caching, global latency improvement, or WAF/DDoS at the edge. Add API Gateway only when you need API *management* — keys, quotas, per-consumer plans, request validation. Use VPC Link or VPC Origins so the load balancer itself never needs a public IP.

---

## Q8. How would you troubleshoot a 502 / 5xx error? What do you check at ALB, Target Group, Service, Pod, and app levels?

**What it is:** A 5xx means the server side failed, but *which* server side matters enormously. The first job is to determine **who generated the error** — the ALB itself, or the backend. AWS gives you this for free via two distinct CloudWatch metrics:

- **`HTTPCode_ELB_5XX_Count`** — the **ALB** generated the error. The backend either didn't respond, responded malformedly, or there were no healthy targets.
- **`HTTPCode_Target_5XX_Count`** — the **application** returned the 5xx. The ALB just passed it through.

That single distinction cuts the search space in half before you run a command.

**How it works — what each ALB code means:**

| Code | ALB meaning | Typical cause |
|---|---|---|
| **502 Bad Gateway** | Malformed or unparseable response from the target, or the target closed the connection | App crashed mid-request, keep-alive timeout mismatch, wrong protocol (HTTP sent to an HTTPS port), response headers too large |
| **503 Service Unavailable** | **No healthy targets** registered in the target group | All pods failing health checks, deployment gone, target group empty |
| **504 Gateway Timeout** | Target didn't respond within the ALB idle timeout (default 60s) | Slow query, deadlock, downstream dependency hanging, app thread pool exhausted |
| **500 Internal Server Error** | ALB internal error (rare) or app 500 | Check which metric fired |
| **460** | Client closed the connection before the target responded | Client-side timeout — often a symptom of your app being slow |
| **463** | `X-Forwarded-For` header with too many IPs | Malformed request chain |

**Answer — the layered method:**

> I work the request path **from the outside in**, eliminating one layer at a time.
>
> **Step 1 — Confirm scope and blast radius.** Is it all requests or some? One path or all paths? One AZ? Did it start at a deploy? `kubectl rollout history` and the CloudWatch metric timeline against the deployment timeline answers "did we cause this" in about 30 seconds.
>
> **Step 2 — Determine who generated the 5xx.**
> CloudWatch → the ALB's metrics → compare `HTTPCode_ELB_5XX_Count` vs `HTTPCode_Target_5XX_Count`.
> - **Target 5xx** → it's the application. Skip to Step 5.
> - **ELB 5xx** → it's infrastructure/connectivity. Continue.
>
> Then read the **ALB access logs** in S3 (or query with Athena) — each line has `elb_status_code`, `target_status_code` (`-` means the target never responded), `request_processing_time`, `target_processing_time`, `response_processing_time`, and the target that was chosen. `target_status_code = -` plus `target_processing_time = -1` means the ALB never got a usable response — that's a 502/504 story, not an app-error story.
>
> ```sql
> -- Athena over ALB access logs
> SELECT elb_status_code, target_status_code, target_processing_time, request_url, COUNT(*)
> FROM alb_logs
> WHERE elb_status_code LIKE '5%' AND time > '...'
> GROUP BY 1,2,3,4 ORDER BY 5 DESC;
> ```
>
> **Step 3 — Target Group health.**
> ```bash
> aws elbv2 describe-target-health --target-group-arn <arn>
> ```
> This gives per-target `State` and a `Reason` + `Description` — `Target.FailedHealthChecks`, `Target.Timeout`, `Target.ResponseCodeMismatch`, `Target.NotRegistered`, `Elb.RegistrationInProgress`, `Target.DeregistrationInProgress`.
> - **Zero healthy targets** → that's the 503, and the investigation becomes Q12's scenario.
> - **Some healthy, some not** → intermittent 5xx as the ALB rotates through; look at what's different about the unhealthy pods (node, AZ, version).
> - **All healthy but still 5xx** → the health check path is passing while the real endpoint fails — meaning the health check is too shallow (e.g. `/` returns 200 statically while `/api/orders` throws).
>
> **Step 4 — Networking between ALB and pod.**
> - **Security groups:** does the node/pod SG allow the ALB SG on the target port *and* the health-check port? A missing rule here is the single most common cause of `Target.Timeout`.
> - **Target type:** in `ip` mode the pod IPs must be registered — confirm with `kubectl get targetgroupbindings -A` and check the AWS Load Balancer Controller logs for reconciliation errors.
> - **Subnets:** the ALB needs `kubernetes.io/role/elb` tags on public subnets (`internal-elb` for internal ALBs) or it won't provision correctly.
> - **NACLs:** ephemeral port ranges blocked on the return path.
>
> **Step 5 — Kubernetes Service and Pod layer.**
> ```bash
> kubectl get endpoints <svc> -n <ns>          # empty = no Ready pods = the 503
> kubectl get pods -n <ns> -o wide             # Ready column, restarts
> kubectl describe pod <pod> | grep -A5 -i probe
> kubectl top pods -n <ns>                     # near memory limit -> OOM incoming
> kubectl logs <pod> --previous                # did it crash mid-request?
> ```
> Then bypass the ALB entirely to isolate:
> ```bash
> kubectl port-forward svc/<svc> 8080:80        # test the Service
> curl -v localhost:8080/api/whatever
> kubectl exec -it <debug-pod> -- curl -v http://<pod-ip>:8080/health    # test the pod directly
> ```
> If the pod works directly but fails through the ALB, the problem is between the ALB and the pod — health checks, security groups, or target registration. If the pod fails directly too, it's the application.
>
> **Step 6 — Application layer.** Application logs in Loki filtered to the failing window, stack traces, DB connection pool exhaustion (`too many connections` on RDS), downstream timeouts, thread pool saturation, unhandled exceptions. Traces show which span is slow.
>
> **The specific 502 causes I'd name from experience:**
> 1. **Keep-alive timeout mismatch** — the classic. The ALB's idle timeout (60s) is *longer* than the app server's keep-alive timeout (Node.js default 5s, older versions). The app closes an idle pooled connection right as the ALB reuses it → 502. Fix: set the app's keep-alive timeout **higher** than the ALB idle timeout (e.g. 65s vs 60s).
> 2. **Pods terminating without draining** — during a rolling update, a pod is killed while the ALB is still sending it requests. Fix: `preStop` hook with a sleep longer than the target group's **deregistration delay**, `terminationGracePeriodSeconds` set accordingly, and readiness failing *before* SIGTERM so the pod is pulled from rotation first.
> 3. **OOMKill mid-request** — the container is killed by the kernel while serving; the ALB sees a closed connection. `kubectl describe pod` shows `OOMKilled`, exit code 137.
> 4. **Protocol mismatch** — the target group is HTTP but the pod speaks HTTPS (or gRPC without the right `backend-protocol-version`).
> 5. **Response header size** — the ALB rejects targets returning oversized headers.
>
> **The specific 504 causes:** slow DB query, missing index, N+1 query, a downstream call with no timeout, thread/connection pool exhaustion, or an ALB idle timeout shorter than a legitimately long request (raise it, or make the endpoint async).
>
> **Prevention:** alert on `HTTPCode_ELB_5XX_Count` and `UnHealthyHostCount` separately, enable ALB access logs to S3 with an Athena table ready, keep readiness probes accurate, always run PDBs plus graceful shutdown, and make the health-check endpoint deep enough to be meaningful but shallow enough not to cascade.

---

## Q9. How would you troubleshoot an unresponsive EC2 instance? What if SSH/SSM is unavailable?

**What it is:** "Unresponsive" is ambiguous, and narrowing it is the first move: is the *instance* down (hypervisor/OS level), is the *network path* broken, or is the *application* hung while the box is fine? Each has a different set of checks.

**How it works — AWS status checks are your first signal:**

| Check | What it tests | Failure means |
|---|---|---|
| **System status check** | AWS underlying hardware, host, network, power | **AWS's problem** — loss of network connectivity, hardware failure, host software issues. Fix: **stop/start** the instance (moves it to new hardware). A reboot won't help. |
| **Instance status check** | The instance's OS and network config | **Your problem** — kernel panic, exhausted memory, corrupted filesystem, bad network config, full disk. Fix: reboot, or investigate the OS. |
| **EBS status check** | Attached EBS volume reachability | Volume I/O impaired |
| **Attached EBS status** | Whether attached volumes can complete I/O | Storage issue |

**Answer — the method:**

> **Step 1 — Console / API basics.**
> ```bash
> aws ec2 describe-instance-status --instance-ids i-0abc --include-all-instances
> ```
> - Is the instance **state** `running`, or did it stop/terminate?
> - **System status check** failed → AWS-side. **Stop and start** the instance (not reboot) to migrate it to healthy hardware. Note: instance-store data is lost, and the public IP changes unless it's an EIP.
> - **Instance status check** failed → OS-level. Continue investigating.
> - Check the **AWS Health Dashboard** for scheduled retirement or degraded-hardware events on that instance.
>
> **Step 2 — Resource utilization (CloudWatch).**
> - `CPUUtilization` pinned at 100% → runaway process, or a **T-instance that exhausted its CPU credits** (`CPUCreditBalance` at 0 → the instance is throttled to baseline, e.g. 20% of a vCPU, which makes it feel completely dead). This is a very common and very satisfying root cause to name.
> - `NetworkIn`/`NetworkOut` abnormally high → possible DDoS, a runaway job, or data exfiltration.
> - `EBSIOBalance%` / `EBSByteBalance%` at 0 → **burst balance exhausted** on gp2, so the volume is throttled to baseline IOPS and everything blocks on disk. Move to gp3.
> - **Memory and disk are NOT in default CloudWatch** — they need the CloudWatch agent. If it's installed, check `mem_used_percent` and `disk_used_percent`. A **full root disk** makes an instance appear dead while it's technically running (can't write logs, can't fork, sshd can't create session files).
>
> **Step 3 — Network path (if it's reachable-in-principle but not connecting).** Work the path methodically:
> - **Security group** — is 22/443/your port allowed from your source IP? Was a rule changed?
> - **NACL** — stateless, so both inbound *and* the ephemeral outbound return range must be allowed.
> - **Route table** — does the subnet have a route to the IGW (public) or NAT (private)?
> - **Public IP / EIP** — did a stop/start change the public IP?
> - **VPC Reachability Analyzer** — this is the tool to name; it statically analyzes SGs, NACLs, and routes and tells you exactly which hop blocks the path, without touching the instance.
> - **VPC Flow Logs** — are packets arriving and being `REJECT`ed, or not arriving at all? `REJECT` = a security control; nothing at all = routing/DNS/upstream.
>
> **Step 4 — Get inside without SSH.**
> - **SSM Session Manager** — `aws ssm start-session --target i-0abc`. Requires the SSM agent running, an instance profile with `AmazonSSMManagedInstanceCore`, and network egress to the SSM endpoints (NAT or interface VPC endpoints). No open port 22 needed.
> - **EC2 Instance Connect** — browser/CLI SSH via AWS-managed keys (still needs port 22 reachable).
> - **EC2 Serial Console** — this is the key answer when the network stack is broken. It gives a direct serial connection to Nitro instances even with no network, no sshd, and a broken security group. You can log in with a local OS password (must be set beforehand) and fix boot problems, fstab errors, or firewall rules. Must be enabled at the account level.
>
> **Step 5 — Diagnose without any access at all.**
> - **`aws ec2 get-console-output --instance-id i-0abc`** — the OS boot log. This is where you see kernel panics, systemd failures, `Out of memory: Killed process`, filesystem errors, or a hang at boot. Free, instant, no access required — I'd run this early.
> - **`aws ec2 get-console-screenshot --instance-id i-0abc`** — literally a screenshot of the console, which catches things like a Windows blue screen or a GRUB prompt.
>
> **Step 6 — Recovery options, in escalating order:**
> 1. **Reboot** (`aws ec2 reboot-instances`) — fixes a hung OS. Try first; it's non-destructive.
> 2. **Stop / Start** — the fix for a failed *system* status check. Migrates to different physical hardware, and also clears exhausted CPU credit throttling. Caveats: instance-store volumes are wiped, public IP changes without an EIP.
> 3. **Rescue via volume attach** — the definitive recovery when the OS won't boot: stop the instance, **detach the root EBS volume**, attach it as a **secondary volume to a healthy rescue instance**, mount it, read the logs (`/var/log/messages`, `/var/log/syslog`, `/var/log/cloud-init.log`), fix the problem (bad `/etc/fstab`, full disk, broken sshd config, corrupt kernel), then detach and reattach it as the root volume (`/dev/xvda`) on the original instance and start it. This is the answer they're looking for when they say "no SSH, no SSM."
> 4. **Snapshot and rebuild** — take an EBS snapshot for forensics, then launch a replacement from a known-good AMI. In an autoscaled or immutable-infrastructure world this is usually the *fastest* path: terminate the instance, let the ASG replace it, and investigate the snapshot offline.
> 5. **CloudWatch auto-recovery** — an alarm on `StatusCheckFailed_System` with a `recover` action automatically stops/starts the instance. Should be configured *proactively* on any pet instance.
>
> **On abnormal traffic specifically:** check `NetworkIn`/`NetworkPacketsIn`, VPC Flow Logs for a flood from a narrow source range, GuardDuty findings (crypto-mining, C2 communication, and port-scan detections show up here), and whether the instance is behind Shield/WAF. If it's an attack, the immediate containment is to tighten the security group (or attach an isolation SG with no rules) — which preserves the instance for forensics while cutting the traffic, rather than terminating evidence.
>
> **The mindset I'd state:** for cattle (ASG-managed, stateless), don't debug — terminate, let it be replaced, and analyze the snapshot afterwards. Time-to-recovery beats root cause during an incident. For pets (a stateful instance with local data), work the rescue-volume path carefully. And the real fix afterwards is to stop having pets.

---

## Q10. Your hands-on with RDS — PostgreSQL creation, private subnets, DB subnet groups, parameter groups. How do you plan Multi-AZ?

**What it is:** Amazon RDS is managed relational database hosting — AWS handles provisioning, patching, backups, failover, and monitoring, while you own schema, queries, and configuration. The four objects the question names are the ones you must understand to place and tune a database correctly.

**How each piece works:**

- **DB subnet group** — a named collection of subnets (in **at least two AZs**) that RDS may place instances in. It is *mandatory* for a VPC instance, and it's the mechanism by which Multi-AZ is even possible: the standby is placed in a different subnet/AZ from the group. I use subnets from the **isolated data tier** with no NAT and no IGW route.
- **Parameter group** — the database engine's configuration (`postgresql.conf` equivalent). The default group is not editable, so you always create a **custom** one. Parameters are either **dynamic** (apply immediately) or **static** (require a reboot — worth knowing, because changing `shared_buffers` needs a restart while `log_min_duration_statement` doesn't).
- **Option group** — engine add-ons/extensions (more relevant to Oracle/SQL Server; for Postgres, extensions are installed with `CREATE EXTENSION`).
- **Security group** — the network gate; allows 5432 **from the application security group ID**, never from a CIDR or `0.0.0.0/0`.

**Answer — how I create a production PostgreSQL RDS:**

> **1. Networking first.** A DB subnet group over three private data-tier subnets in three AZs, with a route table containing only the local VPC route — no NAT, no IGW. The DB security group allows **5432 from the EKS node/pod security group only**. `publicly_accessible = false`, always.
>
> **2. Instance configuration.** An `db.r6g` (Graviton, better price/performance) sized on connections and working-set memory; **gp3** storage with explicit IOPS/throughput (predictable, unlike gp2 burst credits); **storage autoscaling** enabled with a max threshold so a full disk never takes the DB down.
>
> **3. Custom parameter group** — the settings I actually change:
>
> | Parameter | Value | Why |
> |---|---|---|
> | `max_connections` | tuned to instance size | Postgres uses a process per connection; too many exhausts memory |
> | `rds.force_ssl` | `1` | Force TLS in transit |
> | `log_min_duration_statement` | `1000` | Log queries over 1s — the single most useful perf setting |
> | `log_connections` / `log_disconnections` | `1` | Audit trail |
> | `shared_buffers` | ~25% of RAM | Postgres buffer cache (static — needs reboot) |
> | `work_mem` | tuned | Per-sort/hash memory; too high × many connections = OOM |
> | `maintenance_work_mem` | raised | Faster VACUUM and index builds |
> | `effective_cache_size` | ~75% of RAM | Planner hint |
> | `autovacuum_vacuum_scale_factor` | lowered on big tables | Prevents bloat and transaction-ID wraparound |
> | `idle_in_transaction_session_timeout` | set | Kills connections holding locks open |
> | `pg_stat_statements` in `shared_preload_libraries` | enabled | Query-level performance analysis |
>
> **4. Security and access.** Encryption at rest with a **customer-managed KMS key**; credentials in **Secrets Manager** with automatic rotation, pulled into EKS via External Secrets Operator; **IAM database authentication** where possible so applications use short-lived tokens instead of passwords; `deletion_protection = true`.
>
> **5. Backup and recovery.** Automated backups with a 7–35 day retention window, a backup window outside peak hours, **point-in-time recovery** (which is what automated backups actually buy you — restore to any second in the window), plus manual snapshots before major migrations, and cross-region snapshot copies for DR.
>
> **6. Monitoring.** **Enhanced Monitoring** (OS-level, 1-second granularity), **Performance Insights** (top SQL by wait event — the first place I look for a slow database), and CloudWatch alarms on `CPUUtilization`, `FreeableMemory`, `FreeStorageSpace`, `DatabaseConnections`, `ReadLatency`/`WriteLatency`, and `ReplicaLag`.
>
> **7. Maintenance.** A defined maintenance window, `auto_minor_version_upgrade` enabled for patches, and major version upgrades tested on a restored snapshot first.

**Answer — Multi-AZ specifically:**

> **How Multi-AZ works:** RDS provisions a **standby replica in a different AZ** and replicates to it **synchronously** — a commit isn't acknowledged until it's durable on both. The standby is **not readable**; it exists purely for availability, which is a point people frequently get wrong. Failover is automatic on AZ failure, instance failure, storage failure, or during patching/instance-type changes, and it works by **repointing the DNS CNAME** of the DB endpoint to the standby, typically in **60–120 seconds**. Because the endpoint name never changes, applications need no config change — but they *must* handle a brief connection error and reconnect, and their DNS caching TTL must be short (a JVM caching DNS forever is a classic failure here).
>
> **Multi-AZ vs Read Replicas — the distinction to state clearly:**
>
> | | Multi-AZ | Read Replica |
> |---|---|---|
> | Purpose | **Availability** | **Read scaling** |
> | Replication | Synchronous | Asynchronous |
> | Readable? | No | Yes |
> | Failover | Automatic | Manual promotion |
> | Data loss on failover | None | Possible (replica lag) |
> | Cross-region | No (Multi-AZ is in-region) | Yes |
>
> They solve different problems and are commonly used together: Multi-AZ for HA, read replicas for offloading reporting/analytics queries.
>
> **Multi-AZ DB Cluster (the newer option)** — two *readable* standbys across three AZs with faster failover (~35 seconds) and semi-synchronous replication. Worth naming: it gives you HA *and* read capacity, at higher cost.
>
> **How I'd plan the rollout:**
> - **Enable it with zero downtime** — converting Single-AZ to Multi-AZ is an online operation; RDS takes a snapshot, builds the standby, and syncs. There's an I/O performance impact during the build, so I'd do it in the maintenance window.
> - **Cost is ~2× the instance** (you pay for the standby), so in practice: Multi-AZ mandatory in prod, Single-AZ in dev/staging to control spend.
> - **Test failover deliberately** — `aws rds reboot-db-instance --force-failover` (or an AWS FIS experiment) in a lower environment, and measure actual application recovery time. Untested failover is not a DR plan.
> - **Make the application failover-ready** — connection pooling with retry and exponential backoff, short DNS TTL handling, idempotent writes, and a circuit breaker. **RDS Proxy** is worth adding here: it pools connections, survives failover far more gracefully (cutting failover time by up to ~66%), and prevents connection storms when a fleet of pods reconnects simultaneously — which is a real problem when 50 pods all retry at once.
> - **Alert on failover events** via RDS event subscriptions to SNS.
> - **Choose the AZs deliberately** — the same AZs as the EKS node groups, to avoid cross-AZ latency and data transfer charges on every query.

**Terraform snippet worth having ready:**

```hcl
resource "aws_db_subnet_group" "main" {
  name       = "prod-postgres-subnet-group"
  subnet_ids = [for s in aws_subnet.data : s.id]   # 3 AZs, isolated tier
}

resource "aws_db_parameter_group" "postgres16" {
  name   = "prod-postgres16"
  family = "postgres16"

  parameter { name = "rds.force_ssl"               value = "1" }
  parameter { name = "log_min_duration_statement"  value = "1000" }
  parameter { name = "shared_preload_libraries"    value = "pg_stat_statements"
              apply_method = "pending-reboot" }     # static parameter
}

resource "aws_db_instance" "main" {
  identifier     = "prod-postgres"
  engine         = "postgres"
  engine_version = "16.3"
  instance_class = "db.r6g.xlarge"

  allocated_storage     = 100
  max_allocated_storage = 1000          # storage autoscaling
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.rds.arn

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  parameter_group_name   = aws_db_parameter_group.postgres16.name

  multi_az                = true
  backup_retention_period = 14
  backup_window           = "03:00-04:00"
  maintenance_window      = "sun:04:00-sun:05:00"

  performance_insights_enabled = true
  monitoring_interval          = 60
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "prod-postgres-final"

  lifecycle { prevent_destroy = true }
}
```

---

## Q11. How do you control access to an S3 bucket with IAM? How do you restrict specific actions like `s3:DeleteObject`?

**What it is:** S3 access is decided by the **union and intersection** of several independent policy types. Understanding the evaluation order is the actual question here.

**How it works — the policy types:**

| Mechanism | Attached to | Scope |
|---|---|---|
| **IAM identity policy** | User / group / **role** | "What can this principal do?" |
| **Bucket policy** (resource policy) | The bucket | "Who can access this bucket?" — can grant cross-account |
| **SCP** (Service Control Policy) | AWS Organization OU/account | Maximum permission ceiling; can only *deny*, never grant |
| **Permission boundary** | IAM user/role | Caps the max permissions that identity can have |
| **Session policy** | An assumed-role session | Further narrows that session |
| **S3 Block Public Access** | Account & bucket | Overrides everything public |
| **ACLs** | Bucket/object (legacy) | Disable these — use `BucketOwnerEnforced` |

**Evaluation logic (say this verbatim, it's the core):**
1. **An explicit `Deny` anywhere always wins** — no exception, at any layer.
2. Otherwise, an **explicit `Allow`** is required from an applicable policy.
3. Otherwise, the **implicit deny** applies (default is no access).
4. For same-account access, an Allow in *either* the IAM policy *or* the bucket policy suffices. For **cross-account**, you need an Allow in **both** the bucket policy and the caller's IAM policy.

**Answer — how I'd grant access:**

> **Principle: use roles, not users.** For EKS I use **IRSA** — a ServiceAccount annotated with an IAM role ARN, so each pod assumes a scoped role via OIDC and gets short-lived credentials. No access keys anywhere. For EC2, an instance profile. For humans, IAM Identity Center with permission sets, never long-lived keys.
>
> **A least-privilege read/write policy scoped to one prefix:**
> ```json
> {
>   "Version": "2012-10-17",
>   "Statement": [
>     {
>       "Sid": "ListOnlyThisPrefix",
>       "Effect": "Allow",
>       "Action": "s3:ListBucket",
>       "Resource": "arn:aws:s3:::my-app-bucket",
>       "Condition": {
>         "StringLike": { "s3:prefix": ["uploads/tenant-a/*"] }
>       }
>     },
>     {
>       "Sid": "ObjectReadWrite",
>       "Effect": "Allow",
>       "Action": ["s3:GetObject", "s3:PutObject"],
>       "Resource": "arn:aws:s3:::my-app-bucket/uploads/tenant-a/*"
>     }
>   ]
> }
> ```
> Note the two different resource ARNs: **bucket-level** actions (`ListBucket`, `GetBucketLocation`) target `arn:aws:s3:::bucket`, while **object-level** actions target `arn:aws:s3:::bucket/*`. Getting this wrong is the most common S3 policy bug.

**Answer — restricting `s3:DeleteObject` specifically (the actual question):**

> There are several layers, and I'd use more than one because they protect against different threats.
>
> **1. Simply don't grant it.** Least privilege means the role's policy lists only `GetObject` and `PutObject`. Since the default is implicit deny, `DeleteObject` is already unavailable. This is the first and best answer.
>
> **2. Explicit `Deny` — defense against over-broad grants.** An explicit Deny beats *any* Allow, so even if someone later attaches `AmazonS3FullAccess` to the role, deletion stays blocked:
> ```json
> {
>   "Sid": "DenyAllDeletes",
>   "Effect": "Deny",
>   "Action": [
>     "s3:DeleteObject",
>     "s3:DeleteObjectVersion",
>     "s3:DeleteBucket",
>     "s3:DeleteBucketPolicy"
>   ],
>   "Resource": [
>     "arn:aws:s3:::my-app-bucket",
>     "arn:aws:s3:::my-app-bucket/*"
>   ]
> }
> ```
>
> **3. Bucket policy denying deletes from everyone except a specific break-glass role** — protects the bucket regardless of what any identity policy says:
> ```json
> {
>   "Sid": "DenyDeleteExceptAdmin",
>   "Effect": "Deny",
>   "Principal": "*",
>   "Action": ["s3:DeleteObject", "s3:DeleteObjectVersion"],
>   "Resource": "arn:aws:s3:::my-app-bucket/*",
>   "Condition": {
>     "ArnNotEquals": {
>       "aws:PrincipalArn": "arn:aws:iam::123456789012:role/S3BreakGlassAdmin"
>     }
>   }
> }
> ```
>
> **4. Require MFA for deletion** — condition-based:
> ```json
> "Condition": { "BoolIfExists": { "aws:MultiFactorAuthPresent": "false" } }
> ```
> combined with an `Effect: Deny` on delete actions. There's also **MFA Delete** as a bucket-versioning feature (enabled only by the root account, via CLI), which requires an MFA token for permanent version deletion.
>
> **5. Versioning + lifecycle** — the operational safety net. With versioning on, `DeleteObject` doesn't actually destroy data; it writes a **delete marker**, and the previous version is fully recoverable. Only `DeleteObjectVersion` truly removes bytes — which is why the deny statement above lists both.
>
> **6. S3 Object Lock (WORM)** — for compliance-grade immutability. In **Governance mode**, only a principal with `s3:BypassGovernanceRetention` can delete before the retention period expires. In **Compliance mode**, *nobody* can — not even the root account — until retention lapses. This is the answer when they push on "what if the attacker has admin?"
>
> **7. SCP at the organization level** — a `Deny` on `s3:DeleteBucket` across the whole OU means even account administrators can't delete production buckets. The permission ceiling no identity policy can exceed.
>
> **Other conditions worth knowing:** `aws:SourceVpce` (only from a specific VPC endpoint), `aws:SourceIp`, `s3:x-amz-server-side-encryption` (deny unencrypted uploads), and `aws:SecureTransport: false` (deny non-TLS requests — a standard baseline statement on every bucket).
>
> **Verification:** IAM Policy Simulator to test a specific principal/action/resource, **IAM Access Analyzer** to find buckets accessible from outside the account, CloudTrail **data events** for object-level auditing, and S3 Access Logs. I'd also enable **Block Public Access** at the account level and set `BucketOwnerEnforced` to disable ACLs entirely.

---

## Q12. Scenario — Pods are healthy, APIs work when hit directly, but the ALB Target Group shows targets as **unhealthy**. How do you troubleshoot?

> **This was the hardest question in the round, and the interviewers had to prompt toward the answer. The insight they were testing: *application health and load-balancer health are two independent checks against potentially different endpoints.* A pod can be perfectly healthy and still fail the ALB's health check, because the ALB is asking a different question, at a different path, on a different port, from a different source.**

**What it is:** The ALB health check is an **independent HTTP request** originating from the ALB's ENIs in each AZ, hitting a **configured path** on a **configured port**, expecting a **configured status code**, within a **configured timeout**. Every one of those five things is a separate failure mode — and none of them is tested by `curl`-ing the pod from inside the cluster.

**Answer — the systematic method:**

> **Step 1 — Get the actual failure reason, don't guess.** The target group tells you *why*, and this should be the first command:
> ```bash
> aws elbv2 describe-target-health --target-group-arn <arn>
> ```
> ```json
> {
>   "Target": { "Id": "10.0.12.45", "Port": 8080 },
>   "TargetHealth": {
>     "State": "unhealthy",
>     "Reason": "Target.ResponseCodeMismatch",
>     "Description": "Health checks failed with these codes: [404]"
>   }
> }
> ```
> The `Reason` code immediately narrows everything:
>
> | Reason | Meaning | Where to look |
> |---|---|---|
> | `Target.ResponseCodeMismatch` | Reached the app, got the **wrong status code** | Health-check **path** or **success codes** |
> | `Target.Timeout` | No response within the timeout | Security group, or the app is too slow to answer |
> | `Target.FailedHealthChecks` | Connection refused / reset | Wrong **port**, app not listening on `0.0.0.0` |
> | `Target.NotInUse` | Target not in an enabled AZ / not registered | Subnet tags, controller config |
> | `Target.NotRegistered` | Not in the target group at all | TargetGroupBinding / controller reconciliation |
> | `Elb.InternalError` | ALB-side issue | Rare; check AWS Health |
>
> **Step 2 — The most likely culprit: the health-check path.** This is what the interview was driving at. The ALB's default health-check path is **`/`**. If the application only serves `/api/...` and returns **404 on `/`**, every target is marked unhealthy while the application is completely fine — which is *exactly* the symptom described: APIs work when called directly, targets show unhealthy.
>
> ```bash
> aws elbv2 describe-target-group-attributes --target-group-arn <arn>
> aws elbv2 describe-target-groups --target-group-arns <arn> \
>   --query 'TargetGroups[0].{Path:HealthCheckPath,Port:HealthCheckPort,Proto:HealthCheckProtocol,Codes:Matcher.HttpCode,Timeout:HealthCheckTimeoutSeconds,Interval:HealthCheckIntervalSeconds}'
> ```
> Then reproduce the ALB's *exact* request from inside the cluster:
> ```bash
> kubectl run curl --rm -it --image=curlimages/curl -- \
>   curl -v -o /dev/null -w '%{http_code}\n' http://10.0.12.45:8080/
> ```
> If that returns 404 or 302 while `/healthz` returns 200, the root cause is found. **Fix it in the Ingress, not the console:**
> ```yaml
> alb.ingress.kubernetes.io/healthcheck-path: /healthz
> alb.ingress.kubernetes.io/success-codes: '200'
> ```
>
> **The related traps in this same category:**
> - The health-check path requires **authentication** and returns **401/403** — health checks send no auth header. The health endpoint must be unauthenticated.
> - The app **redirects `/` to `/login`** returning **302**, and the matcher only accepts `200`. Either change the path or set `success-codes: '200,302'`.
> - The health path is served by a **different service** behind path-based routing, so the ALB hits a path that this target doesn't serve.
> - **Host-header based routing:** the app is a virtual host that only responds to `app.example.com`, but the ALB health check sends the target's **IP** as the Host header, so the app returns 404. Fix: `alb.ingress.kubernetes.io/healthcheck-*` plus a catch-all vhost, or configure the app to answer on any host.
>
> **Step 3 — Port mismatch.** Distinguish three ports that are easy to conflate: the **container port**, the **Service `targetPort`**, and the **health-check port**. In `target-type: ip` mode the ALB talks to the **pod IP on the container port** — so if the Service maps port 80 → targetPort 8080 and the health check is configured for port 80, it hits nothing.
> ```bash
> kubectl get svc <svc> -o yaml | grep -A5 ports
> kubectl get pod <pod> -o jsonpath='{.spec.containers[*].ports}'
> ```
> Also check the app binds `0.0.0.0`, not `127.0.0.1` — a common cause of "works with `kubectl exec ... localhost` but nothing external can reach it."
>
> **Step 4 — Security groups (the cause when the reason is `Target.Timeout`).** The ALB's security group must be allowed **inbound on the target port** by the **node/pod security group**. Concretely: node SG needs an inbound rule allowing the ALB SG on 8080 (and on the health-check port if different). The AWS Load Balancer Controller normally manages this automatically, but it breaks when someone hand-edits SGs, when the controller lacks IAM permission to modify them, or when `manage-backend-security-group-rules` is disabled.
> ```bash
> aws ec2 describe-security-groups --group-ids <node-sg> \
>   --query 'SecurityGroups[0].IpPermissions'
> ```
> With **security groups for pods** enabled, the pod's *own* SG must allow the ALB — checking only the node SG will mislead you.
>
> **Step 5 — Target registration and the controller.** Are the right IPs even registered?
> ```bash
> kubectl get targetgroupbindings -A
> kubectl describe targetgroupbinding <name> -n <ns>
> kubectl logs -n kube-system deploy/aws-load-balancer-controller --tail=100
> ```
> The controller logs are where you see reconciliation failures — missing IAM permissions, invalid annotations, subnets not tagged (`kubernetes.io/role/elb`), or the target group being modified out from under it.
>
> **Also check:** stale IPs. If pods were recreated and the controller failed to reconcile, the target group may hold IPs of pods that no longer exist — those will always be unhealthy. Compare `kubectl get pods -o wide` IPs against `describe-target-health`.
>
> **Step 6 — Timing and thresholds.** If the app takes 8 seconds to respond to `/health` (because the health check queries the DB) and the health-check timeout is 5 seconds, every check times out even though the app "works." Either make the health endpoint shallow and fast, or raise the timeout/interval. Similarly, if a pod takes 60s to warm up and the deregistration/registration timing is tight, targets flap between healthy and unhealthy. Check for **flapping** in the target health history — intermittent is a different problem than constant.
>
> **Step 7 — Readiness vs ALB health.** In `ip` target-type mode the controller only registers pods that are **Ready**. If pods show `1/1 Ready` but targets are unhealthy, that proves the readiness probe and the ALB health check are testing **different things** — which is itself the diagnostic. Compare them directly:
> ```bash
> kubectl get pod <pod> -o jsonpath='{.spec.containers[0].readinessProbe}' | jq
> aws elbv2 describe-target-groups --target-group-arns <arn> --query 'TargetGroups[0].HealthCheckPath'
> ```
> If readiness probes `/ready` and the ALB probes `/`, you've found the divergence.
>
> **Step 8 — Network path validation.** If everything above looks right, verify the path exists at all: **VPC Reachability Analyzer** from the ALB ENI to the pod IP on the target port, and **VPC Flow Logs** filtered to the pod IP and the health-check port — `REJECT` entries prove a security control is blocking; no entries at all mean the traffic isn't being routed there.
>
> **How I'd summarize the answer in the room:**
>
> > "Pods being healthy and targets being unhealthy is not a contradiction — they're two different checks. The pod's readiness probe is run by the kubelet against whatever path *I* configured in the manifest. The ALB health check is a separate HTTP request from the ALB's ENI, to a path and port and expected status code configured on the **target group**, subject to security groups on the way. So my first command is `describe-target-health` to read the **Reason** code, because it tells me which of those differs. In my experience the number one cause is exactly this: the health-check path is left at the default `/`, the app only serves `/api/*` and returns 404 on `/`, so the ALB marks every target unhealthy while the application is perfectly fine. Second most common is a security group not allowing the ALB SG on the target port, which shows as `Target.Timeout`. Third is a port mismatch between the container port and the configured health-check port. And once I find it, I fix it in the **Ingress annotation**, not the AWS Console — because the Load Balancer Controller will revert any console change on its next reconcile."

**Prevention checklist:**
- Every service exposes a dedicated, unauthenticated, fast `/healthz` that doesn't touch downstream dependencies.
- The health-check path is set explicitly in the Ingress annotation — never left at the default.
- Readiness probe path and ALB health-check path are deliberately aligned (or their difference is deliberate and documented).
- CloudWatch alarm on `UnHealthyHostCount > 0` so this is detected before users report it.
- The AWS Load Balancer Controller's logs are shipped to Loki and its errors are alerted on.

---

# Quick Revision Sheet

**Commands to have on the tip of your tongue:**
```bash
kubectl describe pod <pod>                 # events + container state — start every pod issue here
kubectl logs <pod> --previous              # the crashed instance's logs
kubectl get endpoints <svc>                # empty = no Ready pods = 503
kubectl get events --sort-by=.lastTimestamp
kubectl describe node <node> | grep -A8 "Allocated resources"
kubectl get targetgroupbindings -A
aws elbv2 describe-target-health --target-group-arn <arn>   # the Reason code
aws ec2 describe-instance-status --instance-ids <id> --include-all-instances
aws ec2 get-console-output --instance-id <id>
terraform plan -refresh-only               # drift without proposing changes
terraform plan -detailed-exitcode          # exit 2 = drift, for CI
```

**Distinctions to be able to state in one line each:**
- **Liveness vs readiness** — restarts the container vs removes it from load balancing.
- **Blue-Green vs Canary** — all traffic at one moment vs some traffic gradually.
- **ALB vs NLB** — L7 request routing vs L4 connection forwarding with static IPs.
- **Multi-AZ vs Read Replica** — availability (synchronous, not readable) vs read scaling (asynchronous, readable).
- **ELB 5xx vs Target 5xx** — the load balancer failed vs the application returned the error.
- **System vs Instance status check** — AWS's problem (stop/start) vs your OS's problem (reboot/investigate).
- **Voluntary vs involuntary disruption** — PDBs protect against the first only.
- **Pod readiness vs ALB target health** — two independent checks, often against different paths. *This is the L3 question.*

**Three things to say that signal seniority:**
1. Alert on **symptoms** (user-facing errors, latency) rather than **causes** (CPU) — and tie them to SLOs and error budgets.
2. Fix configuration in the **manifest or Terraform**, never in the console — because a reconciling controller or the next `apply` will revert it, and drift is the root of most "mystery" incidents.
3. For cattle, **replace don't debug** — restore service first with a snapshot for forensics, do root cause afterwards.
