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
  API_TOKEN: string;
  AGENT_TOKEN: string;
  SIGNING_KEY: string;
  GOOGLE_PROJECT_ID?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}
