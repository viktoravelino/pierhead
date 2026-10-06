import { ArrowRight, X } from "lucide-react";
import type { ReactNode } from "react";
import type { BuilderProperty } from "../../../shared/operations";
import type { ResourceEntry, ResourceKind, ResourceValues } from "../../../shared/types";
import type { AppView } from "../../api/client";
import { operationAvailability } from "../../api/operations";
import {
  OperationButton,
  removeButton,
  textButton,
} from "../../components/OperationButton";
import { useRequestOperation, useWrites } from "../../components/OperationHost";
import { EmptyNote, Mono, Panel, RevisionStamp } from "../../components/ui";

const notSet = <span className="text-faint">not set</span>;

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="border-t border-line px-4 py-2.5 text-xs text-faint">{children}</p>
  );
}

const builderRows = [
  { property: "selected", label: "Builder", placeholder: "detected at deploy" },
  { property: "build-dir", label: "Build directory", placeholder: "repository root" },
  { property: "dockerfile-path", label: "Dockerfile path", placeholder: "Dockerfile" },
] as const satisfies readonly {
  property: BuilderProperty;
  label: string;
  placeholder: string;
}[];

function BuilderPanel({ app }: { app: AppView }) {
  const { builder } = app;
  const current = {
    selected: builder.selected,
    "build-dir": builder.buildDir,
    "dockerfile-path": builder.dockerfilePath,
  } as const satisfies Record<BuilderProperty, string | null>;
  return (
    <Panel
      title="Build"
      action={
        <OperationButton
          app={app}
          request={{ op: "ps:rebuild", app: app.name }}
          label="Rebuild"
          className={textButton}
        >
          Rebuild
        </OperationButton>
      }
    >
      <dl className="divide-y divide-line">
        {builderRows.map(({ property, label, placeholder }) => {
          const value = current[property];
          return (
            <div
              key={property}
              className="flex items-center justify-between gap-3 px-4 py-2.5"
            >
              <div className="min-w-0">
                <dt className="label">{label}</dt>
                <dd className="truncate">
                  {value ? (
                    <Mono>{value}</Mono>
                  ) : (
                    <span className="text-faint">{placeholder}</span>
                  )}
                </dd>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <OperationButton
                  app={app}
                  request={{
                    op: "builder:set",
                    app: app.name,
                    property,
                    value: value ?? "",
                  }}
                  label={`Edit ${label}`}
                  className={textButton}
                >
                  Edit
                </OperationButton>
                {value && (
                  <OperationButton
                    app={app}
                    request={{ op: "builder:set", app: app.name, property, value: "" }}
                    label={`Clear ${label}`}
                    className={removeButton}
                  >
                    <X className="size-4" aria-hidden="true" />
                  </OperationButton>
                )}
              </div>
            </div>
          );
        })}
        <div className="flex items-center justify-between gap-3 px-4 py-2.5">
          <div className="min-w-0">
            <dt className="label">Deploy branch</dt>
            <dd className="truncate">
              {app.git.deployBranch ? (
                <Mono>{app.git.deployBranch}</Mono>
              ) : (
                <span className="text-faint">
                  default
                  {app.git.computedDeployBranch && (
                    <>
                      {" "}
                      (<Mono>{app.git.computedDeployBranch}</Mono>)
                    </>
                  )}
                </span>
              )}
            </dd>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <OperationButton
              app={app}
              request={{
                op: "git:set",
                app: app.name,
                branch: app.git.deployBranch ?? "",
              }}
              label="Edit Deploy branch"
              className={textButton}
            >
              Edit
            </OperationButton>
            {app.git.deployBranch && (
              <OperationButton
                app={app}
                request={{ op: "git:set", app: app.name, branch: "" }}
                label="Clear Deploy branch"
                className={removeButton}
              >
                <X className="size-4" aria-hidden="true" />
              </OperationButton>
            )}
          </div>
        </div>
      </dl>
      <Note>Changes take effect on the next build. Rebuild applies them now.</Note>
    </Panel>
  );
}

/** What the app is running from, and the two ways to deploy something else onto it. */
function DeploySourcePanel({ app }: { app: AppView }) {
  const { revision, git } = app;
  return (
    <Panel
      title="Deploy source"
      action={
        <div className="flex gap-2">
          <OperationButton
            app={app}
            request={{ op: "git:from-image", app: app.name, image: "" }}
            label="Deploy an image"
            className={textButton}
          >
            Deploy image
          </OperationButton>
          <OperationButton
            app={app}
            request={{
              op: "git:sync",
              app: app.name,
              url: "",
              ref: "",
              build: true,
            }}
            label="Sync from git"
            className={textButton}
          >
            Sync from git
          </OperationButton>
        </div>
      }
    >
      <dl className="divide-y divide-line">
        <div className="px-4 py-2.5">
          <dt className="label">Image</dt>
          <dd>
            {git.sourceImage ? (
              <Mono>{git.sourceImage}</Mono>
            ) : (
              <span className="text-faint">none</span>
            )}
          </dd>
        </div>
        <div className="px-4 py-2.5">
          <dt className="label">Revision</dt>
          <dd className="flex flex-wrap items-baseline gap-x-2">
            {revision ? (
              <RevisionStamp revision={revision} />
            ) : (
              <span className="text-faint">No code yet</span>
            )}
          </dd>
        </div>
      </dl>
      <Note>
        Deploying replaces the running containers. A repository without "build now" is
        only fetched. Public sources only; private repositories need Dokku's own{" "}
        <Mono>git:auth</Mono>, which pierhead does not drive.
      </Note>
    </Panel>
  );
}

const describeValues = ({ memory, cpu }: ResourceValues) =>
  [memory, cpu && `${cpu} cpu`].filter(Boolean).join(" · ");

function ResourceCell({
  app,
  kind,
  processType,
  values,
}: {
  app: AppView;
  kind: ResourceKind;
  processType: string | null;
  values: ResourceValues;
}) {
  const label = `${kind === "limit" ? "limit" : "reservation"} for ${processType ?? "all process types"}`;
  const isSet = values.memory !== null || values.cpu !== null;
  return (
    <div className="flex items-center gap-1.5">
      <span className="min-w-0 grow truncate">
        {isSet ? <Mono>{describeValues(values)}</Mono> : notSet}
      </span>
      <OperationButton
        app={app}
        request={{
          op: "resource:set",
          app: app.name,
          kind,
          processType,
          memory: values.memory ?? "",
          cpu: values.cpu ?? "",
        }}
        label={`${isSet ? "Edit" : "Set"} ${label}`}
        className={textButton}
      >
        {isSet ? "Edit" : "Set"}
      </OperationButton>
      {isSet && (
        <OperationButton
          app={app}
          request={{ op: "resource:clear", app: app.name, kind, processType }}
          label={`Clear ${label}`}
          className={removeButton}
        >
          <X className="size-4" aria-hidden="true" />
        </OperationButton>
      )}
    </div>
  );
}

/** One row for every process type that has a formation entry or a setting, the default first. */
function resourceRows(app: AppView): ResourceEntry[] {
  const none: ResourceValues = { memory: null, cpu: null };
  const types = [
    ...new Set([
      ...app.formation.map((f) => f.type),
      ...app.resources.map((r) => r.processType),
    ]),
  ].filter((type) => type !== null);
  return [null, ...types.sort()].map(
    (processType) =>
      app.resources.find((r) => r.processType === processType) ?? {
        processType,
        limit: none,
        reserve: none,
      },
  );
}

function ResourcesPanel({ app }: { app: AppView }) {
  return (
    <Panel title="Resources">
      <div className="grid grid-cols-[minmax(5rem,0.6fr)_1fr_1fr] gap-px bg-line">
        {["Process type", "Limit", "Reservation"].map((heading) => (
          <span key={heading} className="label bg-panel px-4 py-2">
            {heading}
          </span>
        ))}
        {resourceRows(app).map((row) => (
          <div key={row.processType ?? "_default_"} className="contents">
            <span className="flex items-center bg-panel px-4 py-2.5">
              {row.processType ? (
                <Mono>{row.processType}</Mono>
              ) : (
                <span className="text-dim">All types</span>
              )}
            </span>
            <div className="bg-panel px-3 py-2">
              <ResourceCell
                app={app}
                kind="limit"
                processType={row.processType}
                values={row.limit}
              />
            </div>
            <div className="bg-panel px-3 py-2">
              <ResourceCell
                app={app}
                kind="reserve"
                processType={row.processType}
                values={row.reserve}
              />
            </div>
          </div>
        ))}
      </div>
      <Note>
        Limits cap what a container may use; a reservation is what Docker sets aside for
        it. Changes take effect on the next deploy.
      </Note>
    </Panel>
  );
}

function StoragePanel({ app }: { app: AppView }) {
  return (
    <Panel
      title="Storage"
      action={
        <OperationButton
          app={app}
          request={{ op: "storage:mount", app: app.name, name: "", containerPath: "" }}
          label="Add mount"
          className={textButton}
        >
          Add
        </OperationButton>
      }
    >
      {app.storage.length === 0 ? (
        <EmptyNote>No persistent storage is mounted.</EmptyNote>
      ) : (
        <ul className="divide-y divide-line">
          {app.storage.map(({ hostPath, containerPath, name }) => (
            <li
              key={`${hostPath}:${containerPath}`}
              className="flex items-center gap-3 px-4 py-2.5"
            >
              <Mono className="min-w-0 truncate text-dim" title={hostPath}>
                {name ?? hostPath}
              </Mono>
              <ArrowRight
                className="size-3.5 shrink-0 text-faint"
                aria-label="mounted at"
              />
              <Mono className="min-w-0 truncate">{containerPath}</Mono>
              {name === null ? (
                <span
                  className="ml-auto shrink-0 text-xs text-faint"
                  title="Only directories under /var/lib/dokku/data/storage are managed here."
                >
                  outside the storage root
                </span>
              ) : (
                <span className="ml-auto shrink-0">
                  <OperationButton
                    app={app}
                    request={{
                      op: "storage:unmount",
                      app: app.name,
                      name,
                      containerPath,
                      confirm: "",
                    }}
                    label={`Unmount ${containerPath}`}
                    className={removeButton}
                  >
                    <X className="size-4" aria-hidden="true" />
                  </OperationButton>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <Note>
        Persistent data lives in <Mono>/var/lib/dokku/data/storage/&lt;name&gt;</Mono> on
        the host and is not in Dokku's app state. Add new directories to the lab backup
        (homelab repo) before relying on them. Mounts apply on the next restart or deploy;
        unmounting never deletes the directory.
      </Note>
    </Panel>
  );
}

/** App settings: build, resources and storage, then the Danger zone, which holds the irreversible operations. */
export function SettingsTab({ app }: { app: AppView }) {
  const requestOperation = useRequestOperation();
  const writes = useWrites();
  const availability = operationAvailability("apps:destroy", app);
  const disabledReason = !writes.enabled
    ? writes.reason
    : !availability.ok
      ? availability.reason
      : undefined;

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      {app.partial && (
        <p role="status" className="text-pretty text-sm text-warn">
          Could not read {app.partial.join(", ")} from Dokku, so those panels may look
          empty. Reload to try again.
        </p>
      )}
      <DeploySourcePanel app={app} />
      <BuilderPanel app={app} />
      <ResourcesPanel app={app} />
      <StoragePanel app={app} />
      <Panel title="Danger zone" className="border-crit/40">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-4">
          <div className="flex min-w-0 flex-col gap-1">
            <h3 className="font-medium">Destroy this app</h3>
            <p className="max-w-[60ch] text-pretty text-dim">
              Removes <Mono>{app.name}</Mono> with its containers, image, config, domains
              and vhost. You will be asked to type its name. This cannot be undone.
            </p>
          </div>
          <button
            type="button"
            disabled={disabledReason !== undefined}
            title={disabledReason}
            onClick={() =>
              requestOperation({ op: "apps:destroy", app: app.name, confirm: "" })
            }
            className="h-9 rounded-sm border border-crit/40 px-3 font-medium text-crit enabled:hover:bg-crit/10 disabled:cursor-not-allowed disabled:opacity-45"
          >
            Destroy app
          </button>
        </div>
      </Panel>
    </div>
  );
}
