#!/usr/bin/env node
/**
 * Generates ultra-minimalist monochrome geometric PNG icons (16x16, 32x32, 48x48, 128x128)
 * for Gemini Antigravity in Chrome using pure Node.js (node:zlib + node:crypto),
 * and maintains deterministic identity for both local unpacked and Chrome Web Store builds.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const ROOT_DIR = path.resolve(__dirname, '..');
const ICONS_DIR = path.join(ROOT_DIR, 'extension', 'icons');
const STORE_ASSETS_DIR = path.join(ROOT_DIR, 'store_assets');
const BRIDGE_DIR = path.join(ROOT_DIR, 'bridge');
const CWS_EXTENSION_ID = 'jilnmjdedhlhhnlopjijgbkoblbeihmg';

fs.mkdirSync(ICONS_DIR, { recursive: true });
fs.mkdirSync(STORE_ASSETS_DIR, { recursive: true });
fs.mkdirSync(BRIDGE_DIR, { recursive: true });

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * Signed distance to a rounded rectangle centered at origin with half-extents (hx, hy) and corner radius r.
 */
function sdRoundedBox(px, py, hx, hy, r) {
  const qx = Math.abs(px) - (hx - r);
  const qy = Math.abs(py) - (hy - r);
  const outDist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inDist = Math.min(Math.max(qx, qy), 0);
  return outDist + inDist - r;
}

/**
 * Supersampled minimalist obsidian squircle + crisp white geometric 4-point Antigravity mark.
 */
function generateMinimalIconPng(size, { opaqueCanvas = false } = {}) {
  const channels = opaqueCanvas ? 3 : 4;
  const rawData = Buffer.alloc(size * (size * channels + 1));
  const center = (size - 1) / 2;
  const half = size * 0.455;
  const cornerRadius = size * 0.235;
  const starScale = size * 0.30;

  // 4x4 subpixel supersampling for razor-sharp anti-aliasing even at 16x16
  const SUB = 4;

  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * channels + 1);
    rawData[rowStart] = 0;

    for (let x = 0; x < size; x++) {
      let accR = 0;
      let accG = 0;
      let accB = 0;
      let accA = 0;

      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const sampleX = x + (sx + 0.5) / SUB - 0.5 - center;
          const sampleY = y + (sy + 0.5) / SUB - 0.5 - center;

          const boxDist = sdRoundedBox(sampleX, sampleY, half, half, cornerRadius);
          if (boxDist > 0) {
            if (opaqueCanvas) {
              accR += 9;
              accG += 9;
              accB += 11;
              accA += 1;
            }
            continue;
          }

          // Matte obsidian surface (#111114 top -> #09090b bottom)
          const vNorm = (sampleY + half) / (2 * half);
          let r = 20 - 8 * vNorm;
          let g = 20 - 8 * vNorm;
          let b = 23 - 9 * vNorm;

          // Subtle 1px inner rim highlight
          const rimFactor = boxDist > -Math.max(1.0, size * 0.025) ? 0.14 : 0;
          r += (255 - r) * rimFactor;
          g += (255 - g) * rimFactor;
          b += (255 - b) * rimFactor;

          // Crisp 4-point geometric astroid star: |nx|^0.58 + |ny|^0.58 <= 1
          const nx = Math.abs(sampleX) / starScale;
          const ny = Math.abs(sampleY) / starScale;
          const astroid = Math.pow(nx, 0.58) + Math.pow(ny, 0.58);

          if (astroid <= 1.0) {
            r = 250;
            g = 250;
            b = 250;
          }

          accR += r;
          accG += g;
          accB += b;
          accA += 1;
        }
      }

      const totalSamples = SUB * SUB;
      const px = rowStart + 1 + x * channels;
      if (opaqueCanvas) {
        rawData[px] = Math.round(accR / totalSamples);
        rawData[px + 1] = Math.round(accG / totalSamples);
        rawData[px + 2] = Math.round(accB / totalSamples);
      } else {
        if (accA === 0) {
          rawData[px] = 0;
          rawData[px + 1] = 0;
          rawData[px + 2] = 0;
          rawData[px + 3] = 0;
        } else {
          rawData[px] = Math.round(accR / accA);
          rawData[px + 1] = Math.round(accG / accA);
          rawData[px + 2] = Math.round(accB / accA);
          rawData[px + 3] = Math.round((accA / totalSamples) * 255);
        }
      }
    }
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = opaqueCanvas ? 2 : 6; // 2 = RGB, 6 = RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(rawData, { level: 9 });
  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

for (const size of [16, 32, 48, 128]) {
  const filePath = path.join(ICONS_DIR, `icon-${size}.png`);
  const pngBuffer = generateMinimalIconPng(size, { opaqueCanvas: false });
  fs.writeFileSync(filePath, pngBuffer);
  console.log(`[icons] Created ${filePath} (${size}x${size}px, ${pngBuffer.length} bytes)`);
}

const storeIconPath = path.join(STORE_ASSETS_DIR, 'store-icon-128x128.png');
const storeIconBuf = generateMinimalIconPng(128, { opaqueCanvas: false });
fs.writeFileSync(storeIconPath, storeIconBuf);
console.log(`[icons] Updated ${storeIconPath} (128x128px, ${storeIconBuf.length} bytes)`);

// --- Deterministic Extension Key & Dual ID Support (Dev + CWS Global) ---
const keyFile = path.join(BRIDGE_DIR, 'extension-id.json');
let keyMetadata;

if (fs.existsSync(keyFile)) {
  keyMetadata = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  if (!keyMetadata.cwsExtensionId) {
    keyMetadata.cwsExtensionId = CWS_EXTENSION_ID;
    fs.writeFileSync(keyFile, `${JSON.stringify(keyMetadata, null, 2)}\n`, 'utf8');
  }
  console.log(`[identity] Dev ID: ${keyMetadata.extensionId} | CWS Global ID: ${keyMetadata.cwsExtensionId}`);
} else {
  const { publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' }
  });

  const manifestKey = publicKey.toString('base64');
  const hashHex = crypto.createHash('sha256').update(publicKey).digest('hex').slice(0, 32);
  const extensionId = hashHex
    .split('')
    .map((ch) => String.fromCharCode(97 + parseInt(ch, 16)))
    .join('');

  keyMetadata = {
    extensionId,
    cwsExtensionId: CWS_EXTENSION_ID,
    manifestKey,
    nativeHostName: 'com.google.antigravity.chrome_bridge',
    wsPort: 17380
  };
  fs.writeFileSync(keyFile, `${JSON.stringify(keyMetadata, null, 2)}\n`, 'utf8');
  console.log(`[identity] Generated Dev ID: ${extensionId} | CWS Global ID: ${CWS_EXTENSION_ID}`);
}
