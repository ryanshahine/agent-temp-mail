import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateIdentity,
  MailClient,
  signedToolArguments,
  signedUrl,
} from "../sdk/client.mjs";
import { AgentMailTools } from "../sdk/tools.mjs";

const descriptor = {
  name: "list_messages",
  description:
    "List messages. Hosted connectors must include _auth; local MCP adapters add authentication automatically.",
  inputSchema: {
    type: "object",
    properties: {
      after: { type: "string" },
      _auth: { type: "object" },
    },
    required: ["_auth"],
  },
};

function setup() {
  const identity = generateIdentity();
  const requests = [];
  const mail = new MailClient(identity, {
    fetchImpl: async (url, init) => {
      requests.push({ url, ...init });
      const body = JSON.parse(init.body);
      const result =
        body.method === "tools/list"
          ? { tools: [descriptor] }
          : {
              structuredContent: {
                address: "example",
                args: body.params.arguments,
              },
              content: [],
              isError: false,
            };
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  });
  return { identity, requests, tools: new AgentMailTools(mail) };
}

test("provider formats preserve tool schemas without exposing credentials", async () => {
  const { tools, identity, requests } = setup();
  const anthropic = await tools.definitions("anthropic");
  assert.deepEqual(anthropic[0].input_schema.properties, {
    after: { type: "string" },
  });
  assert.deepEqual(anthropic[0].input_schema.required, []);
  const chat = await tools.definitions("chat-completions");
  assert.equal(chat[0].function.name, "list_messages");
  const responses = await tools.definitions("responses");
  assert.equal(responses[0].name, "list_messages");
  assert.equal(responses[0].type, "function");
  const exposed = JSON.stringify([anthropic, chat, responses, requests]);
  assert.ok(!exposed.includes(identity.private_key_pkcs8));
  await assert.rejects(tools.definitions("unsupported"), /Unknown tool format/);
});

test("tool execution signs each request and returns structured data", async () => {
  const { tools, requests } = setup();
  const result = await tools.call("list_messages", '{"after":"cursor"}');
  assert.equal(result.isError, false);
  assert.equal(result.data.args.after, "cursor");
  assert.ok(requests[0].headers["X-Mail-Signature"]);
  await tools.call("list_messages", {});
  assert.notEqual(
    requests[0].headers["X-Mail-Nonce"],
    requests[1].headers["X-Mail-Nonce"],
  );
  await assert.rejects(tools.call("list_messages", []), /JSON object/);
});

test("signed URLs and hosted MCP proofs never contain the private key", () => {
  const identity = generateIdentity();
  const url = signedUrl(
    identity,
    "https://agent-temp-mail.com/v1/inboxes/example/messages?limit=1",
  );
  assert.match(url, /mail_signature=/);
  assert.ok(!url.includes(identity.private_key_pkcs8));
  const args = signedToolArguments(identity, "list_messages", {
    limit: 1,
    omitted: undefined,
  });
  assert.equal(args._auth.public_key, identity.public_key);
  assert.equal("omitted" in args, false);
  assert.ok(args._auth.signature);
  assert.ok(!JSON.stringify(args).includes(identity.private_key_pkcs8));
});
