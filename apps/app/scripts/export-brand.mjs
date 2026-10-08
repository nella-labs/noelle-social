import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const root = fileURLToPath(new URL("../", import.meta.url));
const brand = JSON.parse(await readFile(path.join(root, "brand/geometry.json"), "utf8"));
const { symbol, wordmark, lockup, ink, paper, accent } = brand;
const svg = (width, height, body, label = "noelle") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}"><title>${label}</title>${body}</svg>\n`;
const shape = (item, color) => {
  if (item.type === "path") return `<path d="${item.d}"${item.fillRule ? ` fill-rule="${item.fillRule}"` : ""}/>`;
  if (item.type === "circle") return `<circle cx="${item.cx}" cy="${item.cy}" r="${item.r}" fill="none" stroke="${color}" stroke-width="${item.strokeWidth}"/>`;
  if (item.type === "rect") return `<rect x="${item.x}" y="${item.y}" width="${item.width}" height="${item.height}" rx="${item.rx}"/>`;
  throw new Error(`Unknown brand shape: ${item.type}`);
};
const geometry = (part, color) => {
  const elements = part.shapes
    ? part.shapes.map(item => shape(item, color))
    : part.letters.map(({ glyph, x }) => `<g transform="translate(${x} 0)">${shape(part.glyphs[glyph], color)}</g>`);
  return `<g fill="${color}">${elements.join("")}</g>`;
};
const placed = (part, x, y, width, color) =>
  `<g transform="translate(${x} ${y}) scale(${width / part.width})">${geometry(part, color)}</g>`;
const lockupBody = (color = ink) =>
  placed(symbol, symbol.x - lockup.originX, symbol.y - lockup.originY, symbol.width, color) +
  placed(wordmark, wordmark.x - lockup.originX, wordmark.y - lockup.originY, wordmark.width, color);
const markScale = 280 / Math.max(symbol.width, symbol.height);
const icon = svg(512, 512,
  `<path fill="${paper}" d="M0 0h512v512H0z"/>` +
  placed(symbol, (512 - symbol.width * markScale) / 2, (512 - symbol.height * markScale) / 2, symbol.width * markScale, ink));
const socialScale = 720 / lockup.width;
const social = svg(1200, 630,
  `<path fill="${paper}" d="M0 0h1200v630H0z"/>` +
  `<g transform="translate(240 ${(630 - lockup.height * socialScale) / 2}) scale(${socialScale})">${lockupBody()}</g>` +
  `<path fill="${accent}" d="M0 606h1200v24H0z"/>`);

await mkdir(path.join(root, "public/brand"), { recursive: true });
await mkdir(path.join(root, "public/icons"), { recursive: true });
for (const [file, source] of Object.entries({
  "public/brand/noelle-symbol.svg": svg(symbol.width, symbol.height, geometry(symbol, ink), "noelle symbol"),
  "public/brand/noelle-symbol-white.svg": svg(symbol.width, symbol.height, geometry(symbol, "#FFFFFF"), "noelle symbol"),
  "public/brand/noelle-wordmark.svg": svg(wordmark.width, wordmark.height, geometry(wordmark, ink)),
  "public/brand/noelle-wordmark-white.svg": svg(wordmark.width, wordmark.height, geometry(wordmark, "#FFFFFF")),
  "public/brand/noelle-lockup.svg": svg(lockup.width, lockup.height, lockupBody()),
  "public/brand/noelle-lockup-white.svg": svg(lockup.width, lockup.height, lockupBody("#FFFFFF")),
  "public/brand/noelle-icon.svg": icon,
  "public/brand/noelle-social.svg": social,
  "src/app/icon.svg": icon,
})) await writeFile(path.join(root, file), source);

const png = async (source, file, width, height = width) => {
  const bytes = await sharp(Buffer.from(source)).resize(width, height).png().toBuffer();
  await writeFile(path.join(root, file), bytes);
  return bytes;
};
await png(icon, "src/app/apple-icon.png", 180);
await png(icon, "public/icons/icon-192.png", 192);
await png(icon, "public/icons/icon-512.png", 512);
await png(svg(lockup.width, lockup.height, lockupBody("#FFFFFF")),
  "public/brand/noelle-lockup-white.png", lockup.width * 2, lockup.height * 2);
const socialPng = await png(social, "public/og.png", 1200, 630);
await writeFile(path.join(root, "../www/public/og.png"), socialPng);

const sizes = [16, 32, 48];
const images = await Promise.all(sizes.map(size => sharp(Buffer.from(icon)).resize(size).png().toBuffer()));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, index) => {
  const entry = 6 + 16 * index;
  header[entry] = size;
  header[entry + 1] = size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(images[index].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += images[index].length;
});
await writeFile(path.join(root, "src/app/favicon.ico"), Buffer.concat([header, ...images]));
console.log("Generated Noelle vectors, app icons, email lockup, and social cards.");
