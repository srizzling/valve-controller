data "cloudflare_zone" "this" {
  filter = {
    name = var.zone_name
  }
}

# ───────────── Secrets and generated names ─────────────
resource "random_password" "signing_key" {
  length  = 64
  special = false
}

resource "random_password" "link_password" {
  length  = 24
  special = false
}

resource "random_password" "google_client_secret" {
  length  = 40
  special = false
}

resource "random_id" "ntfy_topic" {
  byte_length = 8
}

locals {
  ntfy_topic       = var.ntfy_topic != "" ? var.ntfy_topic : "valve-${random_id.ntfy_topic.hex}"
  google_client_id = "valve-controller"
}

# ───────────── Cloudflare Access in front of the UI and API ─────────────
resource "cloudflare_zero_trust_access_application" "ui" {
  account_id       = var.cloudflare_account_id
  name             = "Valve controller"
  type             = "self_hosted"
  session_duration = "24h"

  destinations = [{
    type = "public"
    uri  = var.app_hostname
  }]

  policies = [{
    name     = "Owner"
    decision = "allow"
    include = [for e in var.allowed_emails : {
      email = { email = e }
    }]
  }]

  depends_on = [cloudflare_zero_trust_organization.this]
}

# Google's servers cannot log in through Access. These paths have their own authentication
# (the link password and signed tokens), so they bypass it. Path rules are more specific than
# the hostname rule above, so they win.
resource "cloudflare_zero_trust_access_application" "google_bypass" {
  account_id = var.cloudflare_account_id
  name       = "Valve controller: Google Home and OAuth"
  type       = "self_hosted"

  destinations = [
    { type = "public", uri = "${var.app_hostname}/oauth/*" },
    { type = "public", uri = "${var.app_hostname}/google/*" },
  ]

  policies = [{
    name     = "Bypass"
    decision = "bypass"
    include  = [{ everyone = {} }]
  }]

  depends_on = [cloudflare_zero_trust_organization.this]
}

# ───────────── healthchecks.io: alert when a scheduled run does not report in ─────────────
data "healthchecksio_channel" "alert" {
  for_each = toset(var.healthchecks_channel_kinds)
  kind     = each.value
}

resource "healthchecksio_check" "scheduled_run" {
  name    = "valve-controller scheduled run"
  desc    = "Pinged by the Worker when a scheduled run starts, finishes or is skipped for rain."
  tags    = ["valve", "garden"]
  timeout = var.heartbeat_timeout_hours * 3600
  grace   = var.heartbeat_grace_hours * 3600

  channels = [for c in data.healthchecksio_channel.alert : c.id]
}
