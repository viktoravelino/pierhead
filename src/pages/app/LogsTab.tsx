import { ArrowDownToLine, Pause, Play, RotateCw, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { LogLine } from "../../../shared/types";
import { type AppView, subscribeToLogs } from "../../api/client";
import { EmptyNote, Panel } from "../../components/ui";
import { clockTime } from "../../lib/time";

const maxLines = 2000;

/** Level glyph and colour for lines that signal trouble, so it is not colour alone. */
function lineLevel(line: string) {
  if (/panic|exit status|error|fatal/i.test(line))
    return { tag: "ERR", cls: "text-crit" } as const;
  if (/warn|rate limit| 4\d\d /i.test(line))
    return { tag: "WRN", cls: "text-warn" } as const;
  return null;
}

/** Colours the HTTP status code in an access-log style message. */
function Message({ text }: { text: string }) {
  const match = text.match(/^(.*?" )(\d{3})(.*)$/);
  if (!match) return <>{text}</>;
  const [, before, code, after] = match;
  const n = Number(code);
  const cls =
    n >= 500 ? "text-crit" : n >= 400 ? "text-warn" : n >= 300 ? "text-dim" : "text-ok";
  return (
    <>
      {before}
      <span className={cls}>{code}</span>
      {after}
    </>
  );
}

const statusLabel = (paused: boolean, status: StreamStatus) =>
  status.kind === "error"
    ? `Error: ${status.message}`
    : status.kind === "ended"
      ? "Ended"
      : paused
        ? "Paused"
        : "Live";

const dotClass = (paused: boolean, status: StreamStatus) =>
  status.kind === "error"
    ? "bg-crit"
    : status.kind === "ended" || paused
      ? "bg-idle"
      : "animate-signal bg-ok";

/** `ended` is a stream that finished on its own; `error` one that failed. */
type StreamStatus =
  | { kind: "live" }
  | { kind: "ended" }
  | { kind: "error"; message: string };

/**
 * Follows the app's logs into a bounded buffer. Pausing keeps the connection open and
 * holds new lines back until resume; `reconnect` starts over (the server replays recent
 * history, so the buffer is cleared first). It never reconnects on its own.
 */
function useLogStream(app: AppView, paused: boolean) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<StreamStatus>({ kind: "live" });
  const [attempt, setAttempt] = useState(0);
  const held = useRef<LogLine[]>([]);
  const pausedRef = useRef(paused);
  const nextId = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` restarts the stream; `app` is polled and must not (only its name matters)
  useEffect(() => {
    held.current = [];
    setLines([]);
    setStatus({ kind: "live" });
    return subscribeToLogs(app, {
      onLines: (events) => {
        const incoming = events.map((e) => ({ ...e, id: `log-${nextId.current++}` }));
        if (pausedRef.current) {
          held.current = [...held.current, ...incoming].slice(-maxLines);
        } else {
          setLines((all) => [...all, ...incoming].slice(-maxLines));
        }
      },
      onEnd: (end) =>
        setStatus(
          end.kind === "exited"
            ? { kind: "ended" }
            : { kind: "error", message: end.message },
        ),
    });
  }, [app.name, attempt]);

  // Resuming flushes what arrived while paused.
  useEffect(() => {
    pausedRef.current = paused;
    if (paused || held.current.length === 0) return;
    const flushed = held.current;
    held.current = [];
    setLines((all) => [...all, ...flushed].slice(-maxLines));
  }, [paused]);

  return { lines, status, reconnect: () => setAttempt((n) => n + 1) };
}

function LogViewer({ app }: { app: AppView }) {
  const [paused, setPaused] = useState(false);
  const { lines, status, reconnect } = useLogStream(app, paused);
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState("");
  const [processFilter, setProcessFilter] = useState("all");
  const scroller = useRef<HTMLDivElement>(null);

  const needle = filter.trim().toLowerCase();
  const visible = lines.filter(
    (l) =>
      (processFilter === "all" || l.process === processFilter) &&
      l.line.toLowerCase().includes(needle),
  );

  // Keep the newest line in view while following.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run whenever the visible set changes
  useEffect(() => {
    const el = scroller.current;
    if (follow && el) el.scrollTop = el.scrollHeight;
  }, [visible.length, follow]);

  return (
    <div className="overflow-hidden rounded-md border border-line bg-panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-2.5">
        <label className="flex h-8 min-w-48 flex-1 items-center gap-2 rounded-sm border border-line-strong bg-sunken px-2.5 focus-within:outline-2 focus-within:outline-accent">
          <Search className="size-3.5 text-faint" aria-hidden="true" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter lines"
            aria-label="Filter log lines"
            className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:font-sans placeholder:text-faint"
          />
        </label>
        <select
          value={processFilter}
          onChange={(e) => setProcessFilter(e.target.value)}
          aria-label="Filter by process"
          className="h-8 rounded-sm border border-line-strong bg-sunken px-2 font-mono text-xs"
        >
          <option value="all">all processes</option>
          {app.processes.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setFollow((f) => !f)}
          aria-pressed={follow}
          className={`flex h-8 items-center gap-1.5 rounded-sm border px-2.5 text-xs font-medium ${
            follow
              ? "border-accent/50 bg-accent/15 text-fg"
              : "border-line-strong text-dim hover:text-fg"
          }`}
        >
          <ArrowDownToLine className="size-3.5" aria-hidden="true" />
          Follow
        </button>
        <button
          type="button"
          onClick={() => setPaused((p) => !p)}
          className="flex h-8 items-center gap-1.5 rounded-sm border border-line-strong px-2.5 text-xs font-medium hover:bg-raised"
        >
          {paused ? (
            <Play className="size-3.5" aria-hidden="true" />
          ) : (
            <Pause className="size-3.5" aria-hidden="true" />
          )}
          {paused ? "Resume" : "Pause"}
        </button>
      </div>

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region must be keyboard reachable
        tabIndex={0}
        role="log"
        aria-label={`Logs for ${app.name}`}
        className="h-[min(60vh,34rem)] overflow-auto bg-sunken py-1 font-mono text-xs leading-5"
      >
        {visible.length === 0 && (
          <p className="px-4 py-6 font-sans text-sm text-dim">
            {lines.length === 0
              ? "No output yet."
              : "No lines match the current filters."}
          </p>
        )}
        {visible.map((l) => {
          const level = lineLevel(l.line);
          return (
            <div key={l.id} className="flex gap-3 px-3 whitespace-pre hover:bg-raised">
              <time dateTime={l.ts} className="tabular shrink-0 text-faint">
                {clockTime(l.ts)}
              </time>
              <span className="w-14 shrink-0 text-accent">{l.process}</span>
              <span className={`w-7 shrink-0 font-medium ${level?.cls ?? ""}`}>
                {level?.tag}
              </span>
              <span className={level?.cls}>
                <Message text={l.line} />
              </span>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-2 text-xs text-dim">
        <span className="inline-flex items-center gap-2">
          <span
            aria-hidden="true"
            className={`size-1.5 rounded-full ${dotClass(paused, status)}`}
          />
          {statusLabel(paused, status)}
          {status.kind !== "live" && (
            <button
              type="button"
              onClick={reconnect}
              className="flex items-center gap-1 rounded-sm border border-line-strong px-2 py-0.5 font-medium text-fg hover:bg-raised"
            >
              <RotateCw className="size-3" aria-hidden="true" />
              Reconnect
            </button>
          )}
        </span>
        <span className="tabular">
          {visible.length} of {lines.length} lines
        </span>
      </div>
    </div>
  );
}

export function LogsTab({ app }: { app: AppView }) {
  if (app.status.kind === "not-deployed") {
    return (
      <Panel title="Logs">
        <EmptyNote>No logs. This app has never been deployed.</EmptyNote>
      </Panel>
    );
  }
  return <LogViewer app={app} />;
}
