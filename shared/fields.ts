// Reading a request body of unknown shape. A reader throws `Refusal` with the reason; the
// `parseBody` wrapper turns that into the string an operation's `parse` returns.

class Refusal extends Error {}

/** Stops the reader that is running; `parseBody` hands the message back as the refusal. */
export const refuse = (message: string): never => {
  throw new Refusal(message);
};

/** Typed access to the keys of a JSON object body; each reader refuses a missing or mistyped key. */
export function fields(body: unknown) {
  if (typeof body !== "object" || body === null) return refuse("Body must be an object.");
  const get = (key: string): unknown =>
    Object.hasOwn(body, key) ? Reflect.get(body, key) : undefined;
  return {
    string: (key: string) => {
      const value = get(key);
      return typeof value === "string" ? value : refuse(`${key} must be a string.`);
    },
    number: (key: string) => {
      const value = get(key);
      return typeof value === "number" ? value : refuse(`${key} must be a number.`);
    },
    /** Reads `key` as an array of 1 to `max` items, each narrowed by `item`. */
    list: <T>(key: string, max: number, item: (value: unknown) => T) => {
      const value = get(key);
      if (!Array.isArray(value)) return refuse(`${key} must be an array.`);
      if (value.length < 1 || value.length > max) {
        return refuse(`${key} must have 1 to ${max} entries.`);
      }
      return value.map(item);
    },
    has: (key: string) => get(key) !== undefined,
  };
}

/** Wraps a reader into a parser: the value it returns, or the reason it refused. */
export const parseBody =
  <T>(read: (body: unknown) => T) =>
  (body: unknown): T | string => {
    try {
      return read(body);
    } catch (e) {
      if (e instanceof Refusal) return e.message;
      throw e;
    }
  };
