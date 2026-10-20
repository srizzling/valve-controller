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

  # State holds every secret (tokens, local key). Keep it somewhere private. Local state is fine for one person
  # on one machine; for anything else use an encrypted remote backend, for example a private R2 bucket:
  #
  # backend "s3" {
  #   bucket = "valve-tfstate"
  #   key    = "terraform.tfstate"
  #   region = "auto"
  #   endpoints                   = { s3 = "https://<account-id>.r2.cloudflarestorage.com" }
  #   skip_credentials_validation = true
  #   skip_region_validation      = true
  #   skip_requesting_account_id  = true
  #   skip_metadata_api_check     = true
  #   use_path_style              = true
  # }
}

# Reads CLOUDFLARE_API_TOKEN from the environment.
# Token permissions: Account > Workers Scripts:Edit, Cloudflare Tunnel:Edit, Access: Apps and Policies:Edit;
# Zone > DNS:Edit, Workers Routes:Edit (on your zone).
provider "cloudflare" {}

provider "healthchecksio" {
  api_key = var.healthchecks_api_key
}

# Empty docker_host means "do not deploy the agent from Terraform"; the provider is then never contacted.
provider "docker" {
  host     = var.docker_host != "" ? var.docker_host : null
  ssh_opts = ["-o", "StrictHostKeyChecking=accept-new", "-o", "UserKnownHostsFile=/dev/null"]
}
