variable "aws_region" {
  description = "AWS region for the disposable Gatehouse instance."
  type        = string
  default     = "us-east-1"
}

variable "hosted_zone_name" {
  description = "Public Route 53 hosted zone used for Gatehouse DNS and certificate validation."
  type        = string

  validation {
    condition     = can(regex("^([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\\.)+[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\\.?$", trimspace(var.hosted_zone_name)))
    error_message = "hosted_zone_name must be a valid DNS name such as example.com."
  }
}

variable "hostname" {
  description = "Full public hostname for Gatehouse."
  type        = string

  validation {
    condition     = can(regex("^([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\\.)+[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\\.?$", trimspace(var.hostname)))
    error_message = "hostname must be a valid DNS name such as gatehouse.example.com."
  }
}

variable "source_branch" {
  description = "Git branch to clone for the Gatehouse source."
  type        = string
  default     = "main"

  validation {
    condition     = length(trimspace(var.source_branch)) > 0 && can(regex("^[A-Za-z0-9._/-]+$", var.source_branch))
    error_message = "source_branch must be a branch name using letters, numbers, dot, underscore, slash, or dash."
  }
}

variable "allowed_ingress_cidr" {
  description = "Only this IP can reach Gatehouse over HTTPS. Use one IPv4 address as x.x.x.x/32."
  type        = string

  validation {
    condition     = can(regex("^([0-9]{1,3}\\.){3}[0-9]{1,3}/32$", var.allowed_ingress_cidr)) && can(cidrhost(var.allowed_ingress_cidr, 0))
    error_message = "allowed_ingress_cidr must be one IPv4 address as x.x.x.x/32."
  }
}

variable "allowed_email" {
  description = "Only this recipient can request a Gatehouse verification email."
  type        = string

  validation {
    condition     = length(trimspace(var.allowed_email)) > 0 && can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.allowed_email))
    error_message = "allowed_email must be one concrete email address."
  }
}
