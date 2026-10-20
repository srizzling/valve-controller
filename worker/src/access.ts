// Validates the Cloudflare Access JWT, so the API refuses any request that did not come through Access
// (for example one sent straight to the workers.dev hostname).
import type { Env } from "./env";

interface Jwk { kid: string; kty: string; n: string; e: string }
export interface Jwks { keys: Jwk[] }

const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const parse = <T>(s: string) => JSON.parse(new TextDecoder().decode(unb64u(s))) as T;

export async function verifyAccessJwt(
  token: string,
  jwks: Jwks,
  expected: { issuer: string; aud: string },
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ email?: string } | null> {
  const [h, p, sig] = token.split(".");
  if (!h || !p || !sig) return null;
  try {
    const header = parse<{ alg: string; kid: string }>(h);
    if (header.alg !== "RS256") return null;
    const jwk = jwks.keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64u(sig), new TextEncoder().encode(`${h}.${p}`)))) return null;
    const c = parse<{ iss: string; aud: string | string[]; exp: number; nbf?: number; email?: string }>(p);
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (c.iss !== expected.issuer || !aud.includes(expected.aud)) return null;
    if (typeof c.exp !== "number" || c.exp < nowSeconds || (c.nbf !== undefined && c.nbf > nowSeconds)) return null;
    return { email: c.email };
  } catch {
    return null;
  }
}

let cache: { team: string; at: number; jwks: Jwks } | null = null;

async function getJwks(team: string, maxAgeMs: number): Promise<Jwks> {
  if (cache && cache.team === team && Date.now() - cache.at < maxAgeMs) return cache.jwks;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`certs endpoint returned ${res.status}`);
  cache = { team, at: Date.now(), jwks: (await res.json()) as Jwks };
  return cache.jwks;
}

export type AccessResult = { ok: true; email?: string } | { ok: false; status: 401 | 403 | 502 | 503; error: string };

export async function checkAccess(req: Request, env: Env): Promise<AccessResult> {
  if (env.DEV_BYPASS_ACCESS === "true") return { ok: true }; // only ever set in .dev.vars
  const team = env.ACCESS_TEAM_DOMAIN;
  if (!team || !env.ACCESS_AUD) return { ok: false, status: 503, error: "Cloudflare Access is not configured" };
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return { ok: false, status: 401, error: "missing Cloudflare Access token" };
  const expected = { issuer: `https://${team}`, aud: env.ACCESS_AUD };
  try {
    // keys rotate: if the token's key isn't in the cached set, refresh once (at most every minute)
    let claims = await verifyAccessJwt(token, await getJwks(team, 60 * 60_000), expected);
    if (!claims) claims = await verifyAccessJwt(token, await getJwks(team, 60_000), expected);
    return claims ? { ok: true, email: claims.email } : { ok: false, status: 403, error: "invalid Cloudflare Access token" };
  } catch (e) {
    console.error("access check failed", e);
    return { ok: false, status: 502, error: "could not verify Cloudflare Access token" };
  }
}
