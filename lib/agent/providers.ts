// Adapters for the model providers an account can bring a key for. Each one
// turns the agent's provider-neutral conversation into that provider's
// tool-calling API. xAI (Grok) speaks the OpenAI Chat Completions format.

export const PROVIDERS = {
  anthropic: { name: "Anthropic", defaultModel: "claude-sonnet-5-5" },
  openai: { name: "OpenAI", defaultModel: "gpt-5" },
  xai: { name: "xAI (Grok)", defaultModel: "grok-4" },
} as const;
export type ProviderId = keyof typeof PROVIDERS;
export const isProviderId = (value: unknown): value is ProviderId =>
  typeof value === "string" && value in PROVIDERS;

export type ToolDefinition = {
  name: string;
  description: string;
  /** JSON Schema for the tool's input object. */
  parameters: Record<string, unknown>;
};
export type ToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};
export type AgentMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; calls: ToolCall[] }
  | { role: "tool"; results: { id: string; content: string }[] };
export type ModelTurn = { text: string; calls: ToolCall[] };

export type ModelProvider = {
  chat(request: {
    system: string;
    messages: AgentMessage[];
    tools: ToolDefinition[];
  }): Promise<ModelTurn>;
  /** Also serves as the key check: it fails on a bad key. */
  listModels(): Promise<string[]>;
};

/** A provider failure, with a message that is safe to show the user. */
export class ProviderError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

type Fetch = typeof fetch;
const TIMEOUT_MS = 60_000;

async function call(
  fetcher: Fetch,
  provider: ProviderId,
  url: string,
  init: RequestInit,
) {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ProviderError(`Couldn't reach ${PROVIDERS[provider].name}`, 0);
  }
  const body = await response.json().catch(() => null);
  if (response.ok) return body;
  const name = PROVIDERS[provider].name;
  if (response.status === 401 || response.status === 403)
    throw new ProviderError(`${name} rejected the API key`, response.status);
  if (response.status === 429)
    throw new ProviderError(`${name} rate limit or quota reached`, 429);
  // Provider error messages describe the request (unknown model, bad
  // parameter), not note content, and help fix the settings.
  const detail = String(body?.error?.message ?? "").slice(0, 200);
  throw new ProviderError(
    `${name} error ${response.status}${detail ? `: ${detail}` : ""}`,
    response.status,
  );
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  try {
    const value = JSON.parse(String(raw || "{}"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

export function anthropicProvider(
  apiKey: string,
  model: string,
  fetcher: Fetch = fetch,
): ModelProvider {
  const headers = {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  return {
    async chat({ system, messages, tools }) {
      const body = await call(
        fetcher,
        "anthropic",
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            model,
            max_tokens: 4096,
            system,
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
            messages: messages.map((m) =>
              m.role === "user"
                ? { role: "user", content: m.text }
                : m.role === "assistant"
                  ? {
                      role: "assistant",
                      content: [
                        ...(m.text ? [{ type: "text", text: m.text }] : []),
                        ...m.calls.map((c) => ({
                          type: "tool_use",
                          id: c.id,
                          name: c.name,
                          input: c.input,
                        })),
                      ],
                    }
                  : {
                      role: "user",
                      content: m.results.map((r) => ({
                        type: "tool_result",
                        tool_use_id: r.id,
                        content: r.content,
                      })),
                    },
            ),
          }),
        },
      );
      const blocks: {
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: unknown;
      }[] = body?.content ?? [];
      return {
        text: blocks
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim(),
        calls: blocks
          .filter((b) => b.type === "tool_use")
          .map((b) => ({
            id: String(b.id),
            name: String(b.name),
            input: parseArguments(b.input),
          })),
      };
    },
    async listModels() {
      const body = await call(
        fetcher,
        "anthropic",
        "https://api.anthropic.com/v1/models?limit=100",
        { headers },
      );
      return (body?.data ?? []).map((m: { id: string }) => m.id);
    },
  };
}

const OPENAI_COMPATIBLE = {
  openai: "https://api.openai.com/v1",
  xai: "https://api.x.ai/v1",
} as const;

export function openAiCompatibleProvider(
  provider: keyof typeof OPENAI_COMPATIBLE,
  apiKey: string,
  model: string,
  fetcher: Fetch = fetch,
): ModelProvider {
  const base = OPENAI_COMPATIBLE[provider];
  const headers = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
  return {
    async chat({ system, messages, tools }) {
      const body = await call(fetcher, provider, `${base}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          tools: tools.map((t) => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          })),
          messages: [
            { role: "system", content: system },
            ...messages.flatMap((m) =>
              m.role === "user"
                ? [{ role: "user", content: m.text }]
                : m.role === "assistant"
                  ? [
                      {
                        role: "assistant",
                        content: m.text || null,
                        ...(m.calls.length && {
                          tool_calls: m.calls.map((c) => ({
                            id: c.id,
                            type: "function",
                            function: {
                              name: c.name,
                              arguments: JSON.stringify(c.input),
                            },
                          })),
                        }),
                      },
                    ]
                  : m.results.map((r) => ({
                      role: "tool",
                      tool_call_id: r.id,
                      content: r.content,
                    })),
            ),
          ],
        }),
      });
      const message = body?.choices?.[0]?.message ?? {};
      return {
        text: String(message.content ?? "").trim(),
        calls: (message.tool_calls ?? []).map(
          (c: {
            id: string;
            function: { name: string; arguments: string };
          }) => ({
            id: String(c.id),
            name: String(c.function?.name),
            input: parseArguments(c.function?.arguments),
          }),
        ),
      };
    },
    async listModels() {
      const body = await call(fetcher, provider, `${base}/models`, { headers });
      return (body?.data ?? []).map((m: { id: string }) => m.id).sort();
    },
  };
}

export function createProvider(
  provider: ProviderId,
  apiKey: string,
  model: string,
  fetcher: Fetch = fetch,
): ModelProvider {
  return provider === "anthropic"
    ? anthropicProvider(apiKey, model, fetcher)
    : openAiCompatibleProvider(provider, apiKey, model, fetcher);
}
