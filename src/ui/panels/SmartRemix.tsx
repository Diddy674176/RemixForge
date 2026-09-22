import { useMemo, useState } from 'react';
import { actions, store, trackForStem } from '../../state/store.ts';
import { buildFullClip } from '../../remix/build.ts';
import { autoMix } from '../../remix/autoMix.ts';
import { scoreLabel } from '../../remix/compatibility.ts';
import {
  describeParts,
  proposeRemixes,
  suggestedKey,
  suggestedTempo,
  type RemixProposal,
} from '../../remix/smartRemix.ts';
import type { Project } from '../../state/types.ts';
import { Panel, notify } from '../components/primitives.tsx';
import { Icon } from '../components/Icon.tsx';

interface Props {
  project: Project;
}

/**
 * Smart Remix: analyse every imported source and suggest combinations.
 *
 * Loading a proposal is a normal edit — it sets the tempo and key, places the
 * stems and balances levels, all of which can be undone or hand-adjusted.
 */
export function SmartRemix({ project }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const proposals = useMemo(() => proposeRemixes(project.sources), [project.sources]);

  const load = (proposal: RemixProposal) => {
    const tempo = suggestedTempo(project, project.sources, proposal);
    const key = suggestedKey(project.sources, proposal);
    actions.setTempo(tempo);
    if (key) actions.setKey(key.tonic, key.mode);

    const existing = store.getState().project.clips.map((c) => c.id);
    if (existing.length) actions.removeClips(existing);

    let placed = 0;
    const seen = new Set<string>();
    for (const part of proposal.parts) {
      // Two vocal parts from different singers share a stem id; give the
      // second one its own track rather than overwriting the first.
      const laneKey = `${part.stem}-${seen.has(part.stem) ? part.sourceId : 'primary'}`;
      seen.add(part.stem);

      const latest = store.getState().project;
      const source = latest.sources.find((s) => s.id === part.sourceId);
      if (!source) continue;
      const existingTrack = latest.tracks.find((t) => t.name === laneKey);
      const track =
        existingTrack ??
        (laneKey.endsWith('-primary')
          ? trackForStem(latest, part.stem)
          : actions.addTrack({ stem: part.stem, name: `${source.name} ${part.stem}` }));

      const clip = buildFullClip(store.getState().project, source, part.stem, track.id, 0);
      if (clip) {
        actions.addClip(clip);
        placed++;
      }
    }

    const mixed = autoMix(store.getState().project);
    for (const track of mixed.tracks) actions.updateTrack(track.id, track, { history: false });
    actions.setMaster({ volume: mixed.masterGain });

    notify(
      placed > 0
        ? `Loaded "${proposal.title}" at ${tempo} BPM.`
        : 'That combination needs stems that have not been separated yet.',
      placed > 0 ? 'ok' : 'error',
    );
  };

  return (
    <Panel title="Smart remix" count={proposals.length || undefined} defaultOpen={false}>
      {proposals.length === 0 ? (
        <div className="hint">
          Import and separate at least two songs — one of which has vocals — and combinations will
          appear here.
        </div>
      ) : (
        proposals.map((proposal, i) => {
          const open = expanded === proposal.id;
          return (
            <div className="proposal" key={proposal.id}>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <div className="grow">
                  <div style={{ fontWeight: 600 }}>
                    Remix {i + 1} — {proposal.title}
                  </div>
                  <div className="hint" style={{ marginTop: 2 }}>
                    {proposal.summary}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div
                    className="score"
                    style={{
                      color:
                        proposal.compatibility.score >= 65
                          ? 'var(--ok)'
                          : proposal.compatibility.score >= 40
                            ? 'var(--warn)'
                            : 'var(--danger)',
                    }}
                  >
                    {proposal.compatibility.score}
                  </div>
                  <div className="hint">{scoreLabel(proposal.compatibility.score)}</div>
                </div>
              </div>

              <div className="row" style={{ marginTop: 8 }}>
                <button className="primary" onClick={() => load(proposal)}>
                  <Icon name="check" size={14} />
                  Load
                </button>
                <button className="ghost" onClick={() => setExpanded(open ? null : proposal.id)}>
                  {open ? 'Hide detail' : 'Why this score?'}
                </button>
              </div>

              {open && (
                <div style={{ marginTop: 8 }}>
                  <div className="hint" style={{ marginBottom: 6 }}>
                    {describeParts(proposal, project.sources).join(' · ')}
                  </div>
                  {proposal.compatibility.factors.map((f) => (
                    <div className="factor" key={f.label}>
                      <span>{f.label}</span>
                      <span className="bar">
                        <i style={{ width: `${Math.round(f.score * 100)}%` }} />
                      </span>
                      <span className="mono">{Math.round(f.score * 100)}</span>
                    </div>
                  ))}
                  {proposal.compatibility.factors.map((f) => (
                    <div className="hint" key={`${f.label}-d`} style={{ marginLeft: 2 }}>
                      {f.label}: {f.detail}
                    </div>
                  ))}
                  {proposal.compatibility.conflicts.map((c) => (
                    <div className="conflict" key={c}>
                      <Icon name="alert" size={12} />
                      <span>{c}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}
    </Panel>
  );
}
