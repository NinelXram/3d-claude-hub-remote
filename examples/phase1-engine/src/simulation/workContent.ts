// Canned work output. Nothing here is generated: templates are picked by regex on the task text.

export interface WorkTemplate {
  key: string;
  match: RegExp;
  subtasks: string[];
  findings: string[];
  tests: string[];
  reviewNotes: string[];
}

export const WORK_TEMPLATES: WorkTemplate[] = [
  {
    key: "auth",
    match: /\b(auth|authentication|jwt|login|session|password|oauth)\b/i,
    subtasks: ["Define user and refresh-token schema", "Implement register and login endpoints", "Issue short-lived access tokens", "Add refresh rotation with reuse detection", "Write auth middleware for protected routes", "Document error codes for clients"],
    findings: ["Access tokens of 10–15 min keep revocation lag acceptable without a denylist", "Refresh rotation with family IDs detects token replay cheaply", "argon2id with per-user salt is the current password-hash baseline"],
    tests: ["rejects expired access token", "rotates refresh token on use", "blocks reused refresh token family"],
    reviewNotes: ["Move token TTLs into config instead of literals", "Constant-time compare for the refresh token hash"],
  },
  {
    key: "migration",
    match: /\b(migration|migrate|pipeline|database|schema|cron|etl)\b/i,
    subtasks: ["Inventory current jobs and consumers", "Design event schema and topics", "Build dual-write shim behind a flag", "Backfill and reconcile historical rows", "Cut over consumers and remove the cron"],
    findings: ["Expand–migrate–contract avoids a big-bang schema change", "Reconciliation queries must run before turning off the old path", "Outbox pattern keeps DB writes and events consistent"],
    tests: ["reconciles backfilled totals with legacy job", "replays events idempotently", "survives consumer restart mid-batch"],
    reviewNotes: ["Add a kill switch to fall back to the cron", "Migration must be reversible for one release"],
  },
  {
    key: "payments",
    match: /\b(payment|payments|billing|stripe|invoice|subscription|checkout)\b/i,
    subtasks: ["Model invoices and payment intents", "Wire Stripe webhook endpoint with signature check", "Make webhook handling idempotent", "Handle proration on plan change", "Add dunning emails for failed charges"],
    findings: ["Stripe retries webhooks for 3 days, so handlers must be idempotent by event ID", "Storing amounts as integer minor units avoids rounding drift", "Proration should be previewed with upcoming-invoice API before committing"],
    tests: ["ignores duplicate webhook delivery", "prorates mid-cycle upgrade", "marks invoice past_due after final retry"],
    reviewNotes: ["Webhook secret must come from the secret store", "Log the Stripe event ID on every state change"],
  },
  {
    key: "search",
    match: /\b(search|index|indexing|full-text|typeahead|ranking)\b/i,
    subtasks: ["Choose analyser and tokeniser per field", "Build incremental indexer from change feed", "Expose query endpoint with filters and paging", "Add typo tolerance and synonyms", "Backfill existing documents"],
    findings: ["Change-data-capture keeps the index fresh without dual writes", "Edge n-grams make typeahead fast but double index size", "BM25 with a recency boost matches user expectations best"],
    tests: ["finds document after update within 2s", "paginates with stable cursor", "matches query with one typo"],
    reviewNotes: ["Cap page size server-side", "Backfill job needs a resumable checkpoint"],
  },
  {
    key: "realtime",
    match: /\b(realtime|real-time|websocket|presence|live cursor|pubsub)\b/i,
    subtasks: ["Stand up WebSocket gateway with auth handshake", "Fan out via pub/sub between nodes", "Track presence with heartbeats", "Add reconnect with resume token", "Back-pressure slow consumers"],
    findings: ["Heartbeat every 15s with 2 missed beats is a sane presence timeout", "Sticky sessions are not needed if state lives in pub/sub", "Slow consumers must be dropped, not buffered forever"],
    tests: ["marks user offline after missed heartbeats", "resumes stream without duplicates", "drops client exceeding buffer limit"],
    reviewNotes: ["Close code 4401 for auth failures, not 1006", "Bound the per-connection send queue"],
  },
  {
    key: "notification",
    match: /\b(notif\w*|email|digest|push|sms)\b/i,
    subtasks: ["Define notification preferences model", "Build digest aggregation job", "Render templates with localisation", "Respect quiet hours and unsubscribe", "Track delivery and bounces"],
    findings: ["Batching into digests cuts unsubscribes noticeably", "List-Unsubscribe headers are required by major mail providers", "Bounces must suppress future sends automatically"],
    tests: ["groups events into one daily digest", "skips users in quiet hours", "suppresses hard-bounced address"],
    reviewNotes: ["Templates need plain-text fallbacks", "Do not send digests with zero items"],
  },
  {
    key: "performance",
    match: /\b(performance|latency|memory leak|leak|slow|p95|p99|cache|caching)\b/i,
    subtasks: ["Reproduce with a load profile", "Capture heap snapshots and flame graphs", "Fix the retaining reference", "Add a regression benchmark", "Set an alert on the metric"],
    findings: ["Heap snapshots show listeners retained by a module-level cache", "p99 is dominated by one N+1 query path", "A bounded LRU removes the unbounded growth"],
    tests: ["keeps heap flat over 10k jobs", "p95 under budget at target RPS", "evicts cache entries past capacity"],
    reviewNotes: ["Benchmark should run in CI, not only locally", "Add a comment on why the cache is bounded"],
  },
  {
    key: "deploy",
    match: /\b(deploy|deployment|kubernetes|k8s|canary|ci|cd|rollout|helm)\b/i,
    subtasks: ["Add readiness and liveness probes", "Template manifests per environment", "Introduce canary step with metrics gate", "Automate rollback on SLO breach", "Document the runbook"],
    findings: ["Canary at 5% for 10 min catches most regressions", "Readiness probes must check dependencies, liveness must not", "Automated rollback needs error-rate and latency gates"],
    tests: ["rolls back canary on error spike", "blocks rollout when readiness fails", "promotes canary after clean window"],
    reviewNotes: ["Pin image digests, not tags", "Resource limits missing on the sidecar"],
  },
  {
    key: "mobile",
    match: /\b(mobile|offline|sync|ios|android)\b/i,
    subtasks: ["Pick local store and sync protocol", "Queue mutations while offline", "Resolve conflicts with last-writer + field merge", "Show sync status in the UI", "Handle schema upgrades on device"],
    findings: ["Operation logs sync more reliably than whole-record diffs", "Field-level merge resolves most conflicts without user input", "Background sync windows on iOS are short and unpredictable"],
    tests: ["replays queued edits after reconnect", "merges concurrent field edits", "upgrades local schema without data loss"],
    reviewNotes: ["Cap the offline queue size", "Surface unrecoverable conflicts to the user"],
  },
  {
    key: "export",
    match: /\b(export|csv|parquet|report|reports|download)\b/i,
    subtasks: ["Define export formats and columns", "Stream rows instead of buffering", "Run large exports as background jobs", "Deliver via signed URL", "Expire old export files"],
    findings: ["Streaming keeps memory flat for million-row exports", "Parquet cuts file size several times for analytics users", "Signed URLs with short expiry avoid leaking data"],
    tests: ["streams 1M rows under memory cap", "escapes commas and quotes in CSV", "expires signed URL after TTL"],
    reviewNotes: ["Column order must be stable across versions", "Add a row limit for synchronous exports"],
  },
  {
    key: "i18n",
    match: /\b(i18n|locali[sz]\w*|translat\w*|locale|rtl|right-to-left)\b/i,
    subtasks: ["Extract strings into message catalogs", "Add ICU plural and date formatting", "Detect and persist user locale", "Support right-to-left layout", "Set up translation workflow"],
    findings: ["ICU MessageFormat handles plurals that string concatenation cannot", "Logical CSS properties make RTL mostly free", "Pseudo-localisation catches truncation early"],
    tests: ["formats plural forms for Polish", "mirrors layout in Arabic", "falls back to English for missing keys"],
    reviewNotes: ["No string concatenation inside translations", "Dates must use the user's time zone"],
  },
  {
    key: "ai",
    match: /\b(ai|llm|summar(y|ise|ize)|embedding|rag|prompt)\b/i,
    subtasks: ["Define input limits and redaction", "Build prompt and output schema", "Add caching keyed by content hash", "Evaluate on a labelled sample", "Expose with rate limits and feedback"],
    findings: ["Structured output with a schema cuts parsing failures sharply", "Content-hash caching removes most repeat cost", "A small labelled eval set catches prompt regressions"],
    tests: ["redacts emails before sending", "returns cached summary for same input", "rejects output failing schema"],
    reviewNotes: ["Log model and prompt version with each result", "Timeouts need a user-visible fallback"],
  },
  {
    key: "security",
    match: /\b(rate.?limit\w*|security|sso|saml|oidc|csrf|xss|vulnerab\w*)\b/i,
    subtasks: ["Threat-model the endpoint", "Add token-bucket rate limiting per key", "Integrate SSO via OIDC", "Harden headers and CSRF protection", "Add audit logging"],
    findings: ["Token bucket in Redis gives fair limits across nodes", "OIDC with PKCE is preferred over SAML for new integrations", "Audit logs must be append-only and include actor and IP"],
    tests: ["returns 429 after burst", "rejects tampered id_token", "blocks cross-site form post"],
    reviewNotes: ["Return Retry-After with 429", "Do not log raw tokens in audit entries"],
  },
  {
    key: "api",
    match: /\b(api|endpoint|endpoints|crud|rest|graphql)\b/i,
    subtasks: ["Design resource schema and routes", "Implement CRUD handlers with validation", "Add pagination and filtering", "Version the API", "Publish OpenAPI docs"],
    findings: ["Cursor pagination stays stable under concurrent inserts", "Validation at the edge keeps handlers simple", "Explicit versioning in the path eases client migration"],
    tests: ["rejects invalid payload with 422", "paginates without duplicates", "returns 404 for deleted resource"],
    reviewNotes: ["Use consistent error envelope", "Missing index on the filter column"],
  },
  {
    key: "ui",
    match: /\b(ui|dashboard|component|components|chart|frontend|design system)\b/i,
    subtasks: ["Sketch layout and states", "Build components with loading and empty states", "Wire data fetching with caching", "Make it keyboard accessible", "Add visual regression snapshots"],
    findings: ["Skeleton states reduce perceived latency", "Charts need table fallbacks for screen readers", "Co-locating queries with components simplifies cache invalidation"],
    tests: ["renders empty state without data", "navigates widgets with keyboard", "matches visual snapshot"],
    reviewNotes: ["Colour contrast fails on muted labels", "Memoise the chart data transform"],
  },
];

export const GENERIC_TEMPLATE: WorkTemplate = {
  key: "generic",
  match: /.*/,
  subtasks: ["Clarify acceptance criteria", "Sketch the design", "Implement the core change", "Add tests for edge cases", "Update documentation"],
  findings: ["Existing code has a natural extension point for this change", "No new dependencies are required", "Risk is low if shipped behind a feature flag"],
  tests: ["handles empty input", "preserves existing behaviour", "rejects invalid state"],
  reviewNotes: ["Add a short design note to the PR", "Name the flag after the feature, not the ticket"],
};

export function templateFor(title: string, description = ""): WorkTemplate {
  const text = `${title} ${description}`;
  return WORK_TEMPLATES.find((t) => t.match.test(text)) ?? GENERIC_TEMPLATE;
}

export function shortTitle(title: string, max = 42): string {
  return title.length <= max ? title : `${title.slice(0, max - 1).trimEnd()}…`;
}
