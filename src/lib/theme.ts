import { useState } from "react";

type Theme = "light" | "dark";

const storageKey = "pierhead-theme";

function currentTheme(): Theme {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "light" || explicit === "dark") return explicit;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Light/dark toggle. Writes data-theme on <html>; before any toggle the OS preference rules. */
export function useTheme() {
  const [theme, setTheme] = useState(currentTheme);

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem(storageKey, next);
    setTheme(next);
  };

  return { theme, toggle };
}
