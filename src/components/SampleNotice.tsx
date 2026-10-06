import { FlaskConical } from "lucide-react";
import type { ReactNode } from "react";
import { dataSource } from "../api/client";

/** Flags a section as placeholder data when the rest of the UI is live. Silent in mock mode. */
export function SampleNotice({
  title = "Sample data.",
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  if (dataSource === "mock") return null;
  return (
    <div
      role="note"
      className="flex items-start gap-2.5 rounded-sm border border-dashed border-line-strong px-3 py-2.5 text-dim"
    >
      <FlaskConical className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
      <p className="text-pretty">
        <strong className="font-semibold text-fg">{title}</strong> {children}
      </p>
    </div>
  );
}
