import { useEffect, useState } from 'react';
import { audioAssets } from '../../audio/assets.ts';
import {
  MODEL_ONLY_STEMS,
  STEM_META,
  getModelBackendUrl,
  modelEngine,
  setModelBackendUrl,
  builtinEngine,
} from '../../audio/separation/index.ts';
import { store } from '../../state/store.ts';
import {
  deleteProject,
  exportProjectFile,
  listProjects,
  loadProject,
  pruneAssets,
  saveProject,
  storageEstimate,
  type ProjectSummary,
} from '../../state/persist.ts';
import { createProject } from '../../state/types.ts';
import { Modal, Spinner, formatBytes, notify } from '../components/primitives.tsx';

type Tab = 'projects' | 'engine' | 'about';

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('projects');
  return (
    <Modal title="Settings" onClose={onClose} width={720}>
      <div className="tabs" style={{ marginBottom: 14, position: 'static' }}>
        {(
          [
            ['projects', 'Projects & storage'],
            ['engine', 'Separation engine'],
            ['about', 'About'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'projects' && <ProjectsTab onClose={onClose} />}
      {tab === 'engine' && <EngineTab />}
      {tab === 'about' && <AboutTab />}
    </Modal>
  );
}

function ProjectsTab({ onClose }: { onClose: () => void }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [usage, setUsage] = useState<{ usedBytes: number; quotaBytes: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setProjects(await listProjects());
    setUsage(await storageEstimate());
  };

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <button
          onClick={async () => {
            setBusy(true);
            await saveProject(store.getState().project);
            await refresh();
            setBusy(false);
            notify('Project saved.', 'ok');
          }}
          disabled={busy}
        >
          Save now
        </button>
        <button
          onClick={() => {
            store.replace(createProject(), 'New project');
            onClose();
          }}
        >
          New project
        </button>
        <button onClick={() => exportProjectFile(store.getState().project)}>Export project file</button>
        <span className="grow" />
        {busy && <Spinner />}
      </div>

      <div className="hint" style={{ marginBottom: 10 }}>
        Projects autosave to this browser. Audio never leaves your machine unless you configure a
        model backend.
        {usage && (
          <>
            {' '}
            Using <strong>{formatBytes(usage.usedBytes)}</strong>
            {usage.quotaBytes > 0 && ` of about ${formatBytes(usage.quotaBytes)} available`}. In memory
            right now: {formatBytes(audioAssets.bytes())}.
          </>
        )}
      </div>

      {projects.length === 0 ? (
        <div className="empty">No saved projects yet.</div>
      ) : (
        projects.map((p) => (
          <div className="row" key={p.id} style={{ padding: '5px 0', borderBottom: '1px solid var(--line)' }}>
            <div className="grow">
              <div style={{ fontWeight: 600 }}>{p.name}</div>
              <div className="hint">
                {p.sourceCount} sources · {p.clipCount} clips · {new Date(p.updatedAt).toLocaleString()}
              </div>
            </div>
            <button
              onClick={async () => {
                setBusy(true);
                const loaded = await loadProject(p.id);
                setBusy(false);
                if (loaded) {
                  store.hydrate(loaded);
                  notify(`Opened "${loaded.name}".`, 'ok');
                  onClose();
                } else {
                  notify('Could not open that project.', 'error');
                }
              }}
            >
              Open
            </button>
            <button
              className="ghost danger"
              onClick={async () => {
                await deleteProject(p.id);
                await refresh();
              }}
            >
              Delete
            </button>
          </div>
        ))
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <button
          className="ghost"
          onClick={async () => {
            const removed = await pruneAssets();
            await refresh();
            notify(
              removed ? `Removed ${removed} unused audio file${removed === 1 ? '' : 's'}.` : 'Nothing to clean up.',
              'ok',
            );
          }}
        >
          Clean up unused audio
        </button>
      </div>
    </>
  );
}

function EngineTab() {
  const [url, setUrl] = useState(getModelBackendUrl());
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const test = async () => {
    setChecking(true);
    setStatus(null);
    setModelBackendUrl(url.trim());
    const available = await modelEngine.available();
    setStatus(
      available
        ? `Connected. Provides: ${modelEngine.supports.map((s) => STEM_META[s].label).join(', ')}.`
        : 'No response, or the backend did not report any stems. The built-in engine will be used.',
    );
    setChecking(false);
  };

  return (
    <>
      <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>{builtinEngine.name} (always available)</h3>
      <div className="hint" style={{ marginBottom: 6 }}>
        {builtinEngine.description}
      </div>
      <div className="hint" style={{ marginBottom: 16 }}>
        Produces: {builtinEngine.supports.map((s) => STEM_META[s].label).join(', ')}.
      </div>

      <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>Model backend (optional)</h3>
      <div className="hint" style={{ marginBottom: 8 }}>
        Point this at a separation service you run yourself for much better vocal isolation and
        instrument-level stems ({MODEL_ONLY_STEMS.map((s) => STEM_META[s].label).join(', ')}).
        <strong> Audio is uploaded to whatever address you enter</strong>, so only use a server you
        control. See <code>docs/model-backend.md</code> for a ~40-line Demucs wrapper that implements
        the two endpoints.
      </div>

      <div className="row" style={{ marginBottom: 8 }}>
        <input
          className="grow"
          placeholder="http://localhost:8000"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button onClick={() => void test()} disabled={checking}>
          {checking ? <Spinner /> : 'Test'}
        </button>
        <button
          className="ghost"
          onClick={() => {
            setUrl('');
            setModelBackendUrl('');
            setStatus('Cleared. Using the built-in engine.');
          }}
        >
          Clear
        </button>
      </div>
      {status && <div className="notice info">{status}</div>}
    </>
  );
}

function AboutTab() {
  return (
    <>
      <p style={{ marginTop: 0 }}>
        <strong>RemixForge</strong> is a multi-track remix and stem studio that runs entirely in your
        browser. Audio is decoded, analysed, separated, mixed and exported locally — nothing is
        uploaded unless you deliberately configure a model backend.
      </p>

      <h3 style={{ fontSize: 14, marginBottom: 6 }}>Rights and permitted use</h3>
      <div className="notice">
        Only import and remix audio you own, created yourself, have permission to remix, or are
        otherwise legally permitted to use. RemixForge deliberately contains no tools for downloading
        music, bypassing copy protection or DRM, circumventing streaming-service protections, or
        imitating a specific artist's voice. Separating and rearranging a file you already hold is
        your responsibility to clear.
      </div>

      <h3 style={{ fontSize: 14, margin: '14px 0 6px' }}>What the analysis actually does</h3>
      <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }} className="hint">
        <li>Tempo: spectral-flux onset envelope, autocorrelation with a tempo prior, then a dynamic-programming beat tracker.</li>
        <li>Key: chroma averaged over the track, correlated against Temperley's key profiles.</li>
        <li>Structure: self-similarity of beat-synchronous chroma and timbre, with a checkerboard novelty kernel.</li>
        <li>Separation: harmonic/percussive median filtering plus stereo centre extraction. Good on drums, bass and instrumental; vocals depend on the mix being genuinely stereo.</li>
        <li>Time-stretch: phase vocoder with peak locking and transient preservation.</li>
      </ul>
      <p className="hint">
        All of it is heuristic and can be wrong. Every detected value is editable, and nothing the app
        decides automatically is locked.
      </p>
    </>
  );
}
