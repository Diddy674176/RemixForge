import { useEffect, useMemo, useState } from 'react';
import { engine } from '../audio/engine.ts';
import { actions, store, useHistory, useProject } from '../state/store.ts';
import type { Clip } from '../state/types.ts';
import { lastProjectId, loadProject, startAutosave, type AutosaveState } from '../state/persist.ts';
import { Arrangement } from './panels/Arrangement.tsx';
import { Assistant } from './panels/Assistant.tsx';
import { ExportDialog } from './panels/ExportDialog.tsx';
import { Inspector } from './panels/Inspector.tsx';
import { QuickRemix } from './panels/QuickRemix.tsx';
import { SettingsDialog } from './panels/SettingsDialog.tsx';
import { SmartRemix } from './panels/SmartRemix.tsx';
import { SourcesPanel } from './panels/SourcesPanel.tsx';
import { Timeline } from './panels/Timeline.tsx';
import { Transport } from './panels/Transport.tsx';
import { Versions } from './panels/Versions.tsx';
import { Toasts, notify } from './components/primitives.tsx';
import { useEngineSync, useImporter, useShortcuts } from './hooks.ts';

type Mode = 'beginner' | 'advanced';

export function App() {
  const project = useProject();
  const history = useHistory();
  const importer = useImporter();

  const [mode, setMode] = useState<Mode>('beginner');
  const [selection, setSelection] = useState<string[]>([]);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [metronome, setMetronome] = useState(false);
  const [clipboard, setClipboard] = useState<Clip[]>([]);
  const [autosave, setAutosave] = useState<AutosaveState>('idle');

  useEngineSync(project);

  // Restore the last session, then keep autosaving.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const id = await lastProjectId();
      if (!id || cancelled) return;
      const restored = await loadProject(id);
      if (restored && !cancelled && store.getState().project.sources.length === 0) {
        store.hydrate(restored);
        notify(`Restored "${restored.name}".`);
      }
    })();
    const stop = startAutosave(4000, setAutosave);
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  // Warn before losing unsaved work in a tab close.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (project.clips.length > 0 && autosave !== 'saved') e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [project.clips.length, autosave]);

  const shortcuts = useMemo(
    () => ({
      ' ': () => (engine.state().playing ? engine.pause() : void engine.play()),
      'mod+z': () => actions.undo(),
      'mod+shift+z': () => actions.redo(),
      'mod+y': () => actions.redo(),
      'mod+s': () => setShowExport(true),
      home: () => engine.seek(0),
      s: () => {
        const at = engine.state().position;
        for (const clip of store.getState().project.clips) {
          if (at > clip.start + 0.02 && at < clip.start + clip.duration - 0.02) {
            actions.splitClip(clip.id, at);
          }
        }
      },
      delete: () => {
        if (selection.length) {
          actions.removeClips(selection);
          setSelection([]);
        }
      },
      backspace: () => {
        if (selection.length) {
          actions.removeClips(selection);
          setSelection([]);
        }
      },
      l: () => actions.setLoop({ enabled: !store.getState().project.loop.enabled }),
      m: () => setMetronome((m) => !m),
      'mod+c': () => {
        const clips = store.getState().project.clips.filter((c) => selection.includes(c.id));
        if (clips.length) {
          setClipboard(clips.map((c) => ({ ...c })));
          notify(`Copied ${clips.length} clip${clips.length === 1 ? '' : 's'}.`);
        }
      },
      'mod+x': () => {
        const clips = store.getState().project.clips.filter((c) => selection.includes(c.id));
        if (clips.length) {
          setClipboard(clips.map((c) => ({ ...c })));
          actions.removeClips(selection);
          setSelection([]);
        }
      },
      'mod+v': () => {
        if (clipboard.length === 0) return;
        const first = store.getState().project.tracks[0]?.id;
        const n = actions.pasteClips(clipboard, engine.state().position, first);
        if (n > 0) notify(`Pasted ${n} clip${n === 1 ? '' : 's'} at the playhead.`, 'ok');
      },
      'mod+d': () => selection.forEach((id) => actions.duplicateClip(id)),
      'mod+a': () => setSelection(store.getState().project.clips.map((c) => c.id)),
    }),
    [selection, clipboard],
  );
  useShortcuts(shortcuts);

  useEffect(() => {
    engine.setMetronome(metronome);
  }, [metronome]);

  return (
    <div className={`app ${mode === 'beginner' ? 'no-right' : ''}`}>
      <header className="topbar">
        <span className="brand">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M4 14v-4M8 18V6M12 15V9M16 20V4M20 13v-2" stroke="hsl(172 76% 48%)" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
          RemixForge
        </span>

        <input
          className="title"
          value={project.name}
          onChange={(e) => actions.rename(e.target.value)}
          aria-label="Project name"
        />

        <button className="ghost" onClick={() => actions.undo()} disabled={!history.canUndo} title={history.lastLabel ? `Undo ${history.lastLabel}` : 'Undo'}>
          ↶
        </button>
        <button className="ghost" onClick={() => actions.redo()} disabled={!history.canRedo} title="Redo">
          ↷
        </button>

        <span className="spacer" />

        <span className="hint" style={{ minWidth: 76, textAlign: 'right' }}>
          {autosave === 'saving' ? 'Saving…' : autosave === 'saved' ? 'Saved' : autosave === 'error' ? 'Save failed' : ''}
        </span>

        <div className="row" style={{ gap: 2 }}>
          <button
            className={mode === 'beginner' ? 'active' : ''}
            onClick={() => setMode('beginner')}
            title="Simplified layout"
          >
            Beginner
          </button>
          <button
            className={mode === 'advanced' ? 'active' : ''}
            onClick={() => setMode('advanced')}
            title="Full mixer, effects and automation"
          >
            Advanced
          </button>
        </div>

        <button onClick={() => setShowSettings(true)}>Settings</button>
        <button className="primary" onClick={() => setShowExport(true)}>
          Export
        </button>
      </header>

      <aside className="sidebar">
        <SourcesPanel project={project} importer={importer} />
        <QuickRemix project={project} importer={importer} />
        <SmartRemix project={project} />
        <Arrangement project={project} />
        <Versions project={project} />
        <Assistant project={project} />
      </aside>

      <main className="main">
        <Timeline
          project={project}
          selection={selection}
          onSelect={setSelection}
          selectedTrackId={selectedTrackId}
          onSelectTrack={setSelectedTrackId}
        />
      </main>

      {mode === 'advanced' && (
        <aside className="inspector">
          <Inspector
            project={project}
            selectedTrackId={selectedTrackId}
            onSelectTrack={setSelectedTrackId}
            selection={selection}
          />
        </aside>
      )}

      <Transport
        project={project}
        metronome={metronome}
        onToggleMetronome={() => setMetronome((m) => !m)}
      />

      {showExport && <ExportDialog project={project} onClose={() => setShowExport(false)} />}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      <Toasts />
    </div>
  );
}
