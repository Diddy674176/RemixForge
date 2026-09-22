import { useCallback, useRef, useState } from 'react';
import { ACCEPT_ATTRIBUTE, filesFromDataTransfer, isSupportedFile } from '../../audio/import.ts';
import { audioAssets } from '../../audio/assets.ts';
import { DEFAULT_TARGETS, MODEL_ONLY_STEMS, STEM_META, type StemId } from '../../audio/separation/types.ts';
import { exportStemAsset, DEFAULT_QUALITY } from '../../audio/export.ts';
import { actions } from '../../state/store.ts';
import { compatibilityOf, scoreLabel } from '../../remix/compatibility.ts';
import { syncWarnings } from '../../remix/sync.ts';
import type { Project, Source } from '../../state/types.ts';
import { Panel, Spinner, formatTime, notify } from '../components/primitives.tsx';
import { placeStem, useImporter } from '../hooks.ts';

const DETAILED_TARGETS: StemId[] = [
  'lead-vocals',
  'backing-vocals',
  'drums',
  'kick',
  'snare',
  'hihat',
  'percussion',
  'bass',
  'melody',
  'instrumental',
];

interface Props {
  project: Project;
  importer: ReturnType<typeof useImporter>;
}

export function SourcesPanel({ project, importer }: Props) {
  const [over, setOver] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      const files = await filesFromDataTransfer(e.dataTransfer);
      if (files.length === 0) {
        notify('No supported audio files in that drop.', 'error');
        return;
      }
      void importer.importFiles(files);
    },
    [importer],
  );

  return (
    <Panel title="Sources" count={project.sources.length || undefined}>
      <div
        className={`dropzone ${over ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => void onDrop(e)}
      >
        {importer.busy ? (
          <span className="row" style={{ justifyContent: 'center' }}>
            <Spinner /> Importing and analysing…
          </span>
        ) : (
          <>
            <div style={{ marginBottom: 8 }}>Drop audio here</div>
            <button onClick={() => fileInput.current?.click()}>Choose files</button>
            <div className="hint" style={{ marginTop: 8 }}>
              MP3, WAV, FLAC, AAC, M4A, OGG, AIFF
            </div>
          </>
        )}
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []).filter(isSupportedFile);
            e.target.value = '';
            void importer.importFiles(files);
          }}
        />
      </div>

      <div style={{ marginTop: 10 }}>
        {project.sources.map((source, index) => (
          <SourceCard
            key={source.id}
            index={index}
            source={source}
            project={project}
            open={expanded === source.id}
            onToggle={() => setExpanded(expanded === source.id ? null : source.id)}
            importer={importer}
          />
        ))}
      </div>
    </Panel>
  );
}

function SourceCard({
  source,
  index,
  project,
  open,
  onToggle,
  importer,
}: {
  source: Source;
  index: number;
  project: Project;
  open: boolean;
  onToggle: () => void;
  importer: ReturnType<typeof useImporter>;
}) {
  const analysis = source.analysis;
  const stems = Object.values(source.stems).filter((s) => s?.ready);
  const warnings = syncWarnings(source, project);

  const reference = project.sources.find((s) => s.id !== source.id && s.analysis);
  const compat = reference && analysis ? compatibilityOf(source, reference) : null;

  return (
    <article className="source">
      <div className="head" onClick={onToggle}>
        <span className="swatch" style={{ background: `hsl(${source.hue} 70% 55%)` }} />
        <span className="grow" style={{ minWidth: 0 }}>
          <div className="truncate" style={{ fontWeight: 600 }}>
            {index + 1}. {source.name}
          </div>
          <div className="hint truncate">
            {formatTime(source.duration)} · {source.channelCount === 1 ? 'mono' : 'stereo'} ·{' '}
            {(source.sampleRate / 1000).toFixed(1)} kHz
          </div>
        </span>
        <span className={`chev ${open ? 'open' : ''}`} aria-hidden>
          ›
        </span>
      </div>

      <div className="facts">
        {source.analysisState === 'running' && (
          <span className="tag">
            <Spinner /> {source.analysisStage}
          </span>
        )}
        {source.analysisState === 'error' && <span className="tag warn">Analysis failed</span>}
        {analysis && (
          <>
            <span className="tag accent mono">{analysis.displayBpm.toFixed(1)} BPM</span>
            <span className="tag accent">{analysis.key.name}</span>
            <span className="tag">{analysis.key.camelot}</span>
            <span className="tag">{analysis.meter}/4</span>
            <span className="tag">{analysis.sections.length} sections</span>
            {analysis.bpmConfidence < 0.35 && <span className="tag warn">low tempo confidence</span>}
          </>
        )}
      </div>

      {open && (
        <div className="stems">
          {analysis && (
            <div className="hint" style={{ marginBottom: 8 }}>
              Structure:{' '}
              {analysis.sections
                .map((s) => s.label)
                .filter((label, i, arr) => label !== arr[i - 1])
                .join(' → ')}
            </div>
          )}

          {compat && (
            <div className="hint" style={{ marginBottom: 8 }}>
              Against {reference!.name}: <strong>{compat.score}/100</strong> ({scoreLabel(compat.score)})
            </div>
          )}

          {warnings.map((w) => (
            <div className="conflict" key={w}>
              <span aria-hidden>⚠</span>
              <span>{w}</span>
            </div>
          ))}

          <div className="row wrap" style={{ marginTop: 8, marginBottom: 8 }}>
            <button onClick={() => placeStem(project, source, 'full')}>Add full mix</button>
            {source.separationState !== 'running' && (
              <>
                <button onClick={() => void importer.separate(source.id, DEFAULT_TARGETS)}>
                  {stems.length ? 'Re-separate' : 'Separate stems'}
                </button>
                <button
                  className="ghost"
                  onClick={() => void importer.separate(source.id, DETAILED_TARGETS)}
                  title="Also split the kit into kick, snare, hi-hats and percussion"
                >
                  Detailed
                </button>
              </>
            )}
            <span className="grow" />
            <button className="ghost danger" onClick={() => actions.removeSource(source.id)}>
              Remove
            </button>
          </div>

          {source.separationState === 'running' && (
            <div style={{ marginBottom: 8 }}>
              <div className="hint" style={{ marginBottom: 4 }}>
                {source.separationStage}
              </div>
              <div className="bar">
                <i style={{ width: `${Math.round(source.separationProgress * 100)}%` }} />
              </div>
            </div>
          )}
          {source.separationState === 'error' && (
            <div className="conflict">
              <span aria-hidden>⚠</span>
              <span>{source.separationError}</span>
            </div>
          )}

          {stems.length > 0 && (
            <>
              {Object.entries(source.stems).map(([id, state]) => {
                if (!state?.ready) return null;
                const meta = STEM_META[id as StemId];
                return (
                  <div className="stem-row" key={id}>
                    <span className="dot" style={{ background: `hsl(${meta.hue} 70% 55%)` }} />
                    <span className="name truncate">{meta.label}</span>
                    <button
                      className="ghost"
                      title="Place on the timeline"
                      onClick={() => placeStem(project, source, id as StemId)}
                    >
                      Use
                    </button>
                    <button
                      className="ghost"
                      title="Download this stem as a WAV"
                      onClick={() => {
                        const asset = audioAssets.get(state.assetId);
                        if (!asset) return;
                        void exportStemAsset(
                          asset.channels,
                          asset.sampleRate,
                          `${source.name} - ${meta.label}`,
                          'wav',
                          DEFAULT_QUALITY,
                        );
                      }}
                    >
                      ↓
                    </button>
                  </div>
                );
              })}
              {source.channelCount === 1 && (
                <div className="hint" style={{ marginTop: 6 }}>
                  This file is mono, so the built-in engine cannot use stereo position to find the
                  vocal. Expect weaker vocal separation than on a stereo mix.
                </div>
              )}
              {source.separationEngine === 'builtin-dsp' && (
                <div className="hint" style={{ marginTop: 6 }}>
                  {MODEL_ONLY_STEMS.length} instrument-level stems (guitar, piano, strings…) need a
                  model backend — see Settings.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </article>
  );
}
