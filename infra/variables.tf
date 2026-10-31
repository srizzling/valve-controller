# ───────────── Cloudflare ─────────────
variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare account id."
}

variable "zone_name" {
  type        = string
  description = "A zone in that account, for example example.com. The UI gets a hostname under it."
}

variable "app_hostname" {
  type        = string
  description = "Public hostname of the UI and API, for example valve.example.com."
}

variable "zero_trust_team" {
  type        = string
  description = "Your Zero Trust team name. It becomes <team>.cloudflareaccess.com and must be unique across Cloudflare."
}

variable "allowed_emails" {
  type        = list(string)
  description = "Who may open the UI. Cloudflare Access sends these addresses a login code."
}

variable "worker_name" {
  type    = string
  default = "valve-controller"
}

variable "compatibility_date" {
  type        = string
  default     = "2026-10-01"
  description = "Workers runtime compatibility date. Keep it in step with worker/wrangler.jsonc."
}

# ───────────── Behaviour ─────────────
variable "timezone" {
  type        = string
  description = "IANA timezone for schedule times, for example Australia/Melbourne."
}

variable "latitude" {
  type = string
}

variable "longitude" {
  type = string
}

# ───────────── Notifications ─────────────
variable "ntfy_url" {
  type    = string
  default = "https://ntfy.sh"
}

variable "ntfy_topic" {
  type        = string
  default     = ""
  description = "Leave empty to generate a hard-to-guess topic name (see the ntfy_topic output)."
}

variable "ntfy_token" {
  type      = string
  default   = ""
  sensitive = true
}

variable "healthchecks_api_key" {
  type        = string
  sensitive   = true
  description = "healthchecks.io project API key (read-write). Set with TF_VAR_healthchecks_api_key."
}

variable "healthchecks_channel_kinds" {
  type        = list(string)
  default     = ["email"]
  description = "Kinds of existing healthchecks.io integrations that should be told when a run is missed (for example email, ntfy, slack). Integrations themselves are created in the healthchecks.io UI."
}

variable "heartbeat_timeout_hours" {
  type        = number
  default     = 26
  description = "How long a scheduled run may go without reporting in before healthchecks.io alerts. Use a value above your longest gap between runs."
}

variable "heartbeat_grace_hours" {
  type    = number
  default = 2
}

# ───────────── Google Home (optional) ─────────────
variable "google_project_id" {
  type        = string
  default     = ""
  description = "Project id of your Google Home cloud-to-cloud integration. Leave empty to leave Google Home switched off."
}

# ───────────── The garden camera (optional) ─────────────
variable "anthropic_api_key" {
  type        = string
  default     = ""
  sensitive   = true
  description = "An Anthropic API key, so the Worker can look at camera photos and alert on a leak. Leave empty to keep photos without checking them."
}

variable "camera_scene" {
  type        = string
  default     = ""
  description = "What the camera looks at, told to the model, for example: potted lemon tree, mint, coriander and two roses on artificial grass; the drip line runs along the fence."
}

variable "camera_model" {
  type        = string
  default     = ""
  description = "Claude model that checks camera photos. Empty uses the Worker's default, claude-haiku-5-5."
}

variable "camera_timelapse_hour" {
  type        = string
  default     = "12"
  description = "Local hour (0-23) of the daily photo for the growth timelapse. Midday gives the steadiest light."
}

# ───────────── The valve, through Tuya's cloud ─────────────
variable "tuya_session" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Optional first login, written by scripts/tuya-login.py (TF_VAR_tuya_session in infra/.env). The Worker keeps the live, rotating login in its own storage, so leave this empty once it has signed in; a login can also be made from the UI, with the QR code."
}

variable "tuya_user_code" {
  type        = string
  default     = ""
  description = "Your Smart Life User Code (app: Me > settings > Account and Security > User Code). Not a secret. It lets the UI's QR reconnect work when the Worker has no login saved."
}

variable "tuya_device_id" {
  type        = string
  default     = ""
  description = "The valve's Tuya device id, written to terraform.tfvars by scripts/tuya-login.py."
}

variable "tuya_switch_code" {
  type        = string
  default     = "switch_1"
  description = "The data point that opens and closes the valve."
}

variable "tuya_countdown_code" {
  type        = string
  default     = "countdown_1"
  description = "The data point for the valve's own auto-close timer, the failsafe if the Worker stops. Empty if the valve has none."
}

variable "durable_object_ready" {
  type        = bool
  default     = false
  description = "False on the very first apply, which creates the Durable Object class. Set to true (and leave it) for every apply after that."
}
