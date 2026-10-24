import type { CreateTaskInput } from "./taskTypes.ts";

export const HOTFIX_TITLE = "Patch session token leak in password-reset flow";
export const MIGRATION_TITLE = "Migrate legacy billing cron to event-driven pipeline";

export const TASK_BACKLOG: CreateTaskInput[] = [
  { title: HOTFIX_TITLE, description: "Reset links reuse the session token in the URL. Issue a single-use reset token and invalidate sessions on change.", priority: "critical", script: { qaFailsOn: [1], reviewChangesOn: [2] } },
  { title: MIGRATION_TITLE, description: "The nightly billing cron double-charges on retries. Move to events with an outbox and reconcile totals.", priority: "high", script: { qaFailsOn: [1, 2, 3] } },
  { title: "Fix memory leak in the image-processing worker", description: "Worker RSS grows until OOM after ~6 hours. Find the retaining reference and add a regression benchmark.", priority: "critical" },
  { title: "Add Stripe usage-based billing for API calls", description: "Report metered usage to Stripe hourly and show the running total on the billing page.", priority: "high" },
  { title: "Full-text search for project documents", description: "Index titles and bodies, support filters by owner and date, and typo-tolerant queries.", priority: "medium" },
  { title: "Live presence indicators in shared editor", description: "Show who is viewing a document with avatars and live cursors over WebSocket.", priority: "medium" },
  { title: "Weekly email digest of mentions", description: "Aggregate mentions and assignments into one weekly email with unsubscribe.", priority: "low" },
  { title: "Export audit log to CSV and Parquet", description: "Admins can export filtered audit events; large exports run in the background.", priority: "low" },
  { title: "Canary deploys for the API on Kubernetes", description: "Route 5% of traffic to the new version and roll back automatically on error spikes.", priority: "high" },
  { title: "Offline mode for the mobile field app", description: "Queue edits while offline and sync with conflict resolution when back online.", priority: "medium" },
  { title: "Localise onboarding into Spanish and Arabic", description: "Extract strings, add ICU plurals and support right-to-left layout.", priority: "medium" },
  { title: "Summarise support tickets with an LLM", description: "Generate a three-line summary per ticket with redaction and caching.", priority: "medium" },
  { title: "Per-key rate limiting for the public API", description: "Token-bucket limits per API key with Retry-After headers.", priority: "high" },
  { title: "SSO login via OIDC for enterprise workspaces", description: "Let workspace admins configure an OIDC provider and enforce SSO.", priority: "high" },
  { title: "CRUD endpoints for team webhooks", description: "Create, list, update and delete webhook subscriptions with validation and pagination.", priority: "medium" },
  { title: "Usage dashboard component for admins", description: "Charts of active users and API calls with empty and loading states.", priority: "low" },
  { title: "Reduce p95 latency of the feed endpoint", description: "Profile the feed query, remove the N+1 path and add caching.", priority: "high" },
  { title: "Archive inactive workspaces after 12 months", description: "Notify owners, then archive and allow restore within 30 days.", priority: "low" },
];

const SPRINT_TITLES = [
  HOTFIX_TITLE,
  MIGRATION_TITLE,
  "Fix memory leak in the image-processing worker",
  "Add Stripe usage-based billing for API calls",
  "Full-text search for project documents",
  "Per-key rate limiting for the public API",
  "Live presence indicators in shared editor",
  "Export audit log to CSV and Parquet",
];

export const SPRINT_TASKS: CreateTaskInput[] = SPRINT_TITLES.map((title) => {
  const t = TASK_BACKLOG.find((b) => b.title === title);
  if (!t) throw new Error(`Sprint task missing from backlog: ${title}`);
  return t;
});

export const TASK_SUGGESTIONS: string[] = TASK_BACKLOG.slice(2, 6).map((t) => t.title);

export function pickRandomTask(exclude: ReadonlySet<string> = new Set(), rng: () => number = Math.random): CreateTaskInput {
  const pool = TASK_BACKLOG.filter((t) => !exclude.has(t.title));
  const list = pool.length > 0 ? pool : TASK_BACKLOG;
  return list[Math.floor(rng() * list.length)]!;
}
