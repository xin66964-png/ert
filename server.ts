import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

// Increase payload limit for large API payloads
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ limit: "15mb", extended: true }));

// Lazy initializer for Gemini SDK
let aiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI | null {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (key && key !== "MY_GEMINI_API_KEY") {
      aiClient = new GoogleGenAI({ apiKey: key });
    }
  }
  return aiClient;
}

// 1. API proxy route to bypass CORS and execute requests server-side
app.post("/api/proxy", async (req, res) => {
  const { url, method, headers, body } = req.body;

  if (!url) {
    res.status(400).json({ error: "Missing Target URL" });
    return;
  }

  // Format valid target URL
  let targetUrl = url;
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = "http://" + targetUrl;
  }

  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

  try {
    // Prep request options
    const fetchOptions: RequestInit = {
      method: method || "GET",
      headers: headers || {},
      signal: controller.signal,
    };

    if (["POST", "PUT", "DELETE", "PATCH"].includes(method?.toUpperCase()) && body !== undefined) {
      if (typeof body === "object") {
        fetchOptions.body = JSON.stringify(body);
        if (!fetchOptions.headers) fetchOptions.headers = {};
        // Add JSON content type if not set
        const hs = fetchOptions.headers as Record<string, string>;
        const keys = Object.keys(hs).map(k => k.toLowerCase());
        if (!keys.includes("content-type")) {
          hs["Content-Type"] = "application/json";
        }
      } else {
        fetchOptions.body = body;
      }
    }

    const response = await fetch(targetUrl, fetchOptions);
    clearTimeout(timeoutId);

    const endTime = Date.now();
    const responseTime = endTime - startTime;

    // Read body buffer to get accurate size and support bin/text
    const arrayBuffer = await response.arrayBuffer();
    const size = arrayBuffer.byteLength;
    
    // Decode text
    const decoder = new TextDecoder("utf-8");
    const responseBodyHtmlOrText = decoder.decode(arrayBuffer);

    // Parse response headers
    const resHeaders: Record<string, string> = {};
    response.headers.forEach((val, key) => {
      resHeaders[key] = val;
    });

    const contentType = resHeaders["content-type"] || "";
    const isJson = contentType.toLowerCase().includes("application/json");

    let parsedJson = null;
    if (isJson) {
      try {
        parsedJson = JSON.parse(responseBodyHtmlOrText);
      } catch (err) {
        // Fallback if parsing fails despite headers
      }
    } else {
      // Try to parse anyway, just in case
      try {
        parsedJson = JSON.parse(responseBodyHtmlOrText);
      } catch (e) {}
    }

    res.json({
      status: response.status,
      statusText: response.statusText,
      headers: resHeaders,
      responseTime,
      size,
      body: responseBodyHtmlOrText,
      isJson: isJson || parsedJson !== null,
      parsedJson: parsedJson || undefined
    });

  } catch (error: any) {
    clearTimeout(timeoutId);
    const endTime = Date.now();
    const responseTime = endTime - startTime;

    let errorMessage = error.message || "Unknown error occurred";
    if (error.name === "AbortError") {
      errorMessage = "Request timed out after 30 seconds";
    }

    res.status(200).json({
      status: 0,
      statusText: "Error / Connection Failed",
      headers: {},
      responseTime,
      size: 0,
      body: `Connection failed: ${errorMessage}`,
      isJson: false,
      error: errorMessage
    });
  }
});

// 2. AI route for analyzing responses/generating payloads
app.post("/api/ai-analyze", async (req, res) => {
  const ai = getGeminiClient();
  if (!ai) {
    res.status(503).json({ 
      error: "Gemini API key is not configured or activated. Please configure GEMINI_API_KEY in the platform secret panels." 
    });
    return;
  }

  const { task, data } = req.body;

  try {
    let prompt = "";
    if (task === "analyze-json") {
      prompt = `You are a professional API Engineering assistant. Analyze the following JSON response. 
Analyze the structure, explain what the keys/data represent, identify potential schema standards, point out any data quality issues or risks, and output a clean summary.

JSON Data to Analyze:
${JSON.stringify(data, null, 2)}

Please respond in Chinese. Keep your analysis structured, clear, and highly practical for developers.`;
    } else if (task === "generate-schema") {
      prompt = `You are an expert TypeScript architect. Generate high-quality TypeScript interfaces and modern JSON Schema representations based on this response data:

JSON Data:
${JSON.stringify(data, null, 2)}

Provide your response in Chinese, containing:
1. Well-documented TypeScript Interfaces (with comments explaining each property type/use)
2. A summary of the key data structures and any optional fields detected.
Output code blocks in markdown format.`;
    } else if (task === "suggest-params") {
      prompt = `The user wants to call an API. Given this prompt or URL: "${data.prompt || data.url}".
Help them draft the proper HTTP parameters (headers, query strings, and body payload) in JSON format.
Include brief notes in Chinese about common OAuth or authentication schemes, content configurations, and any specific headers they should include.`;
    } else {
      prompt = `Explain this API error or data structure in developer-friendly Chinese:
${typeof data === 'object' ? JSON.stringify(data, null, 2) : data}`;
    }

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
    });

    res.json({ result: response.text });
  } catch (error: any) {
    res.status(500).json({ error: `AI Integration Error: ${error.message || error}` });
  }
});

// Serve web application assets
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    console.log("Starting server in development mode with Vite HMR...");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log("Starting server in production mode...");
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
