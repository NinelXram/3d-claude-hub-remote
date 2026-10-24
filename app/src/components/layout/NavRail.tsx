"use client";

import { forwardRef } from "react";
import { Activity, Bot, LayoutDashboard, ListChecks, MessagesSquare, Settings } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { PanelTab } from "@/state/useWorldStore";
import { useSessionStore } from "@/state/useSessionStore";
import { useWorldStore } from "@/state/useWorldStore";
import { useRenderCount } from "@/world/renderCounts";

export const NAV_ITEMS: { tab: PanelTab; label: string; icon: LucideIcon }[] = [
  { tab: "overview", label: "Overview", icon: LayoutDashboard },
  { tab: "agents", label: "Agents", icon: Bot },
  { tab: "tasks", label: "Tasks", icon: ListChecks },
  { tab: "activity", label: "Activity", icon: Activity },
  { tab: "sessions", label: "Sessions", icon: MessagesSquare },
  { tab: "settings", label: "Settings", icon: Settings },
];

// Rounded so server and client render identical attribute strings (no hydration mismatch).
const LOGO_DOTS = ["#E8B04A", "#5CC8D7", "#A78BFA", "#6C9EFF", "#5FD39A", "#F08A7E"].map((fill, i) => {
  const r = (i * Math.PI) / 3;
  return { fill, cx: Math.round((12 + Math.sin(r) * 8.2) * 100) / 100, cy: Math.round((12 - Math.cos(r) * 8.2) * 100) / 100 };
});

export function Logo({ size = 36 }: { size?: number }) {
  return (
    <span
      className="inline-flex flex-none items-center justify-center rounded-[11px] border border-signal/30"
      style={{ width: size, height: size, background: "radial-gradient(circle at 30% 25%, rgb(154 215 230 / 0.35), rgb(14 19 27 / 0.9) 70%)" }}
      aria-hidden
    >
      <svg width={size * 0.58} height={size * 0.58} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="3.2" fill="#9ad7e6" />
        {LOGO_DOTS.map((d) => (
          <circle key={d.fill} cx={d.cx} cy={d.cy} r="2" fill={d.fill} />
        ))}
      </svg>
    </span>
  );
}

/** Tabs that only make sense with a live (non-simulated) backend. */
export const LIVE_ONLY_TABS: ReadonlySet<PanelTab> = new Set(["sessions"]);

export const NavRail = forwardRef<HTMLElement>(function NavRail(_props, ref) {
  useRenderCount("NavRail");
  const tab = useWorldStore((s) => s.tab);
  const setTab = useWorldStore((s) => s.setTab);
  const taskCount = useWorldStore((s) => s.tasks.length);
  const live = useWorldStore((s) => s.backend.identified && !s.backend.simulated);
  const asks = useSessionStore((s) => s.permissions.length);
  const items = live ? NAV_ITEMS : NAV_ITEMS.filter((n) => !LIVE_ONLY_TABS.has(n.tab));

  return (
    <nav
      ref={ref}
      aria-label="Primary"
      className="surface scroll-thin pointer-events-auto flex w-full flex-none items-center justify-around gap-1 px-1.5 py-1.5 lg:w-14 lg:flex-col lg:justify-start lg:gap-1.5 lg:px-0 lg:py-2.5 phl:w-[52px] phl:flex-col phl:justify-start phl:gap-1 phl:overflow-y-auto phl:px-0 phl:py-1"
    >
      <span className="mb-1.5 hidden lg:block">
        <Logo />
      </span>
      {items.map(({ tab: id, label, icon: Icon }) => {
        const active = tab === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => {
              setTab(id);
              // Tapping a tab (even the current one) shows a peeking bottom sheet (SidePanel).
              window.dispatchEvent(new Event("aaw:sheet-raise"));
            }}
            aria-current={active ? "page" : undefined}
            title={label}
            className={`relative flex h-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-[11px] transition-colors lg:size-10 lg:flex-none phl:size-11 phl:flex-none ${
              active ? "bg-ink-600/80 text-signal-strong shadow-[inset_0_1px_0_rgb(255_255_255/0.06)]" : "text-mist-500 hover:bg-ink-700/70 hover:text-mist-100"
            }`}
          >
            <Icon size={18} strokeWidth={active ? 2.2 : 1.8} />
            <span className="text-[9.5px] font-semibold lg:sr-only phl:sr-only">{label}</span>
            {id === "tasks" && taskCount > 0 ? (
              <span className="absolute right-1 top-1 min-w-4 rounded-full bg-signal px-1 text-center font-mono text-[9px] font-bold leading-4 text-ink-950">{taskCount}</span>
            ) : null}
            {id === "sessions" && asks > 0 ? (
              <span className="absolute right-1 top-1 min-w-4 rounded-full bg-warn px-1 text-center font-mono text-[9px] font-bold leading-4 text-ink-950" aria-label={`${asks} permission ${asks === 1 ? "ask" : "asks"} waiting`}>
                {asks}
              </span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
});
