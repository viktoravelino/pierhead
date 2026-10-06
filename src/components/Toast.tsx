import { CircleAlert, CircleCheck } from "lucide-react";
import { createContext, type ReactNode, use, useCallback, useState } from "react";

type Toast = {
  id: number;
  message: string;
  /** A one-line outcome or command, shown as code after the message. */
  detail?: string;
  tone?: "error";
};

const ToastContext = createContext<((toast: Omit<Toast, "id">) => void) | null>(null);

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const notify = useCallback((toast: Omit<Toast, "id">) => {
    const id = nextId++;
    setToasts((all) => [...all, { ...toast, id }]);
    setTimeout(
      () => setToasts((all) => all.filter((t) => t.id !== id)),
      toast.tone === "error" ? 9000 : 5000,
    );
  }, []);

  return (
    <ToastContext value={notify}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-3 bottom-20 z-50 flex flex-col items-end gap-2 md:bottom-4 md:right-4 md:left-auto"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className="animate-toast pointer-events-auto flex max-w-full items-start gap-2.5 rounded-md border border-line-strong bg-raised px-3.5 py-2.5 shadow-lg shadow-black/20"
          >
            {t.tone === "error" ? (
              <CircleAlert
                className="mt-0.5 size-4 shrink-0 text-crit"
                aria-hidden="true"
              />
            ) : (
              <CircleCheck
                className="mt-0.5 size-4 shrink-0 text-ok"
                aria-hidden="true"
              />
            )}
            <p className="min-w-0 text-pretty">
              {t.message}
              {t.detail && (
                <>
                  {" "}
                  <code className="break-all rounded-sm bg-sunken px-1 py-0.5 font-mono text-xs">
                    {t.detail}
                  </code>
                </>
              )}
            </p>
          </div>
        ))}
      </div>
    </ToastContext>
  );
}

export function useToast() {
  const notify = use(ToastContext);
  if (!notify) throw new Error("useToast must be used inside ToastProvider");
  return notify;
}
