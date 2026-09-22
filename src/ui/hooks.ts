import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { engine, type TransportState } from '../audio/engine.ts';
import { audioAssets } from '../audio/assets.ts';
import { importAudioFile } from '../audio/import.ts';
import { analyseAudio, separateAudio } from '../audio/workers/client.ts';
import { DEFAULT_TARGETS, STEM_META, type StemId } from '../audio/separation/types.ts';
import { getModelBackendUrl, modelEngine } from '../audio/separation/index.ts';
import { actions, newId, store, trackForStem } from '../state/store.ts';
import { buildFullClip } from '../remix/build.ts';
import type { Project, Source } from '../state/types.ts';
import { notify } from './components/primitives.tsx';

/** Hues spread around the wheel so sources stay visually distinct. */
const SOURCE_HUES = [204, 28, 288, 150, 340, 48, 176, 264, 12, 96];

export function useTransport(): TransportState {
  return useSyncExternalStore(
    (fn) => engine.subscribe(fn),
    () => engine.state(),
  );
}

/** Keep the audio graph reconciled with the project on every change. */
export function useEngineSync(project: Project): void {
  useEffect(() => {
    engine.sync(project);
  }, [project]);
}

/** Re-render when an asset appears, so waveforms fill in as work completes. */
export function useAssetVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => audioAssets.subscribe(() => setVersion((v) => v + 1)), []);
  return version;
}

export interface ImportOptions {
  /** Run stem separation straight after analysis. */
  autoSeparate: boolean;
  targets: StemId[];
}

export function useImporter() {
  const [busy, setBusy] = useState(false);

  const separate = useCallback(
    async (sourceId: string, targets: StemId[] = DEFAULT_TARGETS) => {
      const project = store.getState().project;
      const source = project.sources.find((s) => s.id === sourceId);
      const asset = audioAssets.get(source?.assetId);
      if (!source || !asset) return;

      const backendUrl = getModelBackendUrl();
      let engineId = 'builtin-dsp';
      if (backendUrl && (await modelEngine.available())) {
        // Only use the model backend if it covers everything asked for.
        if (targets.every((t) => modelEngine.supports.includes(t))) engineId = 'remote-model';
      }

      actions.updateSource(sourceId, {
        separationState: 'running',
        separationProgress: 0,
        separationStage: 'Starting',
        separationEngine: engineId,
        separationError: undefined,
      });

      try {
        const { promise } = separateAudio(
          asset.channels,
          asset.sampleRate,
          targets,
          engineId,
          backendUrl || undefined,
          (p) =>
            actions.updateSource(sourceId, {
              separationProgress: p.value,
              separationStage: p.stage,
            }),
        );
        const stems = await promise;
        const map: Source['stems'] = { ...source.stems };
        for (const stem of stems) {
          const stored = audioAssets.add(stem.channels, asset.sampleRate);
          map[stem.id] = { stemId: stem.id, assetId: stored.id, ready: true };
        }
        actions.updateSource(sourceId, {
          stems: map,
          separationState: 'done',
          separationProgress: 1,
          separationStage: 'Done',
        });
        notify(`Separated ${source.name} into ${stems.length} stems.`, 'ok');
      } catch (err) {
        actions.updateSource(sourceId, {
          separationState: 'error',
          separationError: err instanceof Error ? err.message : String(err),
        });
        notify(`Separation failed for ${source.name}: ${err instanceof Error ? err.message : err}`, 'error');
      }
    },
    [],
  );

  const importFiles = useCallback(
    async (files: File[], options: ImportOptions = { autoSeparate: true, targets: DEFAULT_TARGETS }) => {
      if (files.length === 0) return;
      setBusy(true);
      try {
        for (const file of files) {
          const project = store.getState().project;
          const index = project.sources.length;
          let imported;
          try {
            imported = await importAudioFile(file, engine.sampleRate);
          } catch (err) {
            notify(err instanceof Error ? err.message : `Could not import ${file.name}`, 'error');
            continue;
          }

          const source: Source = {
            id: newId('src'),
            name: imported.name,
            fileName: imported.fileName,
            assetId: imported.asset.id,
            duration: imported.asset.duration,
            sampleRate: imported.asset.sampleRate,
            channelCount: imported.asset.channels.length,
            hue: SOURCE_HUES[index % SOURCE_HUES.length]!,
            analysis: null,
            analysisState: 'running',
            analysisProgress: 0,
            analysisStage: 'Queued',
            separationState: 'idle',
            separationProgress: 0,
            separationStage: '',
            stems: {},
          };
          actions.addSource(source);

          try {
            const result = await analyseAudio(
              imported.asset.channels,
              imported.asset.sampleRate,
              (p) =>
                actions.updateSource(source.id, {
                  analysisProgress: p.value,
                  analysisStage: p.stage,
                }),
            );
            actions.updateSource(source.id, {
              analysis: result,
              analysisState: 'done',
              analysisProgress: 1,
              analysisStage: 'Done',
            });

            // The first analysed source sets the project tempo and key.
            const after = store.getState().project;
            if (after.sources.filter((s) => s.analysis).length === 1) {
              actions.setTempo(Math.round(result.displayBpm));
              actions.setKey(result.key.tonic, result.key.mode);
            }
          } catch (err) {
            actions.updateSource(source.id, {
              analysisState: 'error',
              analysisError: err instanceof Error ? err.message : String(err),
            });
            notify(`Analysis failed for ${source.name}.`, 'error');
          }

          if (options.autoSeparate) await separate(source.id, options.targets);
        }
      } finally {
        setBusy(false);
      }
    },
    [separate],
  );

  return { importFiles, separate, busy };
}

/** Put a source's stem on its track, replacing whatever was there. */
export function placeStem(project: Project, source: Source, stem: StemId | 'full'): boolean {
  const track = trackForStem(project, stem);
  const current = store.getState().project;
  const existing = current.clips.filter((c) => c.trackId === track.id);
  if (existing.length) actions.removeClips(existing.map((c) => c.id));

  const clip = buildFullClip(store.getState().project, source, stem, track.id, 0);
  if (!clip) {
    notify(
      `${source.name} has no ${stem === 'full' ? 'audio' : STEM_META[stem].label.toLowerCase()} available yet.`,
      'error',
    );
    return false;
  }
  actions.addClip(clip);
  return true;
}

/** Global keyboard shortcuts. Ignored while typing in a field. */
export function useShortcuts(handlers: Record<string, () => void>): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;

      const mod = e.metaKey || e.ctrlKey;
      const key = `${mod ? 'mod+' : ''}${e.shiftKey && e.key.length > 1 ? 'shift+' : ''}${e.key.toLowerCase()}`;
      const handler = handlers[key];
      if (handler) {
        e.preventDefault();
        handler();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handlers]);
}
