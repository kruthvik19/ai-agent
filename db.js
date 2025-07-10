import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();
 
const { Pool } = pg;
const pool=new Pool({
    user:"postgres",
    password:"Q1g4LMYDI4hMbcfO4Z8OUT",
    host :"45.118.160.29",
    port :5432,
    database:"Ai_agent"
})
 
// Helper for running queries
async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log('Executed query', { text, duration, rows: res.rowCount });
    return res;
  } catch (error) {
    console.error('Error executing query', { text, error });
    throw error;
  }
}
 
export default {
  query,
  pool
};
 