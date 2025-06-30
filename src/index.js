import Fastify from "fastify";
import fastifyWs from "@fastify/websocket";
import fastifyFormBody from "@fastify/formbody";
import Twilio from "twilio";
import OpenAI from "openai";
import cors from "@fastify/cors";
import dotenv from "dotenv";
dotenv.config();
const twilioClient = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const PORT = process.env.PORT || 8080;
const DOMAIN = process.env.NGROK_URL;
const WS_URL = `wss://${DOMAIN}/ws`;
const WELCOME_GREETING =
  "Hi! I am a voice assistant powered by Twilio and Open A I . Ask me anything!";
const SYSTEM_PROMPT =
  "You are a helpful assistant. This conversation is being translated to voice, so answer carefully. When you respond, please spell out all numbers, for example twenty not 20. Do not include emojis in your responses. Do not include bullet points, asterisks, or special symbols.";
const sessions = new Map();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
async function aiResponse(messages) {
  let completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: messages,
  });
  return completion.choices[0].message.content;
}

const fastify = Fastify();
fastify.register(fastifyWs);
fastify.register(fastifyFormBody);

await fastify.register(cors, {
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
});
fastify.all("/twiml", async (request, reply) => {
  reply.type("text/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <ConversationRelay url="${WS_URL}" ttsProvider="ElevenLabs" voice="ZF6FPAbjXT4488VcRRnw-flash_v2_5-1.2_1.0_1.0" elevenlabsTextNormalization="on" welcomeGreeting="${WELCOME_GREETING}"/>
      </Connect>
    </Response>`
  );
});

// API to initiate outbound call
fastify.post("/call-me", async (request, reply) => {
  const { number: toNumber } = request.body;

  if (!toNumber || !/^\+\d+$/.test(toNumber)) {
    return reply.code(400).send({ error: "Invalid or missing 'number'" });
  }

  try {
    const call = await twilioClient.calls.create({
      to: toNumber,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `https://${DOMAIN}/twiml`,
       record: true, 
      recordingChannels: 'dual',
    });

    console.log(`📞 Outbound call initiated to ${toNumber}. SID: ${call.sid}`);

    reply.send({
      success: true,
      callSid: call.sid,
      to: toNumber,
    });
  } catch (err) {
    console.error("❌ Failed to create outbound call:", err);
    reply.code(500).send({ error: "Failed to create call", details: err.message });
  }
});


fastify.register(async function (fastify) {
  fastify.get("/ws", { websocket: true }, (ws, req) => {
    ws.on("message", async (data) => {
      console.log("💬 Raw message from Twilio:", data);
    
      const message = JSON.parse(data);
      console.log("📝 Parsed message:", message);
    
      switch (message.type) {
        case "setup":
          console.log("⚙️ Setup event received");
          const callSid = message.callSid;
          ws.callSid = callSid;
          sessions.set(callSid, [{ role: "system", content: SYSTEM_PROMPT }]);
          break;
    
        case "prompt":
          console.log("🎤 Prompt received:", message.voicePrompt);
          const conversation = sessions.get(ws.callSid);
          if (!conversation) {
            console.warn("⚠️ No conversation found for this callSid!");
            return;
          }
          conversation.push({ role: "user", content: message.voicePrompt });
    
          const response = await aiResponse(conversation);
          console.log("🤖 AI response:", response);
    
          conversation.push({ role: "assistant", content: response });
    
          const outgoing = JSON.stringify({
            type: "text",
            token: response,
            last: true,
          });
          console.log("📤 Sending response to Twilio:", outgoing);
    
          ws.send(outgoing);
          break;
    
        case "interrupt":
          console.log("🔕 Interrupt event received.");
          break;
    
        default:
          console.warn("⚠️ Unknown message type:", message.type);
          break;
      }
    });

    ws.on("close", () => {
      console.log("WebSocket connection closed");
      sessions.delete(ws.callSid);
    });
  });
});

try {
  await fastify.listen({ port: PORT, host: "0.0.0.0" });
  console.log(
    `Server running at http://0.0.0.0:${PORT} and wss://${DOMAIN}/ws`
  );
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
