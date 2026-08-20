# Cloud identity federation — IRSA, Workload Identity, Azure WI

The pattern: **a Kubernetes ServiceAccount token is exchanged for cloud credentials**, so no cloud key ever exists in the cluster.

---

## The problem it solves

A Pod needs to read an S3 bucket. The bad options:

| Approach | Why it's bad |
|---|---|
| Access keys in a Secret | Long-lived credential, in etcd, readable by anyone with `get secrets`, rotated manually (i.e. never) |
| Access keys in env vars | Same, plus visible in `kubectl describe pod` and every crash dump |
| Node IAM instance profile | **Every Pod on the node** inherits it. No per-workload separation, so the node role becomes the union of everything any Pod needs |

**IRSA** replaces all three: the Pod proves its Kubernetes identity, AWS verifies that proof against the cluster's public OIDC endpoint, and hands back **temporary** credentials scoped to one role.

---

## AWS IRSA — the full flow

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │ SETUP (once per cluster)                                             │
 │  1. EKS publishes an OIDC discovery document:                        │
 │     https://oidc.eks.<region>.amazonaws.com/id/<CLUSTER_ID>          │
 │     .well-known/openid-configuration  +  /keys  (public JWKS)        │
 │  2. You register that URL as an IAM OIDC Identity Provider           │
 │     -> AWS now TRUSTS tokens signed by this cluster                  │
 └──────────────────────────────────────────────────────────────────────┘

 ┌──────────────────────────────────────────────────────────────────────┐
 │ SETUP (once per workload)                                            │
 │  3. Create an IAM role whose TRUST POLICY names exactly one          │
 │     namespace/serviceaccount pair                                    │
 │  4. Annotate the ServiceAccount with that role's ARN                 │
 └──────────────────────────────────────────────────────────────────────┘

 ┌──────────────────────────────────────────────────────────────────────┐
 │ RUNTIME (every Pod start)                                            │
 │  5. Pod Identity Webhook sees the annotation, MUTATES the Pod:       │
 │       env AWS_ROLE_ARN, AWS_WEB_IDENTITY_TOKEN_FILE                  │
 │       + projected token volume, audience sts.amazonaws.com           │
 │  6. AWS SDK finds those env vars automatically                       │
 │  7. SDK calls sts:AssumeRoleWithWebIdentity(token, role)             │
 │  8. STS fetches the cluster's PUBLIC JWKS, verifies the signature,   │
 │     then checks the trust policy:  sub == the exact SA?  aud == sts? │
 │  9. STS returns temporary creds (~1h), SDK refreshes them itself     │
 └──────────────────────────────────────────────────────────────────────┘
```

**Nothing secret is transmitted.** STS verifies a *signature* using the cluster's *public* keys — which is why the OIDC endpoint must be publicly reachable, and why no AWS key needs to live in the cluster.

### Kubernetes side — one annotation

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: s3-reader
  namespace: identity
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/eks-s3-reader
```

Then just `serviceAccountName: s3-reader` on the Pod. See [manifests/60-irsa-eks.yaml](manifests/60-irsa-eks.yaml).

### AWS side — the trust policy is the security boundary

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::123456789012:oidc-provider/oidc.eks.ap-south-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "oidc.eks.ap-south-1.amazonaws.com/id/EXAMPLE:sub": "system:serviceaccount:identity:s3-reader",
        "oidc.eks.ap-south-1.amazonaws.com/id/EXAMPLE:aud": "sts.amazonaws.com"
      }
    }
  }]
}
```

> **Use `StringEquals` on `:sub`, never `StringLike` with a wildcard.** A condition like `system:serviceaccount:*:*` lets **any** ServiceAccount in the cluster assume the role — the single most common IRSA misconfiguration. Always pin both the namespace and the SA name, and always constrain `:aud`.

### Terraform

```hcl
data "aws_iam_policy_document" "irsa_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [module.eks.oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${module.eks.oidc_provider}:sub"
      values   = ["system:serviceaccount:identity:s3-reader"]
    }
    condition {
      test     = "StringEquals"
      variable = "${module.eks.oidc_provider}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "s3_reader" {
  name               = "eks-s3-reader"
  assume_role_policy = data.aws_iam_policy_document.irsa_trust.json
}

resource "aws_iam_role_policy" "s3_read" {
  role   = aws_iam_role.s3_reader.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:ListBucket"]
      Resource = ["arn:aws:s3:::my-bucket", "arn:aws:s3:::my-bucket/*"]
    }]
  })
}
```

### Debugging IRSA

```bash
# 1. did the webhook mutate the Pod? (no env vars = annotation wrong or webhook down)
kubectl describe pod <pod> -n identity | grep -A3 AWS_

# 2. is the token there, with the right audience?
kubectl exec -n identity <pod> -- \
  cat /var/run/secrets/eks.amazonaws.com/serviceaccount/token \
  | cut -d. -f2 | base64 -d | python3 -m json.tool     # aud must be sts.amazonaws.com

# 3. what identity does AWS think we are?
kubectl exec -n identity <pod> -- aws sts get-caller-identity

# 4. is the OIDC provider registered?
aws iam list-open-id-connect-providers
```

| Error | Cause |
|---|---|
| `WebIdentityErr: no such host` | Pod has no egress to STS — needs NAT or an STS VPC endpoint |
| `AccessDenied: Not authorized to perform sts:AssumeRoleWithWebIdentity` | Trust policy `sub` doesn't match this exact namespace/SA |
| `InvalidIdentityToken` | OIDC provider not registered, or thumbprint stale |
| No `AWS_*` env vars in the Pod | Annotation typo, or the Pod predates the annotation — recreate it |
| Credentials expire and aren't refreshed | Very old SDK; upgrade so it re-reads the token file |

---

## EKS Pod Identity — the newer AWS option (2023+)

| | IRSA | EKS Pod Identity |
|---|---|---|
| Trust configured on | the IAM **role's** trust policy | a **PodIdentityAssociation** in EKS |
| Needs an OIDC provider | **yes**, per cluster | no |
| Cross-account | yes | yes |
| Works outside EKS | yes (any OIDC-capable cluster) | EKS only |
| Setup effort | higher (OIDC + per-role trust policies) | lower (one API call per association) |
| Role reuse across clusters | awkward — trust policy names the issuer | easy |

```bash
aws eks create-pod-identity-association \
  --cluster-name my-cluster \
  --namespace identity \
  --service-account s3-reader \
  --role-arn arn:aws:iam::123456789012:role/eks-s3-reader
```

With Pod Identity the SA needs **no annotation** — the association is the link. For new clusters it's the simpler choice; IRSA remains correct for non-EKS clusters and for setups already built on it.

---

## GKE Workload Identity

Same idea, Google's plumbing:

```bash
# 1. bind the Google service account to the Kubernetes SA
gcloud iam service-accounts add-iam-policy-binding \
  gsa-name@PROJECT.iam.gserviceaccount.com \
  --role roles/iam.workloadIdentityUser \
  --member "serviceAccount:PROJECT.svc.id.goog[identity/s3-reader]"
```

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: s3-reader
  namespace: identity
  annotations:
    iam.gke.io/gcp-service-account: gsa-name@PROJECT.iam.gserviceaccount.com
```

The `PROJECT.svc.id.goog[namespace/ksa]` string is the identity format — note the namespace is inside the brackets.

## Azure Workload Identity

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: s3-reader
  namespace: identity
  annotations:
    azure.workload.identity/client-id: <APP_REGISTRATION_CLIENT_ID>
---
# the Pod must also carry a label, unlike AWS/GCP
apiVersion: v1
kind: Pod
metadata:
  labels:
    azure.workload.identity/use: "true"     # <-- required
spec:
  serviceAccountName: s3-reader
```

Azure uses a **federated identity credential** on the app registration, naming the cluster's OIDC issuer plus `system:serviceaccount:identity:s3-reader`.

---

## All three side by side

| | AWS IRSA | GKE WI | Azure WI |
|---|---|---|---|
| SA annotation | `eks.amazonaws.com/role-arn` | `iam.gke.io/gcp-service-account` | `azure.workload.identity/client-id` |
| Pod label needed | no | no | **yes** |
| Cloud-side trust | IAM role trust policy | `roles/iam.workloadIdentityUser` binding | federated identity credential |
| Token audience | `sts.amazonaws.com` | `PROJECT.svc.id.goog` | `api://AzureADTokenExchange` |
| Injected by | Pod Identity Webhook | GKE metadata server | Azure WI mutating webhook |

**The shared shape:** the cluster publishes a public OIDC endpoint; the cloud registers it as a trusted issuer; a policy pins one `namespace/serviceaccount`; the Pod's projected token is exchanged for short-lived cloud credentials. Learn it once and all three read the same.
