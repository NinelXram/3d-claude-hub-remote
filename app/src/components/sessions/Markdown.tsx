"use client";
// Claude's replies as Markdown (GitHub flavour: tables, task lists, strikethrough).
// react-markdown never renders raw HTML and strips unsafe URLs, so untrusted transcript text stays text.
import { createContext, memo, useContext, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ImageIcon, Play } from "lucide-react";
import { Lightbox } from "@/components/sessions/imageAttach";
import { localVideoPath, markdownUrl } from "@/components/sessions/sessionText";
import { sessionCommands } from "@/integrations/sessionClient";

/** The session whose reply is shown; local videos are looked up in its folder. */
const SessionIdContext = createContext<string | null>(null);

/**
 * A video on the session's machine that Claude linked to. Nothing loads until you press play; the server then
 * checks the path (videos inside the session's folder only) and hands back a short-lived stream URL.
 */
function LocalVideo({ path, label }: { path: string; label: string }) {
  const sessionId = useContext(SessionIdContext);
  const [state, setState] = useState<{ kind: "idle" | "loading" } | { kind: "ready"; src: string } | { kind: "error"; message: string }>({ kind: "idle" });
  const name = path.split(/[\\/]/).pop() || path;
  if (!sessionId) return <span className="text-mist-500">[{label || name}]</span>;
  if (state.kind === "ready") {
    return (
      <video src={state.src} controls playsInline preload="metadata" className="block max-h-[420px] w-full rounded-lg border border-mist-500/20 bg-black" data-testid="session-video">
        <track kind="captions" />
      </video>
    );
  }
  const load = () => {
    setState({ kind: "loading" });
    sessionCommands.video(sessionId, path).then(
      (v) => setState({ kind: "ready", src: v.src }),
      (err: unknown) => setState({ kind: "error", message: err instanceof Error ? err.message : String(err) }),
    );
  };
  return (
    <button
      type="button"
      onClick={load}
      disabled={state.kind === "loading"}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-signal/30 bg-signal/10 px-2.5 py-1.5 align-middle text-[12px] text-mist-100 hover:bg-signal/20 disabled:opacity-60 pointer-coarse:min-h-9"
      title={path}
      data-testid="session-video-play"
    >
      <Play size={13} className="flex-none text-signal" />
      <span className="truncate">
        {state.kind === "loading" ? `Opening ${name}…` : state.kind === "error" ? `${name}: ${state.message} (retry)` : `Play video · ${label && label !== path ? label : name}`}
      </span>
    </button>
  );
}

/** Text of a Markdown node, for a link's label. */
function textOf(children: React.ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textOf).join("");
  return "";
}

/**
 * An image in Claude's reply. It points at some other server, and loading it tells that server you are reading
 * this (transcript text can be steered by whatever Claude read), so it loads only when you ask for it.
 */
function MarkdownImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  const [shown, setShown] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const url = typeof src === "string" && /^https?:\/\//i.test(src) ? src : null;
  const label = alt?.trim() || "image";
  if (!url) return <span className="text-mist-500">[{label}]</span>;
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // keep the raw URL
  }
  if (!shown || failed) {
    return (
      <button
        type="button"
        onClick={() => {
          setFailed(false);
          setShown(true);
        }}
        className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-mist-500/20 bg-ink-900/60 px-2 py-1 align-middle text-[11.5px] text-mist-300 hover:text-mist-100"
        title={url}
        data-testid="markdown-image"
      >
        <ImageIcon size={13} className="flex-none" />
        <span className="truncate">{failed ? `${label}: could not load, retry` : `${label} · load from ${host}`}</span>
      </button>
    );
  }
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="block max-w-full overflow-hidden rounded-lg border border-mist-500/20" title="View full size">
        {/* eslint-disable-next-line @next/next/no-img-element -- an arbitrary remote URL, loaded on request */}
        <img src={url} alt={label} referrerPolicy="no-referrer" className="max-h-80 max-w-full object-contain" onError={() => setFailed(true)} />
      </button>
      {open ? <Lightbox src={url} alt={label} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

const components: Components = {
  p: ({ children }) => <p className="break-words">{children}</p>,
  h1: ({ children }) => <h3 className="mt-1 text-[14px] font-semibold text-mist-100">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-1 text-[13.5px] font-semibold text-mist-100">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-1 text-[13px] font-semibold text-mist-100">{children}</h4>,
  h4: ({ children }) => <h4 className="text-[12.5px] font-semibold text-mist-100">{children}</h4>,
  strong: ({ children }) => <strong className="font-semibold text-mist-100">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="text-mist-500">{children}</del>,
  a: ({ href, children }) => {
    const video = href ? localVideoPath(href) : null;
    if (video) return <LocalVideo path={video} label={textOf(children)} />;
    return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-signal underline decoration-signal/40 underline-offset-2 hover:decoration-signal">
      {children}
    </a>
    );
  },
  ul: ({ children, className }) => (
    <ul className={className?.includes("contains-task-list") ? "flex flex-col gap-0.5 pl-1" : "flex list-disc flex-col gap-0.5 pl-5 marker:text-mist-500"}>{children}</ul>
  ),
  ol: ({ children, start }) => (
    <ol start={start} className="flex list-decimal flex-col gap-0.5 pl-5 marker:text-mist-500">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="break-words pl-0.5 [&>input]:mr-1.5 [&>input]:align-middle">{children}</li>,
  blockquote: ({ children }) => <blockquote className="border-l-2 border-mist-500/30 pl-3 text-mist-300">{children}</blockquote>,
  hr: () => <hr className="my-1 border-mist-500/15" />,
  pre: ({ children }) => (
    <pre className="scroll-thin overflow-x-auto rounded-lg border border-mist-500/12 bg-ink-950/70 px-2.5 py-2 font-mono text-[11.5px] leading-snug text-mist-100 [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  ),
  code: ({ children }) => <code className="rounded bg-ink-950/60 px-1 py-px font-mono text-[11.5px] text-mist-100">{children}</code>,
  table: ({ children }) => (
    <div className="scroll-thin overflow-x-auto rounded-lg border border-mist-500/12">
      <table className="w-full border-collapse text-[12px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-ink-850/80">{children}</thead>,
  th: ({ children, style }) => <th style={style} className="border-b border-mist-500/15 px-2 py-1.5 text-left font-semibold text-mist-100">{children}</th>,
  td: ({ children, style }) => <td style={style} className="border-b border-mist-500/8 px-2 py-1.5 align-top text-mist-300">{children}</td>,
  img: ({ src, alt }) => {
    const video = typeof src === "string" ? localVideoPath(src) : null;
    return video ? <LocalVideo path={video} label={alt ?? ""} /> : <MarkdownImage src={src} alt={alt} />;
  },
};

export const Markdown = memo(function Markdown({ text, sessionId = null }: { text: string; sessionId?: string | null }) {
  return (
    <SessionIdContext.Provider value={sessionId}>
    <div className="flex flex-col gap-2 text-[12.5px] leading-relaxed text-mist-100" data-kind="assistant">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={markdownUrl}>
        {text}
      </ReactMarkdown>
    </div>
    </SessionIdContext.Provider>
  );
});
