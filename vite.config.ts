import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // The API server runs next to Vite (same container under compose).
    proxy: { "/api": process.env.API_URL ?? "http://127.0.0.1:3001" },
  },
});
