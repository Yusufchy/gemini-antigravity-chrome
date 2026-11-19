/**
 * Offscreen Document Worker for Gemini Antigravity in Chrome v2.0.
 * Strictly adheres to MV3 Offscreen restrictions: uses ONLY chrome.runtime messaging
 * and standard Web APIs (OffscreenCanvas, createImageBitmap, fetch, Blob).
 *
 * Provides:
 * 1. 20s heartbeat to keep the Service Worker WebSocket bridge alive.
 * 2. CROP_IMAGE: High-DPI region & element cropping for App-Shots and inspect_element.
 * 3. ENCODE_GIF: Pure-JS GIF89a LZW animated GIF encoder for multi-step workflow recordings.
 */

const FAST_HEARTBEAT_MS = 3000;
const CONNECTED_HEARTBEAT_MS = 20000;
let heartbeatTimer = null;

async function scheduleNextHeartbeat() {
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  let nextDelay = FAST_HEARTBEAT_MS;
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_HEARTBEAT',
      timestamp: Date.now()
    });
    if (res?.connected) {
      nextDelay = CONNECTED_HEARTBEAT_MS;
    }
  } catch (_err) {
    // Service worker restarting — retry quickly
  }
  heartbeatTimer = setTimeout(scheduleNextHeartbeat, nextDelay);
}

scheduleNextHeartbeat();

// --- Image Helper: Decode DataURL to ImageBitmap ---
async function decodeDataUrl(dataUrl) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return await createImageBitmap(blob);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('FileReader error'));
    reader.readAsDataURL(blob);
  });
}

// --- High-DPI Region / Element Cropper ---
async function cropImage({ dataUrl, rect, dpr = 1, format = 'png' }) {
  const bitmap = await decodeDataUrl(dataUrl);
  try {
    const scale = dpr || 1;
    const sx = Math.max(0, Math.min(bitmap.width - 1, Math.round((rect.x || 0) * scale)));
    const sy = Math.max(0, Math.min(bitmap.height - 1, Math.round((rect.y || 0) * scale)));
    const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round((rect.width || 100) * scale)));
    const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round((rect.height || 100) * scale)));

    const canvas = new OffscreenCanvas(sw, sh);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);

    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const outBlob = await canvas.convertToBlob({
      type: mimeType,
      quality: format === 'jpeg' ? 0.88 : undefined
    });
    const croppedDataUrl = await blobToDataUrl(outBlob);
    const base64 = croppedDataUrl.replace(/^data:image\/\w+;base64,/, '');
    return { dataUrl: croppedDataUrl, base64, width: sw, height: sh };
  } finally {
    bitmap.close();
  }
}

// --- Pure-JS GIF89a Animated GIF Encoder (3-3-2 RGB Global Palette + LZW) ---
function buildGlobalPalette332() {
  const table = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const r3 = (i >> 5) & 0x07;
    const g3 = (i >> 2) & 0x07;
    const b2 = i & 0x03;
    table[i * 3] = Math.round((r3 * 255) / 7);
    table[i * 3 + 1] = Math.round((g3 * 255) / 7);
    table[i * 3 + 2] = Math.round((b2 * 255) / 3);
  }
  return table;
}

function quantizeRgbaTo332(rgba, pixelCount) {
  const indexed = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const off = i * 4;
    const r = rgba[off] >> 5;
    const g = rgba[off + 1] >> 5;
    const b = rgba[off + 2] >> 6;
    indexed[i] = (r << 5) | (g << 2) | b;
  }
  return indexed;
}

function lzwEncode8Bit(indices) {
  const minCodeSize = 8;
  const clearCode = 256;
  const endCode = 257;
  const bytes = [];

  let bitBuf = 0;
  let bitCount = 0;
  function emitCode(code, size) {
    bitBuf |= code << bitCount;
    bitCount += size;
    while (bitCount >= 8) {
      bytes.push(bitBuf & 0xff);
      bitBuf >>= 8;
      bitCount -= 8;
    }
  }

  // Dictionary stored as flat Int32Array [prefix * 256 + suffix -> nextCode]
  const dict = new Int32Array(4096 * 256);
  dict.fill(-1);

  let codeSize = 9;
  let nextCode = 258;
  emitCode(clearCode, codeSize);

  if (indices.length === 0) {
    emitCode(endCode, codeSize);
    if (bitCount > 0) bytes.push(bitBuf & 0xff);
    return { minCodeSize, data: new Uint8Array(bytes) };
  }

  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const match = dict[key];
    if (match !== -1) {
      prefix = match;
    } else {
      emitCode(prefix, codeSize);
      if (nextCode < 4096) {
        dict[key] = nextCode++;
        if (nextCode > (1 << codeSize) && codeSize < 12) {
          codeSize++;
        }
      } else {
        emitCode(clearCode, codeSize);
        dict.fill(-1);
        codeSize = 9;
        nextCode = 258;
      }
      prefix = k;
    }
  }

  emitCode(prefix, codeSize);
  emitCode(endCode, codeSize);
  if (bitCount > 0) bytes.push(bitBuf & 0xff);

  return { minCodeSize, data: new Uint8Array(bytes) };
}

async function encodeAnimatedGif({ frames = [], maxWidth = 800, defaultDelayMs = 700 }) {
  if (!frames.length) {
    throw new Error('No frames available to encode GIF.');
  }

  const firstBmp = await decodeDataUrl(frames[0].dataUrl);
  const ratio = Math.min(1, maxWidth / firstBmp.width);
  const width = Math.max(16, Math.round(firstBmp.width * ratio));
  const height = Math.max(16, Math.round(firstBmp.height * ratio));
  firstBmp.close();

  const chunks = [];
  const pushBytes = (...arr) => chunks.push(new Uint8Array(arr));
  const pushU16 = (v) => pushBytes(v & 0xff, (v >> 8) & 0xff);

  // Header: GIF89a
  pushBytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
  // Logical Screen Descriptor (Global Color Table = 1, 8-bit color = 7 -> 0xF7)
  pushU16(width);
  pushU16(height);
  pushBytes(0xf7, 0x00, 0x00);
  // Global Color Table (768 bytes)
  chunks.push(buildGlobalPalette332());

  // Netscape 2.0 Infinite Loop Application Extension
  pushBytes(
    0x21, 0xff, 0x0b,
    0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30,
    0x03, 0x01, 0x00, 0x00, 0x00
  );

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  for (const frame of frames) {
    const bmp = await decodeDataUrl(frame.dataUrl);
    try {
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(bmp, 0, 0, width, height);

      if (frame.clickPoint && typeof frame.clickPoint.x === 'number') {
        const cx = Math.round(frame.clickPoint.x * ratio);
        const cy = Math.round(frame.clickPoint.y * ratio);
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, 12, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, 12, 0, Math.PI * 2);
        ctx.strokeStyle = '#111114';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
      }

      if (frame.caption) {
        ctx.save();
        const barH = 26;
        ctx.fillStyle = 'rgba(9, 9, 11, 0.86)';
        ctx.fillRect(0, height - barH, width, barH);
        ctx.fillStyle = '#fafafa';
        ctx.font = '500 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.fillText(String(frame.caption).slice(0, 95), 10, height - 9);
        ctx.restore();
      }

      const imgData = ctx.getImageData(0, 0, width, height);
      const indexed = quantizeRgbaTo332(imgData.data, width * height);
      const { minCodeSize, data } = lzwEncode8Bit(indexed);

      const delayCs = Math.max(8, Math.round((frame.delayMs || defaultDelayMs) / 10));
      // Graphic Control Extension
      pushBytes(0x21, 0xf9, 0x04, 0x00);
      pushU16(delayCs);
      pushBytes(0x00, 0x00);

      // Image Descriptor
      pushBytes(0x2c);
      pushU16(0);
      pushU16(0);
      pushU16(width);
      pushU16(height);
      pushBytes(0x00);

      // LZW Minimum Code Size + Sub-blocks (max 255 bytes each)
      pushBytes(minCodeSize);
      for (let pos = 0; pos < data.length; pos += 255) {
        const slice = data.subarray(pos, Math.min(pos + 255, data.length));
        pushBytes(slice.length);
        chunks.push(slice);
      }
      pushBytes(0x00);
    } finally {
      bmp.close();
    }
  }

  // Trailer
  pushBytes(0x3b);

  const gifBlob = new Blob(chunks, { type: 'image/gif' });
  const dataUrl = await blobToDataUrl(gifBlob);
  const base64 = dataUrl.replace(/^data:image\/gif;base64,/, '');
  return {
    dataUrl,
    base64,
    width,
    height,
    frameCount: frames.length,
    byteLength: gifBlob.size
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.offscreenTarget) return false;

  (async () => {
    try {
      switch (message.type) {
        case 'CROP_IMAGE': {
          const result = await cropImage(message.params || {});
          sendResponse({ ok: true, result });
          break;
        }
        case 'ENCODE_GIF': {
          const result = await encodeAnimatedGif(message.params || {});
          sendResponse({ ok: true, result });
          break;
        }
        default:
          sendResponse({ ok: false, error: `Unknown offscreen op: ${message.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true;
});
