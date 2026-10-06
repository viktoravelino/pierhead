import { Lock } from "lucide-react";
import { SampleNotice } from "../components/SampleNotice";
import { Mono, PageHeader, Panel } from "../components/ui";

const groups = [
  {
    title: "Host",
    rows: [
      ["Hostname", "dokku"],
      ["Address", "192.168.2.13"],
      ["Global domain", "192.168.2.13.sslip.io"],
      ["SSH remote", "dokku@192.168.2.13"],
    ],
  },
  {
    title: "Defaults for new apps",
    rows: [
      ["Restart policy", "on-failure:10"],
      ["Proxy", "enabled (nginx)"],
      ["Builder", "Dockerfile when present, else buildpack"],
    ],
  },
  {
    title: "Backups",
    rows: [
      ["Schedule", "Nightly at 04:45"],
      ["Tool", "restic to Cloudflare R2"],
      ["Retention", "7 daily, 4 weekly, 6 monthly"],
    ],
  },
] as const;

export function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Host-wide configuration. Read-only in this preview."
      />
      <SampleNotice>This host's settings are not read from Dokku yet.</SampleNotice>
      <div className="grid max-w-5xl gap-6 lg:grid-cols-2">
        {groups.map((group) => (
          <Panel
            key={group.title}
            title={group.title}
            action={<Lock className="size-3.5 text-faint" aria-label="Read-only" />}
          >
            <dl className="divide-y divide-line">
              {group.rows.map(([k, v]) => (
                <div
                  key={k}
                  className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-0.5 px-4 py-2.5"
                >
                  <dt className="text-dim">{k}</dt>
                  <dd>
                    <Mono>{v}</Mono>
                  </dd>
                </div>
              ))}
            </dl>
          </Panel>
        ))}
      </div>
    </>
  );
}
