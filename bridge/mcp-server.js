#!/usr/bin/env node
/**
 * Antigravity Chrome MCP Server v2.2.0 (stdio transport, JSON-RPC 2.0).
 * Exposes all 42 autonomous browser, local download/project-sync, hyper-speed deep-read/batch,
 * and cooperative multi-agent DAG swarm tools to Google Antigravity and Gemini CLI.
 *
 * IMPORTANT: stdout is reserved strictly for MCP JSON-RPC protocol messages.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { BridgeLink } = require('./lib/bridge-link');
const { TOOLS, normalizeParams } = require('./lib/tools');
const { detectAntigravity } = require('./lib/detect-antigravity');

const SERVER_INFO = { name: 'antigravity-chrome', version: '2.2.0' };
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const log = (...args) => process.stderr.write(`[agy-chrome-mcp] ${args.join(' ')}\n`);

const link = new BridgeLink();

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.zip': 'application/zip'
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function prepareToolParams(name, rawArgs = {}) {
  const args = normalizeParams(name, { ...rawArgs });

  if (name === 'chrome_upload_file') {
    const fileList = [];
    if (args.filePath) fileList.push(path.resolve(String(args.filePath)));
    if (Array.isArray(args.files)) {
      for (const f of args.files) fileList.push(path.resolve(String(f)));
    }
    if (fileList.length > 0) {
      for (const fp of fileList) {
        if (!fs.existsSync(fp)) {
          throw new Error(`File not found on disk: ${fp}`);
        }
      }
      args.files = fileList;
      const stat = fs.statSync(fileList[0]);
      if (stat.size <= 16 * 1024 * 1024) {
        const ext = path.extname(fileList[0]).toLowerCase();
        args.base64 = fs.readFileSync(fileList[0]).toString('base64');
        args.fileName = path.basename(fileList[0]);
        args.mimeType = MIME_BY_EXT[ext] || 'application/octet-stream';
      }
    }
  }

  return args;
}

function formatToolResult(name, result, rawArgs = {}) {
  if (name === 'chrome_screenshot' && result?.base64) {
    const { base64, annotatedElements, ...meta } = result;
    const content = [
      { type: 'image', data: base64, mimeType: result.format === 'jpeg' ? 'image/jpeg' : 'image/png' },
      { type: 'text', text: JSON.stringify(meta, null, 2) }
    ];
    if (annotatedElements?.length) {
      const legend = annotatedElements.map((e) => `${e.ref.replace('ref_', '')}: ${e.role} "${e.name}"`).join('\n');
      content.push({ type: 'text', text: `Set-of-Marks legend:\n${legend}` });
    }
    return { content };
  }

  if (name === 'chrome_track_downloads' && result?._imageBase64) {
    const { _imageBase64, ...meta } = result;
    return {
      content: [
        { type: 'image', data: _imageBase64, mimeType: meta.mimeType || 'image/png' },
        { type: 'text', text: JSON.stringify(meta, null, 2) }
      ]
    };
  }

  if (name === 'chrome_inspect_element' && result?.screenshotBase64) {
    const { screenshotBase64, ...meta } = result;
    return {
      content: [
        { type: 'image', data: screenshotBase64, mimeType: 'image/png' },
        { type: 'text', text: JSON.stringify(meta, null, 2) }
      ]
    };
  }

  if (name === 'chrome_gif_recorder' && result?.base64) {
    const { base64, dataUrl: _omit, ...meta } = result;
    if (rawArgs.savePath && !meta.savedTo) {
      const outPath = path.resolve(String(rawArgs.savePath));
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, Buffer.from(base64, 'base64'));
      meta.savedTo = outPath;
    }
    return {
      content: [
        { type: 'image', data: base64, mimeType: 'image/gif' },
        { type: 'text', text: JSON.stringify(meta, null, 2) }
      ]
    };
  }

  if (name === 'chrome_save_pdf' && result?.base64) {
    const { base64, ...meta } = result;
    const buf = Buffer.from(base64, 'base64');
    meta.byteLength = buf.length;
    if (rawArgs.savePath && !meta.savedTo) {
      const outPath = path.resolve(String(rawArgs.savePath));
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, buf);
      meta.savedTo = outPath;
    } else if (!meta.savedTo) {
      meta.base64Preview = `${base64.slice(0, 120)}... (${buf.length} bytes)`;
    }
    return { content: [{ type: 'text', text: JSON.stringify(meta, null, 2) }] };
  }

  if (name === 'chrome_macro_recorder' && result?.playwrightCode && rawArgs.savePath) {
    const outPath = path.resolve(String(rawArgs.savePath));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, result.playwrightCode, 'utf8');
    result.savedTo = outPath;
  }

  if (name === 'chrome_read_page' || (name === 'chrome_open_url' && result?.snapshot)) {
    const snap = name === 'chrome_read_page' ? result : result.snapshot;
    const header = [
      name === 'chrome_open_url' ? `Opened tab ${result.tabId}` : `Tab ${result.tabId}`,
      `URL: ${snap.url}`,
      `Title: ${snap.title}`,
      snap.isPdfEmbed ? 'Document type: PDF (Chrome PDF Viewer)' : null,
      snap.crossOriginFrameCount > 0
        ? `Cross-origin iframes: ${snap.crossOriginFrameCount} (${(snap.crossOriginFrames || []).slice(0, 3).join(', ')})`
        : null,
      snap.pausedByUser ? 'WARNING: user has PAUSED agent control on this tab.' : null,
      snap.activeDialog
        ? `ACTIVE JS DIALOG [${snap.activeDialog.type}]: "${snap.activeDialog.message}" (call chrome_handle_dialog to accept/dismiss)`
        : null,
      ...(snap.safetyGates || []).map((g) => `SAFETY GATE [${g.type}]: ${g.message}`),
      `Viewport ${snap.viewport?.width}x${snap.viewport?.height}, scrollY=${snap.viewport?.scrollY}/${snap.viewport?.scrollHeight}`
    ].filter(Boolean);
    const text =
      `${header.join('\n')}\n\nInteractive elements (${snap.elementCount}):\n${snap.formattedTree || '(none)'}` +
      (snap.visibleText ? `\n\nVisible text:\n${snap.visibleText}` : '');
    return { content: [{ type: 'text', text }] };
  }

  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

async function handleRequest(msg) {
  const { id, method, params = {} } = msg;

  switch (method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      reply(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Controls the user's real, authenticated Chrome browser via Gemini Antigravity in Chrome v2.2.0 (42 tools). " +
          'Prefer chrome_deep_read (single-RPC full intelligence + delta diffing), chrome_batch_actions (multi-step in 1 round-trip), ' +
          'chrome_download_file + chrome_track_downloads (atomic project-folder download delivery, SHA-256 tracking, and JSON/CSV/PDF/ZIP/image parsing), ' +
          'chrome_agent_session + chrome_parallel_run (isolated multi-agent sessions with Per-Tab Fair RWLocks & parallel fan-out), ' +
          'and chrome_swarm_plan + chrome_swarm_blackboard (cooperative multi-agent DAG planning with roles, responsibilities, critical-path scheduling & shared Blackboard).'
      });
      link.ensure().catch((err) => log('bridge warm-up failed:', err.message));
      return;
    }

    case 'ping':
      reply(id, {});
      return;

    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;

    case 'tools/call': {
      const name = params.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        replyError(id, -32602, `Unknown tool: ${name}`);
        return;
      }
      try {
        const rawArgs = params.arguments || {};
        const prepared = prepareToolParams(name, rawArgs);
        const callTimeout = Math.max(60000, Number(rawArgs.timeoutMs) || 60000);
        const result = await link.call(name, prepared, callTimeout);
        reply(id, formatToolResult(name, result, rawArgs));
      } catch (err) {
        let hint = '';
        if (name === 'chrome_status') {
          const agy = detectAntigravity();
          hint = `\nBridge role: ${link.role}. Antigravity installed: ${agy.installed}, running: ${agy.running} (v${agy.version || 'unknown'}).`;
        }
        reply(id, { isError: true, content: [{ type: 'text', text: `${err.message}${hint}` }] });
      }
      return;
    }

    case 'resources/list':
      reply(id, { resources: [] });
      return;

    case 'prompts/list':
      reply(id, { prompts: [] });
      return;

    default:
      if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (_e) {
    replyError(null, -32700, 'Parse error');
    return;
  }
  if (msg.id === undefined || msg.id === null) return;
  handleRequest(msg).catch((err) => replyError(msg.id, -32603, err.message));
});

rl.on('close', () => process.exit(0));
process.on('uncaughtException', (err) => log('uncaught:', err.stack || err.message));
process.on('unhandledRejection', (err) => log('unhandled rejection:', err?.stack || err));
log('ready (v2.2.0, 42 tools)');
