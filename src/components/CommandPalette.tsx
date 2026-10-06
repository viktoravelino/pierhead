import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Activity,
  Box,
  Copy,
  CornerDownLeft,
  Hammer,
  LayoutGrid,
  Network,
  Pencil,
  Play,
  Plus,
  RotateCw,
  Search,
  Server,
  Square,
} from "lucide-react";
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { operationAvailability, operationUi, psOperationIds } from "../api/operations";
import { appsQuery } from "../api/queries";
import { useRequestOperation, useWrites } from "./OperationHost";
import { Kbd } from "./ui";

type Item = {
  id: string;
  group: "Go to" | "Run";
  label: string;
  icon: ReactNode;
  run: () => void;
};

const psIcon = {
  "ps:start": <Play className="size-4" aria-hidden="true" />,
  "ps:restart": <RotateCw className="size-4" aria-hidden="true" />,
  "ps:rebuild": <Hammer className="size-4" aria-hidden="true" />,
  "ps:stop": <Square className="size-4" aria-hidden="true" />,
} as const satisfies Record<(typeof psOperationIds)[number], ReactNode>;

const pages = [
  { label: "Apps", to: "/", Icon: LayoutGrid },
  { label: "Networks", to: "/networks", Icon: Network },
  { label: "Activity", to: "/activity", Icon: Activity },
  { label: "Host", to: "/host", Icon: Server },
] as const;

/** Cmd/Ctrl+K palette: jump to a page or app, or start an app action (when writes are on). */
export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const requestOperation = useRequestOperation();
  const writes = useWrites();
  const { data: apps = [] } = useQuery(appsQuery);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setQuery("");
      setActive(0);
      dialog.showModal();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const pageItems = pages.map(
    ({ label, to, Icon }): Item => ({
      id: `page-${to}`,
      group: "Go to",
      label,
      icon: <Icon className="size-4" aria-hidden="true" />,
      run: () => void navigate({ to }),
    }),
  );

  const items: Item[] = [
    ...pageItems,
    ...apps.map((app) => ({
      id: `app-${app.name}`,
      group: "Go to" as const,
      label: `App ${app.name}`,
      icon: <Box className="size-4" aria-hidden="true" />,
      run: () => void navigate({ to: "/apps/$appName", params: { appName: app.name } }),
    })),
    // Operations are hidden, not disabled, while the server is read-only.
    ...(writes.enabled
      ? [
          {
            id: "apps-create",
            group: "Run" as const,
            label: "Add app",
            icon: <Plus className="size-4" aria-hidden="true" />,
            run: () => requestOperation({ op: "apps:create", app: "" }),
          },
        ]
      : []),
    // The dialog asks for the new name; rename also asks for the old one typed back.
    ...apps.flatMap((app) =>
      writes.enabled && operationAvailability("apps:clone", app).ok
        ? [
            {
              id: `apps-clone-${app.name}`,
              group: "Run" as const,
              label: `${operationUi["apps:clone"].label} ${app.name}`,
              icon: <Copy className="size-4" aria-hidden="true" />,
              run: () =>
                requestOperation({
                  op: "apps:clone",
                  app: app.name,
                  newName: "",
                  skipDeploy: true,
                }),
            },
            {
              id: `apps-rename-${app.name}`,
              group: "Run" as const,
              label: `${operationUi["apps:rename"].label} ${app.name}`,
              icon: <Pencil className="size-4" aria-hidden="true" />,
              run: () =>
                requestOperation({
                  op: "apps:rename",
                  app: app.name,
                  newName: "",
                  skipDeploy: false,
                  confirm: "",
                }),
            },
          ]
        : [],
    ),
    ...apps.flatMap((app) =>
      (writes.enabled ? psOperationIds : [])
        .filter((op) => operationAvailability(op, app).ok)
        .map((op) => ({
          id: `${op}-${app.name}`,
          group: "Run" as const,
          label: `${operationUi[op].label} ${app.name}`,
          icon: psIcon[op],
          run: () => requestOperation({ op, app: app.name }),
        })),
    ),
  ];

  const terms = query.toLowerCase().split(" ").filter(Boolean);
  const results = items.filter((item) =>
    terms.every((t) => item.label.toLowerCase().includes(t)),
  );
  const activeItem = results[Math.min(active, results.length - 1)];

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever the highlighted row or results change
  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active, query]);

  const choose = (item: Item) => {
    onClose();
    item.run();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (e.key === "Enter" && activeItem) {
      e.preventDefault();
      choose(activeItem);
    }
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a mouse convenience; Esc closes
    <dialog
      ref={dialogRef}
      aria-label="Command palette"
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      className="mx-auto mt-[12vh] w-[min(36rem,calc(100vw-1.5rem))] rounded-md border border-line-strong bg-raised p-0 shadow-2xl shadow-black/40"
    >
      <div className="flex items-center gap-2.5 border-b border-line px-4">
        <Search className="size-4 text-faint" aria-hidden="true" />
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={activeItem?.id}
          aria-label="Search apps and actions"
          placeholder="Jump to an app or run an action"
          className="h-12 flex-1 bg-transparent outline-none placeholder:text-faint"
        />
        <Kbd>esc</Kbd>
      </div>

      <div
        ref={listRef}
        id="palette-list"
        role="listbox"
        aria-label="Results"
        className="max-h-[50vh] overflow-y-auto p-1.5"
      >
        {results.length === 0 && (
          <div className="px-3 py-6 text-center text-dim">Nothing matches "{query}".</div>
        )}
        {results.map((item, i) => {
          const selected = item === activeItem;
          const newGroup = results[i - 1]?.group !== item.group;
          return (
            <Fragment key={item.id}>
              {newGroup && (
                <div role="presentation" className="label px-3 pt-2.5 pb-1">
                  {item.group}
                </div>
              )}
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard is handled on the combobox input */}
              <div
                id={item.id}
                role="option"
                tabIndex={-1}
                aria-selected={selected}
                onClick={() => choose(item)}
                onMouseMove={() => setActive(i)}
                className={`flex cursor-pointer items-center gap-3 rounded-sm px-3 py-2 ${
                  selected ? "bg-accent/15 text-fg" : "text-dim"
                }`}
              >
                <span className={selected ? "text-accent" : "text-faint"}>
                  {item.icon}
                </span>
                <span className="flex-1 truncate">{item.label}</span>
                {selected && (
                  <CornerDownLeft className="size-3.5 text-faint" aria-hidden="true" />
                )}
              </div>
            </Fragment>
          );
        })}
      </div>
    </dialog>
  );
}
