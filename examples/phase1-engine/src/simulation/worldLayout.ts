// Pure layout data in metres. x: left(-)/right(+), z: back(-)/front(+).
// Heading convention: heading = atan2(dx, dz), so heading π faces -z (towards the back wall).

export interface Vec2 {
  x: number;
  z: number;
}

export type LocationId =
  | "hub"
  | "ops"
  | "research"
  | "product"
  | "dev"
  | "testing"
  | "review"
  | "planning"
  | "collab"
  | "lounge";

export type ZoneId = "operations" | "research" | "development" | "collaboration";

export interface LocationDef {
  id: LocationId;
  label: string;
  slots: Vec2[];
  /** Heading per slot (same length as slots). */
  facing: number[];
  zone: ZoneId;
}

export const FLOOR = { width: 30, depth: 21, minX: -15, maxX: 15, minZ: -9.5, maxZ: 11.5 } as const;
export const CORRIDOR_Z = 2.8;

function ring(center: Vec2, radius: number, count: number): { slots: Vec2[]; facing: number[] } {
  const slots: Vec2[] = [];
  const facing: number[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const slot = { x: center.x + Math.sin(a) * radius, z: center.z + Math.cos(a) * radius };
    slots.push(slot);
    facing.push(Math.atan2(center.x - slot.x, center.z - slot.z)); // inward
  }
  return { slots, facing };
}

const single = (x: number, z: number, facing: number) => ({ slots: [{ x, z }], facing: [facing] });

export const LOCATIONS: Record<LocationId, LocationDef> = {
  hub: { id: "hub", label: "Operations Hub", zone: "operations", ...single(0, 1.15, Math.PI) },
  ops: { id: "ops", label: "Ops Console", zone: "research", ...single(-8.25, 0.05, Math.PI) },
  research: { id: "research", label: "Research Station", zone: "research", ...single(-10, -3.75, Math.PI) },
  product: { id: "product", label: "Product Station", zone: "research", ...single(-6.5, -3.75, Math.PI) },
  dev: { id: "dev", label: "Engineering Station", zone: "development", ...single(6.5, -3.75, Math.PI) },
  testing: { id: "testing", label: "QA Lab", zone: "development", ...single(10, -3.75, Math.PI) },
  review: { id: "review", label: "Review Station", zone: "development", ...single(8.25, 0.05, Math.PI) },
  planning: {
    id: "planning",
    label: "Planning Board",
    zone: "collaboration",
    slots: [
      { x: -11.4, z: 4.2 },
      { x: -11.0, z: 5.6 },
    ],
    facing: [-Math.PI / 2, -Math.PI / 2],
  },
  collab: { id: "collab", label: "Collaboration Table", zone: "collaboration", ...ring({ x: -5, z: 5.6 }, 1.75, 6) },
  lounge: { id: "lounge", label: "Meeting Lounge", zone: "collaboration", ...ring({ x: 7.5, z: 6.2 }, 2.1, 6) },
};

export const HUB_CENTER: Vec2 = { x: 0, z: -0.6 };
export const MISSION_CONTROL: Vec2 = { x: 0, z: -7.4 };

export function slotFor(location: LocationId, seat: number): { position: Vec2; facing: number } {
  const def = LOCATIONS[location];
  const i = ((seat % def.slots.length) + def.slots.length) % def.slots.length;
  return { position: def.slots[i]!, facing: def.facing[i]! };
}

const EPS = 1e-6;

/** Go to the corridor, travel along x, then to the destination. Never returns the start point. */
export function route(from: Vec2, to: Vec2): Vec2[] {
  // Already there: no detour via the corridor.
  if (Math.hypot(to.x - from.x, to.z - from.z) < 1e-3) return [];
  const points: Vec2[] = [
    { x: from.x, z: CORRIDOR_Z },
    { x: to.x, z: CORRIDOR_Z },
    { x: to.x, z: to.z },
  ];
  const out: Vec2[] = [];
  let prev = from;
  for (const p of points) {
    if (Math.abs(p.x - prev.x) > EPS || Math.abs(p.z - prev.z) > EPS) {
      out.push(p);
      prev = p;
    }
  }
  return out;
}

export function pathLength(from: Vec2, path: Vec2[]): number {
  let total = 0;
  let prev = from;
  for (const p of path) {
    total += Math.hypot(p.x - prev.x, p.z - prev.z);
    prev = p;
  }
  return total;
}
