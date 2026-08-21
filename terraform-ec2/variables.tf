# ---------------------------------------------------------------------------
# Root module inputs — set these in terraform.tfvars or with -var flags.
# ---------------------------------------------------------------------------

variable "region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "ap-south-1"
}

variable "project" {
  description = "Project name, used in resource names and tags."
  type        = string
  default     = "demo"
}

variable "environment" {
  description = "Environment name (dev / stage / prod)."
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev", "stage", "prod"], var.environment)
    error_message = "environment must be one of: dev, stage, prod."
  }
}

variable "instance_type" {
  description = "EC2 instance type."
  type        = string
  default     = "t3.micro"
}

variable "subnet_id" {
  description = "Specific subnet to use. Leave null to pick the first default-VPC subnet."
  type        = string
  default     = null
}

variable "key_name" {
  description = "Existing EC2 key pair for SSH. Leave null and use SSM instead."
  type        = string
  default     = null
}

variable "allowed_ssh_cidrs" {
  description = "CIDRs allowed on port 22. Keep empty unless you need SSH; then use YOUR_IP/32."
  type        = list(string)
  default     = []
}

variable "root_volume_size" {
  description = "Root EBS volume size in GiB."
  type        = number
  default     = 8
}
