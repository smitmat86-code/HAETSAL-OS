const endpoint =
  process.env.MCP_ENDPOINT ??
  "https://the-brain.ct-trading-bot1.workers.dev/mcp";
const accessClientId = process.env.CF_ACCESS_CLIENT_ID;
const accessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
const syntheticSub = process.env.BRAIN_JWT_SUB?.trim();
const toolName = process.env.MCP_TOOL_NAME ?? "memory_write";

if (!accessClientId || !accessClientSecret) {
  throw new Error("Missing CF_ACCESS_CLIENT_ID or CF_ACCESS_CLIENT_SECRET");
}

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: unknown;
};

async function call(body: JsonRpcRequest) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "CF-Access-Client-Id": accessClientId,
    "CF-Access-Client-Secret": accessClientSecret,
  };

  if (syntheticSub) {
    headers["x-brain-jwt-sub"] = syntheticSub;
  }

  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const contentType = response.headers.get("content-type") ?? "";
  const text =
    response.status === 202
      ? ""
      : body.method === "initialize" && contentType.includes("text/event-stream")
        ? await readFirstChunk(response)
        : await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep raw text for debugging
  }

  return {
    status: response.status,
    ok: response.ok,
    sessionId: response.headers.get("mcp-session-id"),
    body: parsed,
    raw: text,
  };
}

let sessionId: string | null = null;

async function readFirstChunk(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }

  const decoder = new TextDecoder();
  try {
    const result = await Promise.race([
      reader.read(),
      new Promise<{ value?: Uint8Array; done: boolean }>((resolve) =>
        setTimeout(() => resolve({ done: true }), 5000),
      ),
    ]);
    return result.value ? decoder.decode(result.value) : "";
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

const uniqueStamp = new Date().toISOString();
const memoryText = `Production smoke memory from Codex at ${uniqueStamp}`;
const writeArguments =
  toolName === "brain_v1_retain"
    ? {
        content: memoryText,
        memory_type: "episodic",
        domain: "operations",
        provenance: "codex_live_smoke",
      }
    : {
        content: memoryText,
        memory_type: "episodic",
        domain: "operations",
      };

const requests: JsonRpcRequest[] = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "codex-live-smoke", version: "1.0.0" },
    },
  },
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: toolName,
      arguments: writeArguments,
    },
  },
  {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "memory_search",
      arguments: {
        query: memoryText,
        domain: "operations",
        limit: 5,
      },
    },
  },
];

for (const request of requests) {
  const result = await call(request);
  if (result.sessionId) {
    sessionId = result.sessionId;
  }
  console.log(`\n=== ${request.method}${request.id ? ` #${request.id}` : ""} ===`);
  console.log(`status=${result.status}`);
  if (result.sessionId) {
    console.log(`session=${result.sessionId}`);
  }
  console.log(
    typeof result.body === "string"
      ? result.body
      : JSON.stringify(result.body, null, 2),
  );
}
