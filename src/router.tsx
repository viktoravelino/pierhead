import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { Shell } from "./components/Shell";
import { ActivityPage } from "./pages/ActivityPage";
import { AppPage, type AppTab, appTabs } from "./pages/AppPage";
import { HostPage } from "./pages/HostPage";
import { NetworksPage } from "./pages/NetworksPage";
import { OverviewPage } from "./pages/OverviewPage";
import { ServicesPage } from "./pages/ServicesPage";

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

const servicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/services",
  component: ServicesPage,
});

const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/activity",
  component: ActivityPage,
});

const hostRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/host",
  component: HostPage,
});

// The page was "Settings" before it showed the real host.
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  beforeLoad: () => {
    throw redirect({ to: "/host", replace: true });
  },
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  appRoute,
  networksRoute,
  servicesRoute,
  activityRoute,
  hostRoute,
  settingsRoute,
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
