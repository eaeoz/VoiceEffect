const fs = require('fs');
const path = require('path');

function createIcon() {
  const size = 256;
  const pixels = new Uint8Array(size * size * 4);

  function setPixel(x, y, r, g, b, a = 255) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const i = (y * size + x) * 4;
    const srcA = a / 255;
    const dstA = pixels[i + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA > 0) {
      pixels[i] = Math.round((r * srcA + pixels[i] * dstA * (1 - srcA)) / outA);
      pixels[i + 1] = Math.round((g * srcA + pixels[i + 1] * dstA * (1 - srcA)) / outA);
      pixels[i + 2] = Math.round((b * srcA + pixels[i + 2] * dstA * (1 - srcA)) / outA);
      pixels[i + 3] = Math.round(outA * 255);
    }
  }

  function fillCircle(cx, cy, radius, r, g, b) {
    for (let y = -radius; y <= radius; y++) {
      for (let x = -radius; x <= radius; x++) {
        const dist = Math.sqrt(x * x + y * y);
        if (dist <= radius) {
          const alpha = dist > radius - 1 ? Math.max(0, (radius - dist) * 255) : 255;
          setPixel(cx + x, cy + y, r, g, b, alpha);
        }
      }
    }
  }

  function fillRect(x1, y1, w, h, r, g, b) {
    for (let y = y1; y < y1 + h; y++) {
      for (let x = x1; x < x1 + w; x++) {
        setPixel(x, y, r, g, b);
      }
    }
  }

  const cx = 128, cy = 128;

  fillCircle(cx, cy, 110, 20, 20, 50);
  fillCircle(cx, cy, 105, 30, 15, 80);

  fillCircle(cx, cy - 10, 55, 40, 15, 110);
  fillRect(cx - 15, cy + 10, 30, 50, 40, 15, 110);
  fillRect(cx - 25, cy + 55, 50, 12, 40, 15, 110);

  fillCircle(cx, cy - 10, 35, 124, 58, 237);
  fillRect(cx - 8, cy + 10, 16, 40, 124, 58, 237);
  fillRect(cx - 18, cy + 45, 36, 8, 124, 58, 237);

  for (let i = 0; i < 3; i++) {
    const r = 25 + i * 12;
    const alpha = 200 - i * 50;
    for (let a = -40; a <= 40; a += 2) {
      const rad = (a * Math.PI) / 180;
      const px = cx + Math.cos(rad) * r;
      const py = cy - 20 + Math.sin(rad) * r * 0.6;
      setPixel(Math.round(px), Math.round(py), 6, 182, 212, alpha);
    }
  }

  return pixels;
}

function encodePNG(pixels, width, height) {
  function crc32(buf) {
    let c = 0xFFFFFFFF;
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let v = n;
      for (let k = 0; k < 8; k++) v = v & 1 ? 0xEDB88320 ^ (v >>> 1) : v >>> 1;
      table[n] = v;
    }
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function adler32(buf) {
    let a = 1, b = 0;
    for (let i = 0; i < buf.length; i++) {
      a = (a + buf[i]) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  }

  const rawData = [];
  for (let y = 0; y < height; y++) {
    rawData.push(0);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rawData.push(pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]);
    }
  }

  const rawBuf = Buffer.from(rawData);
  const zlib = require('zlib');
  const compressed = zlib.deflateSync(rawBuf);

  const chunks = [];

  function writeChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeB = Buffer.from(type, 'ascii');
    const crcInput = Buffer.concat([typeB, data]);
    const crcVal = Buffer.alloc(4);
    crcVal.writeUInt32BE(crc32(crcInput));
    chunks.push(len, typeB, data, crcVal);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  writeChunk('IHDR', ihdr);
  writeChunk('IDAT', compressed);
  writeChunk('IEND', Buffer.alloc(0));

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, ...chunks]);
}

function encodeICO(pngBuffer) {
  const icoHeader = Buffer.alloc(6);
  icoHeader.writeUInt16LE(0, 0);
  icoHeader.writeUInt16LE(1, 2);
  icoHeader.writeUInt16LE(1, 4);
  const dirEntry = Buffer.alloc(16);
  dirEntry[0] = 0;
  dirEntry[1] = 0;
  dirEntry.writeUInt16LE(256, 2);
  dirEntry.writeUInt16LE(256, 4);
  dirEntry[6] = 0;
  dirEntry[7] = 0;
  dirEntry.writeUInt16LE(1, 8);
  dirEntry.writeUInt32LE(pngBuffer.length, 12);
  return Buffer.concat([icoHeader, dirEntry, pngBuffer]);
}

const pixels = createIcon();
const png = encodePNG(pixels, 256, 256);
const ico = encodeICO(png);

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'icon.png'), png);
fs.writeFileSync(path.join(dataDir, 'icon.ico'), ico);
console.log('Icons generated: data/icon.png, data/icon.ico');
