import { useSyncExternalStore } from 'react';
import {
  createProject,
  type AutomationLane,
  type AutomationTarget,
  type Clip,
  type ClipStem,
  type EffectSettings,
  type EffectType,
  type MasterState,
  type Project,
  type Source,
  type Track,
  type Version,
} from './types.ts';
import { defaultParams } from '../audio/effects/definitions.ts';
import { STEM_META } from '../audio/separation/types.ts';

/** Snapshots kept for undo. Projects are small JSON, so this is generous. */
const HISTORY_LIMIT = 1000;

export interface HistoryEntry {
  project: Project;
  label: string;
}

interface StoreState {
  project: Project;
  past: HistoryEntry[];
  future: HistoryEntry[];
}

type Listener = () => void;

let uid = 0;
export function newId(prefix: string): string {
  return `${prefix}-${(++uid).toString(36)}-${Date.now().toString(36)}`;
}

class ProjectStore {
  private state: StoreState = { project: createProject(), past: [], future: [] };
  private listeners = new Set<Listener>();

  getState = (): StoreState => this.state;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /**
   * Apply an immutable update.
   *
   * `label` names the step for the history UI. Pass `history: false` for
   * transient changes (a fader being dragged) so the undo stack doesn't fill
   * with intermediate states — commit once on release instead.
   */
  update(
    label: string,
    fn: (project: Project) => Project,
    opts: { history?: boolean } = {},
  ): void {
    const history = opts.history ?? true;
    const prev = this.state.project;
    const next = fn(prev);
    if (next === prev) return;
    next.updatedAt = Date.now();

    if (history) {
      const past = [...this.state.past, { project: prev, label }];
      if (past.length > HISTORY_LIMIT) past.shift();
      this.state = { project: next, past, future: [] };
    } else {
      this.state = { ...this.state, project: next };
    }
    this.emit();
  }

  /** Push the current project onto the undo stack without changing it. */
  checkpoint(label: string): void {
    const past = [...this.state.past, { project: this.state.project, label }];
    if (past.length > HISTORY_LIMIT) past.shift();
    this.state = { ...this.state, past, future: [] };
    this.emit();
  }

  replace(project: Project, label = 'Load project'): void {
    this.update(label, () => project);
  }

  /** Load without touching history — used by autosave restore. */
  hydrate(project: Project): void {
    this.state = { project, past: [], future: [] };
    this.emit();
  }

  undo(): void {
    const { past, future, project } = this.state;
    const entry = past[past.length - 1];
    if (!entry) return;
    this.state = {
      project: entry.project,
      past: past.slice(0, -1),
      future: [{ project, label: entry.label }, ...future].slice(0, HISTORY_LIMIT),
    };
    this.emit();
  }

  redo(): void {
    const { past, future, project } = this.state;
    const entry = future[0];
    if (!entry) return;
    this.state = {
      project: entry.project,
      past: [...past, { project, label: entry.label }],
      future: future.slice(1),
    };
    this.emit();
  }

  canUndo(): boolean {
    return this.state.past.length > 0;
  }

  canRedo(): boolean {
    return this.state.future.length > 0;
  }
}

export const store = new ProjectStore();

export function useProject(): Project {
  return useSyncExternalStore(store.subscribe, () => store.getState().project);
}

export function useHistory(): { canUndo: boolean; canRedo: boolean; lastLabel: string | null } {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  return {
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    lastLabel: state.past[state.past.length - 1]?.label ?? null,
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const actions = {
  newProject(name?: string): void {
    store.replace(createProject(name), 'New project');
  },

  rename(name: string): void {
    store.update('Rename project', (p) => ({ ...p, name }));
  },

  setTempo(bpm: number, opts?: { history?: boolean }): void {
    store.update('Change tempo', (p) => ({ ...p, bpm: Math.max(20, Math.min(300, bpm)) }), opts);
  },

  setMeter(meter: number): void {
    store.update('Change metre', (p) => ({ ...p, meter: Math.max(2, Math.min(12, meter)) }));
  },

  setKey(tonic: number, mode: Project['keyMode']): void {
    store.update('Change key', (p) => ({ ...p, keyTonic: tonic, keyMode: mode }));
  },

  setSnap(snap: Project['snap']): void {
    store.update('Change snapping', (p) => ({ ...p, snap }));
  },

  setAutoHarmonicMatch(on: boolean): void {
    store.update('Toggle harmonic match', (p) => ({ ...p, autoHarmonicMatch: on }));
  },

  setLoop(loop: Partial<Project['loop']>): void {
    store.update('Change loop', (p) => ({ ...p, loop: { ...p.loop, ...loop } }));
  },

  // --- sources -------------------------------------------------------------

  addSource(source: Source): void {
    store.update('Import source', (p) => ({ ...p, sources: [...p.sources, source] }));
  },

  /** Source updates are progress/analysis results, so they stay out of history. */
  updateSource(id: string, patch: Partial<Source>): void {
    store.update(
      'Update source',
      (p) => ({
        ...p,
        sources: p.sources.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      }),
      { history: false },
    );
  },

  removeSource(id: string): void {
    store.update('Remove source', (p) => ({
      ...p,
      sources: p.sources.filter((s) => s.id !== id),
      clips: p.clips.filter((c) => c.sourceId !== id),
    }));
  },

  // --- tracks --------------------------------------------------------------

  addTrack(partial: Partial<Track> = {}): Track {
    const stem = partial.stem;
    const meta = stem && stem !== 'full' ? STEM_META[stem] : undefined;
    const track: Track = {
      id: partial.id ?? newId('track'),
      name: partial.name ?? meta?.label ?? 'Track',
      hue: partial.hue ?? meta?.hue ?? 210,
      volume: partial.volume ?? 0.85,
      pan: partial.pan ?? 0,
      mute: partial.mute ?? false,
      solo: partial.solo ?? false,
      lowGain: partial.lowGain ?? 0,
      midGain: partial.midGain ?? 0,
      highGain: partial.highGain ?? 0,
      effects: partial.effects ?? [],
      automation: partial.automation ?? [],
      height: partial.height ?? 84,
      stem,
    };
    store.update('Add track', (p) => ({ ...p, tracks: [...p.tracks, track] }));
    return track;
  },

  updateTrack(id: string, patch: Partial<Track>, opts?: { history?: boolean }): void {
    store.update(
      'Update track',
      (p) => ({ ...p, tracks: p.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }),
      opts,
    );
  },

  removeTrack(id: string): void {
    store.update('Remove track', (p) => ({
      ...p,
      tracks: p.tracks.filter((t) => t.id !== id),
      clips: p.clips.filter((c) => c.trackId !== id),
    }));
  },

  moveTrack(id: string, delta: number): void {
    store.update('Reorder track', (p) => {
      const i = p.tracks.findIndex((t) => t.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= p.tracks.length) return p;
      const tracks = [...p.tracks];
      const [moved] = tracks.splice(i, 1);
      tracks.splice(j, 0, moved!);
      return { ...p, tracks };
    });
  },

  toggleSolo(id: string): void {
    store.update('Toggle solo', (p) => ({
      ...p,
      tracks: p.tracks.map((t) => (t.id === id ? { ...t, solo: !t.solo } : t)),
    }));
  },

  toggleMute(id: string): void {
    store.update('Toggle mute', (p) => ({
      ...p,
      tracks: p.tracks.map((t) => (t.id === id ? { ...t, mute: !t.mute } : t)),
    }));
  },

  clearSolo(): void {
    store.update('Clear solo', (p) => ({
      ...p,
      tracks: p.tracks.map((t) => (t.solo ? { ...t, solo: false } : t)),
    }));
  },

  // --- effects -------------------------------------------------------------

  addEffect(target: string | 'master', type: EffectType): EffectSettings {
    const settings: EffectSettings = {
      id: newId('fx'),
      type,
      enabled: true,
      params: defaultParams(type),
    };
    store.update('Add effect', (p) => {
      if (target === 'master') {
        return { ...p, master: { ...p.master, effects: [...p.master.effects, settings] } };
      }
      return {
        ...p,
        tracks: p.tracks.map((t) =>
          t.id === target ? { ...t, effects: [...t.effects, settings] } : t,
        ),
      };
    });
    return settings;
  },

  updateEffect(
    target: string | 'master',
    effectId: string,
    patch: Partial<EffectSettings>,
    opts?: { history?: boolean },
  ): void {
    const apply = (list: EffectSettings[]) =>
      list.map((e) =>
        e.id === effectId ? { ...e, ...patch, params: { ...e.params, ...patch.params } } : e,
      );
    store.update(
      'Adjust effect',
      (p) =>
        target === 'master'
          ? { ...p, master: { ...p.master, effects: apply(p.master.effects) } }
          : {
              ...p,
              tracks: p.tracks.map((t) => (t.id === target ? { ...t, effects: apply(t.effects) } : t)),
            },
      opts,
    );
  },

  removeEffect(target: string | 'master', effectId: string): void {
    const apply = (list: EffectSettings[]) => list.filter((e) => e.id !== effectId);
    store.update('Remove effect', (p) =>
      target === 'master'
        ? { ...p, master: { ...p.master, effects: apply(p.master.effects) } }
        : {
            ...p,
            tracks: p.tracks.map((t) => (t.id === target ? { ...t, effects: apply(t.effects) } : t)),
          },
    );
  },

  setMaster(patch: Partial<MasterState>, opts?: { history?: boolean }): void {
    store.update('Adjust master', (p) => ({ ...p, master: { ...p.master, ...patch } }), opts);
  },

  // --- clips ---------------------------------------------------------------

  addClip(clip: Clip): void {
    store.update('Add clip', (p) => ({ ...p, clips: [...p.clips, clip] }));
  },

  addClips(clips: Clip[], label = 'Add clips'): void {
    store.update(label, (p) => ({ ...p, clips: [...p.clips, ...clips] }));
  },

  updateClip(id: string, patch: Partial<Clip>, opts?: { history?: boolean }): void {
    store.update(
      'Edit clip',
      (p) => ({ ...p, clips: p.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) }),
      opts,
    );
  },

  removeClip(id: string): void {
    store.update('Delete clip', (p) => ({ ...p, clips: p.clips.filter((c) => c.id !== id) }));
  },

  removeClips(ids: string[]): void {
    const set = new Set(ids);
    store.update('Delete clips', (p) => ({ ...p, clips: p.clips.filter((c) => !set.has(c.id)) }));
  },

  /** Repeat a clip back to back, `times` copies in total. */
  loopClip(id: string, times: number): void {
    store.update('Loop clip', (p) => {
      const clip = p.clips.find((c) => c.id === id);
      if (!clip || times < 2) return p;
      const copies: Clip[] = [];
      for (let i = 1; i < times; i++) {
        copies.push({ ...clip, id: newId('clip'), start: clip.start + clip.duration * i });
      }
      return { ...p, clips: [...p.clips, ...copies] };
    });
  },

  /**
   * Change a clip's speed while keeping its start fixed.
   *
   * `factor` multiplies playback speed: 0.5 is half-time, 2 is double-time.
   */
  setClipSpeed(id: string, factor: number): void {
    store.update('Change clip speed', (p) => ({
      ...p,
      clips: p.clips.map((c) => {
        if (c.id !== id) return c;
        const sourceDuration = c.duration / c.stretch;
        const stretch = 1 / factor;
        return { ...c, stretch, duration: sourceDuration * stretch };
      }),
    }));
  },

  /** Paste clips at `at`, preserving their relative positions. */
  pasteClips(clips: Clip[], at: number, trackFallback?: string): number {
    if (clips.length === 0) return 0;
    const earliest = Math.min(...clips.map((c) => c.start));
    const project = store.getState().project;
    const valid = clips.filter((c) => project.tracks.some((t) => t.id === c.trackId) || trackFallback);
    if (valid.length === 0) return 0;
    const pasted = valid.map((c) => ({
      ...c,
      id: newId('clip'),
      trackId: project.tracks.some((t) => t.id === c.trackId) ? c.trackId : trackFallback!,
      start: at + (c.start - earliest),
    }));
    store.update('Paste clips', (p) => ({ ...p, clips: [...p.clips, ...pasted] }));
    return pasted.length;
  },

  duplicateClip(id: string): void {
    store.update('Duplicate clip', (p) => {
      const clip = p.clips.find((c) => c.id === id);
      if (!clip) return p;
      return {
        ...p,
        clips: [...p.clips, { ...clip, id: newId('clip'), start: clip.start + clip.duration }],
      };
    });
  },

  /** Cut a clip in two at `time`, keeping both halves' source offsets correct. */
  splitClip(id: string, time: number): void {
    store.update('Split clip', (p) => {
      const clip = p.clips.find((c) => c.id === id);
      if (!clip) return p;
      const local = time - clip.start;
      if (local <= 0.01 || local >= clip.duration - 0.01) return p;
      const left: Clip = { ...clip, duration: local, fadeOut: Math.min(clip.fadeOut, local / 2) };
      const right: Clip = {
        ...clip,
        id: newId('clip'),
        start: time,
        offset: clip.offset + local / clip.stretch,
        duration: clip.duration - local,
        fadeIn: Math.min(clip.fadeIn, (clip.duration - local) / 2),
      };
      return { ...p, clips: [...p.clips.filter((c) => c.id !== id), left, right] };
    });
  },

  // --- automation ----------------------------------------------------------

  addAutomationLane(trackId: string, target: AutomationTarget): void {
    store.update('Add automation lane', (p) => ({
      ...p,
      tracks: p.tracks.map((t) =>
        t.id === trackId && !t.automation.some((l) => l.target === target)
          ? {
              ...t,
              automation: [
                ...t.automation,
                { id: newId('auto'), target, enabled: true, points: [] } satisfies AutomationLane,
              ],
            }
          : t,
      ),
    }));
  },

  updateAutomationLane(
    trackId: string,
    laneId: string,
    patch: Partial<AutomationLane>,
    opts?: { history?: boolean },
  ): void {
    store.update(
      'Edit automation',
      (p) => ({
        ...p,
        tracks: p.tracks.map((t) =>
          t.id === trackId
            ? { ...t, automation: t.automation.map((l) => (l.id === laneId ? { ...l, ...patch } : l)) }
            : t,
        ),
      }),
      opts,
    );
  },

  removeAutomationLane(trackId: string, laneId: string): void {
    store.update('Remove automation lane', (p) => ({
      ...p,
      tracks: p.tracks.map((t) =>
        t.id === trackId ? { ...t, automation: t.automation.filter((l) => l.id !== laneId) } : t,
      ),
    }));
  },

  // --- versions ------------------------------------------------------------

  saveVersion(name: string): Version {
    const project = store.getState().project;
    const version: Version = {
      id: newId('ver'),
      name,
      createdAt: Date.now(),
      tracks: structuredClone(project.tracks),
      clips: structuredClone(project.clips),
    };
    store.update('Save version', (p) => ({
      ...p,
      versions: [...p.versions, version],
      activeVersionId: version.id,
    }));
    return version;
  },

  loadVersion(id: string): void {
    store.update('Load version', (p) => {
      const version = p.versions.find((v) => v.id === id);
      if (!version) return p;
      return {
        ...p,
        tracks: structuredClone(version.tracks),
        clips: structuredClone(version.clips),
        activeVersionId: id,
      };
    });
  },

  removeVersion(id: string): void {
    store.update('Delete version', (p) => ({
      ...p,
      versions: p.versions.filter((v) => v.id !== id),
      activeVersionId: p.activeVersionId === id ? null : p.activeVersionId,
    }));
  },

  undo: () => store.undo(),
  redo: () => store.redo(),
};

/** Find or create the track that should hold a given stem. */
export function trackForStem(project: Project, stem: ClipStem, preferredName?: string): Track {
  const existing = project.tracks.find((t) => t.stem === stem);
  if (existing) return existing;
  const meta = stem !== 'full' ? STEM_META[stem] : undefined;
  return actions.addTrack({
    stem,
    name: preferredName ?? meta?.label ?? 'Full mix',
    hue: meta?.hue ?? 204,
  });
}
