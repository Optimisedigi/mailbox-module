import "@testing-library/jest-dom";

// Many modules in src/ transitively import payload.config (e.g. anything
// that touches auth/store or auth/events). payload.config
// throws at module load time if PAYLOAD_SECRET is missing, so set a
// dummy value here — setupFiles run before any test file imports.
// Tests that need a specific secret (e.g. oauth-state.test.ts) override
// it locally and restore in afterEach.
process.env.PAYLOAD_SECRET = process.env.PAYLOAD_SECRET || "test-secret";

// Node 26 exposes an unavailable global Web Storage shim that Vitest copies over
// jsdom's implementation. Restore a standards-compatible in-memory store for tests.
if (!globalThis.localStorage) {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(String(key)) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(String(key)),
    setItem: (key, value) => values.set(String(key), String(value)),
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
}
