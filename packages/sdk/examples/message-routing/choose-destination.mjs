import { chooseDestination } from './routing.mjs';
let text = '';
for await (const chunk of process.stdin) text += chunk;
try {
  const input = JSON.parse(text);
  process.stdout.write(JSON.stringify(chooseDestination(input.category)) + '\n');
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
