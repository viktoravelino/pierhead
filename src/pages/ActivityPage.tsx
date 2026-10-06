import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { dataSource } from "../api/client";
import { appsQuery } from "../api/queries";
import { ActivityFeed } from "../components/ActivityFeed";
import { inputClass } from "../components/FormControls";
import { PageHeader, Panel } from "../components/ui";

/** The most rows the server returns; the Overview feed keeps the default 50 and shows 7. */
const pageLimit = 500;

export function ActivityPage() {
  const [app, setApp] = useState("");
  const { data: apps = [] } = useQuery(appsQuery);
  return (
    <>
      <PageHeader
        title="Activity"
        subtitle={
          dataSource === "api"
            ? "What pierhead did to the host, merged with the builds and deploys Dokku recorded, newest first."
            : "Deploys, restarts and stops across the host, newest first."
        }
        actions={
          <label className="flex items-center gap-2">
            <span className="label">App</span>
            <select
              value={app}
              onChange={(e) => setApp(e.target.value)}
              className={`${inputClass} w-48`}
            >
              <option value="">All apps</option>
              {apps.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        }
      />
      <Panel title="Events" className="max-w-3xl">
        <ActivityFeed app={app === "" ? undefined : app} limit={pageLimit} />
      </Panel>
    </>
  );
}
