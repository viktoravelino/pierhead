/**
 * A limiter that runs at most `max` tasks at once; the rest wait their turn in order.
 * Keeps the SSH calls under sshd's `MaxSessions` (10) on the shared connection.
 */
export function createLimiter(max: number) {
  let running = 0;
  const waiting: (() => void)[] = [];

  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else running--;
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    // A finishing task hands its slot straight to the next waiter, so `running` stays put.
    if (running >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    else running++;
    try {
      return await task();
    } finally {
      release();
    }
  };
}
