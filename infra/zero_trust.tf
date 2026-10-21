# Manages the Zero Trust organisation: the team address (<team>.cloudflareaccess.com) that Access logins use.
# Cloudflare only lets an account create this by pressing "Enable Access" in the dashboard (the API answers
# "Access is not enabled"). So: activate once there, choose the same team name as zero_trust_team, then import it:
#   terraform import cloudflare_zero_trust_organization.this <account_id>
# Terraform cannot delete it; remove it by hand in the dashboard if you ever need to.
resource "cloudflare_zero_trust_organization" "this" {
  account_id       = var.cloudflare_account_id
  name             = var.zero_trust_team
  auth_domain      = "${var.zero_trust_team}.cloudflareaccess.com"
  session_duration = "24h"
}
