import { useState } from 'react';
import { DEFAULT_TARGETS, type StemId } from '../../audio/separation/types.ts';
import { actions, trackForStem } from '../../state/store.ts';
import { autoMix } from '../../remix/autoMix.ts';
import { buildFullClip } from '../../remix/build.ts';
import { compatibilityOf } from '../../remix/compatibility.ts';
import { store } from '../../state/store.ts';
import type { Project } from '../../state/types.ts';
import { Panel, Spinner, notify } from '../components/primitives.tsx';
import type { useImporter } from '../hooks.ts';

interface Props {
  project: Project;
  importer: ReturnType<typeof useImporter>;
}

const NONE = '';

/**
 * Beginner mode: pick where the vocals, beat and melody come from, press one
 * button, and the app does separation, tempo and key matching, alignment and a
 * starting mix. Everything it does is an ordinary edit the user can then tweak.
 */
export function QuickRemix({ project, importer }: Props) {
  const [vocalsFrom, setVocalsFrom] = useState(NONE);
  const [beatFrom, setBeatFrom] = useState(NONE);
  const [melodyFrom, setMelodyFrom] = useState(NONE);
  const [running, setRunning] = useState(false);
  const [step, setStep] = useState('');

  const analysed = project.sources.filter((s) => s.analysis);
  const ready = vocalsFrom !== NONE && beatFrom !== NONE;

  const vocalSource = project.sources.find((s) => s.id === vocalsFrom);
  const beatSource = project.sources.find((s) => s.id === beatFrom);
  const compat = vocalSource && beatSource ? compatibilityOf(vocalSource, beatSource) : null;

  const run = async () => {
    setRunning(true);
    try {
      const picks: { stem: StemId; sourceId: string }[] = [
        { stem: 'lead-vocals', sourceId: vocalsFrom },
        { stem: 'drums', sourceId: beatFrom },
        { stem: 'bass', sourceId: beatFrom },
      ];
      if (melodyFrom !== NONE) picks.push({ stem: 'melody', sourceId: melodyFrom });

      // 1–3. Separate anything that isn't separated yet.
      const needed = [...new Set(picks.map((p) => p.sourceId))];
      for (const id of needed) {
        const source = store.getState().project.sources.find((s) => s.id === id);
        if (!source) continue;
        const missing = picks
          .filter((p) => p.sourceId === id)
          .some((p) => !source.stems[p.stem]?.ready);
        if (!missing) continue;
        setStep(`Separating ${source.name}…`);
        await importer.separate(id, DEFAULT_TARGETS);
      }

      // 4–5. Tempo and key come from whoever supplies the vocal.
      setStep('Matching tempo and key…');
      const current = store.getState().project;
      const vocal = current.sources.find((s) => s.id === vocalsFrom);
      if (vocal?.analysis) {
        actions.setTempo(Math.round(vocal.analysis.displayBpm));
        actions.setKey(vocal.analysis.key.tonic, vocal.analysis.key.mode);
      }

      // 6. Place every stem, aligned to its source's downbeats.
      setStep('Aligning stems…');
      const withTempo = store.getState().project;
      const existing = withTempo.clips.map((c) => c.id);
      if (existing.length) actions.removeClips(existing);

      let placed = 0;
      for (const pick of picks) {
        const latest = store.getState().project;
        const source = latest.sources.find((s) => s.id === pick.sourceId);
        if (!source?.stems[pick.stem]?.ready) continue;
        const track = trackForStem(latest, pick.stem);
        const clip = buildFullClip(store.getState().project, source, pick.stem, track.id, 0);
        if (clip) {
          actions.addClip(clip);
          placed++;
        }
      }

      // 7. Balance it.
      setStep('Balancing the mix…');
      const mixed = autoMix(store.getState().project);
      for (const track of mixed.tracks) actions.updateTrack(track.id, track, { history: false });
      actions.setMaster({ volume: mixed.masterGain });

      notify(
        placed > 0
          ? `Quick Remix built ${placed} tracks. Press play — then edit anything you like.`
          : 'Nothing could be placed. Check that the stems separated successfully.',
        placed > 0 ? 'ok' : 'error',
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Quick Remix failed.', 'error');
    } finally {
      setRunning(false);
      setStep('');
    }
  };

  return (
    <Panel title="Quick remix" defaultOpen={false}>
      {analysed.length < 2 ? (
        <div className="hint">Import at least two songs to use Quick Remix.</div>
      ) : (
        <>
          <Picker label="Vocals from" value={vocalsFrom} onChange={setVocalsFrom} project={project} />
          <Picker label="Beat from" value={beatFrom} onChange={setBeatFrom} project={project} />
          <Picker
            label="Melody (optional)"
            value={melodyFrom}
            onChange={setMelodyFrom}
            project={project}
            optional
          />

          {compat && (
            <div className="hint" style={{ margin: '8px 0' }}>
              Compatibility <strong>{compat.score}/100</strong>.
              {compat.conflicts.length > 0 && (
                <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
                  {compat.conflicts.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <button
            className="primary"
            style={{ width: '100%', marginTop: 8 }}
            disabled={!ready || running}
            onClick={() => void run()}
          >
            {running ? (
              <span className="row" style={{ justifyContent: 'center' }}>
                <Spinner /> {step || 'Working…'}
              </span>
            ) : (
              'Auto sync'
            )}
          </button>
          <div className="hint" style={{ marginTop: 6 }}>
            Separates stems, detects BPM and key, matches tempo, aligns to the downbeat and balances
            the mix. Undo reverses the whole thing.
          </div>
        </>
      )}
    </Panel>
  );
}

function Picker({
  label,
  value,
  onChange,
  project,
  optional,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  project: Project;
  optional?: boolean;
}) {
  return (
    <label className="col" style={{ gap: 3, marginBottom: 7 }}>
      <span className="hint">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{optional ? 'None' : 'Choose a source…'}</option>
        {project.sources
          .filter((s) => s.analysis)
          .map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} — {s.analysis!.displayBpm.toFixed(0)} BPM, {s.analysis!.key.name}
            </option>
          ))}
      </select>
    </label>
  );
}
