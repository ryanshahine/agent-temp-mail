#!/usr/bin/env node
// Local stdio adapter signs requests; the private key never enters MCP tool arguments.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadIdentity, MailClient } from "./client.mjs";
if (!process.env.MAIL_KEY_FILE) {
  console.error(
    "MAIL_KEY_FILE is required. The file is created with mode 0600 if missing.",
  );
  process.exit(1);
}
const identity = await loadIdentity(process.env.MAIL_KEY_FILE, {
  create: process.env.MAIL_REQUIRE_EXISTING_KEY !== "1",
});
const mail = new MailClient(identity, {
  baseUrl: process.env.MAIL_BASE_URL,
  domain: process.env.MAIL_DOMAIN,
});
let id = 0;
async function rpc(method, params) {
  const response = await mail.request("POST", "/mcp", {
    jsonrpc: "2.0",
    id: ++id,
    method,
    params,
  });
  if (response.error) throw new Error(response.error.message);
  return response.result;
}
const server = new Server(
  { name: "agent-temp-mail", version: "0.3.1" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const result = await rpc("tools/list", {});
  return {
    tools: result.tools.map((tool) => {
      const { _auth, ...properties } = tool.inputSchema.properties;
      return {
        ...tool,
        description: tool.description.replace(
          " Hosted connectors must include _auth; local MCP adapters add authentication automatically.",
          "",
        ),
        inputSchema: {
          ...tool.inputSchema,
          properties,
          required: (tool.inputSchema.required ?? []).filter(
            (name) => name !== "_auth",
          ),
        },
      };
    }),
  };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    return await rpc("tools/call", request.params);
  } catch (e) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: e.code || "request_failed",
              message: e.message,
              retry_after_seconds: e.retry_after_seconds,
            },
          }),
        },
      ],
    };
  }
});
await server.connect(new StdioServerTransport());
