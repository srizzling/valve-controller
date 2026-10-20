# Runs the agent and cloudflared on the homelab Docker host. Skipped when docker_host is empty.
locals {
  deploy_agent = var.docker_host != ""
}

resource "docker_network" "valve" {
  count = local.deploy_agent ? 1 : 0
  name  = "valve"
}

resource "docker_image" "agent" {
  count = local.deploy_agent ? 1 : 0
  name  = "valve-agent:latest"

  build {
    context = "${path.module}/../agent"
  }

  triggers = {
    source = sha1(join("", [for f in sort(fileset("${path.module}/../agent", "*.{py,txt}")) : filesha1("${path.module}/../agent/${f}")]))
  }
}

resource "docker_container" "agent" {
  count        = local.deploy_agent ? 1 : 0
  name         = "agent"
  image        = docker_image.agent[0].image_id
  restart      = "unless-stopped"
  network_mode = "bridge"

  networks_advanced {
    name = docker_network.valve[0].name
  }

  env = [
    "TUYA_DEVICE_ID=${var.tuya_device_id}",
    "TUYA_LOCAL_KEY=${var.tuya_local_key}",
    "TUYA_IP=${var.tuya_ip}",
    "TUYA_VERSION=${var.tuya_version}",
    "TUYA_DP=${var.tuya_dp}",
    "AGENT_TOKEN=${random_password.agent_token.result}",
    "MAX_ON_SECONDS=${var.max_on_seconds}",
    "NTFY_URL=${var.ntfy_url}",
    "NTFY_TOPIC=${local.ntfy_topic}",
    "NTFY_TOKEN=${var.ntfy_token}",
  ]
}

resource "docker_image" "cloudflared" {
  count = local.deploy_agent ? 1 : 0
  name  = "cloudflare/cloudflared:latest"
}

resource "docker_container" "cloudflared" {
  count   = local.deploy_agent ? 1 : 0
  name    = "cloudflared"
  image   = docker_image.cloudflared[0].image_id
  restart = "unless-stopped"
  command = ["tunnel", "--no-autoupdate", "run"]

  networks_advanced {
    name = docker_network.valve[0].name
  }

  env = ["TUNNEL_TOKEN=${data.cloudflare_zero_trust_tunnel_cloudflared_token.agent.token}"]
}
