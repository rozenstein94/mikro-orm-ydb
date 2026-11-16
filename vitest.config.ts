import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { fileParallelism: process.env.YDB_INTEGRATION !== '1', globals: true, testTimeout: 60_000, hookTimeout: 120_000 },
});
