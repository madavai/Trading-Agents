// The entry the engine starts (.mcp.json): the desk tool server over stdio. With --check it prints the desk check and
// exits, for a person or a developer at a terminal.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { deskServer } from './server.js';
import { deskCheck } from '../check/desk-check.js';

if (process.argv.includes('--check')) console.log(await deskCheck());
else await deskServer().connect(new StdioServerTransport());
