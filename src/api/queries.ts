import { queryOptions } from "@tanstack/react-query";
import {
  type AppView,
  getActivity,
  getApp,
  getApps,
  getBackup,
  getBuildOutput,
  getBuilds,
  getConfig,
  getDeploys,
  getHost,
  getHostDetails,
  getHostMetrics,
  getNetworks,
  getServices,
  getStorageUsers,
} from "./client";

// Live app state is polled; TanStack pauses the interval while the tab is hidden. Failures
// surface as error states rather than retries, and polling carries on to recover.
const poll = {
  refetchInterval: 10_000,
  refetchIntervalInBackground: false,
  retry: false,
} as const;

export const hostQuery = queryOptions({ queryKey: ["host"], queryFn: getHost, ...poll });
// Glances is sampled every 5s server-side; poll at the same pace.
export const hostMetricsQuery = queryOptions({
  queryKey: ["host", "metrics"],
  queryFn: getHostMetrics,
  ...poll,
  refetchInterval: 5_000,
});
export const appsQuery = queryOptions({ queryKey: ["apps"], queryFn: getApps, ...poll });
/** Newest-first activity for the host, or for one app; the server sends 50 rows unless `limit` says more. */
export const activityQuery = (app?: string, limit?: number) =>
  queryOptions({
    queryKey: ["activity", app ?? null, limit ?? null],
    queryFn: () => getActivity(app, limit),
    ...poll,
  });
export const backupQuery = queryOptions({ queryKey: ["backup"], queryFn: getBackup });
export const networksQuery = queryOptions({
  queryKey: ["networks"],
  queryFn: getNetworks,
  ...poll,
});
export const servicesQuery = queryOptions({
  queryKey: ["services"],
  queryFn: getServices,
  ...poll,
});
export const storageUsersQuery = queryOptions({
  queryKey: ["storage"],
  queryFn: getStorageUsers,
  retry: false,
});
// The server caches this for 60s, so polling faster only repeats the same answer.
export const hostDetailsQuery = queryOptions({
  queryKey: ["host", "details"],
  queryFn: getHostDetails,
  ...poll,
  refetchInterval: 60_000,
});

export const appQuery = (name: string) =>
  queryOptions({ queryKey: ["apps", name], queryFn: () => getApp(name), ...poll });
export const deploysQuery = (name: string) =>
  queryOptions({ queryKey: ["apps", name, "deploys"], queryFn: () => getDeploys(name) });
export const buildsQuery = (name: string) =>
  queryOptions({
    queryKey: ["apps", name, "builds"],
    queryFn: () => getBuilds(name),
    ...poll,
  });
export const buildOutputQuery = (name: string, id: string) =>
  queryOptions({
    queryKey: ["apps", name, "builds", id, "output"],
    queryFn: () => getBuildOutput(name, id),
    // A finished log does not change; a running one is read again.
    staleTime: 0,
    retry: false,
  });
export const configQuery = (app: AppView) =>
  queryOptions({ queryKey: ["apps", app.name, "config"], queryFn: () => getConfig(app) });
