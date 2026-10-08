/**
 * Inline source for Kiro's local MCP bridge. It runs on the desktop host and relays a
 * fixed allowlist to the provider over a private Unix socket. No model or credentials
 * are started on the SSH host.
 */
export const REMOTE_MCP_BRIDGE_SOURCE = String.raw`
import net from 'node:net';
import readline from 'node:readline';

const tools = JSON.parse(process.env.ADELIC_REMOTE_TOOLS || '[]');
const socketPath = process.env.ADELIC_REMOTE_SOCKET;
let nextId = 1;

function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
function schema(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}
function relay(tool, args) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = '';
    socket.setTimeout(10 * 60_000);
    socket.on('connect', () => socket.write(JSON.stringify({ id: nextId++, tool, args }) + '\n'));
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      const newline = data.indexOf('\n');
      if (newline < 0) return;
      socket.end();
      try { resolve(JSON.parse(data.slice(0, newline))); }
      catch (error) { reject(error); }
    });
    socket.on('timeout', () => { socket.destroy(new Error('Adelic remote approval timed out')); });
    socket.on('error', reject);
  });
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!message || typeof message.method !== 'string' || message.id === undefined) return;
  const id = message.id;
  try {
    let result;
    if (message.method === 'initialize') {
      result = {
        protocolVersion: message.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'adelic_remote', version: '1.0.0' },
      };
    } else if (message.method === 'tools/list') {
      result = { tools: tools.map(schema) };
    } else if (message.method === 'tools/call') {
      const name = message.params?.name;
      const args = message.params?.arguments || {};
      if (!tools.some((tool) => tool.name === name)) throw new Error('Unknown remote tool');
      const response = await relay(name, args);
      result = {
        content: [{ type: 'text', text: String(response.text ?? '') }],
        isError: response.ok !== true,
      };
    } else {
      throw new Error('Unsupported MCP method');
    }
    send({ jsonrpc: '2.0', id, result });
  } catch (error) {
    send({ jsonrpc: '2.0', id, error: { code: -32000, message: error instanceof Error ? error.message : 'Remote bridge failed' } });
  }
});
`;
