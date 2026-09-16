import { base32, b64, unb64, Env, Fault, limit } from "./core";

export const easyWarning =
  "Convenience mode: the mailbox private key is your bearer access key. This Worker sees it in memory on every call; application code does not persist it to D1 or log it. Your chat provider, tool host or infrastructure may retain credentials. Anyone with this key controls the inbox. There is no key recovery or rotation for the same address. Prefer local SDK signing for sensitive or long-lived use. HTTPS only; never put credentials in URLs.";

// Accept only the canonical 48-byte Ed25519 PKCS8 encoding emitted by bootstrap/SDK.
// No credentials are written to D1, included in errors, or returned by this function.
export async function authenticateEasy(
  req: Request,
  env: Env,
): Promise<string> {
  const authorization = req.headers.get("Authorization") || "";
  if (!/^Bearer [A-Za-z0-9_-]{64}$/i.test(authorization))
    throw new Fault(
      401,
      "access_key_required",
      "Send your mailbox access key in the Authorization: Bearer header.",
    );
  let owner: string;
  try {
    const encoded = authorization.slice(7);
    const bytes = unb64(encoded);
    const prefix = [
      0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
      0x04, 0x22, 0x04, 0x20,
    ];
    if (b64(bytes) !== encoded || prefix.some((byte, i) => bytes[i] !== byte))
      throw 0;
    const key = await crypto.subtle.importKey("pkcs8", bytes, "Ed25519", true, [
      "sign",
    ]);
    const jwk = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
    owner = base32(unb64(jwk.x!));
  } catch {
    throw new Fault(401, "invalid_access_key", "Invalid mailbox access key.");
  }
  await limit(env.DB, `owner:${owner}`, 30, 60);
  return owner;
}
