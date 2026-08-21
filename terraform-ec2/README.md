# Terraform — EC2 instance in the default VPC (with a module)

A minimal but correct Terraform project: a root module that discovers the
**default VPC** and calls a reusable **child module** to create one EC2
instance and its security group.

Verified with Terraform **v1.5.7** and AWS provider **>= 5.0**: `fmt`,
`validate`, and a real `plan` against a live AWS account all pass.

---

## Layout

```
terraform-ec2/
├── main.tf                  # ROOT: provider, default-VPC lookup, module call
├── variables.tf             # ROOT inputs
├── outputs.tf               # ROOT outputs
├── terraform.tfvars.example # copy to terraform.tfvars and edit
├── .gitignore               # never commit state or *.tfvars
├── .terraform.lock.hcl      # provider checksums — DO commit this
└── modules/
    └── ec2/                 # the reusable module
        ├── main.tf          # SG + instance + AMI lookup
        ├── variables.tf     # the module's API
        └── outputs.tf       # what it returns
```

**Why split it this way?** The root module is *environment-specific* — it
knows the region, the account, which VPC to use. The child module is
*generic* — it knows how to build an EC2 instance and nothing about your
environment. That separation is what makes the module reusable across dev,
stage and prod, and across projects.

---

## Quick start

```bash
cd terraform-ec2

# credentials (any one of these)
export AWS_PROFILE=my-profile
# or: export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...

cp terraform.tfvars.example terraform.tfvars   # optional — defaults work

terraform init      # download the AWS provider, wire up ./modules/ec2
terraform fmt       # canonical formatting
terraform validate  # syntax + type checking (no AWS calls)
terraform plan      # show what WOULD happen — read this every time
terraform apply     # create it

terraform output    # instance id, public IP, ssh command, http url
terraform destroy   # tear it down (do this — it's a billable instance)
```

A real plan from this configuration creates exactly **4 resources**:

```
Plan: 4 to add, 0 to change, 0 to destroy.

  # module.web_server.aws_instance.this                        will be created
  # module.web_server.aws_security_group.this                  will be created
  # module.web_server.aws_vpc_security_group_egress_rule.all   will be created
  # module.web_server.aws_vpc_security_group_ingress_rule.http will be created
```

Note there is **no SSH rule** — `allowed_ssh_cidrs` defaults to `[]`, so the
`for_each` produces zero rules. Port 22 is closed unless you deliberately
open it.

After `apply`, wait ~60s for cloud-init and then:

```bash
curl "$(terraform output -raw http_url)"
# <h1>demo-dev-web</h1><p>Provisioned by Terraform on ip-172-31-x-x...</p>
```

---

## How the default-VPC lookup works

```hcl
data "aws_vpc" "default" {
  default = true                    # AWS marks exactly one VPC as default
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

locals {
  subnet_id = var.subnet_id != null ? var.subnet_id : sort(data.aws_subnets.default.ids)[0]
}
```

`data` blocks **read** existing infrastructure — they never create or change
anything. Every AWS region ships with a default VPC that already has an
internet gateway and one public subnet per AZ, which is why this project
needs no networking code at all.

**Why `sort()`?** The API can return subnet IDs in a different order between
runs. Without sorting, Terraform would see a different `subnet_id` and want
to **replace the instance** for no reason. Sorting makes the choice
deterministic.

Real resolved values from a `plan`:

```
vpc_id    = "vpc-04739f8a07695d154"
subnet_id = "subnet-0161d1384500876f4"
ami_id    = "ami-06a83a7a581c729a9"     # looked up, latest Amazon Linux 2023
```

> The default VPC is fine for a demo. For anything real, build a VPC with
> private subnets — default-VPC subnets are **public**, so instances there
> are internet-reachable by design.

---

## How the module call works

```hcl
module "web_server" {
  source = "./modules/ec2"        # local path

  name          = "${var.project}-${var.environment}-web"
  instance_type = var.instance_type
  vpc_id        = data.aws_vpc.default.id     # passed IN from the root
  subnet_id     = local.subnet_id
  tags          = { Role = "web" }
}
```

Then read values back out through its outputs:

```hcl
output "public_ip" {
  value = module.web_server.public_ip   # module.<NAME>.<OUTPUT>
}
```

**You can only access a module's `output` values** — not its internal
resources. `module.web_server.aws_instance.this.id` is an error. That
encapsulation is deliberate: outputs are the module's contract.

### Using a remote module instead

```hcl
module "web_server" {
  source = "git::https://github.com/org/tf-modules.git//ec2?ref=v1.2.0"
}

module "web_server" {
  source  = "terraform-aws-modules/ec2-instance/aws"
  version = "~> 5.6"          # ALWAYS pin remote modules
}
```

Without a pinned version, someone else's change breaks your next `apply`.

---

## Inputs

| Variable | Type | Default | Notes |
|---|---|---|---|
| `region` | string | `ap-south-1` | |
| `project` | string | `demo` | Used in names and tags |
| `environment` | string | `dev` | Validated: `dev`/`stage`/`prod` |
| `instance_type` | string | `t3.micro` | Free-tier eligible |
| `subnet_id` | string | `null` | `null` → first default-VPC subnet |
| `key_name` | string | `null` | `null` → no SSH key, use SSM |
| `allowed_ssh_cidrs` | list(string) | `[]` | **Rejects `0.0.0.0/0`** |
| `root_volume_size` | number | `8` | Validated: 8–100 GiB |

## Outputs

`instance_id`, `public_ip`, `private_ip`, `availability_zone`, `ami_id`,
`security_group_id`, `http_url`, `ssh_command`, plus `vpc_id`, `subnet_id`
and `available_subnets` so you can confirm what the lookups resolved to.

---

## The security choices, and why

| Choice | Reason |
|---|---|
| `http_tokens = "required"` | Forces **IMDSv2**. With IMDSv1, any SSRF bug in an app on the box can read the instance's IAM credentials from `169.254.169.254`. |
| `encrypted = true` on the root volume | Encryption at rest, no reason not to. |
| `gp3` not `gp2` | gp3 has no burst-credit cliff — gp2 silently throttles to baseline IOPS once credits run out. |
| SSH closed by default | `allowed_ssh_cidrs = []` opens nothing. |
| Validation rejecting `0.0.0.0/0` for SSH | Fails at plan time rather than becoming an incident. |
| `create_before_destroy` on the SG | Without it, changing the SG fails because the instance still references it. |
| Separate rule resources, not inline `ingress` | Inline blocks and `aws_vpc_security_group_*_rule` resources fight each other — Terraform deletes rules it doesn't know about. Pick one style. |
| No provider block in the module | A module must inherit its provider, or the caller can't control region/credentials and the module stops being reusable. |

Prefer **SSM Session Manager** over SSH: no open port, no key files, IAM-based
access, and every session logged to CloudTrail. It needs an instance profile
with `AmazonSSMManagedInstanceCore` — deliberately left out here to keep the
example minimal.

---

## Things worth knowing

**State contains secrets.** `terraform.tfstate` holds every attribute of
every resource in plain text. It's gitignored here. For team use, switch to
the S3 backend (commented in `main.tf`) with DynamoDB locking so two people
can't apply simultaneously.

**Commit `.terraform.lock.hcl`.** It pins provider checksums so everyone gets
identical versions. This one carries hashes for `darwin_arm64`, `linux_amd64`
and `linux_arm64`, so `terraform init` works on a Mac laptop *and* in Linux
CI:

```bash
terraform providers lock -platform=linux_amd64 -platform=darwin_arm64
```

**The AMI lookup is a trade-off.** `most_recent = true` means a new Amazon
Linux release changes the ID and Terraform will want to **replace** the
instance. Pin `ami_id` explicitly for production.

**`user_data_replace_on_change = true`** recreates the instance when the
bootstrap script changes. Without it you'd have a running box with stale
setup and no indication. Remove it if that trade isn't what you want.

**Always read the plan.** `Plan: 4 to add, 0 to change, 0 to destroy` — the
`destroy` count is the one to check before every apply.

---

## Useful commands

```bash
terraform fmt -recursive -check -diff   # CI-friendly format check
terraform validate                      # no AWS calls, no credentials needed
terraform plan -out=tfplan              # save a plan...
terraform apply tfplan                  # ...and apply exactly that
terraform plan -refresh-only            # detect DRIFT without proposing changes
terraform plan -detailed-exitcode       # exit 2 = changes pending (for CI)
terraform state list                    # what Terraform manages
terraform state show module.web_server.aws_instance.this
terraform output -raw public_ip
terraform graph | dot -Tsvg > graph.svg # dependency graph
terraform destroy                       # remember this — EC2 is billable
```

## Cost

`t3.micro` + 8 GiB gp3 is free-tier eligible for the first 12 months. Outside
free tier it's roughly **$8–10/month** in `ap-south-1`. `terraform destroy`
when you're done.
