# ---------------------------------------------------------------------------
# EC2 module — one instance plus its security group.
#
# NOTE: there is deliberately NO provider block here. A module inherits the
# provider from whoever calls it. Declaring a provider inside a module makes
# it un-reusable (the caller can no longer control region or credentials).
# ---------------------------------------------------------------------------

terraform {
  required_version = ">= 1.3"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

# ---------------------------------------------------------------------------
# AMI lookup — only runs when the caller didn't pin an explicit AMI.
#
# `count` on a data source is how you make a lookup conditional. The result
# is a list, so it's referenced as data.aws_ami.al2023[0].id
# ---------------------------------------------------------------------------
data "aws_ami" "al2023" {
  count = var.ami_id == null ? 1 : 0

  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-kernel-6.1-x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

locals {
  ami_id = var.ami_id != null ? var.ami_id : data.aws_ami.al2023[0].id

  # Default user_data: a tiny nginx page, so `curl <public_ip>` proves the
  # instance, security group and routing all work.
  default_user_data = <<-BASH
    #!/bin/bash
    set -euo pipefail
    dnf update -y
    dnf install -y nginx
    echo "<h1>${var.name}</h1><p>Provisioned by Terraform on $(hostname -f)</p>" \
      > /usr/share/nginx/html/index.html
    systemctl enable --now nginx
  BASH

  user_data = var.user_data != null ? var.user_data : local.default_user_data
}

# ---------------------------------------------------------------------------
# Security group
# ---------------------------------------------------------------------------
resource "aws_security_group" "this" {
  name        = "${var.name}-sg"
  description = "Security group for ${var.name}"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, { Name = "${var.name}-sg" })

  # Lets Terraform build the replacement SG before destroying the old one.
  # Without this, changing the SG fails because the instance still uses it.
  lifecycle {
    create_before_destroy = true
  }
}

# Rules are separate resources rather than inline `ingress` blocks.
# Inline blocks and aws_vpc_security_group_*_rule resources FIGHT each other:
# Terraform deletes any rule it doesn't know about. Pick one style and stay
# consistent — separate resources are more flexible.
resource "aws_vpc_security_group_ingress_rule" "ssh" {
  for_each = toset(var.allowed_ssh_cidrs)

  security_group_id = aws_security_group.this.id
  description       = "SSH from ${each.value}"
  cidr_ipv4         = each.value
  from_port         = 22
  to_port           = 22
  ip_protocol       = "tcp"

  tags = merge(var.tags, { Name = "${var.name}-ssh" })
}

resource "aws_vpc_security_group_ingress_rule" "http" {
  count = var.enable_http ? 1 : 0

  security_group_id = aws_security_group.this.id
  description       = "HTTP from anywhere (demo page)"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"

  tags = merge(var.tags, { Name = "${var.name}-http" })
}

# Egress must be declared explicitly. An SG with no egress rule blocks ALL
# outbound traffic, so the instance couldn't even install nginx.
resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.this.id
  description       = "All outbound"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1" # -1 = every protocol and port

  tags = merge(var.tags, { Name = "${var.name}-egress" })
}

# ---------------------------------------------------------------------------
# The instance
# ---------------------------------------------------------------------------
resource "aws_instance" "this" {
  ami                    = local.ami_id
  instance_type          = var.instance_type
  subnet_id              = var.subnet_id
  vpc_security_group_ids = [aws_security_group.this.id]
  key_name               = var.key_name

  associate_public_ip_address = var.associate_public_ip

  user_data = local.user_data
  # Replace the instance when user_data changes, instead of silently leaving
  # a running box with stale bootstrap. Drop this if you'd rather not have
  # user_data edits recreate the instance.
  user_data_replace_on_change = true

  # Force IMDSv2. IMDSv1 lets any SSRF bug in an app on this box read the
  # instance's IAM credentials from 169.254.169.254 — IMDSv2's token
  # requirement blocks that.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type           = "gp3" # gp3 has no burst-credit cliff, unlike gp2
    volume_size           = var.root_volume_size
    encrypted             = true
    delete_on_termination = true

    tags = merge(var.tags, { Name = "${var.name}-root" })
  }

  tags = merge(var.tags, { Name = var.name })
}
