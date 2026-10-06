import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { networksQuery } from "../api/queries";
import { SampleNotice } from "../components/SampleNotice";
import { Mono, PageHeader, Panel, Skeleton } from "../components/ui";

export function NetworksPage() {
  const { data, isPending } = useQuery(networksQuery);
  return (
    <>
      <PageHeader
        title="Networks"
        subtitle="Docker networks on the host. Apps on the same network reach each other by alias."
      />
      <SampleNotice>
        Networks are not read from the host yet. See an app's Domains & Network tab for
        its real attachments.
      </SampleNotice>
      {isPending || !data ? (
        <Skeleton className="h-40 w-full max-w-3xl" />
      ) : (
        <div className="grid max-w-5xl gap-6 lg:grid-cols-2">
          {data.map((net) => (
            <Panel key={net.name} title={net.driver}>
              <div className="flex flex-col gap-4 p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="font-mono text-lg font-medium">{net.name}</h2>
                  <Mono className="text-faint">{net.subnet}</Mono>
                </div>
                <ul className="divide-y divide-line rounded-sm border border-line">
                  {net.members.map((m) => (
                    <li
                      key={m.app}
                      className="flex items-center justify-between gap-3 px-3 py-2"
                    >
                      <Link
                        to="/apps/$appName"
                        params={{ appName: m.app }}
                        search={{ tab: "network" }}
                        className="font-mono hover:text-accent hover:underline"
                      >
                        {m.app}
                      </Link>
                      {m.alias ? (
                        <span className="text-xs text-dim">
                          alias <Mono className="text-fg">{m.alias}</Mono>
                        </span>
                      ) : (
                        <span className="text-xs text-faint">no alias</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            </Panel>
          ))}
        </div>
      )}
    </>
  );
}
