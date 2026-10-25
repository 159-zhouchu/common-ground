import type { Manifest, Run, Step } from './types';

export function stepManifest(run: Run, step: Step): Manifest | undefined {
  if (step.manifest) return step.manifest;
  const base = step.manifestKey && run.inputManifests?.[step.manifestKey];
  if (!base) return undefined;
  return {
    ...base,
    ...(step.priorStepIds?.length
      ? {
          priorOutputs: step.priorStepIds.flatMap((id) => {
            const output = run.steps.find((s) => s.id === id)?.output;
            return output ? [output] : [];
          }),
        }
      : {}),
    hash: step.manifestHash || base.hash,
  };
}
