import { ExternalLink } from "lucide-react";

/** sslip.io hosts have no TLS on the LAN; anything else is assumed to be served over https. */
const domainUrl = (host: string) =>
  `${host.endsWith(".sslip.io") ? "http" : "https"}://${host}`;

export function DomainLink({ host }: { host: string }) {
  return (
    <a
      href={domainUrl(host)}
      target="_blank"
      rel="noopener noreferrer"
      className="group inline-flex max-w-full items-center gap-1.5 font-mono text-[0.92em] text-fg hover:text-accent"
    >
      <span className="truncate underline decoration-line-strong underline-offset-4 group-hover:decoration-accent">
        {host}
      </span>
      <ExternalLink
        className="size-3 shrink-0 text-faint group-hover:text-accent"
        aria-hidden="true"
      />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}
