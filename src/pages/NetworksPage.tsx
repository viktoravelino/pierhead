import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import type { Network } from "../../shared/types";
import { networksQuery } from "../api/queries";
import { OperationButton, textButton } from "../components/OperationButton";
import {
  EmptyNote,
  ErrorNote,
  Mono,
  PageHeader,
  Panel,
  Skeleton,
} from "../components/ui";

/** Why a network cannot be destroyed from here, if it cannot (the server checks again). */
function keepReason(net: Network) {
  if (!net.dokkuManaged) return "Not created through Dokku, so pierhead leaves it alone.";
  if (net.members.length > 0) {
    return `Still used by ${net.members.map((m) => m.app).join(", ")}. Detach it there first.`;
  }
  return undefined;
}

function NetworkPanel({ net }: { net: Network }) {
  const tags = [
    net.dokkuManaged ? "managed by Dokku" : null,
    net.internal ? "internal" : null,
    `${net.scope} scope`,
  ].filter(Boolean);
  return (
    <Panel
      title={net.driver}
      action={
        <OperationButton
          request={{ op: "network:destroy", network: net.name, confirm: "" }}
          disabledReason={keepReason(net)}
          label={`Destroy ${net.name}`}
          className={textButton}
        >
          Destroy
        </OperationButton>
      }
    >
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-0.5">
          <h2 className="break-all font-mono text-lg font-medium">{net.name}</h2>
          <p className="text-xs text-faint">{tags.join(" · ")}</p>
        </div>
        {net.members.length === 0 ? (
          <p className="text-dim">No app is attached through Dokku.</p>
        ) : (
          <ul className="divide-y divide-line rounded-sm border border-line">
            {net.members.map((m) => (
              <li
                key={m.app}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3 py-2"
              >
                <Link
                  to="/apps/$appName"
                  params={{ appName: m.app }}
                  search={{ tab: "network" }}
                  className="font-mono hover:text-accent hover:underline"
                >
                  {m.app}
                </Link>
                <Mono className="text-xs text-dim">{m.via.join(", ")}</Mono>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

export function NetworksPage() {
  const { data, error, isPending, isFetching, refetch } = useQuery(networksQuery);
  return (
    <>
      <PageHeader
        title="Networks"
        subtitle="Docker networks on the host and the apps Dokku attaches to them. Apps that set no network use Docker's default bridge, which Dokku does not report."
        actions={
          <OperationButton
            request={{ op: "network:create", network: "" }}
            label="Create network"
            className={`${textButton} flex items-center gap-1.5`}
          >
            <Plus className="size-3.5" aria-hidden="true" />
            Create network
          </OperationButton>
        }
      />
      {error ? (
        <Panel title="Networks" className="max-w-3xl">
          <ErrorNote error={error} onRetry={() => void refetch()} retrying={isFetching} />
        </Panel>
      ) : isPending || !data ? (
        <Skeleton className="h-40 w-full max-w-3xl" />
      ) : data.length === 0 ? (
        <Panel title="Networks" className="max-w-3xl">
          <EmptyNote>Docker reports no networks on this host.</EmptyNote>
        </Panel>
      ) : (
        <div className="grid max-w-5xl gap-6 lg:grid-cols-2">
          {data.map((net) => (
            <NetworkPanel key={net.name} net={net} />
          ))}
        </div>
      )}
    </>
  );
}
