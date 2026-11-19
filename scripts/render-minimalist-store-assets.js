#!/usr/bin/env node
/**
 * Renders crisp, ultra-minimalist Chrome Web Store graphic assets using headless Chrome
 * and converts every screenshot & promo tile to strict 24-bit RGB PNG (colorType=2, no alpha)
 * with exact pixel dimensions required by Chrome Web Store:
 *   - screenshot-1-1280x800.png       (1280x800, 24-bit RGB)
 *   - screenshot-2-1280x800.png       (1280x800, 24-bit RGB - How to Use Guide)
 *   - screenshot-3-1280x800.png       (1280x800, 24-bit RGB - Element Picker & DevTools)
 *   - screenshot-4-1280x800.png       (1280x800, 24-bit RGB - Multi-Tab, PDF & GIF Recorder)
 *   - small-promo-tile-440x280.png    (440x280,  24-bit RGB)
 *   - marquee-promo-tile-1400x560.png (1400x560, 24-bit RGB)
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'store_assets');
fs.mkdirSync(OUT_DIR, { recursive: true });

const CHROME_EXE = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
].find((p) => fs.existsSync(p));

if (!CHROME_EXE) {
  throw new Error('Google Chrome executable not found.');
}

// --- Pure-Node PNG RGBA -> 24-bit RGB Converter (Strips Alpha Channel for CWS) ---
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function convertPngToExact24BitRgb(pngPath, targetW, targetH) {
  const buf = fs.readFileSync(pngPath);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];

  if (colorType === 2 && width === targetW && height === targetH) {
    return { width, height, colorType: 2, bytes: buf.length };
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`Unexpected PNG format bitDepth=${bitDepth} colorType=${colorType}`);
  }

  // Collect IDAT chunks
  const idatParts = [];
  let offset = 8;
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') {
      idatParts.push(buf.subarray(offset + 8, offset + 8 + len));
    }
    offset += 12 + len;
  }

  const inflated = zlib.inflateSync(Buffer.concat(idatParts));
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const recon = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y++) {
    const filter = inflated[y * (stride + 1)];
    const rowIn = y * (stride + 1) + 1;
    const rowOut = y * stride;

    for (let i = 0; i < stride; i++) {
      const xByte = inflated[rowIn + i];
      const a = i >= bpp ? recon[rowOut + i - bpp] : 0;
      const b = y > 0 ? recon[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= bpp ? recon[(y - 1) * stride + i - bpp] : 0;

      let val = xByte;
      if (filter === 1) val = (xByte + a) & 0xff;
      else if (filter === 2) val = (xByte + b) & 0xff;
      else if (filter === 3) val = (xByte + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) val = (xByte + paethPredictor(a, b, c)) & 0xff;
      recon[rowOut + i] = val;
    }
  }

  // Crop top-left targetW x targetH (1:1 pixel sharp) and composite onto #09090b RGB
  const outRowLen = 1 + targetW * 3;
  const rawRgb = Buffer.alloc(targetH * outRowLen);

  for (let ty = 0; ty < targetH; ty++) {
    const sy = Math.min(height - 1, ty);
    const dstRow = ty * outRowLen;
    rawRgb[dstRow] = 0; // filter None
    for (let tx = 0; tx < targetW; tx++) {
      const sx = Math.min(width - 1, tx);
      const srcIdx = sy * stride + sx * bpp;
      const r = recon[srcIdx];
      const g = recon[srcIdx + 1];
      const b = recon[srcIdx + 2];
      const a = bpp === 4 ? recon[srcIdx + 3] / 255 : 1;

      const dstIdx = dstRow + 1 + tx * 3;
      rawRgb[dstIdx] = Math.round(r * a + 9 * (1 - a));
      rawRgb[dstIdx + 1] = Math.round(g * a + 9 * (1 - a));
      rawRgb[dstIdx + 2] = Math.round(b * a + 11 * (1 - a));
    }
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(targetW, 0);
  ihdr.writeUInt32BE(targetH, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // 24-bit RGB (no alpha)
  const compressed = zlib.deflateSync(rawRgb, { level: 9 });
  const outPng = Buffer.concat([sig, makeChunk('IHDR', ihdr), makeChunk('IDAT', compressed), makeChunk('IEND', Buffer.alloc(0))]);
  fs.writeFileSync(pngPath, outPng);
  return { width: targetW, height: targetH, colorType: 2, bytes: outPng.length };
}

const SHARED_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    background: #09090b;
    color: #fafafa;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
    overflow: hidden;
  }
  .canvas {
    width: 100vw;
    height: 100vh;
    background: radial-gradient(circle at 80% 15%, rgba(255,255,255,0.045), transparent 55%), #09090b;
    display: flex;
    position: relative;
    overflow: hidden;
  }
  .grid-bg {
    position: absolute;
    inset: 0;
    background-image: linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px),
                      linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px);
    background-size: 40px 40px;
    pointer-events: none;
  }
  .pill-tag {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    border-radius: 999px;
    border: 1px solid rgba(255,255,255,0.14);
    background: #111114;
    font-size: 12px;
    font-weight: 500;
    color: #d4d4d8;
    letter-spacing: 0.01em;
  }
  .mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
  .kbd {
    display: inline-block;
    padding: 2px 7px;
    border-radius: 5px;
    background: #18181c;
    border: 1px solid rgba(255,255,255,0.16);
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 11.5px;
    color: #fafafa;
  }
`;

const STAR_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C12.5 7.8 16.2 11.5 22 12C16.2 12.5 12.5 16.2 12 22C11.5 16.2 7.8 12.5 2 12C7.8 11.5 11.5 7.8 12 2Z"/></svg>`;

const ASSETS = [
  {
    name: 'screenshot-1-1280x800.png',
    width: 1280,
    height: 800,
    html: `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${SHARED_CSS}
      .wrap { position: relative; z-index: 2; width: 100%; height: 100%; padding: 54px 60px; display: grid; grid-template-columns: 430px 1fr; gap: 46px; align-items: center; }
      h1 { font-size: 42px; font-weight: 600; line-height: 1.12; letter-spacing: -0.035em; margin: 18px 0 14px; }
      .sub { font-size: 16px; line-height: 1.55; color: #a1a1aa; margin-bottom: 28px; }
      .feat-list { display: flex; flex-direction: column; gap: 12px; }
      .feat-row { display: flex; align-items: center; gap: 12px; font-size: 14px; color: #e4e4e7; }
      .check { width: 22px; height: 22px; border-radius: 6px; background: #141418; border: 1px solid rgba(255,255,255,0.14); display: flex; align-items: center; justify-content: center; font-size: 12px; }
      .browser-win { height: 660px; background: #0d0d10; border: 1px solid rgba(255,255,255,0.14); border-radius: 14px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 28px 70px rgba(0,0,0,0.75); }
      .b-bar { height: 40px; background: #141418; border-bottom: 1px solid rgba(255,255,255,0.08); display: flex; align-items: center; padding: 0 14px; gap: 10px; }
      .dots { display: flex; gap: 6px; }
      .dots span { width: 10px; height: 10px; border-radius: 50%; background: #27272a; }
      .url-pill { flex: 1; background: #09090b; border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 4px 12px; font-size: 11.5px; color: #a1a1aa; }
      .ext-icon { width: 24px; height: 24px; border-radius: 6px; background: #09090b; border: 1px solid rgba(255,255,255,0.2); display: flex; align-items: center; justify-content: center; color: #fafafa; }
      .b-body { flex: 1; display: grid; grid-template-columns: 1fr 310px; }
      .web-pane { padding: 26px; background: #0b0b0e; border-right: 1px solid rgba(255,255,255,0.08); position: relative; }
      .web-card { background: #111115; border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 18px; margin-bottom: 14px; }
      .som { display: inline-block; background: #09090b; color: #fafafa; border: 1px solid #fafafa; border-radius: 3px; font-size: 10px; padding: 0 4px; font-family: monospace; margin-right: 6px; }
      .sp { background: #09090b; display: flex; flex-direction: column; }
      .sp-top { height: 38px; padding: 0 12px; border-bottom: 1px solid rgba(255,255,255,0.08); display: flex; align-items: center; justify-content: space-between; font-size: 12.5px; font-weight: 500; }
      .dot-ok { width: 6px; height: 6px; border-radius: 50%; background: #10b981; display: inline-block; margin-left: 5px; }
      .sp-msgs { flex: 1; padding: 14px; display: flex; flex-direction: column; gap: 12px; font-size: 12px; }
      .u-bub { align-self: flex-end; background: #18181c; border: 1px solid rgba(255,255,255,0.1); padding: 8px 11px; border-radius: 10px 10px 3px 10px; max-width: 90%; }
      .trace { background: #111114; border: 1px solid rgba(255,255,255,0.09); border-radius: 7px; padding: 8px 10px; font-family: monospace; font-size: 10.5px; color: #a1a1aa; display: flex; flex-direction: column; gap: 4px; }
      .a-txt { color: #e4e4e7; line-height: 1.5; }
      .sp-comp { margin: 10px; background: #111114; border: 1px solid rgba(255,255,255,0.14); border-radius: 10px; padding: 9px; }
      .chips { display: flex; gap: 5px; margin-bottom: 7px; }
      .chip { font-size: 10px; padding: 2px 6px; border-radius: 4px; background: #09090b; border: 1px solid rgba(255,255,255,0.16); }
    </style></head><body><div class="canvas"><div class="grid-bg"></div><div class="wrap">
      <div>
        <div class="pill-tag">${STAR_SVG} Gemini Antigravity in Chrome · v2.0</div>
        <h1>Autonomous Browser Control. Pure Minimalist UI.</h1>
        <p class="sub">Drive your real, signed-in Chrome tabs directly from Google Antigravity with Shadow DOM inspection, multi-tab synthesis, and zero visual clutter.</p>
        <div class="feat-list">
          <div class="feat-row"><span class="check">✓</span><span>1-click minimalist Side Panel — zero toolbar badge noise</span></div>
          <div class="feat-row"><span class="check">✓</span><span>26 autonomous MCP tools (DOM, PDFs, Drag, Upload, GIF)</span></div>
          <div class="feat-row"><span class="check">✓</span><span>Cross-tab <code>@mentions</code>, <code>/shortcuts</code> &amp; scheduled workflows</span></div>
          <div class="feat-row"><span class="check">✓</span><span><code>Auto</code> / <code>Ask</code> modes &amp; automatic login/payment safety gates</span></div>
        </div>
      </div>
      <div class="browser-win">
        <div class="b-bar">
          <div class="dots"><span></span><span></span><span></span></div>
          <div class="url-pill mono">https://localhost:3000/checkout</div>
          <div class="ext-icon">${STAR_SVG}</div>
        </div>
        <div class="b-body">
          <div class="web-pane">
            <div style="font-size:11px;color:#71717a;margin-bottom:8px;" class="mono">LIVE AUTHENTICATED SESSION</div>
            <div class="web-card">
              <div style="font-size:15px;font-weight:600;margin-bottom:6px;">Deployment Pipeline #408</div>
              <div style="font-size:12px;color:#a1a1aa;margin-bottom:14px;">Staging health checks &amp; form verification</div>
              <div style="display:flex;gap:8px;">
                <span style="background:#fafafa;color:#09090b;padding:6px 12px;border-radius:6px;font-size:12px;font-weight:500;"><span class="som">4</span>Run Diagnostics</span>
                <span style="background:#18181c;border:1px solid rgba(255,255,255,0.15);padding:6px 12px;border-radius:6px;font-size:12px;"><span class="som">5</span>Export Report</span>
              </div>
            </div>
            <div class="web-card" style="border-color:rgba(255,255,255,0.28);">
              <div style="font-size:11px;color:#a1a1aa;margin-bottom:6px;" class="mono">CONSOLE &amp; NETWORK TELEMETRY</div>
              <div class="mono" style="font-size:11px;color:#10b981;">POST /api/v2/validate  200 OK (42ms)</div>
              <div class="mono" style="font-size:11px;color:#e4e4e7;margin-top:4px;">0 uncaught exceptions · Shadow DOM verified</div>
            </div>
          </div>
          <div class="sp">
            <div class="sp-top">
              <span style="display:flex;align-items:center;gap:6px;">${STAR_SVG} Antigravity <span class="dot-ok"></span></span>
              <span class="mono" style="font-size:10.5px;color:#a1a1aa;">Auto</span>
            </div>
            <div class="sp-msgs">
              <div class="u-bub">Test the staging form, compare with @spec.pdf, and check console errors.</div>
              <div class="trace">
                <div style="color:#fafafa;margin-bottom:2px;">▾ 4 browser actions completed</div>
                <div>● read_page (18 interactive refs)</div>
                <div>● read_multiple_tabs (@spec.pdf)</div>
                <div>● click [ref_4] "Run Diagnostics"</div>
                <div>● get_console_logs (0 errors)</div>
              </div>
              <div class="a-txt">Diagnostics passed with <strong>200 OK</strong> and zero console errors. All form fields match your PDF specification.</div>
            </div>
            <div class="sp-comp">
              <div class="chips"><span class="chip">● localhost:3000</span><span class="chip">@spec.pdf ×</span></div>
              <div style="font-size:11.5px;color:#71717a;margin-bottom:8px;">Ask anything, / for shortcuts, @ for tabs...</div>
              <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#a1a1aa;">
                <span class="mono">@  ⌖  ⌗  📷</span>
                <span style="width:22px;height:22px;border-radius:50%;background:#fafafa;color:#09090b;display:inline-flex;align-items:center;justify-content:center;font-weight:700;">↑</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div></div></body></html>`
  },
  {
    name: 'screenshot-2-1280x800.png',
    width: 1280,
    height: 800,
    html: `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${SHARED_CSS}
      .wrap { position: relative; z-index: 2; width: 100%; height: 100%; padding: 56px 64px; display: flex; flex-direction: column; justify-content: space-between; }
      .head { text-align: center; max-width: 760px; margin: 0 auto; }
      h1 { font-size: 40px; font-weight: 600; letter-spacing: -0.03em; margin: 14px 0 10px; }
      .sub { font-size: 16px; color: #a1a1aa; }
      .steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; margin: 28px 0; }
      .card { background: #111114; border: 1px solid rgba(255,255,255,0.1); border-radius: 14px; padding: 28px 24px; display: flex; flex-direction: column; gap: 14px; }
      .num { font-family: monospace; font-size: 12px; color: #a1a1aa; letter-spacing: 0.08em; text-transform: uppercase; display: flex; justify-content: space-between; align-items: center; }
      .card h2 { font-size: 20px; font-weight: 600; letter-spacing: -0.02em; }
      .card p { font-size: 13.5px; line-height: 1.6; color: #a1a1aa; }
      .demo-box { margin-top: auto; background: #09090b; border: 1px solid rgba(255,255,255,0.09); border-radius: 9px; padding: 12px 14px; font-size: 12px; color: #e4e4e7; }
      .shortcuts-bar { background: #111114; border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 18px 28px; display: flex; align-items: center; justify-content: space-between; }
      .sc-item { display: flex; align-items: center; gap: 10px; font-size: 13px; color: #d4d4d8; }
    </style></head><body><div class="canvas"><div class="grid-bg"></div><div class="wrap">
      <div class="head">
        <div class="pill-tag">${STAR_SVG} Quick Start Walkthrough</div>
        <h1>How to Use in 3 Simple Steps</h1>
        <p class="sub">Zero configuration overhead — connects directly to Google Antigravity on your workstation.</p>
      </div>
      <div class="steps">
        <div class="card">
          <div class="num"><span>Step 01</span><span class="kbd">Alt+Shift+A</span></div>
          <h2>Open the Side Panel</h2>
          <p>Click the minimalist Antigravity icon in your Chrome toolbar alongside any signed-in website, dashboard, or local dev server.</p>
          <div class="demo-box mono">● Bridge auto-connected on 127.0.0.1:17380</div>
        </div>
        <div class="card">
          <div class="num"><span>Step 02</span><span class="kbd">@  /  ⌖</span></div>
          <h2>Attach Tabs &amp; Elements</h2>
          <p>Type <code>@</code> to synthesize multiple open tabs or PDFs, press <code>/</code> for saved shortcuts, or click the Crosshair to pick any DOM element.</p>
          <div class="demo-box mono">[@analytics] [&lt;button#submit&gt;] /audit</div>
        </div>
        <div class="card">
          <div class="num"><span>Step 03</span><span class="kbd">Auto / Ask</span></div>
          <h2>Automate &amp; Record</h2>
          <p>Press <code>Enter</code> to run autonomous multi-step actions, export animated GIF recordings, or pause anytime with instant takeover.</p>
          <div class="demo-box mono">✓ Completed 5 steps · Exported workflow.gif</div>
        </div>
      </div>
      <div class="shortcuts-bar">
        <div class="sc-item"><span class="kbd">Alt+Shift+A</span><span>Toggle Side Panel</span></div>
        <div class="sc-item"><span class="kbd">Alt+Shift+X</span><span>Pick Page Element</span></div>
        <div class="sc-item"><span class="kbd">Alt+Shift+P</span><span>Pause / Resume Control</span></div>
        <div class="sc-item"><span class="kbd">/</span><span>Slash Workflows</span></div>
      </div>
    </div></div></body></html>`
  },
  {
    name: 'screenshot-3-1280x800.png',
    width: 1280,
    height: 800,
    html: `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${SHARED_CSS}
      .wrap { position: relative; z-index: 2; width: 100%; height: 100%; padding: 56px 64px; display: grid; grid-template-columns: 1fr 480px; gap: 48px; align-items: center; }
      h1 { font-size: 38px; font-weight: 600; letter-spacing: -0.03em; margin: 16px 0 14px; line-height: 1.15; }
      .sub { font-size: 15.5px; color: #a1a1aa; line-height: 1.6; margin-bottom: 24px; }
      .inspector-card { background: #111114; border: 1px solid rgba(255,255,255,0.14); border-radius: 14px; padding: 24px; display: flex; flex-direction: column; gap: 16px; box-shadow: 0 24px 60px rgba(0,0,0,0.65); }
      .pick-preview { background: #09090b; border: 1.5px solid #fafafa; border-radius: 8px; padding: 18px; position: relative; }
      .pick-badge { position: absolute; top: -12px; left: 14px; background: #09090b; border: 1px solid rgba(255,255,255,0.25); padding: 2px 8px; border-radius: 4px; font-size: 11px; color: #fafafa; }
      .code-kv { background: #09090b; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 14px; font-size: 12px; line-height: 1.7; color: #d4d4d8; }
      .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
      .mini-stat { background: #111114; border: 1px solid rgba(255,255,255,0.09); border-radius: 10px; padding: 16px; }
      .mini-stat h3 { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
      .mini-stat p { font-size: 12.5px; color: #a1a1aa; line-height: 1.45; }
    </style></head><body><div class="canvas"><div class="grid-bg"></div><div class="wrap">
      <div>
        <div class="pill-tag">${STAR_SVG} Deep UI &amp; DevTools Inspection</div>
        <h1>Point, Click &amp; Inspect Any Live Component</h1>
        <p class="sub">Pierce Shadow DOM and iframes, capture high-DPI region snips, and send exact computed CSS styles, console exceptions, and network payloads straight to your coding agent.</p>
        <div class="grid-2">
          <div class="mini-stat"><h3>Crosshair Element Picker</h3><p>Click any element on screen to attach its selector, box model, and styles.</p></div>
          <div class="mini-stat"><h3>Region App-Shots</h3><p>Drag-crop any misaligned UI section directly into the conversation.</p></div>
          <div class="mini-stat"><h3>Console &amp; Network</h3><p>Regex-filtered console errors, HTTP status codes, and response bodies.</p></div>
          <div class="mini-stat"><h3>Viewport Emulation</h3><p>Test mobile, tablet, and desktop breakpoints on demand via CDP.</p></div>
        </div>
      </div>
      <div class="inspector-card">
        <div style="font-size:12px;color:#a1a1aa;" class="mono">ELEMENT INSPECTOR · SHADOW DOM PIERCED</div>
        <div class="pick-preview">
          <span class="pick-badge mono">button#checkout-cta.primary · 214×42</span>
          <div style="background:#fafafa;color:#09090b;text-align:center;padding:10px;border-radius:6px;font-weight:600;font-size:13.5px;">Complete Order →</div>
        </div>
        <div class="code-kv mono">
          <div><span style="color:#71717a;">ref:</span> "ref_14"</div>
          <div><span style="color:#71717a;">selector:</span> "#checkout-cta"</div>
          <div><span style="color:#71717a;">display:</span> "flex" · <span style="color:#71717a;">gap:</span> "8px"</div>
          <div><span style="color:#71717a;">padding:</span> "10px 18px" · <span style="color:#71717a;">radius:</span> "6px"</div>
          <div><span style="color:#71717a;">contrast:</span> 19.4:1 (AAA Verified)</div>
        </div>
      </div>
    </div></div></body></html>`
  },
  {
    name: 'screenshot-4-1280x800.png',
    width: 1280,
    height: 800,
    html: `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${SHARED_CSS}
      .wrap { position: relative; z-index: 2; width: 100%; height: 100%; padding: 56px 64px; display: flex; flex-direction: column; justify-content: center; gap: 34px; }
      .top { max-width: 720px; }
      h1 { font-size: 38px; font-weight: 600; letter-spacing: -0.03em; margin: 14px 0 10px; }
      .sub { font-size: 15.5px; color: #a1a1aa; }
      .bento { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
      .tile { background: #111114; border: 1px solid rgba(255,255,255,0.1); border-radius: 14px; padding: 24px; display: flex; flex-direction: column; gap: 10px; }
      .tile-tag { font-family: monospace; font-size: 11px; color: #a1a1aa; text-transform: uppercase; letter-spacing: 0.06em; }
      .tile h3 { font-size: 18px; font-weight: 600; }
      .tile p { font-size: 13px; color: #a1a1aa; line-height: 1.55; }
    </style></head><body><div class="canvas"><div class="grid-bg"></div><div class="wrap">
      <div class="top">
        <div class="pill-tag">${STAR_SVG} Complete Autonomous Suite</div>
        <h1>Built for Real-World Web Workflows</h1>
        <p class="sub">Everything needed for research, QA testing, form automation, and developer workflows—with human-in-the-loop safety.</p>
      </div>
      <div class="bento">
        <div class="tile"><div class="tile-tag">Multi-Tab &amp; PDF</div><h3>Cross-Tab Synthesis</h3><p>Reference multiple open tabs and extract text directly from Chrome PDF Viewer tabs using <code>@</code> mentions.</p></div>
        <div class="tile"><div class="tile-tag">GIF89a Encoder</div><h3>Workflow GIF Recorder</h3><p>Record multi-step browser actions with captions into compact animated GIFs for PRs and bug reports.</p></div>
        <div class="tile"><div class="tile-tag">Hardware Input</div><h3>Drag, Drop &amp; File Upload</h3><p>Trusted CDP mouse drags, keyboard chords, JS dialog unblocking, and direct local file uploads.</p></div>
        <div class="tile"><div class="tile-tag">Automation</div><h3>Scheduled Tasks</h3><p>Run recurring browser checks and daily reports automatically using native Chrome alarms.</p></div>
        <div class="tile"><div class="tile-tag">Guardrails</div><h3>Auto &amp; Ask Modes</h3><p>Configure per-domain allow/block lists and automatic pauses on login, 2FA, CAPTCHA, and checkout screens.</p></div>
        <div class="tile"><div class="tile-tag">100% Local</div><h3>Private Loopback Bridge</h3><p>Zero cloud relays—all communication stays strictly on your machine over authenticated <code>127.0.0.1</code>.</p></div>
      </div>
    </div></div></body></html>`
  },
  {
    name: 'small-promo-tile-440x280.png',
    width: 440,
    height: 280,
    html: `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${SHARED_CSS}
      .canvas { width: 440px !important; height: 280px !important; }
      .wrap { position: relative; z-index: 2; width: 440px; height: 280px; padding: 28px 30px; display: flex; flex-direction: column; justify-content: space-between; }
      .mark { width: 42px; height: 42px; border-radius: 11px; background: #141418; border: 1px solid rgba(255,255,255,0.18); display: flex; align-items: center; justify-content: center; }
      h1 { font-size: 24px; font-weight: 600; letter-spacing: -0.03em; line-height: 1.18; margin-bottom: 6px; }
      p { font-size: 13px; color: #a1a1aa; }
    </style></head><body><div class="canvas"><div class="grid-bg"></div><div class="wrap">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div class="mark"><svg viewBox="0 0 24 24" width="22" height="22" fill="#fafafa"><path d="M12 2C12.5 7.8 16.2 11.5 22 12C16.2 12.5 12.5 16.2 12 22C11.5 16.2 7.8 12.5 2 12C7.8 11.5 11.5 7.8 12 2Z"/></svg></div>
        <span class="pill-tag" style="padding:4px 10px;font-size:11px;">v2.0</span>
      </div>
      <div>
        <h1>Gemini Antigravity<br>in Chrome</h1>
        <p>Minimalist autonomous browser control &amp; DevTools bridge.</p>
      </div>
    </div></div></body></html>`
  },
  {
    name: 'marquee-promo-tile-1400x560.png',
    width: 1400,
    height: 560,
    html: `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${SHARED_CSS}
      .wrap { position: relative; z-index: 2; width: 100%; height: 100%; padding: 60px 80px; display: grid; grid-template-columns: 1.1fr 0.9fr; gap: 56px; align-items: center; }
      h1 { font-size: 50px; font-weight: 600; letter-spacing: -0.035em; line-height: 1.1; margin: 18px 0 16px; }
      p { font-size: 18px; color: #a1a1aa; line-height: 1.55; margin-bottom: 26px; }
      .pills { display: flex; flex-wrap: wrap; gap: 10px; }
      .mock { background: #111114; border: 1px solid rgba(255,255,255,0.14); border-radius: 14px; padding: 24px; display: flex; flex-direction: column; gap: 14px; box-shadow: 0 28px 70px rgba(0,0,0,0.7); }
    </style></head><body><div class="canvas"><div class="grid-bg"></div><div class="wrap">
      <div>
        <div class="pill-tag">${STAR_SVG} Gemini Antigravity · Chrome Extension</div>
        <h1>Autonomous Browser Control for Developers</h1>
        <p>Drive live signed-in tabs, synthesize PDFs &amp; multi-tab research, inspect Shadow DOM styles, and automate workflows.</p>
        <div class="pills">
          <span class="pill-tag">@Multi-Tab</span>
          <span class="pill-tag">Element Picker</span>
          <span class="pill-tag">GIF Recorder</span>
          <span class="pill-tag">CDP DevTools</span>
        </div>
      </div>
      <div class="mock">
        <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(255,255,255,0.08);padding-bottom:12px;">
          <span style="display:flex;align-items:center;gap:8px;font-weight:500;">${STAR_SVG} Antigravity Side Panel</span>
          <span class="mono" style="font-size:11px;color:#10b981;">● Connected</span>
        </div>
        <div style="background:#09090b;border:1px solid rgba(255,255,255,0.09);border-radius:8px;padding:14px;" class="mono">
          <div style="color:#a1a1aa;font-size:11.5px;margin-bottom:6px;">▾ Autonomous Execution Trace</div>
          <div style="font-size:12px;color:#e4e4e7;">✓ chrome_read_multiple_tabs (3 tabs)</div>
          <div style="font-size:12px;color:#e4e4e7;">✓ chrome_inspect_element (&lt;form#deploy&gt;)</div>
          <div style="font-size:12px;color:#e4e4e7;">✓ chrome_fill_form (4 fields populated)</div>
          <div style="font-size:12px;color:#10b981;">✓ chrome_get_console_logs (0 errors)</div>
        </div>
        <div style="background:#09090b;border:1px solid rgba(255,255,255,0.14);border-radius:9px;padding:12px;display:flex;justify-content:space-between;align-items:center;font-size:12.5px;color:#71717a;">
          <span>Ask anything, / for shortcuts, @ for tabs...</span>
          <span style="width:24px;height:24px;border-radius:50%;background:#fafafa;color:#09090b;display:inline-flex;align-items:center;justify-content:center;font-weight:700;">↑</span>
        </div>
      </div>
    </div></div></body></html>`
  }
];

const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cws-render-'));

try {
  for (const asset of ASSETS) {
    const htmlPath = path.join(OUT_DIR, `render-${asset.name.replace(/\.png$/, '.html')}`);
    const outPngPath = path.join(OUT_DIR, asset.name);
    fs.writeFileSync(htmlPath, asset.html, 'utf8');

    const fileUrl = `file:///${htmlPath.replace(/\\/g, '/')}`;
    execFileSync(
      CHROME_EXE,
      [
        '--headless=new',
        `--user-data-dir=${tmpProfile}`,
        `--window-size=${Math.max(600, asset.width)},${Math.max(400, asset.height)}`,
        '--force-device-scale-factor=1',
        '--hide-scrollbars',
        '--default-background-color=09090b',
        '--no-first-run',
        '--disable-gpu',
        `--screenshot=${outPngPath}`,
        fileUrl
      ],
      { stdio: 'ignore', timeout: 25000 }
    );

    const info = convertPngToExact24BitRgb(outPngPath, asset.width, asset.height);
    fs.unlinkSync(htmlPath);
    console.log(`✔ Rendered ${asset.name} (${info.width}x${info.height}, colorType=${info.colorType} 24-bit RGB, ${Math.round(info.bytes / 1024)} KB)`);
  }
} finally {
  fs.rmSync(tmpProfile, { recursive: true, force: true });
}
