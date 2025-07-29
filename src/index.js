import Fastify from "fastify";
import fastifyWs from "@fastify/websocket";
import fastifyFormBody from "@fastify/formbody";
import Twilio from "twilio";
import OpenAI from "openai";
import cors from "@fastify/cors";
import dotenv from "dotenv";
import workflowRoutes from '../routes/workflowRoutes.js';
import workflowController from '../controllers/workflowController.js';
import workflowModel from '../models/workflowModel.js';
dotenv.config();

const { Pinecone } = await import("@pinecone-database/pinecone");

const pinecone = new Pinecone();
const index = pinecone.Index("knowledge-base");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PORT = process.env.PORT || 8080;
const DOMAIN = process.env.NGROK_URL;

const fastify = Fastify({
  logger: true,
  maxParamLength: 1024,
  requestTimeout: 10000,
  keepAliveTimeout: 65 * 1000,
});
fastify.addHook('onRequest', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
});
fastify.register(fastifyWs);
fastify.register(fastifyFormBody);
await fastify.register(cors, {
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
});

const sessions = new Map();
const callSettings = new Map();
const embeddingCache = new Map();

async function getActiveWorkflowForAgent(agentId) {
  const workflow = await workflowController.getActiveWorkflowForAgent(agentId);
  return workflow ? await workflowModel.getWorkflowWithNodesAndEdges(workflow.id) : null;
}

function determineNextNode(workflow, currentNodeId, response, userInput) {
  const currentNode = workflow.nodes.find(n => n.id === currentNodeId);
  if (!currentNode) return null;
  const outgoingEdges = workflow.edges.filter(e => e.from_node_id === currentNodeId);
  if (outgoingEdges.length === 1) return outgoingEdges[0].to_node_id;
  for (const edge of outgoingEdges) {
    if (edge.condition?.type === 'direct') return edge.to_node_id;
    if (edge.condition?.intent && userInput.toLowerCase().includes(edge.condition.intent.toLowerCase())) {
      return edge.to_node_id;
    }
  }
  return outgoingEdges[0]?.to_node_id || null;
}

async function extractVariables(text, plan) {
  if (!plan?.output || plan.output.length === 0) return {};
  try {
    const prompt = `Extract the following variables from the text: ${JSON.stringify(plan.output)}
Text: "${text}"
Respond with only a JSON object containing the extracted variables.`;
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
    });
    return JSON.parse(completion.choices[0].message.content);
  } catch (error) {
    console.error('Error extracting variables:', error);
    return {};
  }
}

async function aiResponse(ws, messages, model, temperature, maxTokens) {
  const stream = await openai.chat.completions.create({
    model,
    temperature,
    max_tokens: maxTokens,
    messages,
    stream: true,
  });
  let fullMessage = "";
  for await (const chunk of stream) {
    const token = chunk.choices?.[0]?.delta?.content;
    if (token) {
      fullMessage += token;
      ws.send(JSON.stringify({ type: "text", token, last: false }));
    }
  }
  // ✅ End the stream clearly with last=true (don't repeat the whole response as a token)
  ws.send(JSON.stringify({ type: "text", token: "", last: true }));
  return fullMessage;
}

async function embedText(text) {
  const cacheKey = text.toLowerCase().trim();
  if (embeddingCache.has(cacheKey)) return embeddingCache.get(cacheKey);
  const embed = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  const result = embed.data[0].embedding;
  embeddingCache.set(cacheKey, result);
  return result;
}

async function preFetchAgentKnowledge(agentId) {
  try {
    const stats = await index.describeIndexStats();
    const vectorCount = stats.namespaces[agentId]?.vectorCount || 1000;
    const queryEmbedding = await embedText("general query");
    const results = await index.query({
      vector: queryEmbedding,
      topK: Math.min(vectorCount, 5000),
      includeMetadata: true,
      filter: { agent_id: agentId },
    });
    return results.matches.map(match => ({
      content: match.metadata.content,
      embedding: match.values
    }));
  } catch (error) {
    console.error('Error pre-fetching knowledge:', error);
    return [];
  }
}

async function executeNodeActions(actions, extractedVariables, callSid) {
  if (!actions) return;
  try {
    console.log('🔄 Executing actions:', actions);
    if (actions.send_calendar_invite) console.log('📅 Sending calendar invite');
    if (actions.update_crm) console.log('💼 Updating CRM');
  } catch (error) {
    console.error('❌ Error executing actions:', error);
  }
}

fastify.all("/twiml", async (request, reply) => {
  const callSid = request.body.CallSid || request.query.callSid;
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
      intelligenceService
  </Connect>
</Response>`
  );
});

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
    maxTokens,
    agentId
  } = request.body;
  if (!toNumber || !/^\+\d+$/.test(toNumber)) {
    return reply.code(400).send({ error: "Invalid or missing 'number'" });
  }
  const client = Twilio(twilioAccountSid, twilioAuthToken);
  try {
    const [workflow, knowledgeChunks] = await Promise.all([
      getActiveWorkflowForAgent(agentId),
      preFetchAgentKnowledge(agentId)
    ]);
    const startNode = workflow?.nodes?.find(n => !workflow.edges.some(e => e.to_node_id === n.id));
    const call = await client.calls.create({
      to: toNumber,
      from: twilioPhoneNumber,
      url: `https://${DOMAIN}/twiml`,
      record: true,
      recordingChannels: "dual",
    });
    callSettings.set(call.sid, {
      agentId,
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
      workflow,
      currentNodeId: startNode?.id,
      extractedVariables: {},
      knowledgeChunks,
      twilioAccountSid,
      twilioAuthToken
    });
    console.log(`📞 Outbound call initiated to ${toNumber}. SID: ${call.sid}`);
    reply.send({ success: true, callSid: call.sid, to: toNumber });
  } catch (err) {
    console.error("❌ Failed to create outbound call:", err);
    reply.code(500).send({ error: "Failed to create call", details: err.message });
  }
});

fastify.post("/end-call/:callSid", async (request, reply) => {
  const { callSid } = request.params;
  const settings = callSettings.get(callSid);
  if (!settings) {
    return reply.code(404).send({ error: "Call not found" });
  }
  try {
    const client = Twilio(settings.twilioAccountSid, settings.twilioAuthToken);
    await client.calls(callSid).update({ status: 'completed' });
    console.log(`📞 Call ${callSid} ended via API`);
    callSettings.delete(callSid);
    sessions.delete(callSid);
    reply.send({ success: true, message: "Call ended successfully" });
  } catch (err) {
    console.error("❌ Failed to end call:", err);
    reply.code(500).send({ error: "Failed to end call", details: err.message });
  }
});

fastify.post("/preview-agent", async (request, reply) => {
  const {
    agentId,
    userInput,
    aiModel,
    temperature,
    maxTokens,
    systemPrompt,
    firstMessage,
  } = request.body;

  try {
    // Get the agent's workflow and knowledge base from Pinecone
    const [workflow, knowledgeChunks] = await Promise.all([
      getActiveWorkflowForAgent(agentId),
      preFetchAgentKnowledge(agentId)
    ]);

    const startNode = workflow?.nodes?.find(n => !workflow.edges.some(e => e.to_node_id === n.id));
    let currentNodeId = startNode?.id;
    let extractedVariables = {};

    // Build the dynamic prompt with knowledge base and current step
    let dynamicPrompt = systemPrompt || "";
    if (startNode) {
      const nodeConfig = typeof startNode.config === 'string'
        ? JSON.parse(startNode.config)
        : startNode.config;
      dynamicPrompt += `\n\nCurrent Step: ${startNode.name}`;
      if (nodeConfig.prompt) dynamicPrompt += `\nStep Instructions: ${nodeConfig.prompt}`;
    }

    // Combine all knowledge chunks, not just the first
    const knowledgeContext = knowledgeChunks.map(chunk => chunk.content).join("\n\n");
    dynamicPrompt += '\n\nKnowledge Base:\n' + knowledgeContext;

    // Build conversation messages
    const messages = [
      { role: "system", content: dynamicPrompt },
      { role: "assistant", content: firstMessage || "How can I help you today?" },
      { role: "user", content: userInput }
    ];

    // Get AI response from OpenAI
    const completion = await openai.chat.completions.create({
      model: aiModel || "gpt-4",
      temperature: temperature !== undefined ? parseFloat(temperature) : 0.7,
      max_tokens: maxTokens !== undefined ? parseInt(maxTokens, 10) : 256,
      messages
    });

    const aiReply = completion.choices[0].message.content;

    // Extract variables if configured in the first node
    if (startNode?.config?.variableExtractionPlan) {
      const newVariables = await extractVariables(
        userInput,
        startNode.config.variableExtractionPlan
      );
      extractedVariables = { ...extractedVariables, ...newVariables };
    }

    // Determine next node for multi-turn preview
    let nextNodeId = null;
    if (workflow && currentNodeId) {
      nextNodeId = determineNextNode(workflow, currentNodeId, aiReply, userInput);
    }

    // Return AI reply and extracted variables
    reply.send({
      success: true,
      aiReply,
      extractedVariables,
      nextNodeId
    });
  } catch (err) {
    console.error("❌ Failed to preview agent:", err);
    reply.code(500).send({ error: "Failed to preview agent", details: err.message });
  }
});

fastify.register(workflowRoutes, { prefix: '/api' });

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
          const { workflow, currentNodeId, knowledgeChunks } = settings;
          const currentNode = workflow?.nodes?.find(n => n.id === currentNodeId);
          if (currentNode?.type === 'end_call') {
            console.log('🛑 End call node reached');
            const nodeConfig = typeof currentNode.config === 'string'
              ? JSON.parse(currentNode.config)
              : currentNode.config;
            if (nodeConfig.actions) {
              await executeNodeActions(nodeConfig.actions, settings.extractedVariables, callSid);
            }
            const endMessage = nodeConfig.prompt || 'Thank you for your time. Goodbye!';
            try {
              const client = Twilio(settings.twilioAccountSid, settings.twilioAuthToken);
              await client.calls(callSid).update({ status: 'completed' });
              console.log(`📞 Call ${callSid} ended via Twilio API`);
            } catch (err) {
              console.error("❌ Failed to end call via Twilio API:", err);
            }
            setTimeout(() => {
              ws.close();
              callSettings.delete(callSid);
              sessions.delete(callSid);
            }, 3000);
            return;
          }
          const topChunk = settings.knowledgeChunks?.[0]?.content || '';
          console.log('📌 Pre-fetched knowledge chunks used');
          let dynamicPrompt = settings.systemPrompt;
          if (currentNode) {
            const nodeConfig = typeof currentNode.config === 'string'
              ? JSON.parse(currentNode.config)
              : currentNode.config;
            dynamicPrompt += `\n\nCurrent Step: ${currentNode.name}`;
            if (nodeConfig.prompt) dynamicPrompt += `\nStep Instructions: ${nodeConfig.prompt}`;
            if (Object.keys(settings.extractedVariables).length > 0) {
              dynamicPrompt += `\nExtracted Variables: ${JSON.stringify(settings.extractedVariables)}`;
            }
          }
          dynamicPrompt += '\n\nContext:\n' + topChunk;
          const messages = [
            { role: "system", content: dynamicPrompt },
            ...conversation,
          ];
          const response = await aiResponse(
            ws,
            messages,
            settings.aiModel,
            settings.temperature,
            settings.maxTokens
          );
          console.log("🤖 AI response:", response);
          if (currentNode?.config?.variableExtractionPlan) {
            const newVariables = await extractVariables(
              message.voicePrompt,
              currentNode.config.variableExtractionPlan
            );
            settings.extractedVariables = {
              ...settings.extractedVariables,
              ...newVariables
            };
            console.log('📝 Extracted variables:', newVariables);
          }
          if (workflow && currentNodeId) {
            const nextNodeId = determineNextNode(workflow, currentNodeId, response, message.voicePrompt);
            if (nextNodeId) {
              settings.currentNodeId = nextNodeId;
              console.log('⏭️ Moving to next node:', nextNodeId);
            }
          }
          conversation.push({ role: "assistant", content: response });
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


fastify.register(async function (fastify) {
  fastify.get("/preview-agent-ws", { websocket: true }, (ws, req) => {
    const sessionId = req.query.sessionId || `preview-${Date.now()}`; // Unique session ID for preview
    console.log(`⚙️ WebSocket setup for preview session: ${sessionId}`);

    ws.on("message", async (data) => {
      try {
        const message = JSON.parse(data);
        switch (message.type) {
          case "ping":
            ws.send(JSON.stringify({ type: "pong" }));
            break;
          case "setup":
            // Initialize session with provided settings
            const {
              agentId,
              aiModel,
              temperature,
              maxTokens,
              systemPrompt,
              firstMessage,
            } = message.payload;
            // Initialize conversation with firstMessage
            sessions.set(sessionId, [{ role: "assistant", content: firstMessage || "How can I help you today?" }]);
            callSettings.set(sessionId, {
              agentId,
              aiModel: aiModel || "gpt-4",
              temperature: parseFloat(temperature) || 0.7,
              maxTokens: parseInt(maxTokens, 10) || 256,
              systemPrompt: systemPrompt || "You are a helpful AI agent designed for phone-like conversations.",
              firstMessage,
              extractedVariables: {},
              workflow: null,
              currentNodeId: null,
              knowledgeChunks: [],
            });

            // Pre-fetch workflow and knowledge
            const [workflow, knowledgeChunks] = await Promise.all([
              getActiveWorkflowForAgent(agentId),
              preFetchAgentKnowledge(agentId),
            ]);
            const startNode = workflow?.nodes?.find(
              (n) => !workflow.edges.some((e) => e.to_node_id === n.id)
            );
            callSettings.get(sessionId).workflow = workflow;
            callSettings.get(sessionId).currentNodeId = startNode?.id;
            callSettings.get(sessionId).knowledgeChunks = knowledgeChunks;

            console.log(`⚙️ Preview session setup for agentId: ${agentId}`);
            ws.send(JSON.stringify({ type: "setup", success: true, sessionId }));
            // Removed: ws.send(JSON.stringify({ type: "text", token: firstMessage, last: true }));
            break;

          case "prompt":
            const { userInput } = message;
            console.log(`🎤 Preview prompt: ${userInput}`);
            const settings = callSettings.get(sessionId);
            if (!settings) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: "Session not found. Please start a new session.",
                })
              );
              return;
            }

            const conversation = sessions.get(sessionId) || [];
            conversation.push({ role: "user", content: userInput });

            const currentWorkflow = settings.workflow;
            const currentNodeId = settings.currentNodeId;
            const currentKnowledgeChunks = settings.knowledgeChunks;
            const currentNode = currentWorkflow?.nodes?.find((n) => n.id === currentNodeId);

            // Build dynamic prompt
            let dynamicPrompt = settings.systemPrompt;
            if (currentNode) {
              const nodeConfig =
                typeof currentNode.config === "string"
                  ? JSON.parse(currentNode.config)
                  : currentNode.config;
              dynamicPrompt += `\n\nCurrent Step: ${currentNode.name}`;
              if (nodeConfig.prompt) dynamicPrompt += `\nStep Instructions: ${nodeConfig.prompt}`;
              if (Object.keys(settings.extractedVariables).length > 0) {
                dynamicPrompt += `\nExtracted Variables: ${JSON.stringify(
                  settings.extractedVariables
                )}`;
              }
            }

            const combinedKnowledge = currentKnowledgeChunks.map(chunk => chunk.content).join("\n\n");
            dynamicPrompt += "\n\nContext:\n" + combinedKnowledge;
            const messages = [
              { role: "system", content: dynamicPrompt },
              ...conversation,
            ];

            // Stream AI response
            const response = await aiResponse(
              ws,
              messages,
              settings.aiModel,
              settings.temperature,
              settings.maxTokens
            );
            console.log("🤖 AI response:", response);

            // Extract variables if needed
            if (currentNode?.config?.variableExtractionPlan) {
              const newVariables = await extractVariables(
                userInput,
                currentNode.config.variableExtractionPlan
              );
              settings.extractedVariables = {
                ...settings.extractedVariables,
                ...newVariables,
              };
              console.log("📝 Extracted variables:", newVariables);
            }

            // Determine next node
            if (currentWorkflow && currentNodeId) {
              const nextNodeId = determineNextNode(currentWorkflow, currentNodeId, response, userInput);
              if (nextNodeId) {
                settings.currentNodeId = nextNodeId;
                console.log(`⏭️ Moving to next node: ${nextNodeId}`);
              }
            }

            conversation.push({ role: "assistant", content: response });
            sessions.set(sessionId, conversation);
            break;

          case "end":
            console.log(`🛑 Preview session ended: ${sessionId}`);
            sessions.delete(sessionId);
            callSettings.delete(sessionId);
            ws.close();
            break;

          default:
            console.warn(`⚠️ Unknown message type: ${message.type}`);
        }
      } catch (err) {
        console.error("❌ WebSocket error:", err);
        ws.send(
          JSON.stringify({ type: "error", message: `Error: ${err.message}` })
        );
      }
    });

    ws.on("close", () => {
      console.log(`🛑 WebSocket closed for session: ${sessionId}`);
      sessions.delete(sessionId);
      callSettings.delete(sessionId);
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
