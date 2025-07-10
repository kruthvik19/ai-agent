import Fastify from "fastify";
import fastifyWs from "@fastify/websocket";
import fastifyFormBody from "@fastify/formbody";
import Twilio from "twilio";
import OpenAI from "openai";
import cors from "@fastify/cors";
import dotenv from "dotenv";
import fs from "fs";
import workflowRoutes from '../routes/workflowRoutes.js';
import workflowController from '../controllers/workflowController.js';
import workflowModel from '../models/workflowModel.js';
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
 
// Helper to get active workflow for an agent
async function getActiveWorkflowForAgent(agentId) {
  // Direct function call instead of HTTP request
  const workflow = await workflowController.getActiveWorkflowForAgent(agentId);
 
  if (workflow) {
    // Get the full workflow with nodes and edges
    return await workflowModel.getWorkflowWithNodesAndEdges(workflow.id);
  }
 
  return null;
}
 
// Helper to determine next node based on response
function determineNextNode(workflow, currentNodeId, response, userInput) {
  const currentNode = workflow.nodes.find(n => n.id === currentNodeId);
  if (!currentNode) return null;
 
  // Find edges from current node
  const outgoingEdges = workflow.edges.filter(e => e.from_node_id === currentNodeId);
 
  // If only one edge, follow it
  if (outgoingEdges.length === 1) {
    return outgoingEdges[0].to_node_id;
  }
 
  // If multiple edges, evaluate conditions
  for (const edge of outgoingEdges) {
    if (edge.condition?.type === 'direct') {
      return edge.to_node_id;
    }
    // Add basic intent matching
    if (edge.condition?.intent && userInput.toLowerCase().includes(edge.condition.intent.toLowerCase())) {
      return edge.to_node_id;
    }
  }
 
  // Default to first edge if no conditions match
  return outgoingEdges[0]?.to_node_id || null;
}
 
// Helper to extract variables based on plan
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
   
    const response = completion.choices[0].message.content;
    return JSON.parse(response);
  } catch (error) {
    console.error('Error extracting variables:', error);
    return {};
  }
}
 
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
 
// Helper to execute actions defined in node config
async function executeNodeActions(actions, extractedVariables, callSid) {
  if (!actions) return;
 
  try {
    console.log('🔄 Executing actions:', actions);
   
    // Handle calendar invite action
    if (actions.send_calendar_invite) {
      console.log('📅 Sending calendar invite');
      // Implementation for sending calendar invite using extracted variables
    }
   
    // Handle CRM update action
    if (actions.update_crm) {
      console.log('💼 Updating CRM');
      // Implementation for updating CRM with call details and extracted variables
    }
   
    // Handle other action types as needed
  } catch (error) {
    console.error('❌ Error executing actions:', error);
  }
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
    // Get active workflow for the agent
    const workflow = await getActiveWorkflowForAgent(request.body.agentId);
    const startNode = workflow?.nodes?.find(n => !workflow.edges.some(e => e.to_node_id === n.id));
   
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
      // Add workflow-related settings
      workflow: workflow,
      currentNodeId: startNode?.id,
      extractedVariables: {}
    });
 
    console.log(`📞 Outbound call initiated to ${toNumber}. SID: ${call.sid}`);
    reply.send({ success: true, callSid: call.sid, to: toNumber });
  } catch (err) {
    console.error("❌ Failed to create outbound call:", err);
    reply.code(500).send({ error: "Failed to create call", details: err.message });
  }
});
 
// Endpoint to end a call
fastify.post("/end-call/:callSid", async (request, reply) => {
  const { callSid } = request.params;
  const settings = callSettings.get(callSid);
 
  if (!settings) {
    return reply.code(404).send({ error: "Call not found" });
  }
 
  try {
    const client = Twilio(request.body.twilioAccountSid, request.body.twilioAuthToken);
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
 fastify.register(workflowRoutes, { prefix: '/api' });
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
         
          // Get current node from workflow
          const { workflow, currentNodeId, extractedVariables } = settings;
          const currentNode = workflow?.nodes?.find(n => n.id === currentNodeId);
         
          console.log('🔄 Current workflow node:', currentNode?.name);
         
          // Check if current node is an end_call type node
          if (currentNode?.type === 'end_call') {
            console.log('🛑 End call node reached, terminating call');
           
            // Get node config
            const nodeConfig = typeof currentNode.config === 'string'
              ? JSON.parse(currentNode.config)
              : currentNode.config;
           
            // Execute any actions defined in the end node
            if (nodeConfig.actions) {
              await executeNodeActions(nodeConfig.actions, settings.extractedVariables, callSid);
            }
           
            // Send final message before ending call
            const endMessage = nodeConfig.prompt || 'Thank you for your time. Goodbye!';
           
            ws.send(JSON.stringify({
              type: "text",
              token: endMessage,
              last: true,
              endCall: true  // Signal to client that call should end
            }));
           
            // End the call via Twilio API
            try {
              const twilioAccountSid = settings.twilioAccountSid;
              const twilioAuthToken = settings.twilioAuthToken;
              if (twilioAccountSid && twilioAuthToken) {
                const client = Twilio(twilioAccountSid, twilioAuthToken);
                await client.calls(callSid).update({ status: 'completed' });
                console.log(`📞 Call ${callSid} ended via Twilio API`);
              }
            } catch (err) {
              console.error("❌ Failed to end call via Twilio API:", err);
            }
           
            // Close the WebSocket after sending the final message
            setTimeout(() => {
              ws.close();
              callSettings.delete(callSid);
              sessions.delete(callSid);
            }, 3000);  // Give time for the message to be processed
           
            return;  // Exit the handler
          }
         
          const relevantChunks = await getRelevantChunks(message.voicePrompt, settings.agentId, 2);
          console.log('📌 Relevant chunks:', relevantChunks);
          const topChunk = relevantChunks[0];
         
          // Build dynamic prompt with workflow context
          let dynamicPrompt = settings.systemPrompt;
          if (currentNode) {
            const nodeConfig = typeof currentNode.config === 'string'
              ? JSON.parse(currentNode.config)
              : currentNode.config;
             
            dynamicPrompt += `\n\nCurrent Step: ${currentNode.name}`;
            if (nodeConfig.prompt) {
              dynamicPrompt += `\nStep Instructions: ${nodeConfig.prompt}`;
            }
            if (Object.keys(extractedVariables).length > 0) {
              dynamicPrompt += `\nExtracted Variables: ${JSON.stringify(extractedVariables)}`;
            }
          }
          dynamicPrompt += '\n\nContext:\n' + topChunk;
 
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
 
          // Extract variables if plan exists
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
         
          // Handle specific node types
          if (currentNode?.type === 'api_request') {
            console.log('🔄 Processing API request node');
            // Implementation for API request node
          } else if (currentNode?.type === 'transfer_call') {
            console.log('📞 Processing transfer call node');
            // Implementation for transfer call node
          }
         
          // Determine next node
          if (workflow && currentNodeId) {
            const nextNodeId = determineNextNode(workflow, currentNodeId, response, message.voicePrompt);
            if (nextNodeId) {
              settings.currentNodeId = nextNodeId;
              console.log('⏭️ Moving to next node:', nextNodeId);
             
              // Check if next node is end_call - prepare for next interaction
              const nextNode = workflow.nodes.find(n => n.id === nextNodeId);
              if (nextNode?.type === 'end_call') {
                console.log('⚠️ Next node is end_call, will terminate on next interaction');
              }
            }
          }
 
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
 
 
