import { useCallback, useEffect, useRef, useState } from 'react';
import { ACCEPT_ATTRIBUTE, filesFromDataTransfer, isSupportedFile } from '../../audio/import.ts';
import { audioAssets } from '../../audio/assets.ts';
import { DEFAULT_TARGETS, MODEL_ONLY_STEMS, STEM_META, type StemId } from '../../audio/separation/types.ts';
import { exportStemAsset, DEFAULT_QUALITY } from '../../audio/export.ts';
import { actions } from '../../state/store.ts';
import { compatibilityOf, scoreLabel } from '../../remix/compatibility.ts';
import { syncWarnings } from '../../remix/sync.ts';
import type { Project, Source } from '../../state/types.ts';
import { Panel, Spinner, formatTime, notify } from '../components/primitives.tsx';
import { placeSection, placeStem, useImporter } from '../hooks.ts';
import { engine } from '../../audio/engine.ts';
import { Icon } from '../components/Icon.tsx';

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
            <Icon
              name="waveform"
              size={24}
              weight={1.4}
              style={{ color: 'var(--text-3)', margin: '0 auto 9px' }}
            />
            <div style={{ color: 'var(--text-2)', marginBottom: 9 }}>Drop audio here</div>
            <button onClick={() => fileInput.current?.click()}>
              <Icon name="folder" size={14} />
              Choose files
            </button>
            <div className="hint" style={{ marginTop: 9 }}>
              MP3 · WAV · FLAC · AAC · M4A · OGG · AIFF
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

/**
 * Per-section picker: take just the chorus vocal from one song and the drop
 * from another, dropping each at the playhead.
 */
function SectionPicker({ source, project }: { source: Source; project: Project }) {
  const [stem, setStem] = useState<StemId | 'full'>('lead-vocals');
  const sections = source.analysis?.sections ?? [];
  const available = (Object.keys(source.stems) as StemId[]).filter((id) => source.stems[id]?.ready);

  return (
    <div style={{ marginBottom: 10 }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <span className="eyebrow">Section as</span>
        <select
          className="grow"
          value={stem}
          onChange={(e) => setStem(e.target.value as StemId | 'full')}
          aria-label="Which stem to take from the section"
        >
          <option value="full">Full mix</option>
          {available.map((id) => (
            <option key={id} value={id}>
              {STEM_META[id].label}
            </option>
          ))}
        </select>
      </div>

      {sections.map((section) => (
        <div className="stem-row" key={section.id}>
          <span
            className="dot"
            style={{ background: `hsl(${source.hue} 60% ${35 + section.energy * 30}%)` }}
          />
          <span className="name truncate">
            {section.label}
            <span className="hint"> · {section.bars} bars</span>
          </span>
          <span className="hint mono">{formatTime(section.startTime)}</span>
          <button
            className="ghost icon"
            title={`Add this ${section.label} at the playhead`}
            aria-label={`Add ${section.label} at the playhead`}
            onClick={() => {
              if (placeSection(project, source, stem, section, engine.state().position)) {
                notify(`Added ${source.name} ${section.label} at the playhead.`, 'ok');
              }
            }}
          >
            <Icon name="plus" size={13} />
          </button>
        </div>
      ))}
    </div>
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
  const [previewing, setPreviewing] = useState<string | null>(null);
  const analysis = source.analysis;
  const stems = Object.values(source.stems).filter((s) => s?.ready);

  // Stop the audition when this card collapses, so nothing keeps playing
  // invisibly after the user moves on.
  useEffect(() => {
    if (!open && previewing) {
      engine.stopPreview();
      setPreviewing(null);
    }
  }, [open, previewing]);
  const warnings = syncWarnings(source, project);

  const reference = project.sources.find((s) => s.id !== source.id && s.analysis);
  const compat = reference && analysis ? compatibilityOf(source, reference) : null;

  return (
    <article className="source">
      <div className="head" onClick={onToggle}>
        <span className="swatch" style={{ background: `hsl(${source.hue} 70% 55%)` }} />
        <span className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 6 }}>
            <span className="index">{String(index + 1).padStart(2, '0')}</span>
            <span className="truncate" style={{ fontWeight: 600, letterSpacing: '-0.01em' }}>
              {source.name}
            </span>
          </div>
          <div className="hint truncate">
            {formatTime(source.duration)} · {source.channelCount === 1 ? 'mono' : 'stereo'} ·{' '}
            {(source.sampleRate / 1000).toFixed(1)} kHz
          </div>
        </span>
        <button
          className="ghost danger icon remove"
          onClick={(e) => {
            e.stopPropagation();
            actions.removeSource(source.id);
          }}
          title={`Remove ${source.name}`}
          aria-label={`Remove ${source.name}`}
        >
          <Icon name="trash" size={13} />
        </button>
        <Icon name="chevron" size={12} weight={2} className={`chev ${open ? 'open' : ''}`} />
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
          {analysis && analysis.sections.length > 0 && (
            <SectionPicker source={source} project={project} />
          )}

          {compat && (
            <div className="hint" style={{ marginBottom: 8 }}>
              Against {reference!.name}: <strong>{compat.score}/100</strong> ({scoreLabel(compat.score)})
            </div>
          )}

          {warnings.map((w) => (
            <div className="conflict" key={w}>
              <Icon name="alert" size={12} />
              <span>{w}</span>
            </div>
          ))}

          <div className="row wrap" style={{ marginTop: 8, marginBottom: 8 }}>
            <button onClick={() => placeStem(project, source, 'full')}>
              <Icon name="plus" size={13} />
              Full mix
            </button>
            {source.separationState !== 'running' && (
              <>
                <button onClick={() => void importer.separate(source.id, DEFAULT_TARGETS)}>
                  <Icon name="layers" size={13} />
                  {stems.length ? 'Re-separate' : 'Separate'}
                </button>
                <button
                  className="ghost"
                  onClick={() => void importer.separate(source.id, DETAILED_TARGETS)}
                  title="Also split the kit into kick, snare, hi-hats and percussion"
                >
                  + kit
                </button>
              </>
            )}
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
              <Icon name="alert" size={12} />
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
                      className={`ghost ${previewing === state.assetId ? 'active' : ''}`}
                      title={previewing === state.assetId ? 'Stop' : 'Listen to this stem on its own'}
                      onClick={() => {
                        if (previewing === state.assetId) {
                          engine.stopPreview();
                          setPreviewing(null);
                        } else {
                          setPreviewing(state.assetId);
                          void engine.previewAsset(state.assetId, {
                            onEnd: () => setPreviewing(null),
                          });
                        }
                      }}
                    >
                      <Icon name={previewing === state.assetId ? 'stop' : 'play'} size={11} />
                    </button>
                    <button
                      className="ghost"
                      title="Place on the timeline"
                      onClick={() => placeStem(project, source, id as StemId)}
                    >
                      Use
                    </button>
                    <button
                      className="ghost icon"
                      title="Download this stem as a WAV"
                      aria-label={`Download ${meta.label}`}
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
                      <Icon name="download" size={13} />
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
