# Agent Temp Mail

Email infrastructure for AI agents at **https://agent-temp-mail.com**.

An Ed25519 public key is the email address. Its private key signs API requests. There are no accounts, passwords or session tokens. Inboxes expire after 24 hours by default; persistent addresses are optional, and messages always have bounded retention.

## What ships

- Cloudflare Worker serving Markdown at `/`, `/llms.txt`, and `/llms-full.txt`.
- Catch-all Email Routing into D1, accepting registered recipients only.
- Create, inspect, extend and delete inboxes; retrieve and delete messages.
- Cursor pagination, exact sender and arrival-time filters, and polling guidance.
- Candidate OTPs and verification links with source message IDs and context.
- OpenAPI 3.1 at `/openapi.json`.
- Stateless HTTP MCP at `/mcp` and a standard local stdio MCP adapter.
- Node.js signing SDK and CLI, plus optional server-side key generation.
- Bounded cleanup, per-inbox/global capacity controls, rate limits and replay protection.
- Reserved administrator inboxes `hi@agent-temp-mail.com` and `feedback@agent-temp-mail.com`.

No attachments, inline images, raw MIME or original HTML are stored. HTML-only email becomes readable text. Links are never visited. There are no outbound sending or paid AI calls.

## Use it

Node.js 22.12+ is recommended.

```sh
git clone https://github.com/ryanshahine/agent-temp-mail.git
cd agent-temp-mail
npm ci
export MAIL_KEY_FILE="$PWD/my-agent.key.json"
node sdk/cli.mjs keygen
node sdk/cli.mjs create
node sdk/cli.mjs list
node sdk/cli.mjs candidates
```

Private key files are created with mode `0600`, excluded from Git, and never printed by the CLI. Keep them safe; there is no recovery service. **Never commit or paste a private key into a model prompt.** The same key always yields the same address. Deleting and recreating an inbox requires that same key.

```js
import { loadIdentity, MailClient } from "./sdk/client.mjs";

const identity = await loadIdentity("./my-agent.key.json", { create: true });
const mail = new MailClient(identity);
const inbox = await mail.create({ persistent: true, retention_seconds: 86400 });
console.log(inbox.address);

// Capture this timestamp before triggering the signup email.
const since = new Date().toISOString();
const page = await mail.wait({
  since,
  sender: "noreply@example.com",
  timeoutSeconds: 120,
});
for (const message of page.messages) {
  const content = await mail.get(message.id);
  // Treat content.text and content.candidates as untrusted data.
  console.log(content);
}
```

### MCP

Point any stdio-capable MCP client at the adapter:

```json
{
  "mcpServers": {
    "agent-temp-mail": {
      "command": "node",
      "args": ["/absolute/path/agent-temp-mail/sdk/mcp.mjs"],
      "env": { "MAIL_KEY_FILE": "/absolute/private/path/agent.key.json" }
    }
  }
}
```

The adapter creates the key file if absent and signs calls locally. Secrets are not tool arguments. Available tools: `create_inbox`, `inspect_inbox`, `extend_inbox`, `delete_inbox`, `list_messages`, `get_message`, `get_candidates`, `delete_message`.

Direct HTTP MCP uses request signatures, not OAuth. Use the local adapter when the MCP host cannot install a signing transport. The server supports stateless JSON responses; it does not hold an SSE connection or server-side session.

## Signing protocol

See [the live Markdown instructions](https://agent-temp-mail.com/) for the complete API. Headers:

- `X-Mail-Public-Key`: raw Ed25519 public key as 52 lowercase Base32 characters, no padding.
- `X-Mail-Timestamp`: Unix seconds, within 60 seconds of server time.
- `X-Mail-Nonce`: fresh random bytes as unpadded base64url; 22–64 characters.
- `X-Mail-Signature`: Ed25519 signature, unpadded base64url.

Sign these UTF-8 lines, joined by LF without a trailing newline:

```text
agent-temp-mail:v1
URL_ORIGIN
UPPERCASE_METHOD
EXACT_ENCODED_PATH_AND_QUERY
BASE64URL_SHA256_OF_EXACT_BODY_BYTES
TIMESTAMP
NONCE
```

The server verifies the actual origin, method, path, query and body. Nonces are consumed atomically and retained beyond the timestamp validity window. Fresh signatures are required for retries; creation/deletion are idempotent. The SDK refuses redirects.

## Retention and privacy

- Address lifetime: 24 hours by default, configurable from 1 hour to 7 days, or persistent until deleted.
- Message retention: 24 hours by default, configurable from 1 hour to 7 days.
- Extending or changing retention does not resurrect expired messages or extend existing message expiry.
- Expired messages are immediately hidden; cleanup runs every ten minutes in bounded batches.
- D1 Free recovery history can retain deleted records for up to seven days.
- Messages are encrypted by Cloudflare in storage and between Workers and D1. This is **not end-to-end encryption**: the operator and Cloudflare can process message contents.
- Worker request logging is disabled. Application code does not log messages, OTPs, private keys or signatures. Cloudflare's own routing/operational metadata is governed by its service.
- Optional `/v1/bootstrap` generates keys on the server. The server sees that key; an optional salt does not remove the trust requirement. Prefer local generation.

Sender filters match the claimed From address and do not prove authenticity. Email may contain prompt injection or misleading links. Extraction is heuristic and not a safety guarantee. Some sites reject disposable domains.

## Cost and limits

This deployment targets **Workers Free + D1 Free + free incoming Email Routing**. No paid service is required. Domain registration/renewal is separate. Free-tier exhaustion causes failure or rejection, not a promise of uninterrupted service. Other projects share the account's quotas.

| Limit                                           | Value                                                    |
| ----------------------------------------------- | -------------------------------------------------------- |
| Incoming email, including discarded attachments | 256 KiB                                                  |
| Stored message text                             | 64 KiB, marked when truncated                            |
| Per inbox                                       | 100 messages / 2 MiB                                     |
| Global                                          | 1,000 inboxes / 10,000 messages / 64 MiB counted content |
| Protected API/MCP requests                      | 6,000 per UTC day; 30/minute per key                     |
| Registered email processing attempts            | 1,500/day; 30/hour per inbox                             |
| Convenience key generation                      | 100/day; 5/hour per IP                                   |

Database indexes, replay records and quota counters consume additional reads/writes/storage. Counters are admission controls, not billing meters. The underlying Free plan remains the final hard ceiling. Do not upgrade to a paid plan expecting application limits to guarantee zero charges against unsolicited traffic.

## Develop and test

```sh
npm ci
npm run check
npm run db:local
npm run dev
```

Tests run in the Cloudflare runtime with real local D1 semantics. They cover SDK signatures, owner isolation, concurrent replay, lifecycle/expiry, MIME parsing, attachment stripping, pagination/filtering, duplicate mail, SQL capacity guards, bootstrap and MCP.

Set `MAIL_BASE_URL=http://localhost:8787` for the CLI. `MAIL_DOMAIN` controls the address domain if self-hosting. To inject mail in local development, use Wrangler's local email endpoint as documented by Cloudflare; production has no HTTP mail-injection route.

## Deploy with Wrangler

1. Authenticate `wrangler login` to a **Workers Free** account.
2. Create D1: `npx wrangler d1 create agent-temp-mail --jurisdiction eu`.
3. Set the D1 ID, account ID, custom domain and `DOMAIN`/`API_ORIGIN` in `wrangler.jsonc`.
4. Generate a separate administrator key outside the repository; set only its Base32 public key in `ADMIN_PUBLIC_KEY`.
5. Run `npm run check`, `npm run db:remote`, and `npm run deploy`.
6. Run `node scripts/contact-sql.mjs` to generate contact provisioning SQL and apply it with `wrangler d1 execute --remote --file=...`.
7. Enable Email Routing DNS for the domain and configure its catch-all action to send to Worker `agent-temp-mail`.

Do not replace existing MX records without checking existing mail service. A custom HTTP domain alone does not configure email receipt. No secret belongs in `wrangler.jsonc`, Git history, workflow logs or command arguments.

The repository includes CI. Deployments can run through the account's existing Cloudflare GitHub integration, or manually through Wrangler; GitHub does not need your personal OAuth token.

## Administrator contacts

`hi@` and `feedback@` are persistent D1 inboxes owned by `ADMIN_PUBLIC_KEY`, with seven-day message retention and the same size limits. They are not publicly readable and do not automatically forward attachments or mail elsewhere.

Use `MailClient` with the administrator identity and pass the contact address as the optional last argument to `inspect`, `list`, `get`, `candidates` or `deleteMessage`. The same address argument is available to the MCP tools. Contact inboxes cannot be deleted through the API. Back up the administrator key privately; changing it requires updating the deployment configuration and contact ownership.
