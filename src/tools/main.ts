// The entry the engine starts (.mcp.json): the desk tool server over stdio. With --check it prints the desk check and
// exits, for a person or a developer at a terminal.
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { deskServer } from './server.js';
import { deskCheck } from '../check/desk-check.js';
import { configure } from '../data/http.js';
import { deskDataDir } from '../paths.js';

if (process.argv.includes('--check')) console.log(await deskCheck());
else {
  // The real thing, not a test: sources are asked politely (one request at a time per host every quarter second, a busy
  // source asked again) and an answer is kept for a few minutes where every copy of the tool server can read it, so four
  // analysts starting together do not get a computer rate-limited.
  configure({ spacingMs: 250, cacheDir: path.join(deskDataDir(process.cwd()), 'cache') });
  await deskServer().connect(new StdioServerTransport());
}
