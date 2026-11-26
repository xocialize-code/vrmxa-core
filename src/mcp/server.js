// `vrmxa mcp`: the studio's MCP server over stdio (PRD MCP-1 as amended by AB-D-0266, MCP-10; plan 0.2 A1).
//
//   vrmxa mcp --app [--port 5213]      the running studio: the Mac app, or the dev server in a browser (loopback bridge)
//   vrmxa mcp [<file.vrmxa>]           the reference library on files, with the app closed
//
// Register it in Claude Code:  claude mcp add vrmxa-studio -- node packages/vrmxa-core/bin/vrmxa.mjs mcp --app
// Modelled on VRMXG's engine/packages/mcp/src/server.js (AB-R-1027). stdout is the protocol: everything else goes to
// stderr.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { INSTRUCTIONS, toolList, TOOLS_VERSION } from './tools.js';

const VERSION = `0.2.${TOOLS_VERSION}`;

/** The tools and their caller for a target, without the transport (tests use this). */
export async function target({ app = false, port, file = null, holdMs } = {}) {
  if (app) {
    const { AppBridge, BRIDGE_PORT } = await import('./bridge.js');
    const bridge = new AppBridge({ port: port ?? BRIDGE_PORT, ...(holdMs ? { holdMs } : {}) });
    await bridge.start();
    const call = async (name, args) => {
      const r = await bridge.call(name, args);
      // status still answers with the app closed: what the bridge knows, and how to connect
      if (name === 'status' && r.isError) return { isError: false, text: JSON.stringify({ connected: false, bridge: bridge.info, note: r.text }) };
      return r;
    };
    return { tools: toolList('app'), call, bridge, close: () => bridge.stop() };
  }
  const { createFileTools } = await import('./files.js');
  const t = createFileTools({ file });
  return { ...t, close: () => {} };
}

/** Serve over stdio until the client closes. */
export async function serve({ app = false, port, file = null } = {}) {
  let t;
  try { t = await target({ app, port, file }); } catch (e) {
    process.stderr.write(`vrmxa mcp${app ? ' --app' : ''}: ${e.code === 'EADDRINUSE' ? `can't listen on 127.0.0.1:${port ?? 5213}: another vrmxa mcp --app has the port (give --port)` : e.message}\n`);
    process.exit(1);
  }
  process.stderr.write(app ? `vrmxa mcp: waiting for the studio on http://127.0.0.1:${t.bridge.port}\n` : `vrmxa mcp: the app is closed: working on files${file ? ` (${file})` : ''}\n`);
  const server = new Server({ name: 'vrmxa-studio', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: t.tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { text, isError, image } = await t.call(req.params.name, req.params.arguments ?? {});
    return { isError: !!isError, content: [...(image ? [{ type: 'image', data: image.data, mimeType: image.mimeType || 'image/png' }] : []), { type: 'text', text: text ?? '' }] };
  });
  const transport = new StdioServerTransport();
  transport.onclose = () => { t.close(); process.exit(0); };
  await server.connect(transport);
}
