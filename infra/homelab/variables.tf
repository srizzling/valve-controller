variable "cloudflare_account_id" {
  type        = string
  description = "Same account id as the cloud root. Used to find its state in the R2 bucket."
}

variable "docker_host" {
  type        = string
  description = "Docker host that runs the agent and cloudflared, for example ssh://you@bowser."
}

variable "tuya_device_id" {
  type = string
}

variable "tuya_local_key" {
  type      = string
  sensitive = true
}

variable "tuya_ip" {
  type        = string
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

variable "ntfy_url" {
  type    = string
  default = "https://ntfy.sh"
}

variable "ntfy_token" {
  type      = string
  default   = ""
  sensitive = true
}
