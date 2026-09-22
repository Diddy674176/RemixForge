import { useState } from 'react';
import { actions } from '../../state/store.ts';
import type { Project } from '../../state/types.ts';
import { Panel, notify } from '../components/primitives.tsx';
import { Icon } from '../components/Icon.tsx';

/**
 * A/B versions.
 *
 * A version snapshots the tracks and clips only — sources and their stems are
 * shared — so switching between "vocals A + beat B" and "vocals A + beat C" is
 * instant and costs no extra audio memory.
 */
export function Versions({ project }: { project: Project }) {
  const [name, setName] = useState('');

  const save = () => {
    const label = name.trim() || `Version ${String.fromCharCode(65 + project.versions.length)}`;
    actions.saveVersion(label);
    setName('');
    notify(`Saved "${label}".`, 'ok');
  };

  return (
    <Panel title="Versions" count={project.versions.length || undefined} defaultOpen={false}>
      <div className="row" style={{ marginBottom: 8 }}>
        <input
          className="grow"
          placeholder="Name this combination"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
        <button onClick={save} disabled={project.clips.length === 0}>
          Save
        </button>
      </div>

      {project.versions.length === 0 ? (
        <div className="hint">
          Save the current stem combination, change it, then flip between them instantly to compare.
        </div>
      ) : (
        project.versions.map((version) => (
          <div className="row" key={version.id} style={{ padding: '3px 0' }}>
            <button
              className={`grow ${project.activeVersionId === version.id ? 'active' : ''}`}
              style={{ justifyContent: 'flex-start', textAlign: 'left' }}
              onClick={() => actions.loadVersion(version.id)}
            >
              {version.name}
              <span className="hint" style={{ marginLeft: 6 }}>
                {version.clips.length} clips
              </span>
            </button>
            <button
              className="ghost danger icon"
              onClick={() => actions.removeVersion(version.id)}
              aria-label={`Delete ${version.name}`}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        ))
      )}
    </Panel>
  );
}
