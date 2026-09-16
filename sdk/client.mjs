import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign,
  randomBytes,
  createHash,
} from "node:crypto";
import { readFile, writeFile, chmod } from "node:fs/promises";
const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
export function base32(bytes) {
  let v = 0,
    bits = 0,
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
export function generateIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    public_key: base32(
      Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url"),
    ),
    private_key_pkcs8: privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64url"),
  };
}
export function validateIdentity(identity) {
  const key = createPrivateKey({
    key: Buffer.from(identity.private_key_pkcs8, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  const pub = createPublicKey(key);
  if (
    pub.asymmetricKeyType !== "ed25519" ||
    base32(Buffer.from(pub.export({ format: "jwk" }).x, "base64url")) !==
      identity.public_key
  )
    throw new Error("Invalid or mismatched Ed25519 identity.");
  return identity;
}
export async function loadIdentity(path, { create = false } = {}) {
  try {
    return validateIdentity(JSON.parse(await readFile(path, "utf8")));
  } catch (e) {
    if (e.code !== "ENOENT" || !create) throw e;
    const identity = generateIdentity();
    try {
      await writeFile(path, JSON.stringify(identity) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (error.code === "EEXIST") return loadIdentity(path);
      throw error;
    }
    await chmod(path, 0o600);
    return identity;
  }
}
export function signedHeaders(
  identity,
  method,
  url,
  body = "",
  {
    timestamp = String(Math.floor(Date.now() / 1000)),
    nonce = randomBytes(18).toString("base64url"),
  } = {},
) {
  const u = new URL(url);
  const canonical = [
    "agent-temp-mail:v1",
    u.origin,
    method.toUpperCase(),
    u.pathname + u.search,
    createHash("sha256").update(body).digest("base64url"),
    timestamp,
    nonce,
  ].join("\n");
  const key = createPrivateKey({
    key: Buffer.from(identity.private_key_pkcs8, "base64url"),
    type: "pkcs8",
    format: "der",
  });
  return {
    "X-Mail-Public-Key": identity.public_key,
    "X-Mail-Timestamp": timestamp,
    "X-Mail-Nonce": nonce,
    "X-Mail-Signature": sign(null, Buffer.from(canonical), key).toString(
      "base64url",
    ),
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
}
function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}
export function signedUrl(
  identity,
  url,
  {
    timestamp = String(Math.floor(Date.now() / 1000)),
    nonce = randomBytes(18).toString("base64url"),
  } = {},
) {
  const headers = signedHeaders(identity, "GET", url, "", {
    timestamp,
    nonce,
  });
  const u = new URL(url);
  u.searchParams.set("mail_public_key", identity.public_key);
  u.searchParams.set("mail_timestamp", timestamp);
  u.searchParams.set("mail_nonce", nonce);
  u.searchParams.set("mail_signature", headers["X-Mail-Signature"]);
  return u.href;
}
export function signedToolArguments(
  identity,
  name,
  args = {},
  {
    origin = "https://agent-temp-mail.com",
    timestamp = String(Math.floor(Date.now() / 1000)),
    nonce = randomBytes(18).toString("base64url"),
  } = {},
) {
  const canonical = [
    "agent-temp-mail:mcp:v1",
    new URL(origin).origin,
    name,
    createHash("sha256").update(stableJson(args)).digest("base64url"),
    timestamp,
    nonce,
  ].join("\n");
  const key = createPrivateKey({
    key: Buffer.from(identity.private_key_pkcs8, "base64url"),
    type: "pkcs8",
    format: "der",
  });
  return {
    ...args,
    _auth: {
      public_key: identity.public_key,
      timestamp,
      nonce,
      signature: sign(null, Buffer.from(canonical), key).toString("base64url"),
    },
  };
}
export class MailClient {
  constructor(
    identity,
    {
      baseUrl = "https://agent-temp-mail.com",
      domain = "agent-temp-mail.com",
      fetchImpl = fetch,
    } = {},
  ) {
    this.identity = validateIdentity(identity);
    const u = new URL(baseUrl);
    if (
      u.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
    )
      throw new Error("HTTPS is required.");
    this.baseUrl = u.origin;
    this.address = `${identity.public_key}@${domain}`;
    this.fetch = fetchImpl;
  }
  async request(method, path, data) {
    const url = this.baseUrl + path,
      body = data === undefined ? "" : JSON.stringify(data);
    const response = await this.fetch(url, {
      method,
      headers: signedHeaders(this.identity, method, url, body),
      ...(body ? { body } : {}),
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400)
      throw new Error(
        "Refusing to redirect a signed request. Check MAIL_BASE_URL.",
      );
    const value = await response.json();
    if (!response.ok) {
      const err = new Error(value.error?.message || `HTTP ${response.status}`);
      Object.assign(err, { status: response.status, ...value.error });
      throw err;
    }
    return value;
  }
  box(address = this.address) {
    return `/v1/inboxes/${encodeURIComponent(address)}`;
  }
  create(options = {}) {
    return this.configure(options);
  }
  inspect(address) {
    return this.request("GET", this.box(address));
  }
  extend(options = {}, address) {
    return address
      ? this.request("PATCH", this.box(address), options)
      : this.configure(options);
  }
  configure(options = {}) {
    return this.request("POST", "/v1/inboxes", options);
  }
  deleteInbox(address) {
    return this.purge(address);
  }
  purge(address) {
    return this.request("DELETE", this.box(address));
  }
  signedUrl(path) {
    return signedUrl(this.identity, this.baseUrl + path);
  }
  list(filters = {}, address) {
    return this.request(
      "GET",
      `${this.box(address)}/messages${query(filters)}`,
    );
  }
  candidates(filters = {}, address) {
    return this.request(
      "GET",
      `${this.box(address)}/candidates${query(filters)}`,
    );
  }
  get(id, address) {
    return this.request(
      "GET",
      `${this.box(address)}/messages/${encodeURIComponent(id)}`,
    );
  }
  deleteMessage(id, address) {
    return this.request(
      "DELETE",
      `${this.box(address)}/messages/${encodeURIComponent(id)}`,
    );
  }
  async wait({ timeoutSeconds = 120, signal, ...filters } = {}) {
    const deadline =
      Date.now() + Math.min(Math.max(timeoutSeconds, 1), 600) * 1000;
    let after = filters.after;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const page = await this.list({ ...filters, ...(after ? { after } : {}) });
      if (page.messages.length) return page;
      after = page.after;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          done,
          Math.min(
            page.poll_after_seconds * 1000,
            Math.max(0, deadline - Date.now()),
          ),
        );
        function done() {
          signal?.removeEventListener("abort", abort);
          resolve();
        }
        function abort() {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(signal.reason);
        }
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    return { messages: [], after, timed_out: true };
  }
}
function query(args) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(args))
    if (v !== undefined) q.set(k, String(v));
  return q.size ? "?" + q : "";
}
