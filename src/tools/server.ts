// The desk tool server: the one MCP server this folder gives the engine (.mcp.json, started by main.ts). Milestone 0
// holds the desk check; the data tools, the journal and the decision record join it in milestones 1 and 2. It never
// holds an order tool.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { deskCheck } from '../check/desk-check.js';
import { VERSION } from '../version.js';

export function deskServer(root: string = process.cwd(), fetchImpl: typeof fetch = fetch): McpServer {
  const server = new McpServer({ name: 'trading-desk', version: VERSION });
  server.registerTool('desk_check', {
    title: 'Desk check',
    description: 'Check that this computer is ready for the Trading Agents desk: Node, the desk data folder, whether a Robinhood sign-in is saved, and whether each free data source answers. Read-only; it sends no order and reads no secret.',
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async () => ({ content: [{ type: 'text', text: await deskCheck(root, fetchImpl) }] }));
  return server;
}
