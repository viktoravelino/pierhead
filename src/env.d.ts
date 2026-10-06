interface ImportMetaEnv {
  /** "api" reads real Dokku data through the backend; anything else serves mocks. */
  readonly VITE_DATA_SOURCE?: "api" | "mock";
}
