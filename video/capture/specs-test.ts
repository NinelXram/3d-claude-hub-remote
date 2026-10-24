// Every clip forces the high rendering tier: the app picks "low" on its own for narrow (phone) viewports.
import { SPECS } from "./specs.ts";

let failures = 0;
for (const spec of SPECS) {
  const ok = new URLSearchParams(spec.path.split("?")[1] ?? "").get("quality") === "high";
  console.log(`  ${ok ? "✓" : "✗"} ${spec.name} forces ?quality=high`);
  if (!ok) failures++;
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
