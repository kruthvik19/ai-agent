import workflowController from '../controllers/workflowController.js';
 
async function workflowRoutes(fastify, options) {
  // Authentication middleware
  const authenticate = async (request, reply) => {
    try {
      const token = request.headers.authorization?.split(' ')[1];
     
      if (!token || token !== process.env.AUTH_TOKEN) {
        throw new Error('Invalid token');
      }
    } catch (err) {
      reply.code(401).send({ error: 'Authentication failed' });
    }
  };
 
  // Get workflow by ID
  fastify.get('/workflows/:id', {
    preHandler: authenticate
  }, workflowController.getWorkflow);
 
  // Get workflows for agent
  fastify.get('/workflows/agent/:agentId', {
    preHandler: authenticate
  }, workflowController.getWorkflowsForAgent);
 
  // Get workflow with nodes and edges
  fastify.get('/workflows/:id/full', {
    preHandler: authenticate
  }, workflowController.getWorkflowWithNodesAndEdges);
}
 
export default workflowRoutes;