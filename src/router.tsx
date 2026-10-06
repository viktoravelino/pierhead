import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Shell } from "./components/Shell";
import { ActivityPage } from "./pages/ActivityPage";
import { AppPage, type AppTab, appTabs } from "./pages/AppPage";
import { NetworksPage } from "./pages/NetworksPage";
import { OverviewPage } from "./pages/OverviewPage";
import { SettingsPage } from "./pages/SettingsPage";

const rootRoute = createRootRoute({ component: Shell });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: OverviewPage,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/apps/$appName",
  validateSearch: (search): { tab?: AppTab } => ({
    tab: appTabs.find((t) => t === search.tab),
  }),
  component: function AppRoute() {
    const { appName } = appRoute.useParams();
    const { tab = "overview" } = appRoute.useSearch();
    return <AppPage appName={appName} tab={tab} />;
  },
});

const networksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/networks",
  component: NetworksPage,
});

const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/activity",
  component: ActivityPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  appRoute,
  networksRoute,
  activityRoute,
  settingsRoute,
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
