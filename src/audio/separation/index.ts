import { DspSeparationEngine } from './dspEngine.ts';
import { RemoteModelEngine } from './remoteEngine.ts';
import type { SeparationEngine, StemId } from './types.ts';

export * from './types.ts';
export { DspSeparationEngine } from './dspEngine.ts';
export { RemoteModelEngine } from './remoteEngine.ts';

const STORAGE_KEY = 'remixforge.modelBackendUrl';

const dsp = new DspSeparationEngine();
const remote = new RemoteModelEngine(
  (typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY)) || '',
);

/** Every engine the app knows about, best-quality first. */
export const engines: SeparationEngine[] = [remote, dsp];

export function setModelBackendUrl(url: string): void {
  remote.setBaseUrl(url);
  try {
    if (url) localStorage.setItem(STORAGE_KEY, url);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private-mode browsers refuse storage; the URL still applies this session.
  }
}

export function getModelBackendUrl(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Pick the best engine that can produce every requested stem. */
export async function pickEngine(targets: StemId[]): Promise<SeparationEngine> {
  for (const engine of engines) {
    if (!(await engine.available())) continue;
    if (targets.every((t) => engine.supports.includes(t))) return engine;
  }
  return dsp;
}

export { dsp as builtinEngine, remote as modelEngine };
