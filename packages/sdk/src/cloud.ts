import type { MethodClient } from './method-client.js';

/** Where the production runs of a Method run in one environment: on the organization's workers, or on Method Cloud. */
export type Placement = 'workers' | 'cloud';
export const environmentPattern = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The placement flags of `method publish`: --cloud or --workers, and --env NAME (default production). */
export function placementFlags(args: string[]): { placement: Placement; environment: string } | undefined {
  const cloud = args.includes('--cloud'), workers = args.includes('--workers');
  if (cloud && workers) throw Error('Use --cloud or --workers, not both.');
  const at = args.findIndex(arg => arg === '--env' || arg.startsWith('--env='));
  const environment = at < 0 ? 'production' : args[at]!.startsWith('--env=') ? args[at]!.slice(6) : args[at + 1];
  if (!environment || !environmentPattern.test(environment)) throw Error('Use --env NAME: lowercase letters, digits, and hyphens.');
  if (!cloud && !workers) { if (at >= 0) throw Error('Use --env with --cloud or --workers.'); return undefined; }
  return { placement: cloud ? 'cloud' : 'workers', environment };
}

/** Set where the production runs of a Method run in one environment. */
export async function setPlacement(client: MethodClient, methodId: string, environment: string, placement: Placement) {
  return client.request<{ environment: string; placement: Placement; updated_at: string | null }>(
    `/api/methods/${encodeURIComponent(methodId)}/placements/${encodeURIComponent(environment)}`, 'PUT', { placement });
}

/**
 * Publish, then set the placement when --cloud or --workers is given. The flags are checked before the publish. When
 * the organization cannot use Method Cloud, the version stays published and the result says why the placement did not
 * change.
 */
export async function publishWithPlacement<T extends { workflow_id: string }>(client: MethodClient, args: string[], publish: () => Promise<T>) {
  const wanted = placementFlags(args);
  const published = await publish();
  if (!wanted) return published;
  try {
    const placement = await setPlacement(client, published.workflow_id, wanted.environment, wanted.placement);
    return { ...published, placement: { environment: placement.environment, placement: placement.placement } };
  } catch (error: any) {
    process.exitCode = 1;
    const message = error.code === 'cloud_not_enabled'
      ? 'Method Cloud is not on for your organization. Production runs still use your workers.'
      : `The placement did not change: ${error.message}`;
    return { ...published, placement: { environment: wanted.environment, error: message } };
  }
}
