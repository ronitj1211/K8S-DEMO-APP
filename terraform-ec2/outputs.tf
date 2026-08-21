# ---------------------------------------------------------------------------
# Root outputs — re-export what the module returned, plus the looked-up
# network context so you can see what the default-VPC lookup resolved to.
# ---------------------------------------------------------------------------

output "instance_id" {
  description = "EC2 instance ID."
  value       = module.web_server.instance_id
}

output "public_ip" {
  description = "Public IPv4 address."
  value       = module.web_server.public_ip
}

output "private_ip" {
  description = "Private IPv4 address."
  value       = module.web_server.private_ip
}

output "availability_zone" {
  description = "AZ the instance landed in."
  value       = module.web_server.availability_zone
}

output "ami_id" {
  description = "AMI that was used."
  value       = module.web_server.ami_id
}

output "security_group_id" {
  description = "Security group created for the instance."
  value       = module.web_server.security_group_id
}

output "http_url" {
  description = "Open this to see the demo nginx page (allow ~60s for boot)."
  value       = module.web_server.http_url
}

output "ssh_command" {
  description = "How to connect."
  value       = module.web_server.ssh_command
}

# Useful for confirming the data sources resolved as expected.
output "vpc_id" {
  description = "Default VPC that was discovered."
  value       = data.aws_vpc.default.id
}

output "subnet_id" {
  description = "Subnet the instance was placed in."
  value       = local.subnet_id
}

output "available_subnets" {
  description = "All subnets found in the default VPC."
  value       = sort(data.aws_subnets.default.ids)
}
