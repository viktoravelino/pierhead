import { dataSource } from "../api/client";
import { ActivityFeed } from "../components/ActivityFeed";
import { PageHeader, Panel } from "../components/ui";

export function ActivityPage() {
  if (dataSource === "api") {
    return (
      <PageHeader title="Activity" subtitle="No activity source is connected yet." />
    );
  }
  return (
    <>
      <PageHeader
        title="Activity"
        subtitle="Deploys, restarts, stops and backup runs across the host, newest first."
      />
      <Panel title="Events" className="max-w-3xl">
        <ActivityFeed />
      </Panel>
    </>
  );
}
