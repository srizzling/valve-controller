# The Worker is deployed from here, not with `wrangler deploy`. Build the bundle first (see Makefile):
#   wrangler deploy --dry-run --outdir worker/build

locals {
  worker_vars = {
    TUYA_DEVICE_ID      = var.tuya_device_id
    TUYA_SWITCH_CODE    = var.tuya_switch_code
    TUYA_COUNTDOWN_CODE = var.tuya_countdown_code
    TIMEZONE            = var.timezone
    LATITUDE            = var.latitude
    LONGITUDE           = var.longitude
    NTFY_URL            = var.ntfy_url
    NTFY_TOPIC          = local.ntfy_topic
    GOOGLE_PROJECT_ID   = var.google_project_id
    ACCESS_TEAM_DOMAIN  = cloudflare_zero_trust_organization.this.auth_domain
    ACCESS_AUD          = cloudflare_zero_trust_access_application.ui.aud
  }

  worker_secrets = merge(
    {
      SIGNING_KEY          = random_password.signing_key.result
      LINK_PASSWORD        = random_password.link_password.result
      HEALTHCHECK_URL      = healthchecksio_check.scheduled_run.ping_url
      GOOGLE_CLIENT_ID     = local.google_client_id
      GOOGLE_CLIENT_SECRET = random_password.google_client_secret.result
    },
    var.ntfy_token != "" ? { NTFY_TOKEN = var.ntfy_token } : {},
    var.tuya_session != "" ? { TUYA_SESSION = var.tuya_session } : {},
  )

  # Every element needs the same keys, so unused ones are null.
  worker_bindings = concat(
    [{ type = "durable_object_namespace", name = "CONTROLLER", class_name = "Controller", text = null }],
    [for k, v in local.worker_vars : { type = "plain_text", name = k, text = v, class_name = null }],
    [for k, v in local.worker_secrets : { type = "secret_text", name = k, text = v, class_name = null }],
  )
}

resource "cloudflare_worker" "valve" {
  account_id = var.cloudflare_account_id
  name       = var.worker_name

  observability = {
    enabled = true
  }
}

resource "cloudflare_worker_version" "valve" {
  account_id         = var.cloudflare_account_id
  worker_id          = cloudflare_worker.valve.id
  compatibility_date = var.compatibility_date
  main_module        = "index.js"

  modules = [{
    name         = "index.js"
    content_type = "application/javascript+module"
    content_file = "${path.module}/../worker/build/index.js" # replaced (new version) whenever this changes
  }]

  assets = {
    directory = "${path.module}/../worker/public"
    config = {
      run_worker_first = ["/api/*", "/oauth/*", "/google/*"]
    }
  }

  bindings = local.worker_bindings

  # Declares the Durable Object class with SQLite storage, so no separate migration step is needed.
  exports = {
    Controller = {
      type    = "durable-object"
      storage = "sqlite"
    }
  }
}

resource "cloudflare_workers_deployment" "valve" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.valve.name
  strategy    = "percentage"

  versions = [{
    percentage = 100
    version_id = cloudflare_worker_version.valve.id
  }]
}

# Check the schedule every minute; the Durable Object decides whether anything is due.
resource "cloudflare_workers_cron_trigger" "valve" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.valve.name
  schedules   = [{ cron = "* * * * *" }]

  depends_on = [cloudflare_workers_deployment.valve]
}

resource "cloudflare_workers_custom_domain" "app" {
  account_id = var.cloudflare_account_id
  zone_id    = data.cloudflare_zone.this.zone_id
  hostname   = var.app_hostname
  service    = cloudflare_worker.valve.name

  depends_on = [cloudflare_workers_deployment.valve]
}

# Only the custom domain, which sits behind Access. The workers.dev address would bypass it.
resource "cloudflare_workers_script_subdomain" "valve" {
  account_id       = var.cloudflare_account_id
  script_name      = cloudflare_worker.valve.name
  enabled          = false
  previews_enabled = false

  depends_on = [cloudflare_workers_deployment.valve]
}
