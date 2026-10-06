// Config vars (`dokku config:*`): the grammar and rules shared by the server (which
// enforces them) and the frontend (which validates forms and marks managed keys).

/** Environment variable names: letters, digits and underscores, not starting with a digit. */
export const isConfigKey = (key: string) => /^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(key);

/**
 * Keys Dokku writes itself (`DOKKU_*`, the deployed `GIT_REV`). They stay in the list but
 * pierhead refuses to change them: Dokku expects to own them.
 */
export const isManagedKey = (key: string) =>
  key === "GIT_REV" || key.startsWith("DOKKU_");

/** Longest value accepted; sshd passes the whole command as one argument list. */
export const maxValueLength = 32_768;

/**
 * Why a value cannot be stored, or null when it can. Multi-line values are refused:
 * Dokku keeps one variable per line of its ENV file and not every consumer reads a
 * newline back faithfully. A trailing backslash corrupts the entry (Dokku 0.38.31 drops
 * it as unparseable) and a trailing double quote reads back with an extra backslash, so
 * neither round-trips.
 */
export function configValueProblem(value: string) {
  if (/[\r\n\0]/.test(value)) return "Values cannot contain line breaks.";
  if (value.length > maxValueLength) {
    return `Values cannot be longer than ${maxValueLength} characters.`;
  }
  if (/[\\"]$/.test(value)) {
    return "Dokku cannot read back a value that ends in a backslash or a double quote.";
  }
  return null;
}

/** One entry of `GET /api/apps/:name/config`: a name, never a value. */
export type ConfigKey = { key: string; managed: boolean };

/** What `PUT /api/apps/:name/config/:key` accepts. */
export type ConfigSetBody = { value: string; restart: boolean };

/** Narrows a parsed JSON body; null when it is not `{ value: string, restart: boolean }`. */
export function parseConfigSetBody(body: unknown): ConfigSetBody | null {
  if (typeof body !== "object" || body === null) return null;
  if (!("value" in body) || typeof body.value !== "string") return null;
  if (!("restart" in body) || typeof body.restart !== "boolean") return null;
  return { value: body.value, restart: body.restart };
}

/**
 * `config:keys` prints one name per line. Lines that are not names (Dokku's notices on
 * stdout) are skipped rather than listed as variables.
 */
export function parseConfigKeys(stdout: string): ConfigKey[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(isConfigKey)
    .map((key) => ({ key, managed: isManagedKey(key) }));
}

/** `config:get` prints the raw value and one trailing newline; nothing else is trimmed. */
export const parseConfigValue = (stdout: string) => stdout.replace(/\n$/, "");

/**
 * The command the dialogs show for a change, with the value masked: the real one carries
 * the secret and only ever travels from the server to Dokku.
 */
export function configCommandLine(change: {
  kind: "set" | "unset";
  app: string;
  key: string;
  restart: boolean;
}) {
  const flag = change.restart ? "" : "--no-restart ";
  const target = change.kind === "set" ? `${change.key}=********` : change.key;
  return `dokku config:${change.kind} ${flag}${change.app} ${target}`;
}
