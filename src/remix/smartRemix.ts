import type { ClipStem, Project, Source } from '../state/types.ts';
import { compatibilityOf, scoreLabel, type Compatibility } from './compatibility.ts';

export interface RemixPart {
  stem: ClipStem;
  sourceId: string;
}

export interface RemixProposal {
  id: string;
  title: string;
  summary: string;
  parts: RemixPart[];
  compatibility: Compatibility;
  /** Sections are taken per-part rather than playing each source end to end. */
  sectionBased: boolean;
}

const VOCAL_STEMS: ClipStem[] = ['lead-vocals', 'backing-vocals'];

function hasStem(source: Source, stem: ClipStem): boolean {
  return stem === 'full' ? true : Boolean(source.stems[stem]?.ready);
}

function nameOf(sources: Source[], id: string): string {
  return sources.find((s) => s.id === id)?.name ?? 'Unknown';
}

/**
 * Propose stem combinations across the imported sources.
 *
 * Nothing is filtered out for scoring badly — awkward pairings are proposed
 * with their conflicts spelled out, because those are often the interesting
 * ones.
 */
export function proposeRemixes(sources: Source[], limit = 6): RemixProposal[] {
  const ready = sources.filter((s) => s.analysis);
  if (ready.length < 2) return [];

  const proposals: RemixProposal[] = [];
  const pairs: { a: Source; b: Source; comp: Compatibility }[] = [];

  for (const a of ready) {
    for (const b of ready) {
      if (a.id === b.id) continue;
      if (!VOCAL_STEMS.some((s) => hasStem(a, s))) continue;
      pairs.push({ a, b, comp: compatibilityOf(a, b) });
    }
  }
  pairs.sort((x, y) => y.comp.score - x.comp.score);

  for (const { a, b, comp } of pairs) {
    if (proposals.length >= limit) break;

    // 1. Straight swap: one track's vocal over another's instrumental.
    if (hasStem(a, 'lead-vocals') && hasStem(b, 'instrumental')) {
      proposals.push({
        id: `remix-${a.id}-${b.id}-simple`,
        title: `${a.name} vocals × ${b.name} instrumental`,
        summary: `Lead vocals from ${a.name} over the full instrumental of ${b.name}. ${scoreLabel(comp.score)} match.`,
        parts: [
          { stem: 'lead-vocals', sourceId: a.id },
          { stem: 'instrumental', sourceId: b.id },
        ],
        compatibility: comp,
        sectionBased: false,
      });
    }

    // 2. Layered build: rhythm section and melody from different sources.
    const drumDonor = ready.find((s) => s.id !== a.id && hasStem(s, 'drums'));
    const bassDonor = ready.find((s) => s.id !== a.id && hasStem(s, 'bass'));
    if (
      proposals.length < limit &&
      hasStem(a, 'lead-vocals') &&
      drumDonor &&
      bassDonor &&
      hasStem(b, 'melody')
    ) {
      proposals.push({
        id: `remix-${a.id}-${b.id}-layered`,
        title: `${a.name} vocals + layered rhythm section`,
        summary: `Vocals from ${a.name}, drums from ${drumDonor.name}, bass from ${bassDonor.name}, melody from ${b.name}.`,
        parts: [
          { stem: 'lead-vocals', sourceId: a.id },
          { stem: 'drums', sourceId: drumDonor.id },
          { stem: 'bass', sourceId: bassDonor.id },
          { stem: 'melody', sourceId: b.id },
        ],
        compatibility: comp,
        sectionBased: false,
      });
    }

    // 3. Section-based: verse from one singer, chorus from another.
    const secondVocal = ready.find(
      (s) => s.id !== a.id && s.id !== b.id && hasStem(s, 'lead-vocals'),
    );
    if (proposals.length < limit && hasStem(a, 'lead-vocals') && secondVocal && hasStem(b, 'instrumental')) {
      proposals.push({
        id: `remix-${a.id}-${secondVocal.id}-sections`,
        title: `Verse ${a.name} / chorus ${secondVocal.name}`,
        summary: `Verse vocals from ${a.name}, chorus vocals from ${secondVocal.name}, instrumental from ${b.name}. Built section by section.`,
        parts: [
          { stem: 'lead-vocals', sourceId: a.id },
          { stem: 'lead-vocals', sourceId: secondVocal.id },
          { stem: 'instrumental', sourceId: b.id },
        ],
        compatibility: comp,
        sectionBased: true,
      });
    }
  }

  return proposals.slice(0, limit);
}

/** Human-readable part list, for proposal cards. */
export function describeParts(proposal: RemixProposal, sources: Source[]): string[] {
  return proposal.parts.map((p) => {
    const label = p.stem === 'full' ? 'Full mix' : p.stem.replace(/-/g, ' ');
    return `${label} — ${nameOf(sources, p.sourceId)}`;
  });
}

/** Suggested project tempo: the median of the sources involved. */
export function suggestedTempo(project: Project, sources: Source[], proposal: RemixProposal): number {
  const bpms = proposal.parts
    .map((p) => sources.find((s) => s.id === p.sourceId)?.analysis?.displayBpm)
    .filter((b): b is number => typeof b === 'number')
    .sort((a, b) => a - b);
  if (bpms.length === 0) return project.bpm;
  return Math.round(bpms[bpms.length >> 1]!);
}

/** Suggested project key: the key of whichever source supplies the lead vocal. */
export function suggestedKey(
  sources: Source[],
  proposal: RemixProposal,
): { tonic: number; mode: 'major' | 'minor' } | null {
  const vocalPart = proposal.parts.find((p) => p.stem === 'lead-vocals');
  const source = sources.find((s) => s.id === vocalPart?.sourceId);
  const key = source?.analysis?.key;
  return key ? { tonic: key.tonic, mode: key.mode } : null;
}
