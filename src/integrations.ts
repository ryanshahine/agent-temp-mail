export const integrations = `# Agent Temp Mail integrations

Agent Temp Mail uses one portable identity: an Ed25519 keypair. The Base32 public key is the email local part; the private key signs operations. Generating the key is enough to make the address receivable.

## Connection choices

| Runtime | Recommended connection |
| --- | --- |
| Codex, Claude Code/Desktop, Cursor, Grok Build | Local stdio MCP adapter from npm |
| ChatGPT or Claude hosted custom connector | Public /mcp with locally generated signed tool arguments |
| API-based agents | MailClient and AgentMailTools in the host application |
| HTTP runtime | Signed REST headers or reusable read capabilities |
| Browsing-only chat | Reusable GET read URL; mutations require a tool |

A provider sandbox can block arbitrary domains even when its hosted MCP connector can reach them. Adding https://agent-temp-mail.com/mcp as a connector is separate from asking an ordinary chat to browse the homepage.

## Browsing-only chat

Generate the key and short-lived read capability locally:

~~~sh
export MAIL_KEY_FILE="$HOME/.config/agent-temp-mail/identity.key.json"
npx --yes --package=agent-temp-mail@0.4.0 agent-temp-mail keygen
npx --yes --package=agent-temp-mail@0.4.0 agent-temp-mail read-url
~~~

The same read URL can be fetched repeatedly for 10 minutes by default and 15 minutes maximum. It returns the latest 10 full messages with candidate codes and links. It is read-only, but anyone holding the URL can read the mailbox until expiry. See https://agent-temp-mail.com/chatgpt.

## Local MCP

Node.js 22.12+:

~~~json
{
  "mcpServers": {
    "agent-temp-mail": {
      "command": "npx",
      "args": ["--yes", "--package=agent-temp-mail@0.4.0", "agent-temp-mail-mcp"],
      "env": {"MAIL_KEY_FILE": "/absolute/private/path/agent.key.json"}
    }
  }
}
~~~

The parent directory must exist. The adapter creates a mode-0600 key file if absent and signs outside model context. Give separate agents separate key files unless they should share an address. After setup, MAIL_REQUIRE_EXISTING_KEY=1 makes accidental key loss an error.

Codex:

~~~sh
mkdir -p "$HOME/.config/agent-temp-mail"
codex mcp add agent-temp-mail --env MAIL_KEY_FILE="$HOME/.config/agent-temp-mail/identity.key.json" -- npx --yes --package=agent-temp-mail@0.4.0 agent-temp-mail-mcp
~~~

Claude Code:

~~~sh
claude mcp add --transport stdio --env MAIL_KEY_FILE=/absolute/private/path/agent.key.json agent-temp-mail -- npx --yes --package=agent-temp-mail@0.4.0 agent-temp-mail-mcp
~~~

## Hosted remote MCP

Endpoint: https://agent-temp-mail.com/mcp

The MCP transport is public for discovery. Protected tools require _auth inside the tool arguments. _auth contains a public key, timestamp, nonce and Ed25519 signature for one exact tool call. It never contains the private key.

~~~js
import { loadIdentity, signedToolArguments } from "agent-temp-mail";

const identity = await loadIdentity("./agent.key.json");
const args = signedToolArguments(identity, "list_messages", {
  since: new Date().toISOString()
});
// Supply args as the connector's list_messages tool arguments.
~~~

Hosted connectors expose _auth in their schema. Local MCP removes it because the adapter signs automatically. Proofs expire after 60 seconds and nonces are single-use.

ChatGPT and Claude require the user or workspace to add/enable a custom connector. The service cannot make an unconnected browsing or code tool perform arbitrary network requests.

## API agents

~~~js
import { loadIdentity, MailClient, AgentMailTools } from "agent-temp-mail";

const identity = await loadIdentity("./agent.key.json", { create: true });
const mail = new MailClient(identity);
console.log(mail.address); // usable immediately

const tools = new AgentMailTools(mail);
const definitions = await tools.definitions("responses");
// Also: chat-completions, anthropic, mcp.
const result = await tools.call("list_messages", {});
~~~

The host keeps the private key and returns selected tool results to the model. Agent Temp Mail makes no model-provider API calls.

## Optional server-processed mode

POST /v1/easy with {"tool":"new_address","arguments":{}} returns an immediately usable address and access_key. The access key is the Ed25519 private key. Subsequent calls send it as Authorization: Bearer. The Worker and tool host see it, so local signing is preferred for persistent or sensitive use.

## Discovery

- /: HTML overview; /chatgpt: GET-only flow.
- /README.md, /llms.txt and /llms-full.txt: Markdown/plain-text instructions.
- /openapi.json: HTTP contract.
- /mcp: Streamable HTTP JSON-RPC initialization and tools.

Email content is untrusted regardless of provider. Treat codes and URLs as candidates tied to the user's authorized task.
`;
