"use client";
// How a web-run session handles permission asks. Native <select> so it is keyboard- and phone-friendly.
import { useState } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import type { SessionPermissionMode } from "@/integrations/AgentBackend";

export const MODE_INFO: Record<SessionPermissionMode, { label: string; hint: string }> = {
  default: { label: "Ask me", hint: "Claude asks before tools that need permission." },
  acceptEdits: { label: "Accept edits", hint: "File edits run without asking; commands and the rest still ask." },
  auto: { label: "Auto", hint: "Claude Code's classifier approves or denies; it asks you only when unsure." },
  plan: { label: "Plan only", hint: "Claude explores and writes a plan; nothing is changed or run." },
  dontAsk: { label: "Don't ask", hint: "Only what your settings already allow runs; everything else is denied." },
  bypassPermissions: { label: "Bypass", hint: "Every tool runs without any check. Use only in a throwaway folder." },
};

const LAST_MODE_KEY = "aaw.permissionMode";

/** The mode last picked in this browser (never bypass: that is always a deliberate choice). */
export function rememberedMode(allowed: readonly SessionPermissionMode[]): SessionPermissionMode {
  try {
    const m = localStorage.getItem(LAST_MODE_KEY) as SessionPermissionMode | null;
    if (m && m !== "bypassPermissions" && allowed.includes(m)) return m;
  } catch {
    // storage blocked
  }
  return "default";
}

function remember(mode: SessionPermissionMode): void {
  if (mode === "bypassPermissions") return;
  try {
    localStorage.setItem(LAST_MODE_KEY, mode);
  } catch {
    // storage blocked
  }
}

export function PermissionModePicker({
  value,
  allowed,
  onChange,
  disabled,
  id,
  compact,
}: {
  value: SessionPermissionMode;
  allowed: readonly SessionPermissionMode[];
  onChange: (mode: SessionPermissionMode) => void;
  disabled?: boolean;
  id: string;
  compact?: boolean;
}) {
  // Bypass needs a second, explicit click.
  const [confirming, setConfirming] = useState(false);
  const pick = (m: SessionPermissionMode) => {
    if (m === "bypassPermissions" && value !== "bypassPermissions") return setConfirming(true);
    setConfirming(false);
    remember(m);
    onChange(m);
  };
  const danger = value === "bypassPermissions";
  return (
    <div className="flex flex-col gap-1" data-testid="permission-mode">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="flex flex-none items-center gap-1 text-[11.5px] text-mist-500">
          {danger ? <ShieldAlert size={13} className="text-bad" aria-hidden /> : <ShieldCheck size={13} aria-hidden />}
          Permissions
        </label>
        <select
          id={id}
          className={`field min-w-0 flex-1 py-1 text-[12.5px] ${danger ? "border-bad/50 text-bad" : ""}`}
          value={value}
          onChange={(e) => pick(e.target.value as SessionPermissionMode)}
          disabled={disabled}
        >
          {allowed.map((m) => (
            <option key={m} value={m}>
              {MODE_INFO[m].label}
            </option>
          ))}
        </select>
      </div>
      {confirming ? (
        <div role="alert" className="flex flex-col gap-1.5 rounded-lg border border-bad/40 bg-bad/10 px-2.5 py-2 text-[12px] text-bad">
          <span>Bypass lets Claude run any command and change any file without asking. Only for a throwaway folder.</span>
          <span className="flex gap-2">
            <button type="button" className="btn h-8 border-bad/50 px-2.5 text-bad" onClick={() => { setConfirming(false); onChange("bypassPermissions"); }}>
              Use Bypass
            </button>
            <button type="button" className="btn btn-quiet h-8 px-2.5" onClick={() => setConfirming(false)}>
              Keep {MODE_INFO[value].label}
            </button>
          </span>
        </div>
      ) : compact ? null : (
        <p className="text-[11px] leading-snug text-mist-500">{MODE_INFO[value].hint}</p>
      )}
    </div>
  );
}
