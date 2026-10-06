import { parseDokkuHost, parseReport } from "../shared/parse";
import type { DokkuHost } from "../shared/types";
import { type Outcome, outcome, stdoutOf } from "./apps";
import type { Dokku } from "./dokku";

/**
 * What Dokku reports about the host: eight read-only commands in parallel over the shared
 * connection (version, five `--global` reports, plugins and SSH keys).
 */
export const readDokkuHost = (dokku: Dokku): Promise<Outcome<DokkuHost>> =>
  outcome(async () => {
    const [version, domains, proxy, scheduler, builder, git, plugins, sshKeys] =
      await Promise.all([
        dokku("version"),
        dokku("domains:report:global"),
        dokku("proxy:report:global"),
        dokku("scheduler:report:global"),
        dokku("builder:report:global"),
        dokku("git:report:global"),
        dokku("plugin:list"),
        dokku("ssh-keys:list"),
      ]);
    return parseDokkuHost({
      version: stdoutOf(version),
      domains: parseReport(stdoutOf(domains)),
      proxy: parseReport(stdoutOf(proxy)),
      scheduler: parseReport(stdoutOf(scheduler)),
      builder: parseReport(stdoutOf(builder)),
      git: parseReport(stdoutOf(git)),
      plugins: stdoutOf(plugins),
      sshKeys: stdoutOf(sshKeys),
    });
  });
