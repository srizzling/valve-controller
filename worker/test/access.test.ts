import { describe, expect, it } from "vitest";
import { verifyAccessJwt } from "../src/access";

const b64u = (b: ArrayBuffer | Uint8Array | string) => {
  const bytes = typeof b === "string" ? new TextEncoder().encode(b) : new Uint8Array(b);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const algo = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

async function setup() {
  const pair = (await crypto.subtle.generateKey({ ...algo, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const jwks = { keys: [{ kid: "k1", kty: pub.kty!, n: pub.n!, e: pub.e! }] };
  const mint = async (claims: object, kid = "k1", alg = "RS256") => {
    const body = `${b64u(JSON.stringify({ alg, kid }))}.${b64u(JSON.stringify(claims))}`;
    return `${body}.${b64u(await crypto.subtle.sign(algo, pair.privateKey, new TextEncoder().encode(body)))}`;
  };
  return { jwks, mint };
}

const expected = { issuer: "https://team.cloudflareaccess.com", aud: "aud123" };
const good = { iss: expected.issuer, aud: ["aud123"], exp: 2000, nbf: 1000, email: "me@example.com" };

describe("Cloudflare Access JWT", () => {
  it("accepts a valid token", async () => {
    const { jwks, mint } = await setup();
    expect(await verifyAccessJwt(await mint(good), jwks, expected, 1500)).toEqual({ email: "me@example.com" });
  });
  it("rejects expiry, wrong audience, wrong issuer, unknown key, wrong alg, forged signature", async () => {
    const { jwks, mint } = await setup();
    const other = await setup();
    expect(await verifyAccessJwt(await mint(good), jwks, expected, 2001)).toBeNull();
    expect(await verifyAccessJwt(await mint(good), jwks, expected, 999)).toBeNull();
    expect(await verifyAccessJwt(await mint({ ...good, aud: ["other"] }), jwks, expected, 1500)).toBeNull();
    expect(await verifyAccessJwt(await mint({ ...good, iss: "https://evil.example" }), jwks, expected, 1500)).toBeNull();
    expect(await verifyAccessJwt(await mint(good, "nope"), jwks, expected, 1500)).toBeNull();
    expect(await verifyAccessJwt(await mint(good, "k1", "none"), jwks, expected, 1500)).toBeNull();
    expect(await verifyAccessJwt(await other.mint(good), jwks, expected, 1500)).toBeNull();
    expect(await verifyAccessJwt("garbage", jwks, expected, 1500)).toBeNull();
  });
});
