import db from '../db.js';
 
const workflowModel = {
  async getById(id) {
    const result = await db.query(
      'SELECT * FROM workflows WHERE id = $1',
      [id]
    );
    return result.rows[0];
  },
 
  async getActiveByAgentId(agentId) {
    const result = await db.query(
      'SELECT * FROM workflows WHERE agent_id = $1 AND is_active = true',
      [agentId]
    );
    return result.rows;
  },
 
  async getWorkflowWithNodesAndEdges(workflowId) {
    // Get workflow
    const workflowResult = await db.query(
      'SELECT * FROM workflows WHERE id = $1',
      [workflowId]
    );
   
    if (workflowResult.rows.length === 0) {
      return null;
    }
   
    const workflow = workflowResult.rows[0];
   
    // Get nodes
    const nodesResult = await db.query(
      'SELECT * FROM workflow_nodes WHERE workflow_id = $1',
      [workflowId]
    );
   
    // Get edges
    const edgesResult = await db.query(
      'SELECT * FROM workflow_edges WHERE workflow_id = $1',
      [workflowId]
    );
   
    return {
      ...workflow,
      nodes: nodesResult.rows,
      edges: edgesResult.rows
    };
  }
};
 
export default workflowModel;
 