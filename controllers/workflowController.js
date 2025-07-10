import workflowModel from '../models/workflowModel.js';
 
const workflowController = {
  async getWorkflow(req, reply) {
    try {
      const { id } = req.params;
      const workflow = await workflowModel.getById(id);
     
      if (!workflow) {
        return reply.code(404).send({
          success: false,
          message: 'Workflow not found'
        });
      }
     
      return reply.send({
        success: true,
        data: workflow
      });
    } catch (error) {
      console.error('Error getting workflow:', error);
      return reply.code(500).send({
        success: false,
        message: 'Failed to get workflow',
        error: error.message
      });
    }
  },
 
  async getWorkflowsForAgent(req, reply) {
    try {
      const { agentId } = req.params;
      const workflows = await workflowModel.getActiveByAgentId(agentId);
     
      return reply.send({
        success: true,
        data: workflows
      });
    } catch (error) {
      console.error('Error getting workflows for agent:', error);
      return reply.code(500).send({
        success: false,
        message: 'Failed to get workflows for agent',
        error: error.message
      });
    }
  },
 
  async getWorkflowWithNodesAndEdges(req, reply) {
    try {
      const { id } = req.params;
      const workflow = await workflowModel.getWorkflowWithNodesAndEdges(id);
     
      if (!workflow) {
        return reply.code(404).send({
          success: false,
          message: 'Workflow not found'
        });
      }
     
      return reply.send({
        success: true,
        data: workflow
      });
    } catch (error) {
      console.error('Error getting workflow with nodes and edges:', error);
      return reply.code(500).send({
        success: false,
        message: 'Failed to get workflow with nodes and edges',
        error: error.message
      });
    }
  },
 
  // Direct function for internal use (no HTTP request/reply)
  async getActiveWorkflowForAgent(agentId) {
    try {
      const workflows = await workflowModel.getActiveByAgentId(agentId);
      return workflows.find(w => w.is_active) || null;
    } catch (error) {
      console.error('Error getting active workflow for agent:', error);
      return null;
    }
  }
 
 
 
};
 
export default workflowController;
 