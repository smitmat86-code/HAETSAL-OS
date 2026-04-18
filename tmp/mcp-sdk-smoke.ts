import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";

const endpoint =
  process.env.MCP_ENDPOINT ??
  "https://the-brain.ct-trading-bot1.workers.dev/mcp";
const accessClientId = process.env.CF_ACCESS_CLIENT_ID;
const accessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
const syntheticSub = process.env.BRAIN_JWT_SUB ?? "test-user-smoke";
const toolName = process.env.MCP_TOOL_NAME ?? "memory_write";

if (!accessClientId || !accessClientSecret) {
  throw new Error("Missing CF_ACCESS_CLIENT_ID or CF_ACCESS_CLIENT_SECRET");
}

const client = new Client(
  {
    name: "codex-sdk-smoke",
    version: "1.0.0",
  },
  {
    capabilities: {},
  },
);

const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
  requestInit: {
    headers: {
      "CF-Access-Client-Id": accessClientId,
      "CF-Access-Client-Secret": accessClientSecret,
      "x-brain-jwt-sub": syntheticSub,
    },
  },
});

const uniqueStamp = Math.floor(Date.now() / 1000);
const searchDelayMs = Number(process.env.MCP_SEARCH_DELAY_MS ?? "45000");
const memoryText = `Avery Smoke Test ${uniqueStamp} prefers persimmon tea over coffee.`;
const searchQuery = `What does Avery Smoke Test ${uniqueStamp} prefer over coffee?`;
const writeArguments =
  toolName === "brain_v1_retain"
    ? {
        content: memoryText,
        memory_type: "semantic",
        domain: "general",
        provenance: "codex_live_smoke",
      }
    : {
        content: memoryText,
        memory_type: "semantic",
        domain: "general",
      };

async function main() {
  await client.connect(transport);
  console.log(`connected session=${transport.sessionId ?? "none"}`);
  console.log(`memory_text=${memoryText}`);
  console.log(`search_query=${searchQuery}`);

  const tools = await client.request(
    { method: "tools/list", params: {} },
    ListToolsResultSchema,
  );
  console.log(`tools=${tools.tools.length}`);

  const writeResult = await client.request(
    {
      method: "tools/call",
      params: {
        name: toolName,
        arguments: writeArguments,
      },
    },
    CallToolResultSchema,
  );
  console.log("write=");
  console.log(JSON.stringify(writeResult, null, 2));

  if (searchDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, searchDelayMs));
  }

  const searchResult = await client.request(
    {
      method: "tools/call",
      params: {
        name: "memory_search",
        arguments: {
          query: searchQuery,
          domain: "general",
          limit: 5,
        },
      },
    },
    CallToolResultSchema,
  );
  console.log("search=");
  console.log(JSON.stringify(searchResult, null, 2));

  await transport.close();
}

main().catch(async (error) => {
  console.error(error);
  await transport.close().catch(() => undefined);
  process.exitCode = 1;
});
