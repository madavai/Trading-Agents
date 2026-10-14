// Run by fake-robinhood.ts as a side process: the MCP library's own demo sign-in server (registration, the approve step, the
// code exchange with PKCE), on the port it is given. It prints a line with "listening" when it is ready. It is a process of
// its own because the library's demo never closes its server: the test stops it by killing the process.
import { setupAuthServer } from '@modelcontextprotocol/sdk/examples/server/demoInMemoryOAuthProvider.js';

const [port, resource] = process.argv.slice(2);
setupAuthServer({ authServerUrl: new URL(`http://127.0.0.1:${port}`), mcpServerUrl: new URL(resource!), strictResource: false });
