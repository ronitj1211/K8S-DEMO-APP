# AWS Load Balancer Controller — End-to-End on EKS

The AWS Load Balancer Controller (formerly "ALB Ingress Controller") watches Kubernetes `Ingress` resources and provisions **real AWS Application Load Balancers** for them. This is the production way to expose HTTP services from EKS to the internet or a VPC.

This doc covers the full flow: **empty AWS account → EKS cluster → controller installed → sample app fronted by an ALB → tested → cleaned up.**

> This is different from the ingress-nginx controller used in the local Colima demo ([RUN-STEPS.md](RUN-STEPS.md)). Nginx runs a Pod that proxies; the AWS controller **doesn't run a proxy** — it just creates an actual ALB in AWS and configures target groups. The ALB itself is the data plane.

---

## Table of contents

- [What is the AWS Load Balancer Controller?](#what-is-the-aws-load-balancer-controller)
- [How it works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Step 1: Create the EKS cluster](#step-1-create-the-eks-cluster)
- [Step 2: Associate an IAM OIDC provider with the cluster](#step-2-associate-an-iam-oidc-provider-with-the-cluster)
- [Step 3: Create the IAM policy for the controller](#step-3-create-the-iam-policy-for-the-controller)
- [Step 4: Create the IAM role + Kubernetes ServiceAccount (IRSA)](#step-4-create-the-iam-role--kubernetes-serviceaccount-irsa)
- [Step 5: Install the controller via Helm](#step-5-install-the-controller-via-helm)
- [Step 6: Deploy a sample app + Service](#step-6-deploy-a-sample-app--service)
- [Step 7: Create the Ingress with ALB annotations](#step-7-create-the-ingress-with-alb-annotations)
- [Step 8: Verify the ALB got provisioned](#step-8-verify-the-alb-got-provisioned)
- [Step 9: Add TLS with ACM (optional)](#step-9-add-tls-with-acm-optional)
- [Common annotations reference](#common-annotations-reference)
- [Troubleshooting](#troubleshooting)
- [Cleanup](#cleanup)

---

## What is the AWS Load Balancer Controller?

An in-cluster controller that watches:

- `Ingress` resources (ingress-class `alb`) — creates an **Application Load Balancer** (L7 HTTP/HTTPS).
- `Service` resources of type `LoadBalancer` with the `service.beta.kubernetes.io/aws-load-balancer-type: nlb` annotation — creates a **Network Load Balancer** (L4 TCP/UDP).

It **doesn't proxy traffic itself** — the ALB/NLB is the actual data plane. The controller just keeps AWS in sync with what your Kubernetes resources declare.

**Modes**:

- **`instance` mode** — target group targets are node IPs on the NodePort. Traffic goes ALB → node → kube-proxy → Pod. Standard for `Service.spec.type=LoadBalancer` on non-Fargate clusters.
- **`ip` mode** — target group targets are Pod IPs directly (requires the VPC CNI). Skips kube-proxy. Faster, more granular health checks. **Required for Fargate**. Recommended default for new setups.

**Why use it over ingress-nginx on EKS?**

| | ingress-nginx | AWS Load Balancer Controller |
|---|---|---|
| Data plane | Nginx Pod inside the cluster | AWS ALB outside the cluster |
| Extra hop | Yes (ALB or NLB → nginx → Pod) | No (ALB → Pod IP directly in `ip` mode) |
| TLS certs | Manual (cert-manager) | ACM integration is one annotation |
| WAF | Add-on | Native AWS WAF integration |
| Access logs | Nginx logs | ALB access logs to S3 |
| Sticky sessions | Nginx cookies | ALB target group stickiness |
| Cost | Nginx Pods (small) | ALB (~$16/mo) + LCU |

On EKS: **use the AWS controller unless you have a reason not to**. On non-EKS clusters or if you want cluster-portable manifests: ingress-nginx.

---

## How it works

```
┌─────────────────────────────────────────────────────────────────┐
│  1. You create an Ingress with ingressClassName: alb             │
│     kubectl apply -f my-ingress.yaml                             │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. AWS Load Balancer Controller Pod (running in kube-system)    │
│     watches the K8s API. Sees the new Ingress.                   │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. Controller assumes its IAM role via IRSA (OIDC → IAM)        │
│     Gets temporary AWS credentials.                              │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  4. Controller calls AWS APIs:                                   │
│     - elbv2 CreateLoadBalancer  (ALB)                            │
│     - elbv2 CreateTargetGroup   (per Ingress rule)               │
│     - elbv2 CreateListener      (:80 and/or :443)                │
│     - elbv2 CreateRule          (host + path routing)            │
│     - ec2 AuthorizeSecurityGroupIngress                          │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  5. Controller keeps Pod IPs (ip mode) or NodePorts (instance    │
│     mode) registered in the target groups by watching Endpoints. │
│     Pod comes up → registered as target. Pod dies → deregistered.│
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  6. Client hits the ALB's DNS name.                              │
│     ALB routes to healthy targets (Pod IPs).                     │
│     Traffic never touches the controller Pod.                    │
└─────────────────────────────────────────────────────────────────┘
```

The controller only sits in the control plane. Data-plane traffic goes **client → ALB → Pod IPs** with no in-cluster proxy.

---

## Prerequisites

- **AWS account** with permission to create EKS clusters, IAM roles, ALBs.
- **AWS CLI** installed and configured (`aws sts get-caller-identity`).
- **`kubectl`**, **`eksctl`**, **`helm`** installed locally.
  ```bash
  brew install awscli eksctl kubernetes-cli helm    # macOS
  ```
- **VPC**: `eksctl` creates one by default. Bring your own with `--vpc-*` flags if needed.

Placeholders throughout:
- `<REGION>` — e.g. `us-east-1`.
- `<ACCOUNT>` — 12-digit AWS account ID (`aws sts get-caller-identity --query Account --output text`).
- `<CLUSTER>` — your EKS cluster name (e.g. `demo-cluster`).

---

## Step 1: Create the EKS cluster

For a demo:

```bash
eksctl create cluster \
  --name <CLUSTER> \
  --region <REGION> \
  --version 1.30 \
  --nodegroup-name workers \
  --node-type t3.medium \
  --nodes 2 \
  --nodes-min 1 \
  --nodes-max 3 \
  --managed
```

Takes ~15 min. When done:

```bash
aws eks update-kubeconfig --name <CLUSTER> --region <REGION>
kubectl get nodes            # should list 2 nodes
```

**Alternative — Fargate profile** (serverless):
```bash
eksctl create fargateprofile --cluster <CLUSTER> --region <REGION> \
  --name default --namespace default
```
With Fargate you **must** use `ip` mode (below) because there are no worker-node IPs to target.

---

## Step 2: Associate an IAM OIDC provider with the cluster

Enables IAM Roles for Service Accounts (IRSA) — Pods assume IAM roles via K8s ServiceAccounts.

```bash
eksctl utils associate-iam-oidc-provider \
  --cluster <CLUSTER> \
  --region <REGION> \
  --approve
```

Verify:
```bash
aws eks describe-cluster --name <CLUSTER> --region <REGION> \
  --query "cluster.identity.oidc.issuer" --output text
```
Returns a URL like `https://oidc.eks.us-east-1.amazonaws.com/id/ABCD1234...`. That's the OIDC issuer for this cluster.

Then check IAM registered it:
```bash
OIDC_ID=$(aws eks describe-cluster --name <CLUSTER> --region <REGION> \
  --query "cluster.identity.oidc.issuer" --output text | sed 's|.*/||')
aws iam list-open-id-connect-providers | grep $OIDC_ID
```

Should return one match.

---

## Step 3: Create the IAM policy for the controller

The controller needs permissions to manage ALBs/NLBs, target groups, security groups, etc. AWS publishes the exact policy JSON. Download and create it:

```bash
curl -o iam-policy.json https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v2.8.0/docs/install/iam_policy.json

aws iam create-policy \
  --policy-name AWSLoadBalancerControllerIAMPolicy \
  --policy-document file://iam-policy.json
```

Note the ARN:
```
arn:aws:iam::<ACCOUNT>:policy/AWSLoadBalancerControllerIAMPolicy
```

> **Pin the version.** `v2.8.0` above is example. Check the [releases page](https://github.com/kubernetes-sigs/aws-load-balancer-controller/releases) for the latest and update both this URL and the Helm chart version in Step 5 together. Policy JSON evolves per release.

---

## Step 4: Create the IAM role + Kubernetes ServiceAccount (IRSA)

The magic that lets the controller Pod authenticate to AWS without keys:

```bash
eksctl create iamserviceaccount \
  --cluster=<CLUSTER> \
  --region=<REGION> \
  --namespace=kube-system \
  --name=aws-load-balancer-controller \
  --role-name=AmazonEKSLoadBalancerControllerRole \
  --attach-policy-arn=arn:aws:iam::<ACCOUNT>:policy/AWSLoadBalancerControllerIAMPolicy \
  --approve
```

What `eksctl` did behind the scenes:
1. Created IAM role `AmazonEKSLoadBalancerControllerRole` with a trust policy tied to your cluster's OIDC provider + the specific ServiceAccount `system:serviceaccount:kube-system:aws-load-balancer-controller`.
2. Attached the policy from Step 3.
3. Created a K8s ServiceAccount `aws-load-balancer-controller` in `kube-system` with the annotation `eks.amazonaws.com/role-arn: <role-arn>` pointing at the IAM role.

Verify:
```bash
kubectl get sa aws-load-balancer-controller -n kube-system -o yaml
# annotations should include eks.amazonaws.com/role-arn: arn:...
```

---

## Step 5: Install the controller via Helm

```bash
helm repo add eks https://aws.github.io/eks-charts
helm repo update eks

helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName=<CLUSTER> \
  --set serviceAccount.create=false \
  --set serviceAccount.name=aws-load-balancer-controller \
  --set region=<REGION> \
  --version 1.8.1        # matches the v2.8.x controller
```

Key flags:
- `serviceAccount.create=false` — we already created the SA via `eksctl` in Step 4. If you set this to `true`, the chart would try to create a new SA without the IRSA annotation.
- `clusterName` — the controller uses this in AWS resource tags to identify which cluster owns which ALB.

Wait for it to be ready:
```bash
kubectl -n kube-system rollout status deployment/aws-load-balancer-controller
kubectl -n kube-system get pods -l app.kubernetes.io/name=aws-load-balancer-controller
```

Two Pods should be `Running 1/1`. If any is `CrashLoopBackOff`, jump to [Troubleshooting](#troubleshooting).

---

## Step 6: Deploy a sample app + Service

Reuse the demo backend from this folder:

```yaml
# backend.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend
spec:
  replicas: 2
  selector: { matchLabels: { app: backend } }
  template:
    metadata: { labels: { app: backend } }
    spec:
      containers:
        - name: backend
          image: k8s-demo-backend:1.0        # push to ECR first
          imagePullPolicy: IfNotPresent
          ports: [{ containerPort: 3000 }]
          readinessProbe:
            httpGet: { path: /health, port: 3000 }
---
apiVersion: v1
kind: Service
metadata:
  name: backend
spec:
  type: ClusterIP                            # ALB targets Pods directly in ip mode
  selector: { app: backend }
  ports:
    - port: 80
      targetPort: 3000
```

```bash
kubectl apply -f backend.yaml
kubectl rollout status deployment/backend
```

> The Service is `ClusterIP` — no NodePort, no LoadBalancer. In `ip` mode the ALB registers Pod IPs directly and doesn't need the Service to expose ports on nodes. The Service still exists so the controller can look up which Pods to target via Endpoints.

---

## Step 7: Create the Ingress with ALB annotations

This is the meat. Annotations tell the controller *how* to shape the ALB:

```yaml
# ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: backend-ingress
  annotations:
    # ALB scheme: internet-facing or internal (VPC-only)
    alb.ingress.kubernetes.io/scheme: internet-facing

    # Target type: 'ip' = direct Pod IP targets (required for Fargate)
    #              'instance' = NodePort on worker nodes
    alb.ingress.kubernetes.io/target-type: ip

    # Listener config: only :80 for the demo (add 443 for TLS — see Step 9)
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP": 80}]'

    # Health check path (optional — defaults to /)
    alb.ingress.kubernetes.io/healthcheck-path: /health
    alb.ingress.kubernetes.io/healthcheck-interval-seconds: '15'
    alb.ingress.kubernetes.io/healthcheck-timeout-seconds: '5'
    alb.ingress.kubernetes.io/success-codes: '200'
spec:
  ingressClassName: alb                       # <-- picks the AWS controller
  rules:
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: backend
                port:
                  number: 80
```

Apply:
```bash
kubectl apply -f ingress.yaml
kubectl get ingress backend-ingress -w
```

You'll see `ADDRESS` populate within ~2 minutes with the ALB's DNS name:
```
NAME              CLASS   HOSTS   ADDRESS                                                   PORTS
backend-ingress   alb     *       k8s-default-backendi-abc-1234567890.us-east-1.elb.amazonaws.com   80
```

---

## Step 8: Verify the ALB got provisioned

**From `kubectl`:**
```bash
kubectl describe ingress backend-ingress
# Events section should show: SuccessfullyReconciled
```

**From AWS CLI:**
```bash
aws elbv2 describe-load-balancers --region <REGION> \
  --query 'LoadBalancers[?contains(LoadBalancerName, `k8s-`)]' | jq
```

**Test the endpoint:**
```bash
ALB_DNS=$(kubectl get ingress backend-ingress -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')

# Wait until DNS resolves and target group has healthy targets (~60-120s)
for i in {1..30}; do
  if curl -sf "http://$ALB_DNS/" >/dev/null; then
    echo "ALB is live"
    curl -s "http://$ALB_DNS/" | head
    break
  fi
  echo "waiting for ALB ($i)..."
  sleep 5
done
```

**Confirm target group has healthy targets:**
```bash
TG_ARN=$(aws elbv2 describe-target-groups --region <REGION> \
  --query 'TargetGroups[?contains(TargetGroupName, `k8s-`)].TargetGroupArn | [0]' --output text)

aws elbv2 describe-target-health --target-group-arn $TG_ARN --region <REGION> \
  --query 'TargetHealthDescriptions[].{IP:Target.Id,Port:Target.Port,State:TargetHealth.State}'
```

You should see one entry per Pod, all `State: healthy`.

---

## Step 9: Add TLS with ACM (optional)

Request a cert in ACM (must be in the same region as the ALB), then add these annotations to the Ingress:

```yaml
annotations:
  alb.ingress.kubernetes.io/scheme: internet-facing
  alb.ingress.kubernetes.io/target-type: ip
  alb.ingress.kubernetes.io/listen-ports: '[{"HTTP": 80}, {"HTTPS": 443}]'
  alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:us-east-1:<ACCOUNT>:certificate/abc-123...
  alb.ingress.kubernetes.io/ssl-policy: ELBSecurityPolicy-TLS-1-2-2017-01

  # Auto-redirect HTTP -> HTTPS via the ALB itself:
  alb.ingress.kubernetes.io/actions.ssl-redirect: '{"Type":"redirect","RedirectConfig":{"Protocol":"HTTPS","Port":"443","StatusCode":"HTTP_301"}}'
  alb.ingress.kubernetes.io/ssl-redirect: '443'
spec:
  ingressClassName: alb
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: backend
                port: { number: 80 }
```

The `alb.ingress.kubernetes.io/actions.ssl-redirect` + `ssl-redirect: '443'` combo is the ALB-native way to force HTTPS — no nginx-style rewrite needed. Point your DNS `api.example.com` at the ALB (either CNAME or Route 53 alias record) and you're TLS-enabled.

Alternative: **cert-manager + Let's Encrypt** works too, but ACM certs are free, auto-renew, and don't need cert-manager running. Use ACM unless you have a specific reason.

---

## Common annotations reference

Annotations live on the `Ingress` (mostly) or `Service` (for NLB). Full list: [official docs](https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/ingress/annotations/).

| Annotation | Values | What it does |
|---|---|---|
| `alb.ingress.kubernetes.io/scheme` | `internet-facing` / `internal` | Public ALB vs VPC-internal |
| `alb.ingress.kubernetes.io/target-type` | `ip` / `instance` | Pod IPs (recommended) vs node NodePort |
| `alb.ingress.kubernetes.io/listen-ports` | JSON list | Which ports/protocols the ALB listens on |
| `alb.ingress.kubernetes.io/certificate-arn` | ACM cert ARN | TLS certificate |
| `alb.ingress.kubernetes.io/ssl-policy` | `ELBSecurityPolicy-*` | TLS cipher suite |
| `alb.ingress.kubernetes.io/subnets` | Subnet ID list | Which subnets to place the ALB in (auto-discovered if omitted) |
| `alb.ingress.kubernetes.io/security-groups` | SG ID list | Extra security groups |
| `alb.ingress.kubernetes.io/wafv2-acl-arn` | WAFv2 ACL ARN | Attach an AWS WAF web ACL |
| `alb.ingress.kubernetes.io/shield-advanced-protection` | `true` / `false` | Enable AWS Shield Advanced |
| `alb.ingress.kubernetes.io/healthcheck-path` | path string | Target group health check path |
| `alb.ingress.kubernetes.io/healthcheck-port` | port or `traffic-port` | Health check port |
| `alb.ingress.kubernetes.io/success-codes` | e.g. `200,301` | HTTP codes considered healthy |
| `alb.ingress.kubernetes.io/target-group-attributes` | `deregistration_delay.timeout_seconds=30` etc. | ALB target group settings |
| `alb.ingress.kubernetes.io/load-balancer-attributes` | `access_logs.s3.enabled=true`, `idle_timeout.timeout_seconds=60` | ALB-level settings |
| `alb.ingress.kubernetes.io/group.name` | any string | **Share one ALB across multiple Ingress resources** — huge cost saver |
| `alb.ingress.kubernetes.io/group.order` | integer | When sharing, controls rule priority |
| `alb.ingress.kubernetes.io/actions.<action-name>` | JSON | Define custom listener actions (redirects, fixed responses) |
| `alb.ingress.kubernetes.io/conditions.<service-name>` | JSON | Match based on host/path/headers/query/source-IP |

### Sharing one ALB across many Ingresses

Every Ingress by default gets its own ALB (~$16/mo). To share:

```yaml
# ingress-a.yaml
metadata:
  annotations:
    alb.ingress.kubernetes.io/group.name: my-team
    alb.ingress.kubernetes.io/group.order: '10'
spec:
  ingressClassName: alb
  rules:
    - host: api.example.com
      ...

# ingress-b.yaml
metadata:
  annotations:
    alb.ingress.kubernetes.io/group.name: my-team    # same group
    alb.ingress.kubernetes.io/group.order: '20'
spec:
  ingressClassName: alb
  rules:
    - host: admin.example.com
      ...
```

Both resolve to one ALB with two rules. Add more Ingresses to the same group as your app portfolio grows.

---

## Troubleshooting

### Controller Pod is CrashLoopBackOff

```bash
kubectl logs -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller --tail=100
```

Common causes:
- **IAM role not assumed** — `WebIdentityErr: failed to retrieve credentials`. Check the SA annotation `eks.amazonaws.com/role-arn` and the trust policy on the IAM role includes this cluster's OIDC provider.
- **Missing permissions** — controller can't call `ec2:DescribeSubnets` etc. Reattach the IAM policy from Step 3.
- **`clusterName` mismatch** — chart was installed with wrong `--set clusterName=`. Reinstall.

### Ingress created but no ALB appears

```bash
kubectl describe ingress <name>
# look at Events section
```

- `FailedDeployModel: no subnets found` — controller can't find subnets. Tag your public subnets:
  ```bash
  aws ec2 create-tags --resources <SUBNET_ID> \
    --tags Key=kubernetes.io/role/elb,Value=1 Key=kubernetes.io/cluster/<CLUSTER>,Value=shared
  ```
  Internal subnets: use `kubernetes.io/role/internal-elb=1`.

- `FailedBuildModel: cannot find matching subnets` — same fix.

- `FailedBuildModel: at least 2 subnets in different AZs` — ALBs require ≥2 subnets in different Availability Zones. Add a subnet in another AZ.

### `ADDRESS` on Ingress stays empty

Give it 60-120s on first deploy. If still empty:
- Controller Pod logs show what it's stuck on.
- Confirm the Ingress has `ingressClassName: alb` (not `nginx` or none).
- `kubectl get ingressclass alb` — must exist. If not, reinstall the controller or check `--set enableIngressClass=true` on the Helm install.

### ALB exists but returns 502 / 504

- Target group has no healthy targets. Check:
  ```bash
  aws elbv2 describe-target-health --target-group-arn <TG_ARN>
  ```
- Health check path / port mismatch. `alb.ingress.kubernetes.io/healthcheck-path` should match a real endpoint (`/health`) that returns 200 quickly.
- Security group doesn't allow ALB → Pod IP on the container port. Controller usually manages this automatically; if you're using strict egress rules or custom SGs, add ingress from the ALB's SG to the Pod SG on port 3000.

### `Access denied` when controller tries to create ALB

The IAM role's inline policy is missing a permission. Either:
- Redownload the [latest iam-policy.json](https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/main/docs/install/iam_policy.json) and update the policy.
- Match the policy version to your controller version (they evolve in lockstep).

### Multiple Ingresses got separate ALBs — I wanted one

You didn't set `alb.ingress.kubernetes.io/group.name` on both. Add it. Existing ALBs won't auto-merge — delete the old Ingresses and reapply with the group annotation.

### Rolling deploys briefly serve 5xx

- Add `alb.ingress.kubernetes.io/target-group-attributes: deregistration_delay.timeout_seconds=30` — default is 300s, which delays graceful drain.
- Set your app's readiness probe correctly so ECS/ALB stops sending traffic before SIGTERM.
- Add pod `preStop` sleep: `lifecycle: { preStop: { exec: { command: ["sleep", "10"] } } }` — gives the ALB time to notice the pod is going away.

---

## Cleanup

Order matters — delete Ingress **before** the cluster, or the ALB will be orphaned:

```bash
# 1. Delete workloads (this deletes ALBs the controller manages)
kubectl delete ingress backend-ingress
kubectl delete -f backend.yaml

# 2. Wait for the ALB to actually go away
aws elbv2 describe-load-balancers --region <REGION> \
  --query "LoadBalancers[?contains(LoadBalancerName, 'k8s-')]"

# 3. Uninstall the controller
helm uninstall aws-load-balancer-controller -n kube-system

# 4. Delete IRSA (removes IAM role + K8s SA)
eksctl delete iamserviceaccount \
  --cluster=<CLUSTER> --region=<REGION> \
  --namespace=kube-system --name=aws-load-balancer-controller

# 5. Delete the IAM policy
aws iam delete-policy \
  --policy-arn arn:aws:iam::<ACCOUNT>:policy/AWSLoadBalancerControllerIAMPolicy

# 6. Delete the cluster (takes ~10 min)
eksctl delete cluster --name <CLUSTER> --region <REGION>
```

Leaving the IAM OIDC provider is fine — no cost, reusable for future clusters in the same account.

---

## Summary

The end-to-end flow:

```
[Prereqs] AWS CLI / eksctl / helm / kubectl
   ↓
[1] eksctl create cluster                      → EKS cluster
   ↓
[2] eksctl utils associate-iam-oidc-provider   → OIDC provider registered in IAM
   ↓
[3] aws iam create-policy iam-policy.json      → IAM policy for the controller
   ↓
[4] eksctl create iamserviceaccount            → IAM role + K8s SA linked via IRSA
   ↓
[5] helm install aws-load-balancer-controller  → controller Pods running in kube-system
   ↓
[6] kubectl apply -f backend.yaml              → sample app running as Pods
   ↓
[7] kubectl apply -f ingress.yaml              → Ingress with alb annotations
   ↓
[8] wait ~2 min                                 → controller creates ALB
   ↓
[9] curl http://<ALB_DNS>/                     → traffic flows through the ALB
   ↓
[optional] add ACM cert                        → HTTPS with 2 more annotations
   ↓
[cleanup] delete Ingress → cluster              → all resources removed
```

Once the controller is installed, adding new services is just: write an Ingress with the right annotations and `kubectl apply`. The controller handles everything else.
