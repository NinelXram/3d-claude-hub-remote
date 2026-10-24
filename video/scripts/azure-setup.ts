// One-time setup for the voiceover: sign in to Azure with a device code, create (or reuse) a free F0 Speech
// resource, and write its key and region to video/.env.local (git-ignored). The key is never printed.
//   npm run azure:setup
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DeviceCodeCredential } from "@azure/identity";

const REGION = "southeastasia";
const GROUP = "rg-3d-claude-hub-video";
const ARM = "https://management.azure.com";
const envFile = join(dirname(fileURLToPath(import.meta.url)), "..", ".env.local");

// "common" accepts both work/school and personal Microsoft accounts.
const cred = new DeviceCodeCredential({
  tenantId: "common",
  userPromptCallback: (info) => {
    console.log(`\nDEVICE CODE: ${info.userCode}`);
    console.log(`Open ${info.verificationUri} and enter the code above.\n`);
  },
});

async function arm<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = (await cred.getToken(`${ARM}/.default`)).token;
  const res = await fetch(`${ARM}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path.split("?")[0]} → ${res.status}: ${text.slice(0, 400)}`);
  return (text ? JSON.parse(text) : {}) as T;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Sub { subscriptionId: string; displayName: string; state: string }
interface Account { id: string; name: string; kind: string; location: string; sku: { name: string }; properties: { provisioningState: string } }

const subs = (await arm<{ value: Sub[] }>("GET", "/subscriptions?api-version=2022-12-01")).value.filter((s) => s.state === "Enabled");
if (subs.length === 0) {
  console.log("NO_SUBSCRIPTION: this account has no active Azure subscription. Create one at https://azure.microsoft.com/free and run again.");
  process.exit(3);
}
const sub = subs[0]!;
console.log(`subscription: ${sub.displayName}${subs.length > 1 ? ` (first of ${subs.length})` : ""}`);
const base = `/subscriptions/${sub.subscriptionId}`;

// The Speech service lives in the Cognitive Services provider, which new subscriptions have not registered yet.
await arm("POST", `${base}/providers/Microsoft.CognitiveServices/register?api-version=2021-04-01`);
for (let i = 0; i < 30; i++) {
  const p = await arm<{ registrationState: string }>("GET", `${base}/providers/Microsoft.CognitiveServices?api-version=2021-04-01`);
  if (p.registrationState === "Registered") break;
  await sleep(4000);
}

// Only one free (F0) Speech resource is allowed per subscription: reuse one if it exists.
const accounts = (await arm<{ value: Account[] }>("GET", `${base}/providers/Microsoft.CognitiveServices/accounts?api-version=2023-05-01`)).value;
let account = accounts.find((a) => a.kind === "SpeechServices" && a.sku.name === "F0");
if (account) {
  console.log(`reusing free Speech resource ${account.name} (${account.location})`);
} else {
  await arm("PUT", `${base}/resourcegroups/${GROUP}?api-version=2021-04-01`, { location: REGION });
  const name = `speech-3dhub-${Math.random().toString(36).slice(2, 8)}`;
  const path = `${base}/resourceGroups/${GROUP}/providers/Microsoft.CognitiveServices/accounts/${name}?api-version=2023-05-01`;
  await arm("PUT", path, { kind: "SpeechServices", sku: { name: "F0" }, location: REGION, properties: {} });
  for (let i = 0; i < 40; i++) {
    account = await arm<Account>("GET", path);
    if (account.properties.provisioningState === "Succeeded") break;
    if (account.properties.provisioningState === "Failed") throw new Error("Creating the Speech resource failed.");
    await sleep(3000);
  }
  console.log(`created free Speech resource ${name} in ${REGION} (resource group ${GROUP})`);
}

const keys = await arm<{ key1: string }>("POST", `${account!.id}/listKeys?api-version=2023-05-01`);
const keep = existsSync(envFile) ? readFileSync(envFile, "utf8").split(/\r?\n/).filter((l) => l && !/^AZURE_SPEECH_(KEY|REGION)=/.test(l)) : [];
writeFileSync(envFile, [...keep, `AZURE_SPEECH_KEY=${keys.key1}`, `AZURE_SPEECH_REGION=${account!.location}`].join("\n") + "\n");
console.log(`DONE: key and region written to video/.env.local (region ${account!.location})`);
