import { openDB, type IDBPDatabase } from 'idb';
import { audioAssets } from '../audio/assets.ts';
import { store } from './store.ts';
import type { AssetId, Project } from './types.ts';

const DB_NAME = 'remixforge';
const DB_VERSION = 1;
const PROJECTS = 'projects';
const ASSETS = 'assets';
const LAST_PROJECT_KEY = 'remixforge.lastProject';

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: number;
  sourceCount: number;
  clipCount: number;
}

interface StoredProject {
  id: string;
  name: string;
  updatedAt: number;
  project: Project;
}

interface StoredAsset {
  id: AssetId;
  sampleRate: number;
  channels: ArrayBuffer[];
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, DB_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(PROJECTS)) {
        database.createObjectStore(PROJECTS, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(ASSETS)) {
        database.createObjectStore(ASSETS, { keyPath: 'id' });
      }
    },
  });
  return dbPromise;
}

/**
 * Assets a project actually needs: imported sources, their stems, and anything
 * a clip points at. Warp renders are deliberately excluded — they are derived
 * data and cheaper to regenerate than to store.
 */
function referencedAssets(project: Project): Set<AssetId> {
  const ids = new Set<AssetId>();
  for (const source of project.sources) {
    ids.add(source.assetId);
    for (const stem of Object.values(source.stems)) {
      if (stem?.assetId) ids.add(stem.assetId);
    }
  }
  for (const clip of project.clips) {
    if (!clip.assetId.includes('#warp')) ids.add(clip.assetId);
  }
  return ids;
}

export async function saveProject(project: Project): Promise<void> {
  const database = await db();
  const ids = referencedAssets(project);

  const tx = database.transaction([PROJECTS, ASSETS], 'readwrite');
  const assetStore = tx.objectStore(ASSETS);

  for (const id of ids) {
    const existing = await assetStore.getKey(id);
    if (existing !== undefined) continue;
    const asset = audioAssets.get(id);
    if (!asset) continue;
    const record: StoredAsset = {
      id,
      sampleRate: asset.sampleRate,
      // Copy so IndexedDB's structured clone can't detach live playback data.
      channels: asset.channels.map((c) => c.slice().buffer as ArrayBuffer),
    };
    await assetStore.put(record);
  }

  const record: StoredProject = {
    id: project.id,
    name: project.name,
    updatedAt: project.updatedAt,
    project,
  };
  await tx.objectStore(PROJECTS).put(record);
  await tx.done;

  try {
    localStorage.setItem(LAST_PROJECT_KEY, project.id);
  } catch {
    // Storage can be blocked; autosave still works, recovery just won't.
  }
}

export async function loadProject(id: string): Promise<Project | null> {
  const database = await db();
  const record = (await database.get(PROJECTS, id)) as StoredProject | undefined;
  if (!record) return null;

  const ids = referencedAssets(record.project);
  for (const assetId of ids) {
    if (audioAssets.has(assetId)) continue;
    const stored = (await database.get(ASSETS, assetId)) as StoredAsset | undefined;
    if (!stored) continue;
    audioAssets.add(
      stored.channels.map((c) => new Float32Array(c)),
      stored.sampleRate,
      assetId,
    );
  }
  return record.project;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const database = await db();
  const all = (await database.getAll(PROJECTS)) as StoredProject[];
  return all
    .map((r) => ({
      id: r.id,
      name: r.name,
      updatedAt: r.updatedAt,
      sourceCount: r.project.sources.length,
      clipCount: r.project.clips.length,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteProject(id: string): Promise<void> {
  const database = await db();
  await database.delete(PROJECTS, id);
  await pruneAssets();
}

/** Drop stored assets no saved project refers to any more. */
export async function pruneAssets(): Promise<number> {
  const database = await db();
  const projects = (await database.getAll(PROJECTS)) as StoredProject[];
  const keep = new Set<AssetId>();
  for (const p of projects) for (const id of referencedAssets(p.project)) keep.add(id);

  const keys = (await database.getAllKeys(ASSETS)) as AssetId[];
  let removed = 0;
  for (const key of keys) {
    if (!keep.has(key)) {
      await database.delete(ASSETS, key);
      removed++;
    }
  }
  return removed;
}

export async function lastProjectId(): Promise<string | null> {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}

export interface StorageEstimate {
  usedBytes: number;
  quotaBytes: number;
}

export async function storageEstimate(): Promise<StorageEstimate | null> {
  if (!navigator.storage?.estimate) return null;
  const est = await navigator.storage.estimate();
  return { usedBytes: est.usage ?? 0, quotaBytes: est.quota ?? 0 };
}

export type AutosaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Debounced autosave.
 *
 * Writes at most once every `delay` ms after the last change, so a drag of a
 * fader doesn't hammer IndexedDB, and still guarantees a save afterwards.
 */
export function startAutosave(
  delay = 4000,
  onState?: (state: AutosaveState, at: number) => void,
): () => void {
  let timer: number | null = null;
  let lastSaved = 0;

  const flush = async () => {
    const project = store.getState().project;
    if (project.updatedAt === lastSaved) return;
    onState?.('saving', Date.now());
    try {
      await saveProject(project);
      lastSaved = project.updatedAt;
      onState?.('saved', Date.now());
    } catch {
      onState?.('error', Date.now());
    }
  };

  const unsubscribe = store.subscribe(() => {
    if (timer !== null) clearTimeout(timer);
    timer = window.setTimeout(() => void flush(), delay);
  });

  const onHide = () => {
    if (document.visibilityState === 'hidden') void flush();
  };
  document.addEventListener('visibilitychange', onHide);

  return () => {
    unsubscribe();
    document.removeEventListener('visibilitychange', onHide);
    if (timer !== null) clearTimeout(timer);
  };
}

/** Export the project as a JSON file (audio is referenced, not embedded). */
export function exportProjectFile(project: Project): void {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${project.name.replace(/[^\w\-. ]+/g, '_') || 'project'}.remixforge.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
