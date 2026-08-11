#!/usr/bin/env node
//
// Run one Zotero MCP tool against an arbitrary RDP port from the CURRENT
// session, without a pinned mcp__* server.
//
// Why this exists: a session's MCP servers are fixed when it starts, so the
// mcp__…zotero-dev__* tools always point at the main instance. A worktree's
// Zotero listens on its own RDP port (see .worktree-meta.json), which those
// tools can't reach. This spawns the same MCP server the tools use, pointed at
// whatever port you give it, and drives it over stdio for a single call.
//
// Usage:
//   node scripts/worktree/zotero-rdp-exec.mjs <rdpPort> [tool] [jsonArgs]
//
// Examples:
//   node scripts/worktree/zotero-rdp-exec.mjs 6106 zotero_execute_js '{"code":"return Zotero.version;"}'
//   node scripts/worktree/zotero-rdp-exec.mjs 6106 zotero_read_errors '{}'
//
// Defaults to zotero_execute_js with a small status probe.
//
import { spawn } from 'node:child_process';
import { connect } from 'node:net';

const [, , rdpPort, tool = 'zotero_execute_js', argsJson] = process.argv;

if (!rdpPort) {
  console.error('Usage: node scripts/worktree/zotero-rdp-exec.mjs <rdpPort> [tool] [jsonArgs]');
  process.exit(2);
}

// Check the port first. The MCP server reports an unreachable Zotero as ordinary
// tool-result TEXT with no error flag, so without this a dead instance would
// exit 0 and look like a successful call to any script wrapping this one.
const reachable = await new Promise((resolve) => {
  const sock = connect({ host: '127.0.0.1', port: Number(rdpPort) });
  const done = (ok) => { sock.destroy(); resolve(ok); };
  sock.setTimeout(3000);
  sock.on('connect', () => done(true));
  sock.on('timeout', () => done(false));
  sock.on('error', () => done(false));
});

if (!reachable) {
  console.error(
    `Nothing is listening on RDP port ${rdpPort}. Start that Zotero instance ` +
    `(scripts/worktree-ready.sh) and check rdpPort in its .worktree-meta.json.`
  );
  process.exit(1);
}

const defaultArgs = JSON.stringify({
  code: 'return { version: Zotero.version, httpPort: Zotero.Server.port, hasBeaver: !!Zotero.Beaver };',
});

const child = spawn('npx', ['-y', '@introfini/mcp-server-zotero-dev'], {
  env: { ...process.env, ZOTERO_RDP_PORT: String(rdpPort) },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const resolve = pending.get(msg.id);
    if (resolve) { pending.delete(msg.id); resolve(msg); }
  }
});

let nextId = 1;
const call = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});

const timer = setTimeout(() => {
  console.error(`Timed out talking to Zotero on RDP port ${rdpPort}. Is that instance running?`);
  child.kill();
  process.exit(1);
}, 45000);

try {
  await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'zotero-rdp-exec', version: '1' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const res = await call('tools/call', {
    name: tool,
    arguments: JSON.parse(argsJson ?? defaultArgs),
  });

  clearTimeout(timer);
  const text = res.result?.content?.map((c) => c.text).join('\n');
  console.log(text ?? JSON.stringify(res.result ?? res.error, null, 2));
  child.kill();
  // A failed tool call comes back as a normal result carrying isError, not as a
  // JSON-RPC error, so check both or a dead instance would look like success.
  process.exit(res.error || res.result?.isError ? 1 : 0);
}
catch (e) {
  clearTimeout(timer);
  console.error(e);
  child.kill();
  process.exit(1);
}
