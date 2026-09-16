import { test } from "node:test";
import assert from "node:assert/strict";
import { generateIdentity, MailClient } from "../sdk/client.mjs";
import { AgentMailTools } from "../sdk/tools.mjs";

const descriptor = {
  name: "create_inbox",
  description: "Create inbox",
  inputSchema: {
    type: "object",
    properties: { persistent: { type: "boolean" } },
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
  assert.deepEqual(anthropic[0].input_schema, descriptor.inputSchema);
  const chat = await tools.definitions("chat-completions");
  assert.equal(chat[0].function.name, "create_inbox");
  const responses = await tools.definitions("responses");
  assert.equal(responses[0].name, "create_inbox");
  assert.equal(responses[0].type, "function");
  const exposed = JSON.stringify([anthropic, chat, responses, requests]);
  assert.ok(!exposed.includes(identity.private_key_pkcs8));
  await assert.rejects(tools.definitions("unsupported"), /Unknown tool format/);
});

test("tool execution signs each request and returns structured data", async () => {
  const { tools, requests } = setup();
  const result = await tools.call("create_inbox", '{"persistent":true}');
  assert.equal(result.isError, false);
  assert.equal(result.data.args.persistent, true);
  assert.ok(requests[0].headers["X-Mail-Signature"]);
  await tools.call("create_inbox", {});
  assert.notEqual(
    requests[0].headers["X-Mail-Nonce"],
    requests[1].headers["X-Mail-Nonce"],
  );
  await assert.rejects(tools.call("create_inbox", []), /JSON object/);
});
