import { renderNetworkPlan } from './plan.ts';

/** Compare validated network protection, permitting only a new core artifact and
 * configuration generation. Names alone never establish resource ownership. */
export function sameNetworkProtection(left: unknown, right: unknown): boolean {
  const domain = (input: unknown) => {
    const value = renderNetworkPlan(input).deployment;
    return { ...value, generation: null, core: { ...value.core, binarySha256: null, unitSha256: null } };
  };
  return JSON.stringify(domain(left)) === JSON.stringify(domain(right));
}
