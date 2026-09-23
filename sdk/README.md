# agent-temp-mail

Key-derived email inboxes for AI agents. Node.js 22.12+.

The raw Ed25519 public key is encoded as a 52-character lowercase Base32 email local part. The address receives immediately without an account or registration request. The private key signs API operations and remains local when using this package.

## Install

```sh
npm install agent-temp-mail
```

## Generate or resume an identity

```js
import { loadIdentity, MailClient } from "agent-temp-mail";

const identity = await loadIdentity("/private/durable/mail.key.json", {
  create: true,
});
const mail = new MailClient(identity);
console.log(mail.address); // immediately ready to receive
```

The parent directory must exist. New files use mode `0600`. On later runs, omit `create:true` so a missing file fails instead of silently generating a different address.

## Receive a signup email

```js
const since = new Date().toISOString();
// Give mail.address to the external service and trigger its email.
const page = await mail.wait({
  since,
  sender: "noreply@example.com",
  timeoutSeconds: 120,
});

for (const summary of page.messages) {
  const message = await mail.get(summary.id);
  console.log(message.text);
  console.log(message.candidates.otp_codes);
  console.log(message.candidates.links);
}
```

`wait()` polls only for the requested period and follows the service polling interval. Sender matching is a filter, not sender authentication.

## Retention and cleanup

```js
await mail.configure({ retention_seconds: 7 * 24 * 60 * 60 });
const state = await mail.inspect();
await mail.purge();
```

The address is permanent for the key. Default message retention is 24 hours and the maximum is 7 days. Configuration affects new messages only. `purge()` deletes stored messages and settings; future mail can initialize the same address again.

`create()` and `extend()` remain compatibility aliases for configuration. Address lifetime parameters are obsolete; `persistent:false` and `ttl_seconds` are rejected.

## Reusable read URLs for GET-only agents

For a chat or retrieval tool that can only make GET requests:

```js
const url = mail.readUrl({ ttlSeconds: 600 });
```

The URL returns the latest 10 full messages, newest first, including candidate OTPs and links. It never contains the private key and can be fetched repeatedly until expiry. It is a bearer secret: anyone holding it can read the mailbox until it expires. The default lifetime is 10 minutes and maximum is 15 minutes. It cannot mutate the mailbox.

`signedUrl(path)` remains for one release as a deprecated single-use URL for one exact REST GET.

## Hosted MCP proof

```js
import { signedToolArguments } from "agent-temp-mail";

const args = signedToolArguments(identity, "list_messages", {
  since: new Date().toISOString(),
});
```

Supply `args` to the `list_messages` tool exposed by `https://agent-temp-mail.com/mcp`. `_auth` proves ownership for that exact tool call and never includes the private key. Generate a fresh proof for every retry.

## Local MCP server

```json
{
  "mcpServers": {
    "agent-temp-mail": {
      "command": "npx",
      "args": [
        "--yes",
        "--package=agent-temp-mail@0.4.0",
        "agent-temp-mail-mcp"
      ],
      "env": { "MAIL_KEY_FILE": "/absolute/private/mail.key.json" }
    }
  }
}
```

The local adapter signs automatically and keeps authentication fields out of model-facing tool arguments. Set `MAIL_REQUIRE_EXISTING_KEY=1` after initial creation if loss of the key file must be fatal.

Tools:

- `inspect_inbox`
- `configure_inbox`
- `purge_inbox`
- `list_messages`
- `get_message`
- `get_candidates`
- `delete_message`

## CLI

```sh
export MAIL_KEY_FILE="$HOME/.config/agent-temp-mail/identity.key.json"
mkdir -p "$(dirname "$MAIL_KEY_FILE")"

npx --yes --package=agent-temp-mail@0.4.0 agent-temp-mail keygen
npx --yes --package=agent-temp-mail@0.4.0 agent-temp-mail read-url
npx --yes --package=agent-temp-mail@0.4.0 agent-temp-mail inspect
npx --yes --package=agent-temp-mail@0.4.0 agent-temp-mail list '{"since":"2026-09-16T12:00:00Z"}'
npx --yes --package=agent-temp-mail@0.4.0 agent-temp-mail configure '{"retention_seconds":604800}'
npx --yes --package=agent-temp-mail@0.4.0 agent-temp-mail purge
```

`keygen` only creates the local key file and prints the immediately usable address. `read-url` prints a reusable read URL with a 10-minute default; pass a TTL in seconds as its optional argument.

## Function-tool bridge

```js
import { AgentMailTools } from "agent-temp-mail";

const tools = new AgentMailTools(mail);
const definitions = await tools.definitions("responses");
const result = await tools.call("list_messages", {});
```

Formats: `mcp`, `responses`, `chat-completions`, and `anthropic`. The host application executes calls with the key; the model sees schemas, ordinary arguments and selected results.

## Security and limits

Email content, sender fields, OTP candidates and URLs are untrusted. The service does not visit links or execute content. It does not store attachments, raw MIME or original HTML. This is not end-to-end encryption.

The service targets Cloudflare's free tier: 100 messages and 2 MiB per address, 256 KiB maximum incoming message, 1–7 day retention, 6,000 shared API calls/day and 30 authenticated calls/minute/key. Poll briefly during active tasks.

Full documentation: https://agent-temp-mail.com/
