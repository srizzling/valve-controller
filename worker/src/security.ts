// Security headers for everything the Worker itself answers (/api, /oauth, /google). The UI's static files do not pass
// through here; they get theirs from worker/assets-headers.txt (deployed as the `_headers` file) and a <meta> CSP.
import { createMiddleware } from "hono/factory";

// Google's redirect targets. Chrome applies form-action to the redirect that follows a form post, not just the post.
const GOOGLE_REDIRECTS = "https://oauth-redirect.googleusercontent.com https://oauth-redirect-sandbox.googleusercontent.com";

// JSON and token responses are never rendered, so they may load nothing and never be framed.
const DATA_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
// The account-linking page is the only HTML the Worker produces. It has inline styles and no script.
const LINK_PAGE_CSP = `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${GOOGLE_REDIRECTS}; frame-ancestors 'none'; base-uri 'none'`;

export const securityHeaders = createMiddleware(async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set("Content-Security-Policy", new URL(c.req.url).pathname === "/oauth/authorize" ? LINK_PAGE_CSP : DATA_CSP);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "no-referrer"); // the authorize URL carries OAuth state
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Strict-Transport-Security", "max-age=31536000");
  h.set("Cache-Control", "no-store");
});
