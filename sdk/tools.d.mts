import type { MailClient } from "./client.mjs";
export class AgentMailTools {
  constructor(mailClient: MailClient);
  definitions(
    format?: "mcp",
  ): Promise<
    Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      annotations?: Record<string, unknown>;
    }>
  >;
  definitions(
    format: "anthropic" | "chat-completions" | "responses",
  ): Promise<Array<Record<string, unknown>>>;
  call<T = unknown>(
    name: string,
    args?: Record<string, unknown> | string,
  ): Promise<{ isError: boolean; data: T }>;
}
