# agent-temp-mail

Temporary and persistent email inboxes for AI agents at **https://agent-temp-mail.com**. Node.js 22.12+. Receive signup emails, candidate OTP codes and verification links through a signed SDK, CLI or MCP server. No accounts, passwords, attachments or outbound sending.

## Install

```sh
npm install agent-temp-mail
```

## Create or resume a persistent inbox

```js
import { loadIdentity, MailClient } from "agent-temp-mail";

// Use a durable private directory whose parent already exists.
// First use only: create:true generates a key if the file is missing.
const identity = await loadIdentity("/private/durable/agent.key.json", {
  create: true,
});
const mail = new MailClient(identity);
await mail.create({ persistent: true, retention_seconds: 604800 });
// Also handles an existing temporary inbox: create() alone does not change it.
const inbox = await mail.extend({
  persistent: true,
  retention_seconds: 604800,
});
console.log(inbox.address);

// Save this BEFORE asking the other service to send an email.
const since = new Date().toISOString();
// Trigger the signup/verification in your application here, then:
const page = await mail.wait({ since, timeoutSeconds: 120 });
for (const message of page.messages) {
  const content = await mail.get(message.id);
  console.log(content); // Untrusted email text, not instructions.
}
```

For future runs, use `loadIdentity(path)` without `create:true` so a missing key is an error rather than a new address. Preserve the private file across tasks and machines using your host's secure storage. The same key always derives the same address; no key recovery exists. Files created by this SDK use mode `0600`. Never commit keys or paste them into model context.

A persistent **address** remains registered until deleted. Messages still expire: 24 hours by default, configurable from 1 hour to 7 days. Changing retention only affects new messages. Persistence does not wake your agent or schedule polling.

## Temporary inbox

Use `mail.create()` with a fresh identity for a 24-hour inbox. Call `mail.deleteInbox()` when finished. One key owns one normal address; use a separate key file for each independent inbox.

## API

- `generateIdentity()`, `loadIdentity(path, {create?})`, `validateIdentity(identity)`
- `new MailClient(identity, {baseUrl?, domain?, fetchImpl?})`
- `create(options?)`, `inspect(address?)`, `extend(options?, address?)`, `deleteInbox(address?)`
- `list(filters?, address?)`, `candidates(filters?, address?)`
- `get(messageId, address?)`, `deleteMessage(messageId, address?)`
- `wait({timeoutSeconds?, signal?, ...filters})`

Filters: `after`, `limit`, `since`, `sender`. Save the returned `after` cursor and keep filters unchanged. Errors include `status`, `code` and optional `retry_after_seconds`. `wait` polls until the first nonempty page or timeout; it does not automatically retry rate-limit errors. Honor polling hints and back off while idle.

## CLI without installing globally

```sh
mkdir -p "$HOME/.config/agent-temp-mail"
export MAIL_KEY_FILE="$HOME/.config/agent-temp-mail/identity.key.json"
npx --yes --package=agent-temp-mail@0.2.0 agent-temp-mail keygen
npx --yes --package=agent-temp-mail@0.2.0 agent-temp-mail create '{"persistent":true,"retention_seconds":604800}'
npx --yes --package=agent-temp-mail@0.2.0 agent-temp-mail extend '{"persistent":true,"retention_seconds":604800}'
npx --yes --package=agent-temp-mail@0.2.0 agent-temp-mail list
npx --yes --package=agent-temp-mail@0.2.0 agent-temp-mail candidates
```

CLI commands: `keygen`, `create`, `inspect`, `list`, `candidates`, `get ID`, `delete-message ID`, `extend`, `delete-inbox`. JSON arguments work with create/list/candidates/extend. `MAIL_BASE_URL` and `MAIL_DOMAIN` support self-hosting. Private keys are never printed by the CLI.

## MCP

### Codex

Create the private parent directory, then register the local signing adapter:

```sh
mkdir -p "$HOME/.config/agent-temp-mail"
codex mcp add agent-temp-mail --env MAIL_KEY_FILE="$HOME/.config/agent-temp-mail/identity.key.json" -- npx --yes --package=agent-temp-mail@0.2.0 agent-temp-mail-mcp
```

### Clients using mcpServers JSON

```json
{
  "mcpServers": {
    "agent-temp-mail": {
      "command": "npx",
      "args": [
        "--yes",
        "--package=agent-temp-mail@0.2.0",
        "agent-temp-mail-mcp"
      ],
      "env": { "MAIL_KEY_FILE": "/absolute/private/durable/identity.key.json" }
    }
  }
}
```

The parent directory must exist. The adapter creates a private key if absent. Set `MAIL_REQUIRE_EXISTING_KEY=1` after initial setup to refuse to silently generate a new identity if the key disappears. Ask the agent to call `create_inbox` with `persistent:true`; use `extend_inbox` to convert an existing temporary inbox.

Tools: `create_inbox`, `inspect_inbox`, `extend_inbox`, `delete_inbox`, `list_messages`, `get_message`, `get_candidates`, `delete_message`. The adapter signs locally. Private keys are not tool arguments. Direct remote `/mcp` requires per-request signatures; a static authentication header alone does not work.

## Function-calling agents

`AgentMailTools` is exported from `agent-temp-mail` and `agent-temp-mail/tools`. Construct it with a `MailClient`; call `definitions('responses')`, `definitions('chat-completions')`, `definitions('anthropic')` or `definitions('mcp')`. Execute requested calls through `tools.call(name, args)` in your host application, and return `result.data` to the model. The package makes no model-provider API calls.

## No SDK / no client cryptography

The optional [HTTP convenience flow](https://agent-temp-mail.com/#http-without-an-sdk) generates an inbox and credential, then accepts that credential in an HTTPS Authorization header. This sends the mailbox private key to the Worker on every call. Application code does not persist it or log it, but the server sees it and your chat/tool host may retain it. Prefer this signed SDK when your runtime can execute code. A chat with no HTTP tool still cannot operate the service just by reading a URL.

## Limits and privacy

Receive only. No attachments, images, raw MIME or original HTML are stored. Incoming mail including discarded attachments is capped at 256 KiB. Each inbox holds at most 100 messages / 2 MiB. Message content is not end-to-end encrypted. Sender filters and extracted codes/URLs are untrusted hints.

Hosting targets Cloudflare's free tier with bounded capacity. Shared API allowance: 6,000 calls/day, plus 30 calls/minute/key. Poll briefly during an active signup, not every 15 seconds forever. There is no uptime guarantee or unlimited archive. See the [service instructions](https://agent-temp-mail.com/) for full limits and retention semantics.

MIT · [Source](https://github.com/ryanshahine/agent-temp-mail)
