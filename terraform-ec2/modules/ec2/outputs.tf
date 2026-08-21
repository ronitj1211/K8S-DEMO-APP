# ---------------------------------------------------------------------------
# Module outputs.
#
# Outputs are the only way a caller can read values back out of a module.
# Expose what a consumer legitimately needs — IDs for wiring into other
# resources, addresses for humans — and nothing more.
# ---------------------------------------------------------------------------

output "instance_id" {
  description = "EC2 instance ID."
  value       = aws_instance.this.id
}

output "instance_arn" {
  description = "EC2 instance ARN."
  value       = aws_instance.this.arn
}

output "private_ip" {
  description = "Private IPv4 address inside the VPC."
  value       = aws_instance.this.private_ip
}

output "public_ip" {
  description = "Public IPv4 address, or null when associate_public_ip is false."
  value       = aws_instance.this.public_ip
}

output "public_dns" {
  description = "Public DNS name."
  value       = aws_instance.this.public_dns
}

output "availability_zone" {
  description = "AZ the instance landed in."
  value       = aws_instance.this.availability_zone
}

output "ami_id" {
  description = "AMI actually used (looked up or pinned)."
  value       = local.ami_id
}

output "security_group_id" {
  description = "ID of the security group created for this instance."
  value       = aws_security_group.this.id
}

output "ssh_command" {
  description = "Ready-to-paste SSH command, or a hint if no key pair was set."
  value = var.key_name != null && var.associate_public_ip ? (
    "ssh -i ~/.ssh/${var.key_name}.pem ec2-user@${aws_instance.this.public_ip}"
    ) : (
    "No key_name set — connect with: aws ssm start-session --target ${aws_instance.this.id}"
  )
}

output "http_url" {
  description = "URL of the demo nginx page."
  value       = var.associate_public_ip ? "http://${aws_instance.this.public_ip}" : null
}
