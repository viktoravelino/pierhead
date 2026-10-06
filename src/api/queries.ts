import { queryOptions } from "@tanstack/react-query";
import {
  type AppView,
  getActivity,
  getApp,
  getApps,
  getBackup,
  getConfig,
  getDeploys,
  getHost,
  getHostDetails,
  getHostMetrics,
  getNetworks,
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
export const activityQuery = queryOptions({
  queryKey: ["activity"],
  queryFn: getActivity,
});
export const backupQuery = queryOptions({ queryKey: ["backup"], queryFn: getBackup });
export const networksQuery = queryOptions({
  queryKey: ["networks"],
  queryFn: getNetworks,
  ...poll,
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
export const configQuery = (app: AppView) =>
  queryOptions({ queryKey: ["apps", app.name, "config"], queryFn: () => getConfig(app) });
