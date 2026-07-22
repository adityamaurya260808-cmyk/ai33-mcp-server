// ai33-mcp-server
//
// Ye ek MCP (Model Context Protocol) server hai jo Ai33.Pro ke
// Text-to-Speech aur Imagen 2 (image generation) APIs ko Claude ke
// liye "tools" bana deta hai.
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

// Task status ko poll karne ke liye helper.
// Har 4 seconds mein check karta hai, max ~2 minute tak (30 tries).
async function pollTaskUntilDone(taskId, { intervalMs = 4000, maxTries = 30 } = {}) {
  for (let i = 0; i < maxTries; i++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));

    const res = await fetch(`https://api.ai33.pro/v1/task/${taskId}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": AI33_API_KEY,
      },
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Task status check failed (${res.status}): ${errText || res.statusText}`);
    }

    const data = await res.json();

    if (data.status === "done") {
      return data;
    }
    if (data.status === "error") {
      throw new Error(data.error_message || "Image generation failed.");
    }
    // status === "doing" -> continue polling
  }

  throw new Error(
    `Task ${taskId} 2 minute ke andar complete nahi hua. Baad mein task_id "${taskId}" se status check karo.`
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
          .describe("The text to convert to speech. Max 1,000,000 characters."),
        voice_id: z
          .string()
          .default("minimax_male-qn-qingse")
          .describe(
            "Provider-prefixed voice id, e.g. elevenlabs_..., minimax_..., clone_..., edge_..., kokoro_..., vbee_..., fishaudio_... " +
              "Use the ai33_list_voices tool to search for available voice ids."
          ),
        speed: z
          .number()
          .min(0.5)
          .max(1.5)
          .default(1)
          .describe("Playback speed, between 0.5 and 1.5."),
        with_transcript: z
          .boolean()
          .default(false)
          .describe("If true, also return a word-level transcript alongside the audio."),
        file_name: z
          .string()
          .optional()
          .describe("Optional output file name for the generated audio."),
        pronunciation_dictionary_id: z
          .number()
          .optional()
          .describe(
            "Optional id of a pronunciation dictionary (created via the Ai33.Pro dictionaries API) to apply. Only affects the audio, not the transcript."
          ),
      },
    },
    async ({ text, voice_id, speed, with_transcript, file_name, pronunciation_dictionary_id }) => {
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
      formData.append("with_transcript", String(with_transcript ?? false));
      if (file_name) {
        formData.append("file_name", file_name);
      }
      if (pronunciation_dictionary_id !== undefined) {
        formData.append("pronunciation_dictionary_id", String(pronunciation_dictionary_id));
      }

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

      const contentType = response.headers.get("content-type") || "";

      // Agar with_transcript=true tha, API JSON bhi laut sakta hai (audio_url + transcript).
      // Is case ko safely handle karo instead of assuming raw audio bytes.
      if (contentType.includes("application/json")) {
        const jsonData = await response.json();
        return {
          content: [
            {
              type: "text",
              text: `Audio task submitted.\n${JSON.stringify(jsonData, null, 2)}`,
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

  server.registerTool(
    "ai33_list_voices",
    {
      title: "Ai33.Pro List Voices",
      description:
        "Search the Ai33.Pro Voice Library (ElevenLabs, Minimax, cloned, Edge, Kokoro, Vbee, or FishAudio voices) " +
        "to find a voice_id to use with text_to_speech.",
      inputSchema: {
        provider: z
          .enum(["elevenlabs", "minimax", "clone", "edge", "kokoro", "vbee", "fishaudio"])
          .describe("Which voice provider to search."),
        search: z
          .string()
          .optional()
          .describe("Free-text search across id, name, description, language, gender, tags."),
        language: z.string().optional().describe("Filter by language, e.g. Vietnamese, English."),
        gender: z.string().optional().describe("Filter by gender, e.g. Male, Female."),
        page: z.number().default(1).describe("Page number, default 1."),
        limit: z.number().default(30).describe("Results per page, default 30, max 100."),
      },
    },
    async ({ provider, search, language, gender, page, limit }) => {
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

      const params = new URLSearchParams();
      params.set("provider", provider);
      if (search) params.set("search", search);
      if (language) params.set("language", language);
      if (gender) params.set("gender", gender);
      params.set("page", String(page ?? 1));
      params.set("page_size", String(limit ?? 30));

      let response;
      try {
        response = await fetch(`https://api.ai33.pro/v3/voices?${params.toString()}`, {
          method: "GET",
          headers: {
            "xi-api-key": AI33_API_KEY,
          },
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

      const data = await response.json();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    "list_image_models",
    {
      title: "Ai33.Pro List Image Models",
      description:
        "Retrieves available Ai33.Pro image generation models with their supported parameters " +
        "(aspect ratios, resolutions, max generations, etc). Use this to find a model_id for generate_image.",
      inputSchema: {},
    },
    async () => {
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

      let response;
      try {
        response = await fetch("https://api.ai33.pro/v1i/models", {
          method: "GET",
          headers: {
            "xi-api-key": AI33_API_KEY,
          },
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

      const data = await response.json();

      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.registerTool(
    "generate_image",
    {
      title: "Ai33.Pro Generate Image",
      description:
        "Generate an image from a text prompt using the Ai33.Pro Imagen 2 API " +
        "(bytedance-seedream-4.5 model). Creates a task, polls until complete, " +
        "and returns the generated image.",
      inputSchema: {
        prompt: z
          .string()
          .max(4000)
          .describe("Image description (max 4000 characters)."),
        model_id: z
          .string()
          .default("bytedance-seedream-4.5")
          .describe(
            "Which image model to use. Default is bytedance-seedream-4.5. " +
              "Use the list_image_models tool to see other available model ids."
          ),
        aspect_ratio: z
          .enum(["16:9", "4:3", "1:1", "3:4", "9:16"])
          .default("16:9")
          .describe("Aspect ratio of the generated image."),
        resolution: z
          .enum(["2K", "4K"])
          .default("2K")
          .describe("Output resolution."),
      },
    },
    async ({ prompt, model_id, aspect_ratio, resolution }) => {
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

      const modelParameters = JSON.stringify({
        aspect_ratio: aspect_ratio ?? "16:9",
        resolution: resolution ?? "2K",
      });

      const formData = new FormData();
      formData.append("prompt", prompt);
      formData.append("model_id", model_id ?? "bytedance-seedream-4.5");
      formData.append("generations_count", "1");
      formData.append("model_parameters", modelParameters);

      // Step 1: create the image generation task
      let createRes;
      try {
        createRes = await fetch("https://api.ai33.pro/v1i/task/generate-image", {
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

      if (!createRes.ok) {
        const errText = await createRes.text().catch(() => "");
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Ai33.Pro API error (${createRes.status}): ${errText || createRes.statusText}`,
            },
          ],
        };
      }

      const createData = await createRes.json();
      const taskId = createData.task_id;

      if (!taskId) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Task create response mein task_id nahi mila: ${JSON.stringify(createData)}` },
          ],
        };
      }

      // Step 2: poll until done
      let finalData;
      try {
        finalData = await pollTaskUntilDone(taskId);
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err.message }],
        };
      }

      const resultImages = finalData?.metadata?.result_images ?? [];
      if (resultImages.length === 0) {
        return {
          isError: true,
          content: [
            { type: "text", text: "Task complete hua lekin koi image nahi mili." },
          ],
        };
      }

      const imageUrl = resultImages[0].imageUrl;

      // Step 3: download the image and return as base64
      let imgRes;
      try {
        imgRes = await fetch(imageUrl);
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Image generate ho gayi, lekin download mein error aayi. Direct URL: ${imageUrl}`,
            },
          ],
        };
      }

      if (!imgRes.ok) {
        return {
          content: [
            {
              type: "text",
              text: `Image generate ho gayi, lekin download fail hua. Direct URL: ${imageUrl}`,
            },
          ],
        };
      }

      const imgArrayBuffer = await imgRes.arrayBuffer();
      const base64Image = Buffer.from(imgArrayBuffer).toString("base64");
      const mimeType = resultImages[0].mimeType || "image/png";

      return {
        content: [
          { type: "text", text: `Image successfully generated. URL: ${imageUrl}` },
          {
            type: "image",
            data: base64Image,
            mimeType,
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
