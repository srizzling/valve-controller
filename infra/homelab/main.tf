# Runs the agent and cloudflared on the homelab Docker host. This is its own Terraform root, applied from your
# machine, because GitHub's runners cannot reach the homelab. The cloud root (../) is applied by CI.

# Values the cloud root creates: the agent token, the tunnel token and the ntfy topic.
data "terraform_remote_state" "cloud" {
  backend = "s3"
  config = {
    bucket                      = "valve-controller-tfstate"
    key                         = "infra/terraform.tfstate"
    region                      = "auto"
    endpoints                   = { s3 = "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com" }
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}

locals {
  cloud = data.terraform_remote_state.cloud.outputs
}

resource "docker_network" "valve" {
  name = "valve"
}

resource "docker_image" "agent" {
  name = "valve-agent:latest"

  build {
    context = "${path.module}/../../agent"
  }

  triggers = {
    source = sha1(join("", [for f in sort(fileset("${path.module}/../../agent", "*.{py,txt}")) : filesha1("${path.module}/../../agent/${f}")]))
  }
}

resource "docker_container" "agent" {
  name         = "agent"
  image        = docker_image.agent.image_id
  restart      = "unless-stopped"
  network_mode = "bridge"

  networks_advanced {
    name = docker_network.valve.name
  }

  env = [
    "TUYA_DEVICE_ID=${var.tuya_device_id}",
    "TUYA_LOCAL_KEY=${var.tuya_local_key}",
    "TUYA_IP=${var.tuya_ip}",
    "TUYA_VERSION=${var.tuya_version}",
    "TUYA_DP=${var.tuya_dp}",
    "AGENT_TOKEN=${local.cloud.agent_token}",
    "MAX_ON_SECONDS=${var.max_on_seconds}",
    "NTFY_URL=${var.ntfy_url}",
    "NTFY_TOPIC=${local.cloud.ntfy_topic}",
    "NTFY_TOKEN=${var.ntfy_token}",
  ]
}

resource "docker_image" "cloudflared" {
  name = "cloudflare/cloudflared:latest"
}

resource "docker_container" "cloudflared" {
  name    = "cloudflared"
  image   = docker_image.cloudflared.image_id
  restart = "unless-stopped"
  command = ["tunnel", "--no-autoupdate", "run"]

  networks_advanced {
    name = docker_network.valve.name
  }

  env = ["TUNNEL_TOKEN=${local.cloud.tunnel_token}"]
}
