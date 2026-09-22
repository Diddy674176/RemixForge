import { useState } from 'react';
import {
  DEFAULT_QUALITY,
  FORMAT_INFO,
  exportMix,
  exportStems,
  type ExportFormat,
  type ExportQuality,
} from '../../audio/export.ts';
import { projectDuration } from '../../audio/engine.ts';
import type { Project } from '../../state/types.ts';
import { Modal, Spinner, formatTime, notify } from '../components/primitives.tsx';

export function ExportDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [format, setFormat] = useState<ExportFormat>('wav');
  const [quality, setQuality] = useState<ExportQuality>(DEFAULT_QUALITY);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ value: 0, stage: '' });

  const duration = projectDuration(project);
  const info = FORMAT_INFO[format];

  const run = async (stems: boolean) => {
    setBusy(true);
    setProgress({ value: 0, stage: 'Starting' });
    try {
      if (stems) {
        const count = await exportStems(project, format, quality, setProgress);
        notify(`Exported ${count} stem file${count === 1 ? '' : 's'}.`, 'ok');
      } else {
        await exportMix(project, format, quality, setProgress);
        notify('Mix exported.', 'ok');
      }
      onClose();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Export failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Export"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button onClick={() => void run(true)} disabled={busy || project.clips.length === 0}>
            Export stems
          </button>
          <button
            className="primary"
            onClick={() => void run(false)}
            disabled={busy || project.clips.length === 0}
          >
            Export mix
          </button>
        </>
      }
    >
      {project.clips.length === 0 && (
        <div className="notice" style={{ marginBottom: 12 }}>
          There is nothing on the timeline yet, so there is nothing to export.
        </div>
      )}

      <div className="row" style={{ marginBottom: 12 }}>
        {(Object.keys(FORMAT_INFO) as ExportFormat[]).map((f) => (
          <button key={f} className={format === f ? 'active' : ''} onClick={() => setFormat(f)}>
            {FORMAT_INFO[f].label}
            {FORMAT_INFO[f].lossless ? ' · lossless' : ''}
          </button>
        ))}
      </div>
      <div className="hint" style={{ marginBottom: 14 }}>
        {info.note}
      </div>

      <div className="row wrap" style={{ gap: 14 }}>
        {format !== 'mp3' ? (
          <label className="col" style={{ gap: 3 }}>
            <span className="hint">Bit depth</span>
            <select
              value={quality.bitDepth}
              onChange={(e) =>
                setQuality({ ...quality, bitDepth: Number(e.target.value) as ExportQuality['bitDepth'] })
              }
            >
              <option value={16}>16-bit</option>
              <option value={24}>24-bit</option>
              {format === 'wav' && <option value={32}>32-bit float</option>}
            </select>
          </label>
        ) : (
          <label className="col" style={{ gap: 3 }}>
            <span className="hint">Bitrate</span>
            <select
              value={quality.mp3Bitrate}
              onChange={(e) => setQuality({ ...quality, mp3Bitrate: Number(e.target.value) })}
            >
              {[128, 192, 256, 320].map((b) => (
                <option key={b} value={b}>
                  {b} kbps
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="col" style={{ gap: 3 }}>
          <span className="hint">Sample rate</span>
          <select
            value={quality.sampleRate}
            onChange={(e) => setQuality({ ...quality, sampleRate: Number(e.target.value) })}
          >
            {[44100, 48000, 96000].map((r) => (
              <option key={r} value={r}>
                {(r / 1000).toFixed(1)} kHz
              </option>
            ))}
          </select>
        </label>

        <div className="col" style={{ gap: 3 }}>
          <span className="hint">Length</span>
          <span className="mono">{formatTime(duration)}</span>
        </div>
      </div>

      <div className="notice info" style={{ marginTop: 14 }}>
        Stem export renders one file per track without the master chain, so the files sum back to the
        same mix in another DAW. Time-stretched clips are rendered with the phase vocoder first,
        never varispeed.
      </div>

      {busy && (
        <div style={{ marginTop: 14 }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <Spinner />
            <span className="hint">{progress.stage}</span>
          </div>
          <div className="bar">
            <i style={{ width: `${Math.round(progress.value * 100)}%` }} />
          </div>
        </div>
      )}
    </Modal>
  );
}
