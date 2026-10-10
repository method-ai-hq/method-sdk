import { defineConfig } from 'vitest/config';
import { homedir } from 'node:os';
// Tests never use this computer's Method sign-in or settings: the default server is a closed loopback port, and
// testkit/setup-home.ts gives each test file a temporary HOME and refuses writes under the real one.
export default defineConfig({test: {include: ['testkit/**/*.test.ts'], environment: 'node', setupFiles: ['testkit/setup-home.ts'],
  env: {METHOD_SERVER: 'http://127.0.0.1:9', METHOD_TEST_REAL_HOME: homedir()}}});
