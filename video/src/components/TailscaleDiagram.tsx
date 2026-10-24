// Phone → Tailscale → personal machine; another user's path stops at a token lock.
import { interpolate, useCurrentFrame } from "remotion";
import { C, sans } from "../theme.ts";

const node = (label: string, sub: string, color: string, glyph: React.ReactNode, opacity: number) => (
  <div style={{ opacity, display: "flex", flexDirection: "column", alignItems: "center", gap: 10, width: 170 }}>
    <div style={{ width: 96, height: 96, borderRadius: 24, border: `2px solid ${color}`, background: "rgba(17,24,39,0.9)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: `0 0 30px ${color}33` }}>
      {glyph}
    </div>
    <div style={{ fontFamily: sans, fontWeight: 600, fontSize: 24, color: C.ink, textAlign: "center" }}>{label}</div>
    <div style={{ fontFamily: sans, fontSize: 17, color: C.dim, textAlign: "center" }}>{sub}</div>
  </div>
);

const Arrow: React.FC<{ progress: number; color: string; width?: number }> = ({ progress, color, width = 90 }) => (
  <svg width={width} height={20} style={{ marginTop: 38 }}>
    {progress > 0.02 && <line x1={0} y1={10} x2={(width - 10) * progress} y2={10} stroke={color} strokeWidth={4} strokeLinecap="round" />}
    {progress > 0.95 && <polygon points={`${width - 12},2 ${width},10 ${width - 12},18`} fill={color} />}
  </svg>
);

const phone = (
  <svg width={40} height={56} viewBox="0 0 40 56"><rect x={4} y={2} width={32} height={52} rx={7} fill="none" stroke={C.accent2} strokeWidth={3} /><rect x={15} y={46} width={10} height={3} rx={1.5} fill={C.accent2} /></svg>
);
const mesh = (
  <svg width={52} height={52} viewBox="0 0 52 52">{[0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => <circle key={`${r}${c}`} cx={10 + c * 16} cy={10 + r * 16} r={5} fill={(r + c) % 2 === 0 ? C.accent : "#475569"} />))}</svg>
);
const laptop = (
  <svg width={60} height={48} viewBox="0 0 60 48"><rect x={8} y={4} width={44} height={30} rx={4} fill="none" stroke={C.good} strokeWidth={3} /><rect x={2} y={38} width={56} height={6} rx={3} fill={C.good} /></svg>
);
const person = (
  <svg width={44} height={48} viewBox="0 0 44 48"><circle cx={22} cy={14} r={10} fill="none" stroke={C.dim} strokeWidth={3} /><path d="M4 46c2-12 10-17 18-17s16 5 18 17" fill="none" stroke={C.dim} strokeWidth={3} /></svg>
);
const lock = (
  <svg width={44} height={52} viewBox="0 0 44 52"><path d="M12 22v-8a10 10 0 0 1 20 0v8" fill="none" stroke={C.warn} strokeWidth={3} /><rect x={4} y={22} width={36} height={26} rx={5} fill="none" stroke={C.warn} strokeWidth={3} /><circle cx={22} cy={35} r={4} fill={C.warn} /></svg>
);

/** `frame` is relative to the scene; the diagram builds up from `start`. */
export const TailscaleDiagram: React.FC<{ start: number }> = ({ start }) => {
  const f = useCurrentFrame() - start;
  const step = (from: number, len = 15) => interpolate(f, [from, from + len], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 34 }}>
      <div style={{ display: "flex", alignItems: "flex-start" }}>
        {node("Điện thoại", "của bạn", C.accent2, phone, step(0))}
        <Arrow progress={step(12)} color={C.accent2} />
        {node("Tailscale", "tailnet riêng", C.accent, mesh, step(24))}
        <Arrow progress={step(36)} color={C.accent} />
        {node("Máy cá nhân", "session Claude Code", C.good, laptop, step(48))}
      </div>
      <div style={{ display: "flex", alignItems: "flex-start", opacity: step(80) }}>
        {node("Người khác", "trong tailnet", C.dim, person, 1)}
        <Arrow progress={step(92)} color={C.dim} />
        {node("Cần token", "không có thì không vào", C.warn, lock, step(104))}
      </div>
    </div>
  );
};
