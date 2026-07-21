// ai33-mcp-server
//
// Ye ek MCP (Model Context Protocol) server hai jo Ai33.Pro ke
// Text-to-Speech API ko Claude ke liye ek "tool" bana deta hai.
// Ise deploy karne ke baad, iska public URL Claude.ai ke
// Settings -> Connectors -> Add custom connector mein daalo.
//
// API key kabhi bhi is file mein hardcode mat karo. Ye AI33_API_KEY
// environment variable se aayegi (hosting platform pe set karoge).

import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const AI33_API_KEY = process.env.AI33_API_KEY;
const PORT = process.env.PORT || 3000;

if (!AI33_API_KEY) {
  console.warn(
    "[warn] AI33_API_KEY environment variable set nahi hai. " +
      "Requests fail ho jayengi jab tak ise set na karo."
  );
}

function buildServer() {
  const server = new McpServer({
    name: "ai33-pro",
    version: "1.0.0",
  });

  server.registerTool(
    "text_to_speech",
    {
      title: "Ai33.Pro Text to Speech",
      description:
        "Convert text into spoken audio using the Ai33.Pro v3 text-to-speech API. " +
        "Returns the generated audio as an MP3 file.",
      inputSchema: {
        text: z
          .string()
          .max(1000000)
          .describe("The text to convert to speech."),
        voice_id: z
          .string()
          .default("minimax_male-qn-qingse")
          .describe(
            "Provider-prefixed voice id, e.g. elevenlabs_..., minimax_..., clone_..., edge_..., kokoro_..., vbee_..., fishaudio_..."
          ),
        speed: z
          .number()
          .min(0.5)
          .max(1.5)
          .default(1)
          .describe("Playback speed, between 0.5 and 1.5."),
      },
    },
    async ({ text, voice_id, speed }) => {
      if (!AI33_API_KEY) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Server par AI33_API_KEY set nahi hai. Hosting platform ke environment variables mein API key add karo.",
            },
          ],
        };
      }

      const formData = new FormData();
      formData.append("text", text);
      formData.append("voice_id", voice_id ?? "minimax_male-qn-qingse");
      formData.append("speed", String(speed ?? 1));
      formData.append("with_transcript", "false");

      let response;
      try {
        response = await fetch("https://api.ai33.pro/v3/text-to-speech", {
          method: "POST",
          headers: {
            "xi-api-key": AI33_API_KEY,
          },
          body: formData,
        });
      } catch (err) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Network error calling Ai33.Pro: ${err.message}` },
          ],
        };
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Ai33.Pro API error (${response.status}): ${errText || response.statusText}`,
            },
          ],
        };
      }

      const arrayBuffer = await response.arrayBuffer();
      const base64Audio = Buffer.from(arrayBuffer).toString("base64");

      return {
        content: [
          { type: "text", text: "Audio successfully generated." },
          {
            type: "audio",
            data: base64Audio,
            mimeType: "audio/mpeg",
          },
        ],
      };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

// Stateless mode: har request apna naya server + transport instance leta hai.
// Chhote/simple connectors ke liye ye sabse aasan aur reliable pattern hai.
app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// GET/DELETE not used in stateless mode, but MCP clients may probe them.
app.get("/mcp", (req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. Use POST." },
    id: null,
  });
});

app.get("/", (req, res) => {
  res.send("ai33-mcp-server is running. MCP endpoint: POST /mcp");
});

app.listen(PORT, () => {
  console.log(`ai33-mcp-server listening on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});
