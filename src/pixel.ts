import { keccak256, type Address } from "viem";

/** Deterministic 8×8 mirrored pixel avatar derived from the token address. Nothing is stored. */
export function pixelAvatar(address: Address, size = 48): string {
  const hash = keccak256(address.toLowerCase() as Address).slice(2);
  const byte = (i: number) => parseInt(hash.slice((i % 32) * 2, (i % 32) * 2 + 2), 16);
  const hue = Math.round((byte(0) / 255) * 360);
  const hue2 = (hue + 120 + Math.round((byte(1) / 255) * 120)) % 360;
  const fg = `hsl(${hue} 72% 58%)`;
  const accent = `hsl(${hue2} 70% 62%)`;
  const bg = `hsl(${hue} 40% 14%)`;
  let cells = "";
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 4; x++) {
      const v = byte(2 + y * 4 + x);
      if (v < 100) continue;
      const fill = v > 215 ? accent : fg;
      cells += `<rect x="${x}" y="${y}" width="1" height="1" fill="${fill}"/><rect x="${7 - x}" y="${y}" width="1" height="1" fill="${fill}"/>`;
    }
  }
  return `<svg class="pixel" width="${size}" height="${size}" viewBox="0 0 8 8" shape-rendering="crispEdges" role="img" aria-label="Token avatar"><rect width="8" height="8" fill="${bg}"/>${cells}</svg>`;
}
