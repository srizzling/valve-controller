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
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State holds every secret (tokens, local key), so it lives in a private R2 bucket, not in git.
  # The account-specific endpoint is in backend.hcl and the R2 keys come from the environment:
  #   terraform init -backend-config=backend.hcl      (see the Makefile and docs/setup.md)
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
# Token permissions: Account > Workers Scripts:Edit, Access: Apps and Policies:Edit, Access: Organizations Write;
# Zone > DNS:Edit, Workers Routes:Edit (on your zone). The one-time setup script (make setup) uses a token with
# Account > Account API Tokens:Edit and Workers R2 Storage:Edit; Terraform itself reaches the state bucket with the R2 keys it creates.
provider "cloudflare" {}

provider "healthchecksio" {
  api_key = var.healthchecks_api_key
}
