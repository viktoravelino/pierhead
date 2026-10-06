import type { ReactNode } from "react";
import type { Revision } from "../../shared/types";
import { describeError } from "../api/backend";
import { relativeTime } from "../lib/time";
import { Signal } from "./Signal";

/** Bordered section with a small-caps title and an optional right-hand slot. */
export function Panel({
  title,
  action,
  children,
  className = "",
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-md border border-line bg-panel ${className}`}>
      <header className="flex min-h-10 items-center justify-between gap-3 border-b border-line px-4 py-2">
        <h2 className="label">{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div aria-hidden="true" className={`animate-pulse rounded-sm bg-line ${className}`} />
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-sm border border-line-strong bg-sunken px-1 font-mono text-[10px] leading-4 text-dim">
      {children}
    </kbd>
  );
}

/** Inline monospace token for machine data (names, revs, CIDs). */
export function Mono({
  children,
  className = "",
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span title={title} className={`font-mono text-[0.92em] ${className}`}>
      {children}
    </span>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-balance text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="max-w-[65ch] text-dim">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-center text-dim">{children}</p>;
}

/** Short sha with the full one on hover, then when Dokku last updated the source. */
export function RevisionStamp({ revision }: { revision: Revision }) {
  return (
    <>
      <Mono title={revision.sha} className="text-fg">
        {revision.sha.slice(0, 7)}
      </Mono>
      {revision.updatedAt && (
        <time
          dateTime={revision.updatedAt}
          title={new Date(revision.updatedAt).toLocaleString()}
          className="text-faint"
        >
          updated {relativeTime(revision.updatedAt)}
        </time>
      )}
    </>
  );
}

/** A failed query: the error kind and message, with a retry. Sits inside a Panel. */
export function ErrorNote({
  error,
  onRetry,
  retrying,
}: {
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
}) {
  const { kind, message } = describeError(error);
  return (
    <div role="alert" className="flex flex-col items-start gap-3 p-4">
      <Signal tone="crit" label={kind} />
      <p className="text-pretty">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="h-9 rounded-sm border border-line-strong px-3 font-medium hover:bg-raised disabled:opacity-60"
      >
        {retrying ? "Retrying..." : "Retry"}
      </button>
    </div>
  );
}
