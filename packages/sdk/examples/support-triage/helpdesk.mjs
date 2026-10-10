// Help desk requests for the scripts of support-triage.method. Every request sends HELPDESK_TOKEN and stops after 10 seconds.
export async function readInput() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return JSON.parse(text);
}

export async function helpdesk(base, path, {method = 'GET', body} = {}) {
  if (typeof base !== 'string' || !/^https?:\/\//.test(base)) throw Error('The helpdesk connection must be an http or https URL.');
  const token = process.env.HELPDESK_TOKEN;
  if (!token) throw Error('HELPDESK_TOKEN is not set. Run method secret find, or method secret set HELPDESK_TOKEN.');
  const response = await fetch(new URL(path, base.endsWith('/') ? base : base + '/'), {
    method, signal: AbortSignal.timeout(10_000), redirect: 'error',
    headers: {authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? {'content-type': 'application/json'} : {})},
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
  if (!response.ok) throw Error(`The help desk returned ${response.status} for ${method} ${path}.`);
  return response.json();
}

export function ticketPath(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw Error('Expected a ticket ID of letters, digits, - and _.');
  return `tickets/${id}`;
}

export async function main(run) {
  try {
    process.stdout.write(JSON.stringify(await run(await readInput())) + '\n');
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
