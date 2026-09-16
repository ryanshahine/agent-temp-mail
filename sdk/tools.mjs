/**
 * Provider-neutral function-tool bridge. The host application executes calls
 * with the signing key; the model sees only schemas, arguments and results.
 */
export class AgentMailTools {
  constructor(mailClient) {
    this.mail = mailClient;
    this.requestId = 0;
  }

  async rpc(method, params = {}) {
    const response = await this.mail.request("POST", "/mcp", {
      jsonrpc: "2.0",
      id: ++this.requestId,
      method,
      params,
    });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  }

  async definitions(format = "mcp") {
    const { tools } = await this.rpc("tools/list");
    if (format === "mcp") return tools;
    if (format === "anthropic") {
      return tools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        input_schema: inputSchema,
      }));
    }
    if (format === "chat-completions") {
      return tools.map(({ name, description, inputSchema }) => ({
        type: "function",
        function: { name, description, parameters: inputSchema },
      }));
    }
    if (format === "responses") {
      return tools.map(({ name, description, inputSchema }) => ({
        type: "function",
        name,
        description,
        parameters: inputSchema,
      }));
    }
    throw new Error(
      "Unknown tool format. Use mcp, anthropic, chat-completions or responses.",
    );
  }

  async call(name, args = {}) {
    if (typeof args === "string") args = JSON.parse(args);
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new TypeError("Tool arguments must be a JSON object.");
    }
    const result = await this.rpc("tools/call", { name, arguments: args });
    return {
      isError: result.isError === true,
      data:
        result.structuredContent ??
        JSON.parse(result.content.find((c) => c.type === "text").text),
    };
  }
}
