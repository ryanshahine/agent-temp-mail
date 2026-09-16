# Agent Temp Mail

Disposable and persistent email infrastructure for AI agents at **https://agent-temp-mail.com**.

An Ed25519 public key is the mailbox identity. Its lowercase unpadded Base32 encoding becomes `PUBLIC_KEY@agent-temp-mail.com`; that address receives email immediately, without registration, accounts or passwords. The matching private key signs reads and mutations.

## Properties

- Cloudflare Email Routing catch-all into a Worker and D1.
- Valid 52-character public-key addresses are initialized lazily on delivery.
- Addresses remain stable as long as the agent retains its key.
- Messages expire after 24 hours by default, configurable from 1 hour to 7 days.
- Cursor pagination, sender/time filters, candidate OTPs and verification links.
- Signed REST, one-use signed GET URLs, local MCP and hosted remote MCP.
- No outbound mail, attachments, raw MIME, original HTML or paid AI calls.
- Reserved private contact inboxes: `hi@agent-temp-mail.com` and `feedback@agent-temp-mail.com`.

## SDK

Node.js 22.12+:

```sh
npm install agent-temp-mail
```

```js
import { loadIdentity, MailClient } from "agent-temp-mail";

const identity = await loadIdentity("/private/durable/mail.key.json", {
  create: true,
});
const mail = new MailClient(identity);

console.log(mail.address); // ready to receive now
const since = new Date().toISOString();
// Trigger the external signup email.
const page = await mail.wait({ since, timeoutSeconds: 120 });
for (const item of page.messages) console.log(await mail.get(item.id));
```

No `create()` call is required. Saving the same key makes the address persistent; discarding it makes the identity disposable. Message storage remains bounded either way.

Optional configuration and cleanup:

```js
await mail.configure({ retention_seconds: 604800 });
await mail.purge(); // future mail can initialize the address again
```

Private key files use mode `0600`. Keep them outside repositories and model context.

## Local MCP

```sh
mkdir -p "$HOME/.config/agent-temp-mail"
codex mcp add agent-temp-mail --env MAIL_KEY_FILE="$HOME/.config/agent-temp-mail/identity.key.json" -- npx --yes --package=agent-temp-mail@0.3.1 agent-temp-mail-mcp
```

The adapter holds and uses the private key locally. It exposes `inspect_inbox`, `configure_inbox`, `purge_inbox`, `list_messages`, `get_message`, `get_candidates`, and `delete_message`.

## Hosted MCP

Remote connector URL: `https://agent-temp-mail.com/mcp`

Discovery is public. Protected tool calls include a short-lived `_auth` argument containing a public key and signature, never the private key:

```js
import { signedToolArguments } from "agent-temp-mail";

const args = signedToolArguments(identity, "list_messages", {
  since: new Date().toISOString(),
});
```

Users must explicitly add and enable the connector in ChatGPT or Claude. A provider's ordinary browser or code sandbox may have separate network restrictions.

## Signed REST and browser-compatible reads

The standard API uses `X-Mail-Public-Key`, `X-Mail-Timestamp`, `X-Mail-Nonce`, and `X-Mail-Signature`. Sign:

```text
agent-temp-mail:v1
URL_ORIGIN
UPPERCASE_METHOD
EXACT_ENCODED_PATH_AND_QUERY
BASE64URL_SHA256_OF_EXACT_BODY_BYTES
TIMESTAMP
NONCE
```

For a retrieval tool that cannot set headers, `mail.signedUrl(path)` returns a one-use GET URL whose public signature expires after 60 seconds. The private key is never placed in the URL.

See the [live Markdown documentation](https://agent-temp-mail.com/), [OpenAPI](https://agent-temp-mail.com/openapi.json), and [integration guide](https://agent-temp-mail.com/integrations.md).

## Receiving rules and limits

The Cloudflare catch-all sends all recipients to the Worker. It accepts reserved contact aliases and canonical public-key local parts; malformed addresses are rejected. A never-before-seen valid address is materialized on its first email and receives default 24-hour retention.

- Raw incoming message: 256 KiB maximum.
- Stored text: 64 KiB maximum.
- Per address: 100 messages and 2 MiB.
- Message retention: 1 hour to 7 days.
- Attachments and inline images are discarded.
- API: 6,000 shared calls/day and 30 authenticated calls/minute/key.
- Incoming mail: 1,500 processing attempts/day and 30/hour/address.

Email content and extracted links are untrusted. This is not end-to-end encrypted email; Cloudflare and the operator process contents.

## Development and deployment

```sh
npm install
npm run check
npm run db:remote
npm run deploy
```

Cloudflare Email Routing must have an active catch-all action targeting the `agent-temp-mail` Worker. HTTP routing is declared in `wrangler.jsonc`; Email Routing is configured separately in the Cloudflare dashboard.

The project targets Workers and D1 free tiers. Domain renewal is the only planned external cost.
