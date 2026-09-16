terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      app = "gatehouse"
    }
  }
}

locals {
  hosted_zone_name = trimsuffix(lower(trimspace(var.hosted_zone_name)), ".")
  hostname         = trimsuffix(lower(trimspace(var.hostname)), ".")
  mail_from        = "gatehouse@${local.hosted_zone_name}"
  name             = "gatehouse-target"
}

data "aws_caller_identity" "current" {}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }

  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

data "aws_ssm_parameter" "al2023_x86_64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_security_group" "gatehouse" {
  name        = local.name
  description = "Gatehouse EC2 target"
  vpc_id      = data.aws_vpc.default.id

  tags = {
    Name = local.name
  }
}

resource "aws_vpc_security_group_ingress_rule" "from_alb" {
  security_group_id            = aws_security_group.gatehouse.id
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
  description                  = "Gatehouse traffic from the ALB"
}

resource "aws_vpc_security_group_egress_rule" "https" {
  security_group_id = aws_security_group.gatehouse.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "HTTPS for AWS APIs, packages, git, Docker Hub"
}

resource "aws_iam_role" "gatehouse" {
  name = local.name

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.gatehouse.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "email_sender" {
  name = "${local.name}-email-sender"
  role = aws_iam_role.gatehouse.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ses:SendEmail"]
      Resource = "arn:aws:ses:${var.aws_region}:${data.aws_caller_identity.current.account_id}:identity/${local.hosted_zone_name}"
      Condition = {
        StringEquals = {
          "ses:FromAddress" = local.mail_from
        }
        "ForAllValues:StringEquals" = {
          "ses:Recipients" = [var.allowed_email]
        }
      }
    }]
  })
}

resource "aws_iam_instance_profile" "gatehouse" {
  name = local.name
  role = aws_iam_role.gatehouse.name
}

resource "aws_instance" "gatehouse" {
  ami                         = data.aws_ssm_parameter.al2023_x86_64.value
  instance_type               = "t3.small"
  subnet_id                   = sort(data.aws_subnets.default.ids)[0]
  associate_public_ip_address = true
  iam_instance_profile        = aws_iam_instance_profile.gatehouse.name
  vpc_security_group_ids      = [aws_security_group.gatehouse.id]
  user_data_replace_on_change = true

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  root_block_device {
    encrypted   = true
    volume_size = 16
    volume_type = "gp3"
  }

  user_data_base64 = base64encode(templatefile("${path.module}/user_data.sh.tftpl", {
    allowed_email = var.allowed_email
    aws_region    = var.aws_region
    mail_from     = local.mail_from
    source_branch = var.source_branch
  }))

  tags = {
    Name = local.name
  }

  depends_on = [
    aws_iam_role_policy.email_sender,
    aws_iam_role_policy_attachment.ssm,
  ]
}

resource "terraform_data" "gatehouse_ready" {
  triggers_replace = [
    aws_instance.gatehouse.id,
    aws_lb_listener.https.arn,
    aws_lb_listener.https.certificate_arn,
    aws_route53_record.gatehouse.fqdn,
  ]

  provisioner "local-exec" {
    command = "bash ${path.module}/scripts/wait-ready.sh ${var.aws_region} ${aws_instance.gatehouse.id} ${aws_lb_target_group.gatehouse.arn}"
  }

  depends_on = [
    aws_lb_target_group_attachment.gatehouse,
    aws_vpc_security_group_egress_rule.alb_to_gatehouse,
    aws_vpc_security_group_ingress_rule.from_alb,
  ]
}
