# ───────────── Cloudflare ─────────────
variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare account id."
}

variable "zone_name" {
  type        = string
  description = "A zone in that account, for example example.com. The UI and the agent get hostnames under it."
}

variable "app_hostname" {
  type        = string
  description = "Public hostname of the UI and API, for example valve.example.com."
}

variable "agent_hostname" {
  type        = string
  description = "Public hostname of the Cloudflare Tunnel that fronts the homelab agent, for example valve-agent.example.com."
}

variable "access_team_domain" {
  type        = string
  description = "Your Zero Trust team domain, for example yourteam.cloudflareaccess.com (Zero Trust > Settings > Custom Pages)."
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

# ───────────── Homelab agent ─────────────
variable "docker_host" {
  type        = string
  default     = ""
  description = "Docker host that should run the agent and cloudflared, for example ssh://you@bowser. Leave empty to deploy the agent yourself (see agent/compose.yaml and the tunnel_token output)."
}

variable "tuya_device_id" {
  type    = string
  default = ""
}

variable "tuya_local_key" {
  type      = string
  default   = ""
  sensitive = true
}

variable "tuya_ip" {
  type        = string
  default     = ""
  description = "LAN address of the valve. Give it a DHCP reservation."
}

variable "tuya_version" {
  type    = string
  default = "3.4"
}

variable "tuya_dp" {
  type    = number
  default = 1
}

variable "max_on_seconds" {
  type        = number
  default     = 3900
  description = "Hard ceiling on a single open. Keep it above your longest watering period (60 min max) plus 90 seconds."
}
