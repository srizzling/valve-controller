output "ui_url" {
  value = "https://${var.app_hostname}"
}

output "ntfy_topic" {
  description = "Subscribe to this topic in the ntfy app."
  value       = local.ntfy_topic
}

output "link_password" {
  description = "Typed on the Google account-linking page. Read with: terraform output -raw link_password"
  value       = random_password.link_password.result
  sensitive   = true
}

output "agent_token" {
  description = "Only needed if you run the agent yourself instead of through docker_host."
  value       = random_password.agent_token.result
  sensitive   = true
}

output "tunnel_token" {
  description = "Only needed if you run cloudflared yourself instead of through docker_host."
  value       = data.cloudflare_zero_trust_tunnel_cloudflared_token.agent.token
  sensitive   = true
}

output "google_home" {
  description = "What to enter in the Google Home developer console (cloud-to-cloud integration)."
  value = {
    client_id         = local.google_client_id
    client_secret     = "terraform output -raw google_client_secret"
    authorization_url = "https://${var.app_hostname}/oauth/authorize"
    token_url         = "https://${var.app_hostname}/oauth/token"
    fulfillment_url   = "https://${var.app_hostname}/google/fulfillment"
  }
}

output "google_client_secret" {
  value     = random_password.google_client_secret.result
  sensitive = true
}
