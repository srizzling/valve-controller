import type { Controller } from "./controller";

export interface Env {
  CONTROLLER: DurableObjectNamespace<Controller>;
  ASSETS: Fetcher;
  TUYA_DEVICE_ID: string;
  TUYA_SWITCH_CODE?: string; // data point that opens and closes the valve (default switch_1)
  TUYA_COUNTDOWN_CODE?: string; // data point for the valve-side auto-close (default countdown_1, empty if none)
  TIMEZONE: string;
  LATITUDE: string;
  LONGITUDE: string;
  NTFY_URL: string;
  NTFY_TOPIC: string;
  NTFY_TOKEN?: string;
  HEALTHCHECK_URL?: string; // healthchecks.io ping URL (secret)
  // Cloudflare Access (protects the UI and /api)
  ACCESS_TEAM_DOMAIN?: string; // e.g. yourteam.cloudflareaccess.com
  ACCESS_AUD?: string; // the Access application's Audience tag
  DEV_BYPASS_ACCESS?: string; // "true" in .dev.vars only
  // Password typed on the Google account-linking page
  LINK_PASSWORD: string;
  TUYA_SESSION: string; // the login from scripts/tuya-login.py; the live, rotating copy is kept in the Durable Object
  SIGNING_KEY: string;
  GOOGLE_PROJECT_ID?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}
