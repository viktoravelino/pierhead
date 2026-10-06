/** Whether the server may change Dokku state, decided once at startup. */
export type WriteGate =
  | { enabled: true }
  | { enabled: false; error: { kind: "writes-disabled"; message: string } };

/** Only the literal `PIERHEAD_ALLOW_WRITES=true` opens the gate; anything else stays read-only. */
export function loadWriteGate(env: NodeJS.ProcessEnv = process.env): WriteGate {
  if (env.PIERHEAD_ALLOW_WRITES === "true") return { enabled: true };
  return {
    enabled: false,
    error: {
      kind: "writes-disabled",
      message:
        "This server is read-only. Set PIERHEAD_ALLOW_WRITES=true to allow actions.",
    },
  };
}
