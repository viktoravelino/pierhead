import { Check, Copy } from "lucide-react";
import { useState } from "react";

export const iconButton =
  "grid size-8 place-items-center rounded-sm border border-line-strong text-dim hover:bg-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-dim";

/** Copies `value` to the clipboard and shows a check for a moment; `name` labels it for screen readers. */
export function CopyButton({ name, value }: { name: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      aria-label={`Copy ${name}`}
      title="Copy value"
      className={iconButton}
    >
      {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
    </button>
  );
}
