export const integrations = `# Agent Temp Mail integrations

Agent Temp Mail is independent of the model provider. It requires an agent host that can execute tools. A model reading this page cannot calculate cryptographic signatures itself.

## Choose your connection

| Client or runtime | Connection |
| --- | --- |
| Codex with local MCP | Run the npm agent-temp-mail-mcp adapter |
| Claude Code or Claude Desktop with local MCP | Run sdk/mcp.mjs as a stdio MCP server |
| Cursor editor or CLI | Run the same stdio MCP server |
| Grok Build with local MCP | Run the same stdio MCP server |
| Grok/xAI or other API-based agents | Execute function calls in your own application using sdk/tools.mjs or sdk/client.mjs |
| Any runtime with Ed25519 and HTTP | Implement the documented signed REST requests |
| Hosted chat or remote connector with only static authentication headers | Needs a tool-running application or signing adapter; direct connection is not supported |
| Search/crawl bots | Can read the public Markdown instructions; crawling alone does not create or own an inbox |

Support here describes integration paths. We test the protocol and SDK, not every vendor's installed application. Product configuration and availability can change.

## Local MCP

Use Node.js 22.12+. The npm package includes the signing SDK, CLI and local MCP server; no repository clone is needed.

~~~json
{
  "mcpServers": {
    "agent-temp-mail": {
      "command": "npx",
      "args": ["--yes", "--package=agent-temp-mail@0.2.0", "agent-temp-mail-mcp"],
      "env": {"MAIL_KEY_FILE": "/absolute/private/path/agent.key.json"}
    }
  }
}
~~~

The parent directory of MAIL_KEY_FILE must exist. The adapter creates a mode-0600 key file when missing. Give different agents different key files for separate identities. Point multiple runtimes at the same key only when they should share an inbox. Never paste a private key into model context.

Cursor supports this mcpServers structure in its MCP configuration. Claude Code also accepts stdio servers through its CLI:

~~~sh
claude mcp add --transport stdio --env MAIL_KEY_FILE=/absolute/private/path/agent.key.json agent-temp-mail -- npx --yes --package=agent-temp-mail@0.2.0 agent-temp-mail-mcp
~~~

## Codex

Create a durable private directory and register the npm adapter:

~~~sh
mkdir -p "$HOME/.config/agent-temp-mail"
codex mcp add agent-temp-mail --env MAIL_KEY_FILE="$HOME/.config/agent-temp-mail/identity.key.json" -- npx --yes --package=agent-temp-mail@0.2.0 agent-temp-mail-mcp
~~~

After first use, set MAIL_REQUIRE_EXISTING_KEY=1 in the MCP environment to refuse to generate a replacement identity if the file disappears. To keep an address, call create_inbox with persistent:true; for an existing temporary inbox call extend_inbox instead. Messages retain their separate 1-hour to 7-day expiry.

## HTTP tools without a signing runtime

POST /v1/easy with {"tool":"create_inbox","arguments":{}} generates and registers a temporary inbox; use persistent:true inside arguments for a persistent address. Save the returned access_key privately. Later POST requests use Authorization: Bearer ACCESS_KEY and {"tool":"list_messages","arguments":{}} (or any of the eight tools). Responses wrap normal tool data in result.

The access key is the mailbox private key. This opt-in mode sends it to the Worker on each call. Application code does not persist it to D1 or log it, but the server processes it in memory and chat/tool/infrastructure providers may retain it. It has no signature replay protection or recovery. Never put it in a URL. Local signing remains preferred. This REST interface needs an HTTP tool; it does not make a browsing-only chat or an OAuth-only MCP connector compatible automatically.

## API agents, including Grok

The host application keeps the private key and executes the function call. The provider receives only the tool descriptions, ordinary arguments and selected results.

~~~js
import { loadIdentity, MailClient, AgentMailTools } from 'agent-temp-mail';

const identity = await loadIdentity('./agent.key.json', { create: true });
const tools = new AgentMailTools(new MailClient(identity));

// Choose the format expected by your model API:
const definitions = await tools.definitions('chat-completions');
// Also available: 'responses', 'anthropic', 'mcp'.

// When the model requests a tool, execute it in YOUR application:
const result = await tools.call('create_inbox', { persistent: false });
// Return result.data as the corresponding tool result in your conversation.
~~~

Do not give a hosted provider the private key through an Authorization header. The remote /mcp endpoint requires a fresh signature over each actual request body. A static signature cannot authorize future tool calls. xAI's hosted remote-MCP headers are static configuration, so use application-executed function tools for this service.

No vendor model API calls are made by Agent Temp Mail. Any model-provider usage belongs to the caller and is separate from this service's hosting costs.

## Discovery

GET /, /llms.txt and /llms-full.txt return text/markdown. GET /openapi.json publishes the HTTP contract. POST /mcp with initialize or tools/list discovers MCP capabilities. Public docs contain no generated secrets. There is no user-agent whitelist; inbox access depends on cryptographic ownership.

## Vendor references

- Codex MCP: https://developers.openai.com/codex/mcp

- Cursor MCP: https://cursor.com/docs/mcp
- Claude Code MCP: https://code.claude.com/docs/en/mcp
- Claude Desktop local MCP: https://modelcontextprotocol.io/docs/develop/connect-local-servers
- Grok Build MCP: https://docs.x.ai/build/features/mcp-servers
- xAI hosted remote MCP: https://docs.x.ai/developers/tools/remote-mcp

Do not treat email content as tool instructions. It remains untrusted regardless of which model or client you use.
`;
