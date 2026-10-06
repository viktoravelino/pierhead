import { parseReport } from "../shared/parse";
import { parseServiceInfo, parseServices, parseServiceTypes } from "../shared/services";
import type { AppDetail, Service, ServiceGroup } from "../shared/types";
import { type Outcome, outcome, stdoutOf } from "./apps";
import { type DokkuRun, knownServiceTypes } from "./dokku";

/**
 * The installed service plugins (`plugin:list`), which also tells the runner which types
 * may become a command; every read and every operation on a service starts here.
 */
async function discover(dokku: DokkuRun) {
  const types = parseServiceTypes(stdoutOf(await dokku("plugin:list")));
  knownServiceTypes.replace(types.map((t) => t.type));
  return types;
}

export const readServiceTypes = (dokku: DokkuRun) => outcome(() => discover(dokku));

/**
 * Every service of every installed service plugin: `plugin:list`, then one `<type>:info`
 * per plugin (it prints all of its services at once). A plugin whose read fails keeps its
 * group with the reason instead of failing the others.
 */
export const listServices = (dokku: DokkuRun) =>
  outcome<ServiceGroup[]>(async () => {
    const types = await discover(dokku);
    return Promise.all(
      types.map(async ({ type, version }): Promise<ServiceGroup> => {
        const group = { type, pluginVersion: version };
        const result = await dokku("service:info", type);
        if (!result.ok) {
          return { ...group, services: [], error: result.error.message };
        }
        try {
          return { ...group, services: parseServices(type, result.stdout) };
        } catch (e) {
          return {
            ...group,
            services: [],
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }),
    );
  });

/** One service, read live. Dokku says `service <name> does not exist` (exit 1) for an unknown one. */
export const getService = (dokku: DokkuRun, type: string, name: string) =>
  outcome<Service>(async () =>
    parseServiceInfo(
      type,
      parseReport(stdoutOf(await dokku("service:info", type, name))),
    ),
  );

/**
 * The app's detail with the services linked to it, from the batched services read (one
 * `info` per plugin, not one `app-links` per plugin and app). A read that failed leaves
 * the list as far as it got and says so in `partial`.
 */
export function withServices(
  detail: AppDetail,
  groups: Outcome<ServiceGroup[]>,
): AppDetail {
  const found = groups.ok ? groups.value : [];
  const services = found.flatMap((group) =>
    group.services
      .filter((service) => service.apps.includes(detail.name))
      .map(({ type, name }) => ({ type, name })),
  );
  const incomplete = !groups.ok || found.some((group) => group.error !== undefined);
  return {
    ...detail,
    services,
    ...(incomplete ? { partial: [...(detail.partial ?? []), "services"] } : {}),
  };
}
