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

output "camera_client_id" {
  description = "Access service token for scripts/camera-pusher.mjs (CF_ACCESS_CLIENT_ID). Read with: terraform output -raw camera_client_id"
  value       = cloudflare_zero_trust_access_service_token.camera.client_id
}

output "camera_client_secret" {
  description = "Access service token secret for scripts/camera-pusher.mjs (CF_ACCESS_CLIENT_SECRET). Read with: terraform output -raw camera_client_secret"
  value       = cloudflare_zero_trust_access_service_token.camera.client_secret
  sensitive   = true
}
