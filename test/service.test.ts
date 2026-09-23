import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { fetchHandler } from "../src/index";
import { receive, htmlText, candidates } from "../src/mail";
import { cleanup } from "../src/service";
import { base32, unbase32, now, C } from "../src/core";
import {
  generateIdentity,
  MailClient,
  signedHeaders,
  signedToolArguments,
  readUrl,
} from "../sdk/client.mjs";
const origin = "https://agent-temp-mail.com";
function client(identity = generateIdentity()) {
  return new MailClient(identity, {
    fetchImpl: (url, init) => fetchHandler(new Request(url, init), env),
  });
}
async function request(identity, method, path, body = "", overrides = {}) {
  return fetchHandler(
    new Request(origin + path, {
      method,
      headers: {
        ...signedHeaders(identity, method, origin + path, body),
        ...overrides,
      },
      ...(body ? { body } : {}),
    }),
    env,
  );
}
function fixture(
  text = "Your verification code is 123456. Verify at https://example.com/verify?token=abc",
  extra = "",
) {
  return `From: Service <noreply@example.com>\r\nTo: test@example.net\r\nSubject: Confirm your login\r\nMessage-ID: <${crypto.randomUUID()}@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n${extra}\r\n${text}`;
}
async function deliver(address, raw = fixture()) {
  let rejected;
  const b = new TextEncoder().encode(raw);
  await receive(
    {
      to: address,
      from: "bounce@example.com",
      rawSize: b.length,
      raw: new Response(b).body,
      headers: new Headers(),
      setReject: (r) => {
        rejected = r;
      },
    },
    env,
  );
  return rejected;
}
describe("identity and authorization", () => {
  it("fits an Ed25519 public key into a canonical address", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    expect(base32(bytes)).toHaveLength(52);
    expect(unbase32(base32(bytes))).toEqual(bytes);
    expect(() => unbase32("a".repeat(51) + "b")).toThrow("Noncanonical");
  });
  it("signs with the shipped SDK, isolates owners, and rejects tampering", async () => {
    const a = client(),
      b = client();
    await a.create();
    await expect(b.inspect(a.address)).rejects.toMatchObject({ status: 403 });
    const path = a.box();
    const h = signedHeaders(a.identity, "GET", origin + path);
    const altered = await fetchHandler(
      new Request(origin + path + "?x=1", { headers: h }),
      env,
    );
    expect(altered.status).toBe(401);
    expect(
      (
        await request(a.identity, "PATCH", path, '{"persistent":true}', {
          "X-Mail-Signature": h["X-Mail-Signature"],
        })
      ).status,
    ).toBe(401);
  });
  it("atomically rejects replayed concurrent requests", async () => {
    const a = client();
    await a.create();
    const path = a.box(),
      h = signedHeaders(a.identity, "GET", origin + path);
    const send = () =>
      fetchHandler(new Request(origin + path, { headers: h }), env);
    expect(
      (await Promise.all([send(), send()])).map((x) => x.status).sort(),
    ).toEqual([200, 409]);
  });
  it("supports one-use signed GET URLs without exposing the private key", async () => {
    const a = client();
    await deliver(a.address);
    const url = a.signedUrl(`${a.box()}/messages?limit=1`);
    expect(url).not.toContain(a.identity.private_key_pkcs8);
    const first = await fetchHandler(new Request(url), env);
    expect(first.status).toBe(200);
    expect((await first.json()).messages).toHaveLength(1);
    expect((await fetchHandler(new Request(url), env)).status).toBe(409);
  });
  it("supports a reusable read-only capability before and after delivery", async () => {
    const a = client();
    const url = a.readUrl({ ttlSeconds: 600 });
    expect(url).not.toContain(a.identity.private_key_pkcs8);
    const empty = await fetchHandler(new Request(url), env);
    expect(empty.status).toBe(200);
    expect(empty.headers.get("Cache-Control")).toBe("no-store");
    expect(empty.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(empty.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect((await empty.json()).messages).toHaveLength(0);
    await deliver(a.address, fixture("Your code is 246810"));
    const received = await fetchHandler(new Request(url), env);
    const body = await received.json();
    expect(body.address).toBe(a.address);
    expect(body.messages[0].text).toContain("246810");
    expect(body.messages[0].candidates.source_message_id).toBe(
      body.messages[0].id,
    );
    expect((await fetchHandler(new Request(url), env)).status).toBe(200);
    expect(
      (
        await fetchHandler(
          new Request(url, { method: "POST", body: '{"retention":1}' }),
          env,
        )
      ).status,
    ).toBe(405);
  });
  it("returns only the newest 10 messages in newest-first order", async () => {
    const a = client();
    const url = a.readUrl();
    for (let n = 0; n < 11; n++)
      await deliver(a.address, fixture(`Sequence ${n}; code 123456`));
    const messages = (await (await fetchHandler(new Request(url), env)).json())
      .messages;
    expect(messages).toHaveLength(10);
    expect(messages[0].text).toContain("Sequence 10");
    expect(messages[9].text).toContain("Sequence 1");
    expect(
      messages.some((message) => message.text.includes("Sequence 0")),
    ).toBe(false);
  });
  it("rejects expired, overlong, altered, and wrong-owner read capabilities", async () => {
    const a = client(),
      b = client();
    const expired = readUrl(a.identity, {
      now: now() - 2,
      ttlSeconds: 1,
    });
    const tooLong = readUrl(a.identity, {
      now: now() + 5,
      ttlSeconds: 900,
    });
    expect((await fetchHandler(new Request(expired), env)).status).toBe(401);
    expect((await fetchHandler(new Request(tooLong), env)).status).toBe(401);

    const valid = a.readUrl({ ttlSeconds: 600 });
    const changedExpiry = valid.replace(
      /\.(\d{10})\./,
      (_all, expiry) => `.${Number(expiry) + 1}.`,
    );
    expect((await fetchHandler(new Request(changedExpiry), env)).status).toBe(
      401,
    );
    const changedOwner = valid.replace(
      a.identity.public_key,
      b.identity.public_key,
    );
    expect((await fetchHandler(new Request(changedOwner), env)).status).toBe(
      401,
    );
    const badSignature = valid.slice(0, -1) + (valid.endsWith("A") ? "B" : "A");
    expect((await fetchHandler(new Request(badSignature), env)).status).toBe(
      401,
    );
  });
  it("rejects old signatures and signature reuse on another origin", async () => {
    const a = client();
    await a.create();
    const path = a.box();
    const stale = signedHeaders(a.identity, "GET", origin + path, "", {
      timestamp: String(now() - 61),
    });
    expect(
      (await fetchHandler(new Request(origin + path, { headers: stale }), env))
        .status,
    ).toBe(401);
    const h = signedHeaders(a.identity, "GET", origin + path);
    expect(
      (
        await fetchHandler(
          new Request("https://other.example" + path, { headers: h }),
          env,
        )
      ).status,
    ).toBe(401);
  });
  it("returns auth errors as JSON and keeps private-key convenience calls same-origin", async () => {
    expect(
      (await fetchHandler(new Request(origin + "/v1/inboxes/x"), env)).status,
    ).toBe(401);
    expect(
      (
        await fetchHandler(
          new Request(origin + "/v1/easy", {
            method: "POST",
            headers: {
              Origin: "https://evil.example",
              "Content-Type": "application/json",
            },
            body: '{"tool":"new_address","arguments":{}}',
          }),
          env,
        )
      ).status,
    ).toBe(403);
  });
});
describe("inbox lifecycle", () => {
  it("makes a generated address immediately usable and changes retention only for new mail", async () => {
    const a = client();
    const first = await a.inspect();
    expect(first.persistent).toBe(true);
    expect(first.accepting_mail).toBe(true);
    expect(first.storage_initialized).toBe(false);
    expect(await deliver(a.address)).toBeUndefined();
    const page = await a.list();
    const before = await a.get(page.messages[0].id);
    const configured = await a.configure({ retention_seconds: 604800 });
    expect(configured.retention_seconds).toBe(604800);
    expect((await a.get(before.id)).expires_at).toBe(before.expires_at);
    await expect(
      a.configure({ persistent: false, ttl_seconds: 3600 }),
    ).rejects.toMatchObject({ status: 400, code: "address_always_active" });
  });
  it("replaces legacy expired metadata automatically on the next delivery", async () => {
    const a = client();
    await a.create();
    await deliver(a.address, fixture("Old code is 111111"));
    await env.DB.prepare("UPDATE inboxes SET expires_at=? WHERE address=?")
      .bind(now() - 1, a.address)
      .run();
    expect((await a.inspect()).storage_initialized).toBe(false);
    expect(
      await deliver(a.address, fixture("New code is 222222")),
    ).toBeUndefined();
    expect((await a.list()).messages).toHaveLength(1);
  });
  it("purges stored mail while leaving the public-key address receivable", async () => {
    const a = client(),
      b = client();
    await a.create();
    await deliver(a.address);
    await expect(b.deleteInbox(a.address)).rejects.toMatchObject({
      status: 403,
    });
    await a.deleteInbox();
    expect((await a.inspect()).storage_initialized).toBe(false);
    expect((await env.DB.prepare("SELECT * FROM usage").first()).bytes).toBe(0);
    expect(await deliver(a.address)).toBeUndefined();
    expect((await a.list()).messages).toHaveLength(1);
  });
  it("protects contact aliases from ordinary keys", async () => {
    const a = client();
    await expect(a.inspect("hi@agent-temp-mail.com")).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      a.create({ address: "hi@agent-temp-mail.com" }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
describe("mail ingestion and retrieval", () => {
  it("extracts codes and source IDs, filters, pages and continues after an empty poll", async () => {
    const a = client();
    await a.create();
    const empty = await a.list();
    await deliver(a.address, fixture("Your code is 123456"));
    await deliver(a.address, fixture("Your code is 654321"));
    const page = await a.list({
      after: empty.after,
      limit: 1,
      sender: "NOREPLY@EXAMPLE.COM",
      since: new Date((now() - 5) * 1000).toISOString(),
    });
    expect(page.messages).toHaveLength(1);
    expect(page.has_more).toBe(true);
    const next = await a.list({ after: page.after, limit: 1 });
    expect(next.messages[0].id).not.toBe(page.messages[0].id);
    expect((await a.list({ after: next.after })).messages).toHaveLength(0);
    const found = await a.candidates({ limit: 1 });
    expect(found.messages[0].candidates.source_message_id).toBe(
      page.messages[0].id,
    );
    expect(found.messages[0].candidates.otp_codes[0].value).toBe("123456");
    expect(
      (await a.list({ sender: "other@example.com" })).messages,
    ).toHaveLength(0);
  });
  it("converts HTML-only mail and discards attachment contents and scripts", async () => {
    const a = client();
    await a.create();
    const mime = `From: Sender <noreply@example.com>\r\nSubject: Verify\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="xxx"\r\n\r\n--xxx\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Your code is <b>889900</b></p><a href="https://example.com/verify?a=1&amp;b=2">Verify</a><script>BAD_SCRIPT</script><img src="https://tracker.invalid">\r\n--xxx\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="secret.txt"\r\n\r\nATTACHMENT_SECRET code 777777\r\n--xxx--`;
    expect(await deliver(a.address, mime)).toBeUndefined();
    const item = await a.get((await a.list()).messages[0].id);
    expect(item.text).toContain("889900");
    expect(item.text).not.toMatch(
      /BAD_SCRIPT|ATTACHMENT_SECRET|tracker.invalid/,
    );
    expect(item.attachments_removed).toBe(true);
    expect(item.candidates.links[0].url).toBe(
      "https://example.com/verify?a=1&b=2",
    );
    const row = await env.DB.prepare(
      "SELECT text,candidates FROM messages",
    ).first();
    expect(JSON.stringify(row)).not.toContain("ATTACHMENT_SECRET");
  });
  it("deduplicates identical deliveries and maintains storage counters", async () => {
    const a = client();
    await a.create();
    const raw = fixture();
    await deliver(a.address, raw);
    await deliver(a.address, raw);
    expect((await a.list()).messages).toHaveLength(1);
    const msg = (await a.list()).messages[0];
    await a.deleteMessage(msg.id);
    expect((await a.inspect()).stored_bytes).toBe(0);
  });
  it("rejects unknown and oversized mail without storing it", async () => {
    expect(await deliver("unknown@agent-temp-mail.com")).toContain("Unknown");
    const a = client();
    await a.create();
    expect(await deliver(a.address, fixture("x".repeat(C.raw)))).toContain(
      "256 KiB",
    );
    expect((await a.list()).messages).toHaveLength(0);
  });
  it("truncates UTF-8 safely and rejects cross-inbox cursors", async () => {
    const a = client(),
      b = client();
    await a.create();
    await b.create();
    await deliver(
      a.address,
      fixture("Your code is 123456. " + "é".repeat(40000)),
    );
    const item = await a.get((await a.list()).messages[0].id);
    expect(item.truncated).toBe(true);
    expect(new TextEncoder().encode(item.text).length).toBeLessThanOrEqual(
      C.text,
    );
    expect(item.text).not.toContain("\ufffd");
    await expect(
      b.list({ after: (await a.list()).after }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("hides expired messages and reclaims counters in cleanup", async () => {
    const a = client();
    await a.create({ persistent: true });
    await deliver(a.address);
    const id = (await a.list()).messages[0].id;
    await env.DB.prepare("UPDATE messages SET expires_at=?")
      .bind(now() - 1)
      .run();
    expect((await a.list()).messages).toHaveLength(0);
    await expect(a.get(id)).rejects.toMatchObject({ status: 404 });
    await cleanup(env);
    expect((await a.inspect()).stored_bytes).toBe(0);
  });
  it("enforces capacity atomically in SQL", async () => {
    const a = client();
    await a.create();
    await env.DB.prepare("UPDATE usage SET bytes=67108864 WHERE id=1").run();
    expect(await deliver(a.address)).toContain("capacity");
    expect((await a.list()).messages).toHaveLength(0);
    await env.DB.prepare("UPDATE usage SET bytes=0 WHERE id=1").run();
  });
});
describe("agent interfaces", () => {
  it("bootstraps fresh keys even with the same salt, without registering", async () => {
    const gen = async () => {
      const r = await fetchHandler(
        new Request(origin + "/v1/bootstrap", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{"salt":"agent-provided"}',
        }),
        env,
      );
      expect(r.headers.get("Cache-Control")).toBe("no-store");
      return r.json();
    };
    const a = await gen(),
      b = await gen();
    expect(a.public_key).not.toBe(b.public_key);
    expect(a.ready_to_receive).toBe(true);
    const c = client(a);
    expect((await c.inspect()).address).toBe(a.address);
  });
  it("supports MCP discovery, signed tool calls, and structured errors", async () => {
    const a = client();
    const call = (method, params) =>
      a.request("POST", "/mcp", { jsonrpc: "2.0", id: 1, method, params });
    expect(
      (await call("initialize", { protocolVersion: "2025-11-25" })).result
        .capabilities.tools,
    ).toBeDefined();
    const tools = (await call("tools/list", {})).result.tools;
    expect(tools).toHaveLength(7);
    expect(
      tools.every((tool) => tool.inputSchema.required.includes("_auth")),
    ).toBe(true);
    expect(
      (
        await call("tools/call", {
          name: "configure_inbox",
          arguments: { retention_seconds: 604800 },
        })
      ).result.structuredContent.retention_seconds,
    ).toBe(604800);
    const wrong = await call("tools/call", {
      name: "inspect_inbox",
      arguments: { address: "hi@agent-temp-mail.com" },
    });
    expect(wrong.result.isError).toBe(true);
    expect(wrong.result.structuredContent.error.code).toBe("mailbox_forbidden");
    const unauth = await fetchHandler(
      new Request(origin + "/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://chatgpt.com",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "inspect_inbox" },
        }),
      }),
      env,
    );
    expect(unauth.status).toBe(200);
    const unauthBody = await unauth.json();
    expect(unauthBody.result.isError).toBe(true);
    expect(unauthBody.result.structuredContent.error.code).toBe(
      "signature_required",
    );

    const hostedArgs = signedToolArguments(a.identity, "inspect_inbox", {});
    const hosted = await fetchHandler(
      new Request(origin + "/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "inspect_inbox", arguments: hostedArgs },
        }),
      }),
      env,
    );
    expect((await hosted.json()).result.structuredContent.address).toBe(
      a.address,
    );
  });
  it("publishes Markdown and machine-readable contracts without credentials", async () => {
    const home = await fetchHandler(new Request(origin), env);
    expect(home.headers.get("Content-Type")).toContain("text/html");
    expect(await home.text()).toContain("read_url");
    const llms = await fetchHandler(new Request(origin + "/llms.txt"), env);
    expect(llms.headers.get("Content-Type")).toContain("text/plain");
    expect(await llms.text()).toContain("agent-temp-mail:read:v1");
    const chatgpt = await fetchHandler(new Request(origin + "/chatgpt"), env);
    expect(await chatgpt.text()).toContain("agent-temp-mail read-url");
    const spec = await (
      await fetchHandler(new Request(origin + "/openapi.json"), env)
    ).json();
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.paths["/r/{capability}"]).toBeDefined();
    expect(spec.paths["/v1/inboxes/{address}/candidates"]).toBeDefined();
  });
  it("returns actionable validation and rate-limit errors", async () => {
    const a = client();
    await expect(a.create({ ttl_seconds: 1 })).rejects.toMatchObject({
      status: 400,
      code: "address_always_active",
    });
    await env.DB.prepare(
      "INSERT INTO limits(key,value,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
      .bind(`daily:api:${Math.floor(now() / 86400)}`, 6000, now() + 3600)
      .run();
    const r = await request(a.identity, "POST", "/v1/inboxes", "{}");
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});

describe("HTTP convenience mode", () => {
  async function easy(tool, args = {}, key, options = {}) {
    return fetchHandler(
      new Request(
        (options.origin || origin) + "/v1/easy" + (options.query || ""),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(key === undefined ? {} : { Authorization: `Bearer ${key}` }),
            ...(options.headers || {}),
          },
          body: JSON.stringify({ tool, arguments: args }),
        },
      ),
      env,
    );
  }
  it("creates a persistent inbox, reads real parsed mail, and keeps the key out of storage and subsequent responses", async () => {
    const response = await easy("create_inbox", {
      persistent: true,
      retention_seconds: 604800,
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const created = await response.json();
    expect(created.result.persistent).toBe(true);
    expect(created.result.expires_at).toBe(null);
    expect(created.security.key_persisted_by_application).toBe(false);
    const key = created.access_key;
    expect(key).toHaveLength(64);
    const signed = client({
      public_key: created.public_key,
      private_key_pkcs8: key,
    });
    expect((await signed.inspect()).address).toBe(created.result.address);
    expect(await deliver(created.result.address)).toBeUndefined();
    const page = await (await easy("list_messages", {}, key)).json();
    expect(page.result.messages).toHaveLength(1);
    expect(JSON.stringify(page)).not.toContain(key);
    const read = await (
      await easy("get_message", { message_id: page.result.messages[0].id }, key)
    ).json();
    expect(read.result.text).toContain("123456");
    expect(read.result.untrusted).toBe(true);
    for (const table of ["inboxes", "messages", "limits", "nonces", "usage"]) {
      expect(
        JSON.stringify(await env.DB.prepare(`SELECT * FROM ${table}`).all()),
      ).not.toContain(key);
    }
    const deleted = await (await easy("delete_inbox", {}, key)).json();
    expect(deleted.result.deleted).toBe(true);
    const afterPurge = await (await easy("inspect_inbox", {}, key)).json();
    expect(afterPurge.result.storage_initialized).toBe(false);
  });
  it("isolates owners and rejects malformed, missing and cross-origin credentials without echoing them", async () => {
    const a = client(),
      b = client();
    await a.create();
    await b.create();
    expect(
      (
        await easy(
          "list_messages",
          { address: a.address },
          b.identity.private_key_pkcs8,
        )
      ).status,
    ).toBe(403);
    expect((await easy("list_messages")).status).toBe(401);
    const bad = "A".repeat(64);
    const invalid = await easy("create_inbox", {}, bad);
    expect(invalid.status).toBe(401);
    expect(await invalid.text()).not.toContain(bad);
    expect(
      (
        await easy("list_messages", {}, a.identity.private_key_pkcs8, {
          headers: { Origin: "https://other.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await easy("list_messages", {}, a.identity.private_key_pkcs8, {
          query: "?access_key=do-not-put-secrets-in-urls",
        })
      ).status,
    ).toBe(400);
    const insecure = await easy(
      "list_messages",
      {},
      a.identity.private_key_pkcs8,
      { origin: "http://agent-temp-mail.com" },
    );
    expect(insecure.status).toBe(400);
    expect(insecure.headers.get("Location")).toBeNull();
    expect(
      (await easy("unknown_tool", {}, a.identity.private_key_pkcs8)).status,
    ).toBe(400);
    expect(
      (await easy("list_messages", [], a.identity.private_key_pkcs8)).status,
    ).toBe(400);
  });
  it("keeps legacy lifecycle aliases compatible and shares owner limits", async () => {
    const a = client();
    await a.create();
    const again = await (
      await easy(
        "create_inbox",
        { persistent: true },
        a.identity.private_key_pkcs8,
      )
    ).json();
    expect(again.result.persistent).toBe(true);
    expect(again.access_key).toBeUndefined();
    const extended = await (
      await easy(
        "extend_inbox",
        { persistent: true },
        a.identity.private_key_pkcs8,
      )
    ).json();
    expect(extended.result.persistent).toBe(true);
    for (let i = 0; i < 27; i++)
      expect(
        (await easy("inspect_inbox", {}, a.identity.private_key_pkcs8)).status,
      ).toBe(200);
    await expect(a.inspect()).rejects.toMatchObject({ status: 429 });
  });
  it("limits generated identities and documents the current convenience tools", async () => {
    for (let i = 0; i < 5; i++)
      expect((await easy("create_inbox")).status).toBe(201);
    expect((await easy("create_inbox")).status).toBe(429);
    const spec = await (
      await fetchHandler(new Request(origin + "/openapi.json"), env)
    ).json();
    expect(
      spec.paths["/v1/easy"].post.requestBody.content["application/json"].schema
        .oneOf,
    ).toHaveLength(8);
    expect(spec.components.securitySchemes.MailboxPrivateKey.scheme).toBe(
      "bearer",
    );
  });
});
