terraform {
  required_version = ">= 1.6"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
    healthchecksio = {
      source  = "kristofferahl/healthchecksio"
      version = "~> 2.3"
    }
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 3.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State holds every secret (tokens, local key), so it lives in a private R2 bucket, not in git.
  # The account-specific endpoint is in backend.hcl and the R2 keys come from the environment:
  #   terraform init -backend-config=backend.hcl      (see the Makefile and README)
  # Settings below are the ones Cloudflare documents for R2. No state locking: it is one person running one apply at a time.
  backend "s3" {
    bucket                      = "valve-controller-tfstate"
    key                         = "infra/terraform.tfstate"
    region                      = "auto"
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}

# Reads CLOUDFLARE_API_TOKEN from the environment.
# Token permissions: Account > Workers Scripts:Edit, Cloudflare Tunnel:Edit, Access: Apps and Policies:Edit;
# Zone > DNS:Edit, Workers Routes:Edit (on your zone). Creating the state bucket (make bootstrap) also needs
# Account > Workers R2 Storage:Edit; Terraform itself reaches the bucket with the separate R2 keys.
provider "cloudflare" {}

provider "healthchecksio" {
  api_key = var.healthchecks_api_key
}

# Empty docker_host means "do not deploy the agent from Terraform"; the provider is then never contacted.
provider "docker" {
  host     = var.docker_host != "" ? var.docker_host : null
  ssh_opts = ["-o", "StrictHostKeyChecking=accept-new", "-o", "UserKnownHostsFile=/dev/null"]
}
