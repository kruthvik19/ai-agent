import Fastify from "fastify";
import fastifyWs from "@fastify/websocket";
import fastifyFormBody from "@fastify/formbody";
import Twilio from "twilio";
import OpenAI from "openai";
import cors from "@fastify/cors";
import dotenv from "dotenv";
import fs from "fs";
dotenv.config();
const { Pinecone } = await import("@pinecone-database/pinecone");



const pinecone = new Pinecone();
const index = pinecone.Index("knowledge-base");

// OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PORT = process.env.PORT || 8080;
const DOMAIN = process.env.NGROK_URL;

const fastify = Fastify();
fastify.register(fastifyWs);
fastify.register(fastifyFormBody);
await fastify.register(cors, {
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
});

// In-memory stores
const sessions = new Map();
const callSettings = new Map();

// Helpers
async function aiResponse(messages, model, temperature, maxTokens) {
  const completion = await openai.chat.completions.create({
    model,
    temperature,
    max_tokens: maxTokens,
    messages,
  });
  return completion.choices[0].message.content;
}

async function embedText(text) {
  const embed = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  return embed.data[0].embedding;
}

async function getRelevantChunks(query, agentId, topK = 2) {
  const queryEmbedding = await embedText(query);
  const results = await index.query({
    vector: queryEmbedding,
    topK,
    includeMetadata: true,
    filter: { agent_id: agentId },
  });
  return results.matches.map(match => match.metadata.content);
}

// TwiML endpoint
fastify.all("/twiml", async (request, reply) => {
  const callSid = request.body.CallSid || request.query.callSid;
  console.log("📞 TwiML called with CallSid:", callSid);

  const settings = callSettings.get(callSid);

  if (!settings) {
    console.error("❌ Unknown CallSid:", callSid);
    return reply.code(400).send("Unknown CallSid.");
  }

  const combinedVoice = `${settings.elevenLabsVoiceId}-${settings.elevenLabsSpeed}_${settings.elevenLabsStability}_${settings.elevenLabsSimilarityBoost}`;

  reply.type("text/xml").send(
`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="wss://${DOMAIN}/ws?callSid=${callSid}"
      ttsProvider="ElevenLabs"
      voice="${combinedVoice}"
      elevenlabsTextNormalization="on"
      transcriberProvider="${settings.transcriberProvider}"
      transcriberLanguage="${settings.transcriberLanguage}"
      transcriberModel="${settings.transcriberModel}"
      welcomeGreeting="${settings.firstMessage}"/>
  </Connect>
</Response>`
  );
});

// Start call
fastify.post("/call-me", async (request, reply) => {
  const {
    number: toNumber,
    twilioAccountSid,
    twilioAuthToken,
    twilioPhoneNumber,
    elevenLabsVoiceId,
    elevenLabsSpeed,
    elevenLabsStability,
    elevenLabsSimilarityBoost,
    transcriberProvider,
    transcriberLanguage,
    transcriberModel,
    aiModel,
    temperature,
    systemPrompt,
    firstMessage,
    maxTokens
  } = request.body;

  if (!toNumber || !/^\+\d+$/.test(toNumber)) {
    return reply.code(400).send({ error: "Invalid or missing 'number'" });
  }

  const client = Twilio(twilioAccountSid, twilioAuthToken);

  try {
    const call = await client.calls.create({
      to: toNumber,
      from: twilioPhoneNumber,
      url: `https://${DOMAIN}/twiml`,
      record: true,
      recordingChannels: "dual",
    });

    callSettings.set(call.sid, {
      agentId: request.body.agentId, 
      elevenLabsVoiceId,
      elevenLabsSpeed,
      elevenLabsStability,
      elevenLabsSimilarityBoost,
      transcriberProvider,
      transcriberLanguage,
      transcriberModel,
      aiModel,
      temperature: parseFloat(temperature),
      systemPrompt,
      firstMessage,
      maxTokens: parseInt(maxTokens, 10),
    });

    console.log(`📞 Outbound call initiated to ${toNumber}. SID: ${call.sid}`);
    reply.send({ success: true, callSid: call.sid, to: toNumber });
  } catch (err) {
    console.error("❌ Failed to create outbound call:", err);
    reply.code(500).send({ error: "Failed to create call", details: err.message });
  }
});

// WebSocket
fastify.register(async function (fastify) {
  fastify.get("/ws", { websocket: true }, (ws, req) => {
    const callSid = req.query.callSid;
    const settings = callSettings.get(callSid);

    if (!settings) {
      console.error("❌ Unknown callSid in WebSocket:", callSid);
      ws.close();
      return;
    }

    ws.on("message", async (data) => {
      console.log("💬 Raw message:", data);
      const message = JSON.parse(data);

      switch (message.type) {
        case "setup":
          console.log("⚙️ Setup received for CallSid:", callSid);
          ws.callSid = callSid;
          sessions.set(callSid, []);
          break;

          case 'prompt':
            console.log('🎤 Prompt:', message.voicePrompt);
            const conversation = sessions.get(callSid) || [];
            conversation.push({ role: 'user', content: message.voicePrompt });
          
           
          
            const relevantChunks = await getRelevantChunks(message.voicePrompt, settings.agentId, 2); // topK = 1
            console.log('📌 Relevant chunks:', relevantChunks);
            const topChunk = relevantChunks[0]; // single most relevant chunk
            console.log('📌 top chunks:', topChunk);
            const dynamicPrompt = settings.systemPrompt + '\n\nContext:\n' + topChunk;

          const messages = [
            { role: "system", content: dynamicPrompt },
            ...conversation,
          ];

          const response = await aiResponse(
            messages,
            settings.aiModel,
            settings.temperature,
            settings.maxTokens
          );

          console.log("🤖 AI response:", response);

          conversation.push({ role: "assistant", content: response });

          ws.send(JSON.stringify({
            type: "text",
            token: response,
            last: true,
          }));
          break;

        case "interrupt":
          console.log("🔕 Interrupt received.");
          break;

        default:
          console.warn("⚠️ Unknown message type:", message.type);
      }
    });

    ws.on("close", () => {
      console.log("🛑 WebSocket closed");
      sessions.delete(callSid);
      callSettings.delete(callSid);
    });
  });
});

try {
  await fastify.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`🚀 Server running at http://0.0.0.0:${PORT} and wss://${DOMAIN}/ws`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
