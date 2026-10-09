import { defineConfig } from 'vitest/config';
// Tests never use this computer's Method sign-in: the default server is a closed loopback port with no saved credential.
export default defineConfig({test: {include: ['testkit/**/*.test.ts'], environment: 'node', env: {METHOD_SERVER: 'http://127.0.0.1:9'}}});
