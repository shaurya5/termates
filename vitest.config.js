import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 15000,
    hookTimeout: 10000,

    // Integration tests share the hardcoded Unix socket path
    // (os.tmpdir()/termates.sock).  Running them in parallel would cause
    // EADDRINUSE / ECONNREFUSED races.  Forcing a single worker keeps them
    // sequential without any extra coordination.
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
