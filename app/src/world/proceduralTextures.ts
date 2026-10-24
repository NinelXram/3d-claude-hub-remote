import * as THREE from "three";

/**
 * Canvas-generated textures (§0.6: no binary assets). Each one is built once on first use and cached for the
 * page's lifetime; colour maps are tagged sRGB. Client-only: everything here touches `document`.
 */

type Draw = (g: CanvasRenderingContext2D, w: number, h: number) => void;

export function canvasTexture(w: number, h: number, draw: Draw, colorSpace: THREE.ColorSpace = THREE.SRGBColorSpace): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  if (g) draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = colorSpace;
  t.anisotropy = 4;
  return t;
}

/** Deterministic hash noise in [0, 1): textures look the same on every load. */
export function hash(x: number, y: number, seed = 0): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

const cache = new Map<string, THREE.Texture>();
function cached<T extends THREE.Texture>(key: string, make: () => T): T {
  let t = cache.get(key) as T | undefined;
  if (!t) {
    t = make();
    cache.set(key, t);
  }
  return t;
}

/** Large-format stone tiles (4 × 4 per texture) with soft tonal variation, mottling and dark seams. */
export function floorTexture(): THREE.CanvasTexture {
  return cached("floor", () => {
    const t = canvasTexture(1024, 1024, (g, w, h) => {
      const n = 4;
      const s = w / n;
      g.fillStyle = "#0c1018";
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const v = hash(i, j, 3);
          const base = 58 + v * 12;
          const grad = g.createLinearGradient(i * s, j * s, (i + 1) * s, (j + 1) * s);
          grad.addColorStop(0, `rgb(${base + 2},${base + 7},${base + 16})`);
          grad.addColorStop(1, `rgb(${base - 3},${base + 1},${base + 9})`);
          g.fillStyle = grad;
          g.fillRect(i * s + 3, j * s + 3, s - 6, s - 6);
          // soft clouding: a few large, very faint radial patches
          for (let k = 0; k < 5; k++) {
            const px = i * s + hash(i * 31 + k, j, 1) * s;
            const py = j * s + hash(i, j * 17 + k, 2) * s;
            const r = s * (0.25 + hash(k, i + j, 5) * 0.35);
            const cg = g.createRadialGradient(px, py, 0, px, py, r);
            const light = hash(k, i * 7 + j, 9) > 0.5;
            cg.addColorStop(0, light ? "rgba(255,255,255,0.025)" : "rgba(0,0,0,0.04)");
            cg.addColorStop(1, "rgba(0,0,0,0)");
            g.fillStyle = cg;
            g.fillRect(i * s + 3, j * s + 3, s - 6, s - 6);
          }
          // fine speckle
          for (let k = 0; k < 700; k++) {
            const px = i * s + 4 + hash(i * 131 + k, j, 12) * (s - 8);
            const py = j * s + 4 + hash(i, j * 113 + k, 13) * (s - 8);
            g.fillStyle = hash(k, i + j * 5, 14) > 0.5 ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.07)";
            g.fillRect(px, py, 1.5, 1.5);
          }
          // soft bevel highlight on the top/left edge of each tile
          g.fillStyle = "rgba(190,210,240,0.05)";
          g.fillRect(i * s + 3, j * s + 3, s - 6, 2);
          g.fillRect(i * s + 3, j * s + 3, 2, s - 6);
        }
      }
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  });
}

/** Blue-hour sky: deep navy at the zenith through violet to a warm horizon glow. */
export function skyTexture(): THREE.CanvasTexture {
  return cached("sky", () =>
    canvasTexture(32, 512, (g, w, h) => {
      const gr = g.createLinearGradient(0, 0, 0, h);
      // The sky plane spans y −130…150, so the horizon (eye level, y ≈ 20) sits at v ≈ 0.46 from the top.
      gr.addColorStop(0, "#050914");
      gr.addColorStop(0.2, "#0f1c3d");
      gr.addColorStop(0.36, "#34396a");
      gr.addColorStop(0.43, "#9a5f66");
      gr.addColorStop(0.46, "#e9a56e");
      gr.addColorStop(0.475, "#f3c084");
      gr.addColorStop(0.5, "#3a2a3a");
      gr.addColorStop(0.58, "#0a0e15");
      gr.addColorStop(1, "#0a0e15");
      g.fillStyle = gr;
      g.fillRect(0, 0, w, h);
    }),
  );
}

/** Lit office windows on a dark facade, used as the skyline's emissive map. */
export function windowsTexture(): THREE.CanvasTexture {
  return cached("windows", () => {
    const t = canvasTexture(128, 512, (g, w, h) => {
      g.fillStyle = "#000000";
      g.fillRect(0, 0, w, h);
      for (let y = 6; y < h - 4; y += 10) {
        const rowLit = hash(0, y, 4) > 0.25;
        for (let x = 6; x < w - 4; x += 10) {
          const r = hash(x, y, 7);
          if (!rowLit || r < 0.55) continue;
          g.fillStyle = r > 0.93 ? "#ffd9a0" : r > 0.8 ? "#ffc27a" : "#7fa6e8";
          g.globalAlpha = 0.45 + hash(y, x, 8) * 0.55;
          g.fillRect(x, y, 6, 6);
        }
      }
      g.globalAlpha = 1;
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  });
}

/** Syntax-coloured "code" lines; repeats vertically so screens can scroll it. */
export function screenTexture(): THREE.CanvasTexture {
  return cached("screen", () => {
    const t = canvasTexture(256, 256, (g, w, h) => {
      g.fillStyle = "#081120";
      g.fillRect(0, 0, w, h);
      const cols = ["#7cc4d6", "#a78bfa", "#6fe3a4", "#b7c1cf", "#f2b46a", "#6c9eff"];
      for (let y = 8, i = 0; y < h - 4; y += 10, i++) {
        const indent = 10 + (Math.floor(hash(i, 0, 1) * 4) % 4) * 12;
        let x = indent;
        const words = 1 + Math.floor(hash(i, 1, 2) * 5);
        for (let k = 0; k < words && x < w - 16; k++) {
          const len = 8 + Math.floor(hash(i, k, 3) * 40);
          g.fillStyle = cols[Math.floor(hash(i, k, 4) * cols.length)]!;
          g.globalAlpha = 0.9;
          g.fillRect(x, y, Math.min(len, w - 10 - x), 4);
          x += len + 7;
        }
      }
      g.globalAlpha = 1;
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  });
}

/** Soft dark radial blob: contact shadows under robots and furniture. */
export function blobTexture(): THREE.CanvasTexture {
  return cached("blob", () =>
    canvasTexture(128, 128, (g, w) => {
      const gr = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
      gr.addColorStop(0, "rgba(0,0,0,0.6)");
      gr.addColorStop(0.55, "rgba(0,0,0,0.28)");
      gr.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = gr;
      g.fillRect(0, 0, w, w);
    }),
  );
}

/** Soft white radial glow: dust motes, floor highlights, light pools. */
export function glowTexture(): THREE.CanvasTexture {
  return cached("glow", () =>
    canvasTexture(64, 64, (g, w) => {
      const gr = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
      gr.addColorStop(0, "rgba(255,255,255,1)");
      gr.addColorStop(0.35, "rgba(255,255,255,0.45)");
      gr.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = gr;
      g.fillRect(0, 0, w, w);
    }),
  );
}

/** The page's resolved UI font stack (next/font hashes the Inter family name, so read it from the body). */
export function uiFont(): string {
  const fallback = "Inter, ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif";
  if (typeof document === "undefined") return fallback;
  return getComputedStyle(document.body).fontFamily || fallback;
}
