const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function generateTrayPixels() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  const cx = SIZE / 2, cy = SIZE / 2;

  function setPixel(x, y, r, g, b, a) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
    const idx = (y * SIZE + x) * 4;
    const srcA = pixels[idx + 3] / 255;
    const dstA = a / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA > 0) {
      pixels[idx] = Math.round((pixels[idx] * srcA + r * dstA * (1 - srcA)) / outA);
      pixels[idx + 1] = Math.round((pixels[idx + 1] * srcA + g * dstA * (1 - srcA)) / outA);
      pixels[idx + 2] = Math.round((pixels[idx + 2] * srcA + b * dstA * (1 - srcA)) / outA);
      pixels[idx + 3] = Math.round(outA * 255);
    }
  }

  function fillCircle(cx, cy, radius, r, g, b, a) {
    for (let y = -radius; y <= radius; y++) {
      for (let x = -radius; x <= radius; x++) {
        if (x * x + y * y <= radius * radius) {
          setPixel(cx + x, cy + y, r, g, b, a);
        }
      }
    }
  }

  function fillRoundedRect(x, y, w, h, rad, r, g, b, a) {
    for (let py = y; py < y + h; py++) {
      for (let px = x; px < x + w; px++) {
        let inRect = false;
        if (px >= x + rad && px <= x + w - rad && py >= y && py <= y + h) inRect = true;
        if (py >= y + rad && py <= y + h - rad && px >= x && px <= x + w) inRect = true;
        if (!inRect) {
          const corners = [
            [x + rad, y + rad], [x + w - rad, y + rad],
            [x + rad, y + h - rad], [x + w - rad, y + h - rad]
          ];
          for (const [ccx, ccy] of corners) {
            const dx = px - ccx, dy = py - ccy;
            if (dx * dx + dy * dy <= rad * rad) { inRect = true; break; }
          }
        }
        if (inRect) setPixel(px, py, r, g, b, a);
      }
    }
  }

  // Bright purple-blue gradient background
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      const dx = px - cx, dy = py - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const maxR = SIZE / 2 - 4;
      if (dist <= maxR) {
        const t = py / SIZE;
        const r = Math.round(90 + t * 40);
        const g = Math.round(60 + t * 10);
        const b = Math.round(220 - t * 30);
        setPixel(px, py, r, g, b, 255);
      }
    }
  }

  // Dark outline ring
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      const dx = px - cx, dy = py - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const maxR = SIZE / 2 - 4;
      if (dist > maxR - 5 && dist <= maxR) {
        setPixel(px, py, 20, 20, 30, 255);
      }
    }
  }

  // Microphone outline then white
  const micW = 24, micH = 60;
  fillRoundedRect(cx - micW / 2 - 3, cy - micH / 2 - 10 - 3, micW + 6, micH + 6, 14, 20, 20, 30, 255);
  fillRoundedRect(cx - micW / 2, cy - micH / 2 - 10, micW, micH, 12, 255, 255, 255, 255);

  // Holder arc outline then white
  const arcR = 38;
  const arcThickness = 8;
  for (let angle = Math.PI; angle <= 2 * Math.PI; angle += 0.02) {
    const ax = cx + Math.cos(angle) * arcR;
    const ay = cy - 10 + Math.sin(angle) * (arcR * 0.8);
    fillCircle(ax, ay, arcThickness / 2 + 3, 20, 20, 30, 255);
  }
  for (let angle = Math.PI; angle <= 2 * Math.PI; angle += 0.02) {
    const ax = cx + Math.cos(angle) * arcR;
    const ay = cy - 10 + Math.sin(angle) * (arcR * 0.8);
    fillCircle(ax, ay, arcThickness / 2, 255, 255, 255, 255);
  }

  // Stand outline then white
  for (let y = cy + 20; y <= cy + 48; y++) {
    fillCircle(cx, y, 5, 20, 20, 30, 255);
  }
  for (let y = cy + 20; y <= cy + 48; y++) {
    fillCircle(cx, y, 3, 255, 255, 255, 255);
  }

  // Base outline then white
  fillRoundedRect(cx - 22, cy + 44, 44, 10, 4, 20, 20, 30, 255);
  fillRoundedRect(cx - 20, cy + 46, 40, 6, 3, 255, 255, 255, 255);

  // Sound waves outline then white
  const waveR1 = 50, waveR2 = 62;
  for (let angle = -0.6; angle <= 0.6; angle += 0.03) {
    fillCircle(cx + Math.cos(angle) * waveR1, cy - 10 + Math.sin(angle) * waveR1 * 0.6, 3, 20, 20, 30, 220);
    fillCircle(cx + Math.cos(angle) * waveR2, cy - 10 + Math.sin(angle) * waveR2 * 0.6, 3, 20, 20, 30, 180);
  }
  for (let angle = -0.6; angle <= 0.6; angle += 0.03) {
    fillCircle(cx + Math.cos(angle) * waveR1, cy - 10 + Math.sin(angle) * waveR1 * 0.6, 2, 255, 255, 255, 255);
    fillCircle(cx + Math.cos(angle) * waveR2, cy - 10 + Math.sin(angle) * waveR2 * 0.6, 2, 255, 255, 255, 220);
  }

  return pixels;
}



function encodePNG(pixels, width, height) {
  function crc32(buf) {
    let table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c;
    }
    let crc = -1;
    for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
  }

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeData = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeData));
    return Buffer.concat([len, typeData, crc]);
  }

  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0;
    pixels.copy(rawData, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const compressed = zlib.deflateSync(rawData);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function resizePNG(pixels, srcSize, dstSize) {
  const dst = Buffer.alloc(dstSize * dstSize * 4);
  const ratio = srcSize / dstSize;
  
  for (let dy = 0; dy < dstSize; dy++) {
    for (let dx = 0; dx < dstSize; dx++) {
      let r = 0, g = 0, b = 0, a = 0, count = 0;
      
      const startX = Math.floor(dx * ratio);
      const endX = Math.floor((dx + 1) * ratio);
      const startY = Math.floor(dy * ratio);
      const endY = Math.floor((dy + 1) * ratio);
      
      for(let y = startY; y < endY; y++) {
        for(let x = startX; x < endX; x++) {
          const si = (y * srcSize + x) * 4;
          r += pixels[si];
          g += pixels[si + 1];
          b += pixels[si + 2];
          a += pixels[si + 3];
          count++;
        }
      }
      
      const di = (dy * dstSize + dx) * 4;
      if(count > 0) {
        dst[di] = r / count;
        dst[di + 1] = g / count;
        dst[di + 2] = b / count;
        dst[di + 3] = a / count;
      }
    }
  }
  return dst;
}

function createICO(pngBuffers) {
  const count = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const dirEntries = [];
  let dataOffset = 6 + count * 16;

  for (const { size, buffer } of pngBuffers) {
    const entry = Buffer.alloc(16);
    entry[0] = size < 256 ? size : 0;
    entry[1] = size < 256 ? size : 0;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(buffer.length, 8);
    entry.writeUInt32LE(dataOffset, 12);
    dirEntries.push(entry);
    dataOffset += buffer.length;
  }

  return Buffer.concat([header, ...dirEntries, ...pngBuffers.map(e => e.buffer)]);
}

console.log('Generating tray icon (icon.png)...');
const rawPixels = generateTrayPixels();
const trayPng = encodePNG(rawPixels, SIZE, SIZE);
fs.writeFileSync(path.join(dataDir, 'icon.png'), trayPng);
console.log('Tray icon created: data/icon.png');

console.log('Generating exe/installer icon (icon.ico)...');
const icoSizes = [16, 32, 48, 256];
const icoBuffers = icoSizes.map(size => ({
  size,
  buffer: encodePNG(resizePNG(rawPixels, SIZE, size), size, size)
}));
fs.writeFileSync(path.join(dataDir, 'icon.ico'), createICO(icoBuffers));
console.log('Exe icon created: data/icon.ico');
