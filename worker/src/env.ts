import type { Controller } from "./controller";

export interface Env {
  CONTROLLER: DurableObjectNamespace<Controller>;
  ASSETS: Fetcher;
  AGENT_URL: string;
  TIMEZONE: string;
  LATITUDE: string;
  LONGITUDE: string;
  NTFY_URL: string;
  NTFY_TOPIC: string;
  NTFY_TOKEN?: string;
  // Cloudflare Access (protects the UI and /api)
  ACCESS_TEAM_DOMAIN?: string; // e.g. yourteam.cloudflareaccess.com
  ACCESS_AUD?: string; // the Access application's Audience tag
  DEV_BYPASS_ACCESS?: string; // "true" in .dev.vars only
  // Password typed on the Google account-linking page
  LINK_PASSWORD: string;
  AGENT_TOKEN: string;
  SIGNING_KEY: string;
  GOOGLE_PROJECT_ID?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}
