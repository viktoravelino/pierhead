import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  FlaskConical,
  LayoutGrid,
  Moon,
  Network,
  Search,
  Server,
  Sun,
} from "lucide-react";
import { useEffect, useState } from "react";
import { backendHealthQuery } from "../api/backend";
import { dataSource } from "../api/client";
import { hostQuery } from "../api/queries";
import { useTheme } from "../lib/theme";
import { CommandPalette } from "./CommandPalette";
import { OperationHost } from "./OperationHost";
import { ToastProvider } from "./Toast";
import { Kbd, Skeleton } from "./ui";

function BackendStatus() {
  const { data, isPending } = useQuery(backendHealthQuery);
  const text = isPending
    ? "Checking backend..."
    : data?.ok
      ? `Dokku v${data.dokku.version} connected`
      : "Backend offline";
  return (
    <div className="mt-1 flex flex-col items-start gap-1.5">
      <p className="font-mono text-[11px]">{text}</p>
      {data?.ok && !data.writesEnabled && (
        <span
          title="The server was started without PIERHEAD_ALLOW_WRITES=true, so actions are refused."
          className="rounded-sm border border-warn/50 px-1.5 font-mono text-[10px] font-medium uppercase tracking-wide text-warn"
        >
          read-only
        </span>
      )}
    </div>
  );
}

const allNav = [
  {
    label: "Apps",
    to: "/",
    Icon: LayoutGrid,
    isActive: (p: string) => p === "/" || p.startsWith("/apps"),
  },
  {
    label: "Networks",
    to: "/networks",
    Icon: Network,
    isActive: (p: string) => p.startsWith("/networks"),
  },
  {
    label: "Activity",
    to: "/activity",
    Icon: Activity,
    isActive: (p: string) => p.startsWith("/activity"),
  },
  {
    label: "Host",
    to: "/host",
    Icon: Server,
    isActive: (p: string) => p.startsWith("/host"),
  },
] as const;

// Activity has no real data source yet.
const nav = allNav.filter((item) => dataSource === "mock" || item.to !== "/activity");

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

function Brand() {
  const { data: host } = useQuery(hostQuery);
  return (
    <Link to="/" className="flex items-center gap-2.5">
      <img src="/icon.svg" alt="" className="size-7" />
      <span className="flex flex-col leading-tight">
        <span className="text-[15px] font-semibold tracking-tight">pierhead</span>
        {host ? (
          <span className="whitespace-nowrap font-mono text-[10.5px] text-faint">
            dokku @ {host.address ?? host.name}
          </span>
        ) : (
          <Skeleton className="mt-0.5 h-2.5 w-24" />
        )}
      </span>
    </Link>
  );
}

/** App frame: sidebar on desktop, top bar plus bottom tab bar on phones. */
export function Shell() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { theme, toggle } = useTheme();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  return (
    <ToastProvider>
      <OperationHost>
        <div className="grid min-h-dvh md:grid-cols-[14.5rem_minmax(0,1fr)]">
          <aside className="sticky top-0 hidden h-dvh flex-col gap-6 border-r border-line bg-panel px-3 py-4 md:flex">
            <div className="px-2">
              <Brand />
            </div>
            <nav aria-label="Primary" className="flex flex-col gap-0.5">
              {nav.map(({ label, to, Icon, isActive }) => {
                const active = isActive(pathname);
                return (
                  <Link
                    key={to}
                    to={to}
                    aria-current={active ? "page" : undefined}
                    className={`flex h-9 items-center gap-2.5 rounded-sm px-2.5 font-medium ${
                      active
                        ? "bg-accent/15 text-fg"
                        : "text-dim hover:bg-raised hover:text-fg"
                    }`}
                  >
                    <Icon
                      className={`size-4 ${active ? "text-accent" : ""}`}
                      aria-hidden="true"
                    />
                    {label}
                  </Link>
                );
              })}
            </nav>
            <div className="mt-auto flex items-start gap-2 rounded-sm border border-dashed border-line-strong px-2.5 py-2 text-xs text-dim">
              <FlaskConical
                className="mt-0.5 size-3.5 shrink-0 text-warn"
                aria-hidden="true"
              />
              <div>
                {dataSource === "api" ? (
                  <p>
                    Live from Dokku: apps, networks, host settings, logs and config. Live
                    from Glances: host CPU, memory and disk, when configured. Actions and
                    config changes run on Dokku when the server allows writes.
                  </p>
                ) : (
                  <p>Design preview. All data is mocked; nothing reaches the host.</p>
                )}
                <BackendStatus />
              </div>
            </div>
          </aside>

          <div className="flex min-w-0 flex-col pb-16 md:pb-0">
            <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-bg/90 px-4 backdrop-blur-sm md:px-8">
              <div className="md:hidden">
                <Brand />
              </div>
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                className="ml-auto flex h-9 items-center gap-2.5 rounded-sm border border-line-strong bg-panel px-3 text-dim hover:text-fg md:ml-0 md:w-80"
              >
                <Search className="size-4" aria-hidden="true" />
                <span className="hidden flex-1 whitespace-nowrap text-left md:inline">
                  Search apps and actions
                </span>
                <span className="sr-only md:hidden">Search</span>
                <span className="hidden items-center gap-0.5 md:flex">
                  <Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd>
                  <Kbd>K</Kbd>
                </span>
              </button>
              <button
                type="button"
                onClick={toggle}
                aria-label={
                  theme === "dark" ? "Switch to light theme" : "Switch to dark theme"
                }
                className="grid size-9 place-items-center rounded-sm border border-line-strong bg-panel text-dim hover:text-fg md:ml-auto"
              >
                {theme === "dark" ? (
                  <Sun className="size-4" />
                ) : (
                  <Moon className="size-4" />
                )}
              </button>
            </header>

            <main className="mx-auto flex w-full max-w-[84rem] flex-1 flex-col gap-6 px-4 py-6 md:px-8">
              <Outlet />
            </main>
          </div>
        </div>

        <nav
          aria-label="Primary"
          className="fixed inset-x-0 bottom-0 z-30 grid auto-cols-fr grid-flow-col border-t border-line bg-panel md:hidden"
        >
          {nav.map(({ label, to, Icon, isActive }) => {
            const active = isActive(pathname);
            return (
              <Link
                key={to}
                to={to}
                aria-current={active ? "page" : undefined}
                className={`flex h-14 flex-col items-center justify-center gap-0.5 text-xs font-medium ${
                  active ? "text-accent" : "text-dim"
                }`}
              >
                <Icon className="size-4.5" aria-hidden="true" />
                {label}
              </Link>
            );
          })}
        </nav>

        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      </OperationHost>
    </ToastProvider>
  );
}
