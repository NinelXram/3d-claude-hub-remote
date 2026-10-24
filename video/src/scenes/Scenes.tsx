// The six scenes, in spec order. Each runs inside its own <Sequence>, so frames here are scene-relative.
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame } from "remotion";
import { Caption } from "../components/Caption.tsx";
import { Clip, LaptopFrame, PhoneFrame } from "../components/Frames.tsx";
import { TailscaleDiagram } from "../components/TailscaleDiagram.tsx";
import { FPS, clipUses, lineWindows, sceneById } from "../timeline.ts";
import { C, mono, sans } from "../theme.ts";

const Backdrop: React.FC = () => (
  <AbsoluteFill style={{ background: `radial-gradient(1200px 700px at 50% 35%, #172033 0%, ${C.bg} 70%)` }}>
    <AbsoluteFill style={{ backgroundImage: "linear-gradient(rgba(148,163,184,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.06) 1px, transparent 1px)", backgroundSize: "64px 64px" }} />
  </AbsoluteFill>
);

const sceneFade = (frame: number, total: number) =>
  interpolate(frame, [0, 10, total - 10, total], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

const headline: React.CSSProperties = { fontSize: 52, fontWeight: 800, letterSpacing: -0.5, textAlign: "center", lineHeight: 1.2 };

export const Hook: React.FC = () => {
  const frame = useCurrentFrame();
  const total = sceneById("hook").durationInFrames;
  const second = lineWindows("hook")[1]!.from;
  const watchers = [-330, -200, 200, 330, 0];
  return (
    <AbsoluteFill style={{ opacity: sceneFade(frame, total) }}>
      <Backdrop />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 70 }}>
        <div style={{ position: "relative", width: 900, height: 220 }}>
          <div style={{ position: "absolute", left: 300, top: 50, width: 300, height: 120, borderRadius: 18, border: `2px solid ${C.accent}`, background: "rgba(17,24,39,0.9)", padding: 20, fontFamily: mono, color: C.ink, fontSize: 20 }}>
            <div style={{ color: C.accent, fontSize: 16, marginBottom: 10 }}>session của bạn</div>
            <div style={{ height: 10, width: 220, background: "#334155", borderRadius: 5, marginBottom: 10 }} />
            <div style={{ height: 10, width: 160, background: "#334155", borderRadius: 5 }} />
          </div>
          {watchers.map((x, i) => {
            const o = interpolate(frame, [second + i * 6, second + i * 6 + 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
            const top = i === 4 ? -10 : i % 2 === 0 ? 20 : 150;
            return (
              <div key={i} style={{ position: "absolute", left: 420 + x, top, opacity: o, width: 60, height: 60, borderRadius: 30, background: "#1e293b", border: `2px solid ${C.warn}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width={34} height={20} viewBox="0 0 34 20"><path d="M2 10C7 3 12 1 17 1s10 2 15 9c-5 7-10 9-15 9S7 17 2 10z" fill="none" stroke={C.warn} strokeWidth={2.5} /><circle cx={17} cy={10} r={4} fill={C.warn} /></svg>
              </div>
            );
          })}
        </div>
        <Caption scene="hook" variant="stack" style={{ alignItems: "center", gap: 26 }} styleFor={(i) => ({ ...headline, fontSize: i === 0 ? 64 : 46, color: i === 0 ? C.ink : C.warn })} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const Credit: React.FC = () => {
  const frame = useCurrentFrame();
  const total = sceneById("credit").durationInFrames;
  const [use] = clipUses("credit");
  return (
    <AbsoluteFill style={{ opacity: sceneFade(frame, total), background: C.bg }}>
      <AbsoluteFill style={{ filter: "blur(14px) brightness(0.45)", transform: "scale(1.08)" }}>
        <Clip name={use!.clip} startAt={use!.startAt} />
      </AbsoluteFill>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <Caption
          scene="credit"
          variant="stack"
          style={{ alignItems: "center", gap: 40, maxWidth: 1400 }}
          styleFor={(i) =>
            i === 0
              ? { ...headline, fontSize: 56 }
              : { fontFamily: mono, fontSize: 34, color: C.accent, padding: "14px 28px", borderRadius: 14, border: `2px solid ${C.accent}66`, background: "rgba(11,15,23,0.75)" }
          }
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** Caption bar above a laptop. The first office line (the product name) is set larger. */
const LaptopScene: React.FC<{ scene: "office" | "sessions"; zoomTo?: number }> = ({ scene, zoomTo = 1 }) => {
  const frame = useCurrentFrame();
  const total = sceneById(scene).durationInFrames;
  const uses = clipUses(scene);
  const zoom = interpolate(frame, [0, total], [1, zoomTo]);
  let at = 0;
  return (
    <AbsoluteFill style={{ opacity: sceneFade(frame, total) }}>
      <Backdrop />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "flex-start", paddingTop: 44 }}>
        <div style={{ height: 120, display: "flex", alignItems: "center" }}>
          <Caption scene={scene} variant="sequence" style={{ alignItems: "center" }} styleFor={(i) => ({ ...headline, fontSize: scene === "office" && i === 0 ? 72 : 48, color: scene === "office" && i === 0 ? C.accent : C.ink })} />
        </div>
        <div style={{ marginTop: -60 }}>
          <LaptopFrame scale={0.86}>
            <AbsoluteFill style={{ transform: `scale(${zoom})`, transformOrigin: "100% 30%" }}>
              {uses.map((u) => {
                const from = at;
                at += u.seconds * FPS;
                return (
                  <Sequence key={u.clip} from={from} durationInFrames={u.seconds * FPS} layout="none">
                    <AbsoluteFill>
                      <Clip name={u.clip} startAt={u.startAt} />
                    </AbsoluteFill>
                  </Sequence>
                );
              })}
            </AbsoluteFill>
          </LaptopFrame>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const Office: React.FC = () => <LaptopScene scene="office" />;
// Drift towards the Sessions panel on the right while the chat plays.
export const Sessions: React.FC = () => <LaptopScene scene="sessions" zoomTo={1.35} />;

export const Remote: React.FC = () => {
  const frame = useCurrentFrame();
  const total = sceneById("remote").durationInFrames;
  const [use] = clipUses("remote");
  const lines = lineWindows("remote");
  return (
    <AbsoluteFill style={{ opacity: sceneFade(frame, total) }}>
      <Backdrop />
      <AbsoluteFill style={{ flexDirection: "row", alignItems: "center", padding: "0 110px", gap: 110 }}>
        <PhoneFrame scale={1.12}>
          <Clip name={use!.clip} startAt={use!.startAt} />
        </PhoneFrame>
        <div style={{ display: "flex", flexDirection: "column", gap: 60, flex: 1 }}>
          <Caption scene="remote" variant="stack" style={{ gap: 22 }} styleFor={(i) => ({ fontFamily: sans, fontSize: i === 0 ? 50 : 34, fontWeight: i === 0 ? 800 : 600, lineHeight: 1.3, color: i === 2 ? C.accent : C.ink })} />
          <TailscaleDiagram start={lines[1]!.from} />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const total = sceneById("outro").durationInFrames;
  const fadeOut = interpolate(frame, [total - 20, total], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const fadeIn = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ opacity: Math.min(fadeIn, fadeOut) }}>
      <Backdrop />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <Caption
          scene="outro"
          variant="stack"
          style={{ alignItems: "center", gap: 34 }}
          styleFor={(i) =>
            [
              { ...headline, fontSize: 84, color: C.accent },
              { fontFamily: mono, fontSize: 34, color: C.ink, padding: "14px 30px", borderRadius: 14, background: "#0f172a", border: `2px solid ${C.frameEdge}` },
              { fontFamily: mono, fontSize: 36, color: C.ink },
              { fontFamily: sans, fontSize: 30, color: C.dim, marginTop: 30 },
            ][i] ?? {}
          }
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** Scene components by id, used by Video.tsx. */
export const SCENES = { hook: Hook, credit: Credit, office: Office, sessions: Sessions, remote: Remote, outro: Outro } as const;
