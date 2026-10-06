import { Link } from "@tanstack/react-router";
import { dataSource } from "../api/client";
import { ActivityFeed } from "../components/ActivityFeed";
import { AppsList } from "../components/AppsList";
import { BackupTile } from "../components/BackupTile";
import { HostStrip } from "../components/HostStrip";
import { Panel } from "../components/ui";

export function OverviewPage() {
  // Backups and activity have no real data source yet, so only the mocks show them.
  return (
    <>
      <HostStrip />
      {dataSource === "api" ? (
        <AppsList />
      ) : (
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <AppsList />
          <div className="flex flex-col gap-6">
            <BackupTile />
            <Panel
              title="Recent activity"
              action={
                <Link
                  to="/activity"
                  className="text-xs font-medium text-accent hover:underline"
                >
                  View all
                </Link>
              }
            >
              <ActivityFeed limit={7} />
            </Panel>
          </div>
        </div>
      )}
    </>
  );
}
