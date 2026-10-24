// Images you attach to a prompt (paste, drop or pick): read in the browser, shrunk when they are too big for the
// Claude API, and sent as base64 with the prompt. The server checks them again.
import { MAX_PROMPT_IMAGES, MAX_PROMPT_IMAGE_BASE64, PROMPT_IMAGE_TYPES } from "../../integrations/AgentBackend.ts";
import type { PromptImage, PromptImageType } from "../../integrations/AgentBackend.ts";

/** Longest side sent as-is; larger images are scaled down (the API would scale them down anyway). */
export const MAX_IMAGE_EDGE = 2000;

export interface Attachment extends PromptImage {
  id: string;
  name: string;
  /** data: URL for the thumbnail. */
  url: string;
}

export function isPromptImageType(type: string): type is PromptImageType {
  return (PROMPT_IMAGE_TYPES as readonly string[]).includes(type);
}

/** "data:image/png;base64,AAAA" → { mediaType, data }; null for anything else. */
export function splitDataUrl(url: string): { mediaType: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return m ? { mediaType: m[1]!, data: m[2]! } : null;
}

/** Whether an image can be sent without re-encoding. */
export function sendsAsIs(mediaType: string, base64Length: number, width: number, height: number): boolean {
  return isPromptImageType(mediaType) && base64Length <= MAX_PROMPT_IMAGE_BASE64 && Math.max(width, height) <= MAX_IMAGE_EDGE;
}

/** Size to scale `width`×`height` to so the longest side is at most `edge`. */
export function fitWithin(width: number, height: number, edge = MAX_IMAGE_EDGE): { width: number; height: number } {
  const scale = Math.min(1, edge / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** How many more images fit, and a message when some were left out. */
export function roomFor(current: number, adding: number): { take: number; note: string | null } {
  const take = Math.max(0, Math.min(adding, MAX_PROMPT_IMAGES - current));
  return { take, note: take < adding ? `At most ${MAX_PROMPT_IMAGES} images per prompt; ${adding - take} left out.` : null };
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("Could not read the file."));
    r.readAsDataURL(file);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("This file is not an image the browser can open."));
    img.src = url;
  });
}

let seq = 0;

/** Read a pasted, dropped or picked file into an attachment, re-encoding it as JPEG when it is too big or not a sendable type. */
export async function fileToAttachment(file: File): Promise<Attachment> {
  if (!file.type.startsWith("image/")) throw new Error(`${file.name || "That file"} is not an image.`);
  const name = file.name || "pasted image";
  const url = await readAsDataUrl(file);
  const img = await loadImage(url);
  const parts = splitDataUrl(url);
  const id = `att-${Date.now()}-${seq++}`;
  if (parts && sendsAsIs(parts.mediaType, parts.data.length, img.naturalWidth, img.naturalHeight)) {
    return { id, name, url, mediaType: parts.mediaType as PromptImageType, data: parts.data };
  }
  // Too big, too large in pixels, or a type the API does not take (BMP, TIFF, HEIC…): draw it and re-encode.
  let { width, height } = fitWithin(img.naturalWidth, img.naturalHeight);
  for (let attempt = 0; attempt < 6; attempt++) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser cannot resize images.");
    // JPEG has no transparency: put transparent areas on white rather than black.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const out = canvas.toDataURL("image/jpeg", 0.86);
    const p = splitDataUrl(out);
    if (p && p.data.length <= MAX_PROMPT_IMAGE_BASE64) return { id, name, url: out, mediaType: "image/jpeg", data: p.data };
    ({ width, height } = fitWithin(width, height, Math.round(Math.max(width, height) * 0.75)));
  }
  throw new Error(`${name} is too large to send.`);
}

/** Image files in a paste or drop. */
export function imageFiles(list: DataTransfer | null): File[] {
  if (!list) return [];
  const fromItems = [...list.items].filter((i) => i.kind === "file" && i.type.startsWith("image/")).map((i) => i.getAsFile()).filter((f): f is File => !!f);
  if (fromItems.length > 0) return fromItems;
  return [...list.files].filter((f) => f.type.startsWith("image/"));
}
