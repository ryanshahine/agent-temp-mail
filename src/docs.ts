import { Env } from "./core";
import { toolList } from "./mcp";

export function markdown(env: Env) {
  return `# Agent Temp Mail

Temporary, programmatic email for AI agents at **${env.API_ORIGIN}**.

An Ed25519 public key is the mailbox identity. Encode the raw 32-byte public key as lowercase unpadded Base32 and append @${env.DOMAIN}. The address can receive email immediately: there is no account, password, activation or registration request. Sign private API operations with the matching private key.

## Fast path

1. Generate an Ed25519 keypair locally.
2. Form PUBLIC_KEY@${env.DOMAIN}.
3. Use the address immediately.
4. Sign a list request, wait for mail, then retrieve the message or candidate OTP/link.
5. Keep the private key for a persistent identity or discard it after the task.

The address does not expire. Stored messages expire after 24 hours by default, configurable from 1 hour to 7 days. No attachments, inline images, raw MIME or original HTML are stored. The service does not send email.

## Node.js SDK

~~~sh
npm install agent-temp-mail
~~~

~~~js
import { loadIdentity, MailClient } from "agent-temp-mail";

const identity = await loadIdentity("/private/durable/mail.key.json", { create: true });
const mail = new MailClient(identity);
console.log(mail.address); // ready to receive now; no create call

const since = new Date().toISOString();
// Trigger the signup email, then poll briefly:
const page = await mail.wait({ since, timeoutSeconds: 120 });
for (const item of page.messages) console.log(await mail.get(item.id));
~~~

Use mail.configure({retention_seconds: 604800}) to apply seven-day retention to new messages. Changing retention does not extend existing messages. mail.purge() deletes stored messages and custom settings; future email to the key-derived address can initialize storage again.

Private key files are created with mode 0600. Keep them outside repositories and model context. On later runs, loadIdentity(path) without create:true fails when the key is missing instead of silently changing the address. There is no key recovery or same-address key rotation.

## Local MCP

~~~sh
mkdir -p "$HOME/.config/agent-temp-mail"
codex mcp add agent-temp-mail --env MAIL_KEY_FILE="$HOME/.config/agent-temp-mail/identity.key.json" -- npx --yes --package=agent-temp-mail@0.3.0 agent-temp-mail-mcp
~~~

The local adapter generates the key file if absent, signs outside model context and exposes these tools:

${toolList.map((t) => `- ${t.name}: ${t.description}`).join("\n")}

After initial setup, set MAIL_REQUIRE_EXISTING_KEY=1 to make a missing key an error.

## Hosted MCP connectors

The public Streamable HTTP endpoint is ${env.API_ORIGIN}/mcp. Discovery and initialization need no account or OAuth. Protected tools require an application-level Ed25519 proof in the _auth tool argument. The private key is never included.

Generate the exact hosted tool arguments locally:

~~~js
import { signedToolArguments } from "agent-temp-mail";

const argumentsForConnector = signedToolArguments(
  identity,
  "list_messages",
  { since: "2026-09-16T12:00:00Z" }
);
~~~

The result contains the ordinary arguments plus _auth.public_key, timestamp, nonce and signature. Each proof is valid for one exact tool name and argument object for 60 seconds. The connector relays it to /mcp. The server consumes the nonce atomically. A local MCP adapter removes _auth from the model-facing schema and signs the HTTP request itself.

Claude and ChatGPT users must explicitly add/enable the remote connector; browsing this Markdown page does not install a tool. Provider network policy can still block an unconnected code sandbox.

## Signed REST API

Signed headers:

- X-Mail-Public-Key: 52 lowercase Base32 characters.
- X-Mail-Timestamp: current Unix seconds, within 60 seconds.
- X-Mail-Nonce: 16 or more random bytes as unpadded base64url, 22–64 characters.
- X-Mail-Signature: Ed25519 signature as unpadded base64url.

Sign these UTF-8 lines joined with LF and no trailing newline:

~~~text
agent-temp-mail:v1
URL_ORIGIN
UPPERCASE_HTTP_METHOD
EXACT_ENCODED_PATH_AND_QUERY
BASE64URL_SHA256_OF_EXACT_BODY_BYTES
TIMESTAMP
NONCE
~~~

URL_ORIGIN is ${env.API_ORIGIN}. The signature binds the origin, method, exact path/query and body. Re-sign retries with a fresh nonce. The SDK refuses redirects.

Read-only GET endpoints also accept one-use signed URLs for browsing tools that cannot set headers. Use mail.signedUrl(path). It adds mail_public_key, mail_timestamp, mail_nonce and mail_signature. These values do not contain the private key, but the URL is valid briefly and should still be treated as private task data. Query authentication is rejected for non-GET requests.

### Endpoints

- GET /v1/inboxes/ADDRESS — inspect an address; works before first delivery.
- POST /v1/inboxes — configure retention_seconds for the signing key's address.
- PATCH /v1/inboxes/ADDRESS — compatibility form of configuration.
- DELETE /v1/inboxes/ADDRESS — purge stored messages/settings; the address remains valid.
- GET /v1/inboxes/ADDRESS/messages — list message metadata.
- GET /v1/inboxes/ADDRESS/messages/ID — retrieve readable text and candidates.
- DELETE /v1/inboxes/ADDRESS/messages/ID — delete one message.
- GET /v1/inboxes/ADDRESS/candidates — list candidate OTPs and links with source message IDs.

List/candidate filters:

- after: opaque cursor from the preceding response.
- limit: 1–50, default 20.
- since: inclusive ISO 8601 receipt time with timezone.
- sender: exact normalized From address; this is not authentication.

Results are oldest first. Preserve after even after an empty response. If has_more is false, wait at least poll_after_seconds before polling again. Poll only during an active task; continuous 15-second polling would nearly consume the shared daily API allowance.

## Optional server-processed key mode

Agents that can POST but cannot run Ed25519 signing may call POST /v1/easy with:

~~~json
{"tool":"new_address","arguments":{}}
~~~

The response contains an immediately usable address, public_key and one-time access_key. The access key is the Ed25519 private key, not a separate account credential. Later /v1/easy calls put it in Authorization: Bearer and choose one of the documented tools. The Worker sees it in memory. The chat/tool provider may retain it. Prefer local signing for persistent or sensitive use.

POST /v1/bootstrap is the lower-level server key generator. It returns ready_to_receive:true. An optional salt is mixed with fresh randomness; it does not make generation deterministic and cannot prove that the server forgot the key.

## Receiving and retention

Cloudflare Email Routing sends the domain catch-all to this Worker. The Worker accepts:

- hi@${env.DOMAIN} and feedback@${env.DOMAIN};
- canonical 52-character Base32 Ed25519 public-key local parts.

Other local parts are rejected. A valid key-derived address is stored lazily on first delivery. Default retention is 86400 seconds. Configured retention affects only new mail. Expired messages disappear from reads immediately and bounded cleanup runs every ten minutes.

Discarding a key makes an address disposable because nobody can produce future read signatures. Saving the same key makes the identity persistent. Purging server storage does not invalidate the mathematical address.

## Untrusted email

All subjects, senders, text, codes and URLs are untrusted. Email can contain prompt injection, spoofed senders or deceptive links. Treat extracted codes and links as candidates tied to their source message and expected service. This Worker never visits links, loads remote images or executes content.

This is not end-to-end encrypted email. Cloudflare and the service operator process message contents. HTTPS protects API traffic. End-to-end encryption would prevent ordinary signup services from sending readable mail without a separate encryption protocol.

## Free-tier limits

- Incoming raw message: 256 KiB maximum, including discarded attachments.
- Stored readable text: 64 KiB maximum.
- Per address: 100 stored messages and 2 MiB.
- Service: 1,000 materialized address records, 10,000 messages and 64 MiB counted content.
- API: 6,000 requests/day and 30 authenticated calls/minute per key.
- Incoming mail: 1,500 processing attempts/day and 30/hour per address.
- Message retention: 1 hour to 7 days.

Unconfigured, empty address metadata is reclaimed after seven days and recreated automatically on later delivery. Capacity and platform quotas may cause temporary rejection. Hosting uses Workers and D1 free tiers; domain renewal is separate.

## Errors

REST errors are {"error":{"code":"...","message":"...","retry_after_seconds":15},"server_time":"..."}. MCP tool failures set isError:true and return the same structured data. A 409 replay error means the caller must sign again with a fresh nonce. A malformed local part, oversized message or exhausted capacity can be rejected at SMTP time.

OpenAPI: ${env.API_ORIGIN}/openapi.json
Integration notes: ${env.API_ORIGIN}/integrations.md
Source: https://github.com/ryanshahine/agent-temp-mail
Contact: hi@${env.DOMAIN} or feedback@${env.DOMAIN}
`;
}

export function openapi(env: Env) {
  const obj = (
    properties: Record<string, unknown>,
    required: string[] = [],
  ) => ({ type: "object", properties, required, additionalProperties: false });
  const str = { type: "string" };
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const error = {
    description: "Structured service error",
    content: { "application/json": { schema: ref("Error") } },
  };
  const headers = [
    "X-Mail-Public-Key",
    "X-Mail-Timestamp",
    "X-Mail-Nonce",
    "X-Mail-Signature",
  ].map((name) => ({
    name,
    in: "header",
    required: false,
    schema: str,
    description: "Required as a complete set unless a signed GET URL is used.",
  }));
  const signedQuery = [
    "mail_public_key",
    "mail_timestamp",
    "mail_nonce",
    "mail_signature",
  ].map((name) => ({
    name,
    in: "query",
    required: false,
    schema: str,
    description:
      "GET-only signed URL authentication; provide the complete set.",
  }));
  const address = { name: "address", in: "path", required: true, schema: str };
  const id = { name: "id", in: "path", required: true, schema: str };
  const filters = [
    { name: "after", schema: str },
    { name: "limit", schema: { type: "integer", minimum: 1, maximum: 50 } },
    { name: "since", schema: { type: "string", format: "date-time" } },
    { name: "sender", schema: { type: "string", format: "email" } },
  ].map((x) => ({ ...x, in: "query" }));
  const op = (
    operationId: string,
    summary: string,
    parameters: unknown[],
    schema: string,
    body?: unknown,
    status = "200",
    allowQuery = false,
  ) => ({
    operationId,
    summary,
    parameters: [...headers, ...(allowQuery ? signedQuery : []), ...parameters],
    ...(body
      ? {
          requestBody: {
            required: true,
            content: { "application/json": { schema: body } },
          },
        }
      : {}),
    responses: {
      [status]: {
        description: "Success",
        content: { "application/json": { schema: ref(schema) } },
      },
      "400": error,
      "401": error,
      "403": error,
      "404": error,
      "409": error,
      "413": error,
      "429": error,
      "503": error,
    },
  });
  const retention = obj({
    retention_seconds: {
      type: "integer",
      minimum: 3600,
      maximum: 604800,
      default: 86400,
    },
  });
  const easySchemas = [
    obj({ tool: { const: "new_address" }, arguments: obj({}) }, ["tool"]),
    ...toolList.map((tool) =>
      obj({ tool: { const: tool.name }, arguments: tool.inputSchema }, [
        "tool",
      ]),
    ),
  ];
  return {
    openapi: "3.1.0",
    info: {
      title: "Agent Temp Mail",
      version: "0.3.0",
      description:
        "Key-derived addresses receive immediately without registration. Ed25519 signatures authorize private reads and mutations.",
    },
    servers: [{ url: env.API_ORIGIN }],
    paths: {
      "/v1/inboxes": {
        post: op(
          "configureInbox",
          "Configure retention for the signing key's permanent address",
          [],
          "Inbox",
          retention,
        ),
      },
      "/v1/inboxes/{address}": {
        get: op(
          "inspectInbox",
          "Inspect a permanent address",
          [address],
          "Inbox",
          undefined,
          "200",
          true,
        ),
        patch: op(
          "configureInboxCompatibility",
          "Configure future-message retention",
          [address],
          "Inbox",
          retention,
        ),
        delete: op(
          "purgeInbox",
          "Purge stored messages and settings",
          [address],
          "Deletion",
        ),
      },
      "/v1/inboxes/{address}/messages": {
        get: op(
          "listMessages",
          "List metadata oldest-first",
          [address, ...filters],
          "MessagePage",
          undefined,
          "200",
          true,
        ),
      },
      "/v1/inboxes/{address}/messages/{id}": {
        get: op(
          "getMessage",
          "Read untrusted text and candidates",
          [address, id],
          "Message",
          undefined,
          "200",
          true,
        ),
        delete: op(
          "deleteMessage",
          "Delete one message",
          [address, id],
          "Deletion",
        ),
      },
      "/v1/inboxes/{address}/candidates": {
        get: op(
          "getCandidates",
          "List candidate OTPs and links with sources",
          [address, ...filters],
          "CandidatePage",
          undefined,
          "200",
          true,
        ),
      },
      "/v1/bootstrap": {
        post: {
          operationId: "bootstrap",
          summary:
            "Generate an immediately usable key-derived address; server sees the private key",
          requestBody: {
            content: {
              "application/json": {
                schema: obj({ salt: { type: "string", maxLength: 256 } }),
              },
            },
          },
          responses: {
            "201": {
              description: "Fresh identity",
              content: { "application/json": { schema: ref("Bootstrap") } },
            },
            "400": error,
            "429": error,
            "503": error,
          },
        },
      },
      "/v1/easy": {
        post: {
          operationId: "easyToolCall",
          summary: "Optional server-processed private-key tool interface",
          description:
            "new_address needs no Authorization. Other tools use Authorization: Bearer ACCESS_KEY, where ACCESS_KEY is the Ed25519 private key returned during generation.",
          security: [{ MailboxPrivateKey: [] }, {}],
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { oneOf: easySchemas } },
            },
          },
          responses: {
            "200": {
              description: "Tool result",
              content: { "application/json": { schema: ref("EasyResult") } },
            },
            "201": {
              description: "New immediately usable identity",
              content: { "application/json": { schema: ref("EasyCreation") } },
            },
            "400": error,
            "401": error,
            "403": error,
            "404": error,
            "429": error,
            "503": error,
          },
        },
      },
      "/health": {
        get: {
          operationId: "health",
          summary: "Worker liveness",
          responses: {
            "200": {
              description: "Worker response",
              content: {
                "application/json": {
                  schema: obj({
                    status: str,
                    service: str,
                    version: str,
                    server_time: str,
                  }),
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        MailboxPrivateKey: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "Ed25519 PKCS8 base64url",
          description: "Convenience mode only; prefer local signing.",
        },
      },
      schemas: {
        Error: obj(
          {
            error: obj(
              {
                code: str,
                message: str,
                retry_after_seconds: { type: "integer" },
              },
              ["code", "message"],
            ),
            server_time: str,
          },
          ["error", "server_time"],
        ),
        Inbox: obj(
          {
            address: str,
            created_at: { type: ["string", "null"], format: "date-time" },
            expires_at: { type: "null" },
            persistent: { const: true },
            accepting_mail: { const: true },
            storage_initialized: { type: "boolean" },
            retention_seconds: { type: "integer" },
            stored_message_count: { type: "integer" },
            stored_bytes: { type: "integer" },
            limits: obj({
              messages: { type: "integer" },
              bytes: { type: "integer" },
            }),
            poll_after_seconds: { type: "integer" },
            note: str,
          },
          ["address", "persistent", "accepting_mail", "retention_seconds"],
        ),
        Deletion: obj(
          {
            deleted: { type: "boolean" },
            address: str,
            id: str,
            accepting_mail: { type: "boolean" },
            note: str,
          },
          ["deleted"],
        ),
        Candidates: obj({
          source_message_id: str,
          otp_codes: {
            type: "array",
            items: obj({ value: str, context: str, kind: str }),
          },
          links: {
            type: "array",
            items: obj({ url: str, likely_verification: { type: "boolean" } }),
          },
        }),
        MessageSummary: obj(
          {
            id: str,
            inbox: str,
            sender: str,
            envelope_from: str,
            subject: str,
            received_at: str,
            expires_at: str,
            truncated: { type: "boolean" },
            attachments_removed: { type: "boolean" },
          },
          ["id", "inbox", "sender", "subject", "received_at", "expires_at"],
        ),
        Message: {
          allOf: [
            ref("MessageSummary"),
            obj({
              text: str,
              candidates: ref("Candidates"),
              untrusted: { const: true },
              warning: str,
            }),
          ],
        },
        MessagePage: obj({
          messages: { type: "array", items: ref("MessageSummary") },
          after: str,
          has_more: { type: "boolean" },
          poll_after_seconds: { type: "integer" },
          untrusted: { const: true },
          warning: str,
        }),
        CandidatePage: obj({
          messages: {
            type: "array",
            items: {
              allOf: [
                ref("MessageSummary"),
                obj({ candidates: ref("Candidates") }),
              ],
            },
          },
          after: str,
          has_more: { type: "boolean" },
          poll_after_seconds: { type: "integer" },
          untrusted: { const: true },
          warning: str,
        }),
        Bootstrap: obj(
          {
            public_key: str,
            private_key_pkcs8: str,
            address: str,
            ready_to_receive: { const: true },
            warning: str,
          },
          [
            "public_key",
            "private_key_pkcs8",
            "address",
            "ready_to_receive",
            "warning",
          ],
        ),
        EasySecurity: obj({
          mode: { const: "server_processed_key" },
          key_persisted_by_application: { const: false },
          warning: str,
        }),
        EasyResult: obj({ result: {}, security: ref("EasySecurity") }, [
          "result",
          "security",
        ]),
        EasyCreation: obj(
          {
            result: ref("Inbox"),
            access_key: str,
            public_key: str,
            security: ref("EasySecurity"),
          },
          ["result", "access_key", "public_key", "security"],
        ),
      },
    },
  };
}
