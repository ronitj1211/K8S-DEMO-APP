# ===========================================================================
# ROOT MODULE
#
# Responsibilities of a root module:
#   1. configure the provider
#   2. discover / look up existing infrastructure (here: the default VPC)
#   3. call child modules, passing values in
#
# It should contain almost no resources of its own — the reusable logic
# lives in modules/ec2/.
# ===========================================================================

terraform {
  required_version = ">= 1.3"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }

  # Local state by default so this runs with no setup. For anything shared,
  # uncomment and use S3 + DynamoDB locking so two people can't apply at once.
  #
  # backend "s3" {
  #   bucket         = "my-tfstate-bucket"
  #   key            = "ec2-demo/terraform.tfstate"
  #   region         = "ap-south-1"
  #   dynamodb_table = "terraform-locks"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.region

  # Tags applied to every taggable resource, even ones created inside modules.
  # Far more reliable than remembering to tag each resource by hand.
  default_tags {
    tags = {
      Project     = var.project
      Environment = var.environment
      ManagedBy   = "terraform"
      Repo        = "k8s-demo-app/terraform-ec2"
    }
  }
}

# ---------------------------------------------------------------------------
# Look up the DEFAULT VPC instead of creating one.
#
# `data` blocks READ existing infrastructure — they never create or modify
# anything. Every AWS region ships with a default VPC containing a public
# subnet per AZ, which is why this demo needs no networking code at all.
# ---------------------------------------------------------------------------
data "aws_vpc" "default" {
  default = true
}

# All subnets in that VPC (one per availability zone).
data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

locals {
  # sort() makes the choice deterministic — without it the API's ordering can
  # vary between runs and Terraform would want to move the instance.
  # A default VPC's subnets are public (they route to an internet gateway),
  # which is why the instance is reachable.
  subnet_id = var.subnet_id != null ? var.subnet_id : sort(data.aws_subnets.default.ids)[0]
}

# ---------------------------------------------------------------------------
# Call the module.
#
# `source` is a local path here. In a real setup it would be a versioned Git
# ref or registry address, e.g.
#   source  = "git::https://github.com/org/tf-modules.git//ec2?ref=v1.2.0"
#   source  = "terraform-aws-modules/ec2-instance/aws"
#   version = "~> 5.6"
# Always pin a version for remote modules.
# ---------------------------------------------------------------------------
module "web_server" {
  source = "./modules/ec2"

  name          = "${var.project}-${var.environment}-web"
  instance_type = var.instance_type

  vpc_id    = data.aws_vpc.default.id
  subnet_id = local.subnet_id

  key_name          = var.key_name
  allowed_ssh_cidrs = var.allowed_ssh_cidrs
  root_volume_size  = var.root_volume_size

  tags = {
    Role = "web"
  }
}
