export interface Env {
  DB: D1Database;
  DOMAIN: string;
  ADMIN_PUBLIC_KEY: string;
  API_ORIGIN: string;
}
export const enc = new TextEncoder();
export const C = {
  raw: 262144,
  text: 65536,
  retention: 86400,
  maxRetention: 604800,
  maxRequest: 16384,
  poll: 15,
};
export class Fault extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retry?: number,
  ) {
    super(message);
  }
}
export function json(
  data: unknown,
  status = 200,
  extra: Record<string, string> = {},
) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extra,
    },
  });
}
export const now = () => Math.floor(Date.now() / 1000);
export const iso = (n: number | null) =>
  n === null ? null : new Date(n * 1000).toISOString();
const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
export function base32(bytes: Uint8Array): string {
  let bits = 0,
    v = 0,
    out = "";
  for (const b of bytes) {
    v = (v << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(v >>> bits) & 31];
    }
  }
  if (bits) out += alphabet[(v << (5 - bits)) & 31];
  return out;
}
export function unbase32(s: string): Uint8Array {
  if (!/^[a-z2-7]{52}$/.test(s))
    throw new Fault(
      400,
      "invalid_public_key",
      "Public key must be 52 lowercase unpadded Base32 characters.",
    );
  let v = 0,
    bits = 0;
  const out = [];
  for (const ch of s) {
    v = (v << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((v >>> bits) & 255);
    }
  }
  const bytes = new Uint8Array(out);
  if (base32(bytes) !== s)
    throw new Fault(
      400,
      "invalid_public_key",
      "Noncanonical public key encoding.",
    );
  return bytes;
}
export function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
export function unb64(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(s))
    throw new Fault(400, "invalid_encoding", "Expected unpadded base64url.");
  try {
    return Uint8Array.from(
      atob(s.replaceAll("-", "+").replaceAll("_", "/")),
      (c) => c.charCodeAt(0),
    );
  } catch {
    throw new Fault(400, "invalid_encoding", "Invalid base64url.");
  }
}
export async function digest(data: Uint8Array | string) {
  return b64(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        typeof data === "string" ? enc.encode(data) : data,
      ),
    ),
  );
}
export async function readLimited(
  stream: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new Fault(
          413,
          "message_too_large",
          `Maximum size is ${max} bytes.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.length;
  }
  return all;
}
export function parseBody(raw: Uint8Array): Record<string, unknown> {
  if (!raw.length) return {};
  try {
    const b = JSON.parse(new TextDecoder().decode(raw));
    if (!b || Array.isArray(b) || typeof b !== "object") throw 0;
    return b;
  } catch {
    throw new Fault(400, "invalid_json", "Expected a JSON object.");
  }
}
export function only(obj: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(obj))
    if (!allowed.includes(key))
      throw new Fault(400, "unknown_field", `Unknown field: ${key}`);
}
export function integer(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new Fault(
      400,
      "invalid_parameter",
      `${name} must be an integer from ${min} to ${max}.`,
    );
  return value;
}
export async function limit(
  db: D1Database,
  key: string,
  max: number,
  window: number,
) {
  const t = now(),
    bucket = Math.floor(t / window);
  const row = await db
    .prepare(
      "INSERT INTO limits(key,value,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET value=value+1 WHERE value<? RETURNING value",
    )
    .bind(`${key}:${bucket}`, (bucket + 1) * window, max)
    .first();
  if (!row)
    throw new Fault(
      429,
      "rate_limited",
      "Capacity or rate limit reached. Retry later.",
      (bucket + 1) * window - t,
    );
}
export async function authenticate(
  req: Request,
  raw: Uint8Array,
  env: Env,
): Promise<string> {
  const owner = req.headers.get("X-Mail-Public-Key") || "",
    timestamp = req.headers.get("X-Mail-Timestamp") || "",
    nonce = req.headers.get("X-Mail-Nonce") || "",
    sig = req.headers.get("X-Mail-Signature") || "";
  if (!owner || !timestamp || !nonce || !sig)
    throw new Fault(
      401,
      "signature_required",
      "Sign this request with your mailbox private key. See /#authentication.",
    );
  const pub = unbase32(owner);
  if (!/^\d{10}$/.test(timestamp) || Math.abs(now() - Number(timestamp)) > 60)
    throw new Fault(
      401,
      "stale_signature",
      "Timestamp must be within 60 seconds of server time.",
    );
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(nonce))
    throw new Fault(
      400,
      "invalid_nonce",
      "Nonce must be 22–64 base64url characters; use 16 or more random bytes.",
    );
  const url = new URL(req.url);
  const canonical = [
    "agent-temp-mail:v1",
    url.origin,
    req.method.toUpperCase(),
    url.pathname + url.search,
    await digest(raw),
    timestamp,
    nonce,
  ].join("\n");
  let valid = false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      pub,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    valid = await crypto.subtle.verify(
      "Ed25519",
      key,
      unb64(sig),
      enc.encode(canonical),
    );
  } catch {}
  if (!valid)
    throw new Fault(401, "invalid_signature", "Signature verification failed.");
  await limit(env.DB, `owner:${owner}`, 30, 60);
  const used = await env.DB.prepare(
    "INSERT INTO nonces(owner,nonce,expires_at) VALUES(?,?,?) ON CONFLICT DO NOTHING RETURNING nonce",
  )
    .bind(owner, nonce, now() + 120)
    .first();
  if (!used)
    throw new Fault(
      409,
      "replayed_request",
      "Nonce already used. Sign retries with a fresh nonce.",
    );
  return owner;
}
export function ownerAddress(owner: string, env: Env) {
  return `${owner}@${env.DOMAIN}`;
}
export function authorize(address: string, owner: string, env: Env) {
  if (address === ownerAddress(owner, env)) return;
  if (
    ["hi", "feedback"].some((n) => address === `${n}@${env.DOMAIN}`) &&
    owner === env.ADMIN_PUBLIC_KEY
  )
    return;
  throw new Fault(
    403,
    "mailbox_forbidden",
    "This key does not own that mailbox.",
  );
}
export function secureError(err: unknown) {
  if (err instanceof Fault) return err;
  const s = String(err);
  if (/capacity/.test(s))
    return new Fault(
      503,
      "capacity_exhausted",
      "Storage capacity is full. Retry after cleanup.",
      600,
    );
  return new Fault(
    503,
    "temporarily_unavailable",
    "Service temporarily unavailable. Retry later.",
    60,
  );
}
