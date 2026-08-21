# ---------------------------------------------------------------------------
# Module inputs.
#
# A module's variables are its API. Anything the caller might reasonably want
# to change belongs here; anything that should never vary stays hardcoded in
# main.tf. Every variable gets a type and a description — that is what makes
# `terraform-docs` and editor autocomplete useful.
# ---------------------------------------------------------------------------

variable "name" {
  description = "Name prefix for the instance and its security group."
  type        = string

  validation {
    condition     = can(regex("^[a-zA-Z0-9-]+$", var.name))
    error_message = "name must contain only letters, numbers and hyphens."
  }
}

variable "vpc_id" {
  description = "VPC to create the security group in. Passed in by the caller."
  type        = string
}

variable "subnet_id" {
  description = "Subnet to launch the instance in."
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type. t3.micro is free-tier eligible."
  type        = string
  default     = "t3.micro"
}

variable "ami_id" {
  description = <<-EOT
    AMI to use. Leave null to look up the latest Amazon Linux 2023 for the
    region automatically.

    Pinning an explicit AMI is better for production: with the data-source
    lookup, a new Amazon release changes the ID and Terraform will want to
    REPLACE the instance.
  EOT
  type        = string
  default     = null
}

variable "key_name" {
  description = "Existing EC2 key pair name for SSH. Leave null for no key (use SSM instead)."
  type        = string
  default     = null
}

variable "allowed_ssh_cidrs" {
  description = <<-EOT
    CIDRs allowed to reach port 22. Empty list = no SSH rule at all,
    which is the right default — use SSM Session Manager instead.

    Never put 0.0.0.0/0 here.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = !contains(var.allowed_ssh_cidrs, "0.0.0.0/0")
    error_message = "Refusing 0.0.0.0/0 for SSH. Use your own IP/32 or SSM Session Manager."
  }
}

variable "associate_public_ip" {
  description = "Give the instance a public IP. Needed in a default (public) subnet to reach it."
  type        = bool
  default     = true
}

variable "root_volume_size" {
  description = "Root EBS volume size in GiB."
  type        = number
  default     = 8

  validation {
    condition     = var.root_volume_size >= 8 && var.root_volume_size <= 100
    error_message = "root_volume_size must be between 8 and 100 GiB."
  }
}

variable "user_data" {
  description = "Shell script to run on first boot. Leave null to install nginx as a demo."
  type        = string
  default     = null
}

variable "enable_http" {
  description = "Open port 80 to the world (so you can see the demo nginx page)."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags applied to every resource this module creates."
  type        = map(string)
  default     = {}
}
