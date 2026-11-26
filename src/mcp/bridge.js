// The loopback bridge (Node): MCP tool calls handed to the studio's page and answered there (plan 0.2 A1, decision
// AB-D-0266). The page polls POST http://127.0.0.1:<port>/vrmxa-mcp/exchange with its last reply and gets the next call
// back (held up to 20 s when there is none): plain HTTP the page reaches from a browser or the Mac app, no WebSocket
// server needed. CORS-readable, and text/plain bodies so no preflight is needed. One app has the link at a time: the
// first to poll keeps it until it stops polling; another is told so ({ taken }) and backs off, so calls never split.
//
// Copied from VRMXG's EditorBridge (../vrmxa-game-engine/engine/packages/mcp/src/bridge.js, 71 lines, as of its commit 5405d62;
// the pattern AB-R-1027 proved), not imported: the engine depends on vrmxa-core, so vrmxa-core can't depend on it.
// Changed here: the path (/vrmxa-mcp/), the default port (5213; VRMXG's is 5183, so both can run), "editor" → "app"
// in names and messages, and `info` for the status tool.
import http from 'node:http';

export const BRIDGE_PORT = 5213;
export const BRIDGE_PATH = '/vrmxa-mcp/exchange';

export class AppBridge {
  /** @param {{ port?: number, connectTimeoutMs?: number, callTimeoutMs?: number, holdMs?: number }} [o] */
  constructor({ port = BRIDGE_PORT, connectTimeoutMs = 15000, callTimeoutMs = 180000, holdMs = 20000 } = {}) {
    this.port = port; this.connectTimeoutMs = connectTimeoutMs; this.callTimeoutMs = callTimeoutMs; this.holdMs = holdMs;
    this.queue = []; this.waiting = null; this.calls = new Map(); this.nextId = 1;
    this.seen = 0; this.app = null; this.owner = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', () => { this.port = /** @type {import('node:net').AddressInfo} */ (this.server.address()).port; resolve(this.port); });
    });
  }

  stop() { this.waiting?.end(); this.server?.close(); for (const c of this.calls.values()) c.reject(new Error('the bridge stopped')); }

  get connected() { return Date.now() - this.seen < this.holdMs + 10000; }

  /** What the bridge knows of the app on its end, for `status` when the app isn't answering. */
  get info() { return { port: this.port, connected: this.connected, app: this.app, lastSeenMs: this.seen ? Date.now() - this.seen : null }; }

  handle(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    if (req.method !== 'POST' || !req.url.startsWith(BRIDGE_PATH)) { res.writeHead(404).end(`VRMXA studio MCP bridge: POST ${BRIDGE_PATH}`); return; }
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let msg = {};
      try { msg = body ? JSON.parse(body) : {}; } catch { /* an empty poll */ }
      const id = msg.app ?? 'anonymous';
      if (this.owner && this.owner !== id && this.connected) { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ taken: this.app ?? true })); return; }
      if (this.owner !== id) { this.owner = id; this.app = null; }
      this.seen = Date.now();
      if (msg.hello) this.app = msg.hello;
      if (msg.reply) { const c = this.calls.get(msg.reply.id); if (c) { this.calls.delete(msg.reply.id); c.resolve(msg.reply); } }
      if (this.waiting) this.send(this.waiting, { idle: true }); // one poller at a time: the newest
      this.waiting = res;
      const timer = setTimeout(() => { if (this.waiting === res) this.send(res, { idle: true }); }, this.holdMs);
      res.on('close', () => { clearTimeout(timer); if (this.waiting === res) this.waiting = null; });
      this.flush();
    });
  }

  send(res, obj) { if (this.waiting === res) this.waiting = null; if (!res.writableEnded) res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj)); }

  flush() { if (this.waiting && this.queue.length) this.send(this.waiting, { call: this.queue.shift() }); }

  /** Hand a tool call to the app and wait for its reply: { text, isError, image? }. */
  async call(name, args) {
    const until = Date.now() + this.connectTimeoutMs;
    while (!this.connected && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
    if (!this.connected) return { isError: true, text: `the VRMXA Avatar Studio isn't connected: open the studio (the Mac app, or the dev server at http://127.0.0.1:5210 in a browser); it polls http://127.0.0.1:${this.port}${BRIDGE_PATH}${this.port === BRIDGE_PORT ? '' : ` (in a browser add ?mcp=${this.port})`}. With the app closed, run vrmxa mcp without --app to work on files.` };
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.calls.delete(id); resolve({ isError: true, text: `the studio didn't answer ${name} within ${this.callTimeoutMs / 1000} s` }); }, this.callTimeoutMs);
      this.calls.set(id, { resolve: (r) => { clearTimeout(timer); resolve(r); }, reject: (e) => { clearTimeout(timer); resolve({ isError: true, text: e.message }); } });
      this.queue.push({ id, name, args });
      this.flush();
    });
  }
}
