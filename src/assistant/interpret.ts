import { actions, newId, trackForStem } from '../state/store.ts';
import { STEM_META } from '../audio/separation/types.ts';
import { autoMix } from '../remix/autoMix.ts';
import { buildFullClip } from '../remix/build.ts';
import { resyncClip, barDuration } from '../remix/sync.ts';
import { smoothTransitions } from '../remix/arrange.ts';
import { defaultParams } from '../audio/effects/definitions.ts';
import { EFFECT_WORDS, SECTION_WORDS, STEM_WORDS, matchLongest } from './vocabulary.ts';
import type { ClipStem, EffectType, Project, Source, Track } from '../state/types.ts';
import type { SectionLabel } from '../audio/analysis/structure.ts';

export interface AssistantResult {
  /** What the assistant understood and did, in plain language. */
  reply: string;
  /** False when nothing was changed — the reply then explains why. */
  applied: boolean;
  /** Suggestions shown when the request wasn't understood. */
  suggestions?: string[];
}

const dbToGain = (db: number) => Math.pow(10, db / 20);

function normalise(input: string): string {
  return input.toLowerCase().replace(/[^\w\s%.+-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function findStem(text: string): ClipStem | null {
  return matchLongest(text, STEM_WORDS, (r) => r.stem)?.value ?? null;
}

function findSection(text: string): SectionLabel | null {
  return matchLongest(text, SECTION_WORDS, (r) => r.label)?.value ?? null;
}

function findEffect(text: string): EffectType | null {
  return matchLongest(text, EFFECT_WORDS, (r) => r.type)?.value ?? null;
}

/** Resolve "source 2", "from Foo Bar", or a bare source name. */
function findSource(text: string, project: Project): Source | null {
  const indexed = /source\s+(\d+)/.exec(text) ?? /track\s+(\d+)/.exec(text);
  if (indexed) {
    const i = Number(indexed[1]) - 1;
    if (i >= 0 && i < project.sources.length) return project.sources[i]!;
  }
  let best: { source: Source; length: number } | null = null;
  for (const source of project.sources) {
    const name = source.name.toLowerCase();
    if (name.length >= 3 && text.includes(name) && (!best || name.length > best.length)) {
      best = { source, length: name.length };
    }
  }
  return best?.source ?? null;
}

function findTrack(text: string, project: Project): Track | null {
  const stem = findStem(text);
  if (stem) {
    const byStem = project.tracks.find((t) => t.stem === stem);
    if (byStem) return byStem;
  }
  let best: { track: Track; length: number } | null = null;
  for (const track of project.tracks) {
    const name = track.name.toLowerCase();
    if (name.length >= 3 && text.includes(name) && (!best || name.length > best.length)) {
      best = { track, length: name.length };
    }
  }
  return best?.track ?? null;
}

/** Turn "a bit", "much", "3 dB" into a decibel delta. */
function amountDb(text: string, direction: 1 | -1): number {
  const explicit = /(-?\d+(?:\.\d+)?)\s*db/.exec(text);
  if (explicit) return Math.abs(Number(explicit[1])) * direction;
  if (/\b(slightly|a bit|a little|touch|hair)\b/.test(text)) return 1.5 * direction;
  if (/\b(much|a lot|way|significantly|loads)\b/.test(text)) return 6 * direction;
  return 3 * direction;
}

function stemLabel(stem: ClipStem): string {
  return stem === 'full' ? 'full mix' : STEM_META[stem].label.toLowerCase();
}

/**
 * Interpret a typed instruction and apply it.
 *
 * Every branch routes through the ordinary store actions, so anything the
 * assistant does lands on the undo stack and can be reverted or hand-edited
 * like any other change. Nothing here is a separate, privileged code path.
 */
export function interpret(input: string, project: Project): AssistantResult {
  const text = normalise(input);
  if (!text) return { reply: 'Type an instruction and I will apply it to the project.', applied: false };

  // --- tempo ---------------------------------------------------------------
  const bpmMatch = /(\d{2,3}(?:\.\d+)?)\s*(?:bpm|beats per minute)/.exec(text);
  if (bpmMatch && /\b(match|set|change|make|sync|go to|to)\b/.test(text)) {
    const bpm = Number(bpmMatch[1]);
    if (bpm >= 20 && bpm <= 300) {
      actions.setTempo(bpm);
      const sources = new Map(project.sources.map((s) => [s.id, s]));
      const resynced = project.clips
        .map((c) => {
          const source = sources.get(c.sourceId);
          return source ? resyncClip(c, source, { ...project, bpm }) : null;
        })
        .filter((c): c is NonNullable<typeof c> => c !== null);
      for (const clip of resynced) actions.updateClip(clip.id, clip, { history: false });
      return {
        reply: `Project tempo set to ${bpm} BPM and ${resynced.length} clip${resynced.length === 1 ? '' : 's'} re-synced.`,
        applied: true,
      };
    }
  }

  // --- swap a stem's source ------------------------------------------------
  const swapMatch =
    /\b(?:use|take|swap in|replace with|switch to)\b.*?\b(?:from|of)\b/.test(text) ||
    /\btry\b.*\bover\b/.test(text);
  if (swapMatch) {
    const stem = findStem(text);
    const source = findSource(text, project);
    if (!stem) {
      return {
        reply: 'I could not tell which part you meant. Name a stem, for example "use the drums from source 2".',
        applied: false,
      };
    }
    if (!source) {
      return {
        reply: `I could not find that source. You have: ${project.sources.map((s, i) => `${i + 1}. ${s.name}`).join(', ') || 'none imported yet'}.`,
        applied: false,
      };
    }
    // "try the vocals over source 2" means keep the vocals, swap the backing.
    const overForm = /\btry\b.*\bover\b/.test(text);
    const targetStem: ClipStem = overForm ? 'instrumental' : stem;
    if (targetStem !== 'full' && !source.stems[targetStem]?.ready) {
      return {
        reply: `${source.name} has no separated ${stemLabel(targetStem)} yet. Separate it first and I will swap it in.`,
        applied: false,
      };
    }

    const track = trackForStem(project, targetStem);
    const current = project.clips.filter((c) => c.trackId === track.id);
    actions.removeClips(current.map((c) => c.id));
    const clip = buildFullClip(project, source, targetStem, track.id, 0);
    if (!clip) return { reply: 'That stem is not available to place.', applied: false };
    actions.addClip(clip);
    return {
      reply: `${stemLabel(targetStem)} now comes from ${source.name}${clip.pitch !== 0 ? `, shifted ${clip.pitch > 0 ? '+' : ''}${clip.pitch} semitones to match the project key` : ''}.`,
      applied: true,
    };
  }

  // --- automatic mix -------------------------------------------------------
  if (/\b(auto ?mix|balance the mix|mix it|fix the mix|balance everything)\b/.test(text)) {
    const result = autoMix(project);
    for (const track of result.tracks) actions.updateTrack(track.id, track, { history: false });
    actions.setMaster({ volume: result.masterGain });
    return {
      reply: `Balanced ${result.decisions.length} track${result.decisions.length === 1 ? '' : 's'}. Open the Mix panel to see every change.`,
      applied: true,
    };
  }

  // --- transitions ---------------------------------------------------------
  if (/\b(transition|transitions|crossfade|smoother|smooth)\b/.test(text)) {
    const smoothed = smoothTransitions(project.clips.map((c) => ({ ...c })));
    for (const clip of smoothed) actions.updateClip(clip.id, clip, { history: false });
    return { reply: 'Crossfades lengthened wherever clips meet, with longer fades between different songs.', applied: true };
  }

  // --- clean up ------------------------------------------------------------
  if (/\b(clean up|cleanup|clean|tidy|de-?noise|remove noise|clarity)\b/.test(text)) {
    const track = findTrack(text, project) ?? project.tracks.find((t) => t.stem === 'lead-vocals');
    if (!track) return { reply: 'I could not tell which track to clean up.', applied: false };
    const additions: EffectType[] = ['gate', 'deesser', 'compressor'];
    const effects = [...track.effects];
    for (const type of additions) {
      if (effects.some((e) => e.type === type)) continue;
      effects.push({ id: newId('fx'), type, enabled: true, params: defaultParams(type) });
    }
    actions.updateTrack(track.id, { effects, highGain: Math.max(track.highGain, 1) });
    return {
      reply: `Added a gate, de-esser and compressor to ${track.name} and lifted the top end slightly.`,
      applied: true,
    };
  }

  // --- add an effect -------------------------------------------------------
  if (/\b(add|put|throw|apply)\b/.test(text)) {
    const type = findEffect(text);
    const track = findTrack(text, project);
    if (type && track) {
      actions.addEffect(track.id, type);
      return { reply: `Added ${type} to ${track.name}.`, applied: true };
    }
    if (type && !track) return { reply: `Which track should I add the ${type} to?`, applied: false };
  }

  // --- filters with a frequency -------------------------------------------
  const hzMatch = /(\d{2,5})\s*(?:hz|hertz)/.exec(text);
  if (hzMatch && /\b(high-?pass|low-?pass|filter|cut)\b/.test(text)) {
    const track = findTrack(text, project);
    if (!track) return { reply: 'Which track should I filter?', applied: false };
    const isLow = /\blow-?pass\b/.test(text);
    const settings = actions.addEffect(track.id, isLow ? 'lowpass' : 'highpass');
    actions.updateEffect(track.id, settings.id, { params: { cutoff: Number(hzMatch[1]) } });
    return {
      reply: `${isLow ? 'Low' : 'High'}-passed ${track.name} at ${hzMatch[1]} Hz.`,
      applied: true,
    };
  }

  // --- mute / solo ---------------------------------------------------------
  if (/\b(mute|silence|drop out)\b/.test(text)) {
    const track = findTrack(text, project);
    if (!track) return { reply: 'Which track should I mute?', applied: false };
    actions.updateTrack(track.id, { mute: true });
    return { reply: `Muted ${track.name}.`, applied: true };
  }
  if (/\b(unmute|bring back)\b/.test(text)) {
    const track = findTrack(text, project);
    if (!track) return { reply: 'Which track should I unmute?', applied: false };
    actions.updateTrack(track.id, { mute: false });
    return { reply: `Unmuted ${track.name}.`, applied: true };
  }
  if (/\b(solo)\b/.test(text)) {
    const track = findTrack(text, project);
    if (!track) return { reply: 'Which track should I solo?', applied: false };
    actions.clearSolo();
    actions.updateTrack(track.id, { solo: true });
    return { reply: `Soloed ${track.name}.`, applied: true };
  }

  // --- panning -------------------------------------------------------------
  if (/\b(pan|centre|center)\b/.test(text)) {
    const track = findTrack(text, project);
    if (!track) return { reply: 'Which track should I pan?', applied: false };
    let pan = 0;
    if (/\bleft\b/.test(text)) pan = /\b(hard|full)\b/.test(text) ? -1 : -0.4;
    else if (/\bright\b/.test(text)) pan = /\b(hard|full)\b/.test(text) ? 1 : 0.4;
    actions.updateTrack(track.id, { pan });
    return {
      reply: `${track.name} panned ${pan === 0 ? 'to the centre' : pan < 0 ? 'left' : 'right'}.`,
      applied: true,
    };
  }

  // --- level, optionally scoped to a section -------------------------------
  const louder = /\b(louder|up|boost|raise|increase|more)\b/.test(text);
  const quieter = /\b(quieter|down|lower|reduce|duck|decrease|less|softer)\b/.test(text);
  if (louder || quieter) {
    const track = findTrack(text, project);
    if (!track) {
      return {
        reply: 'I could not tell which track to change. Try naming the stem, e.g. "make the vocals louder".',
        applied: false,
      };
    }
    const delta = amountDb(text, louder ? 1 : -1);
    const section = findSection(text);

    if (section) {
      const range = sectionRange(project, section);
      if (!range) {
        return {
          reply: `I could not find a ${section} in the analysed sources, so I changed the whole track instead.`,
          applied: false,
        };
      }
      const lane = track.automation.find((l) => l.target === 'volume');
      const base = track.volume;
      const target = Math.max(0.01, base * dbToGain(delta));
      const points = [
        { time: Math.max(0, range.start - 0.4), value: base },
        { time: range.start, value: target },
        { time: range.end, value: target },
        { time: range.end + 0.4, value: base },
      ];
      if (lane) {
        actions.updateAutomationLane(track.id, lane.id, {
          points: [...lane.points, ...points].sort((a, b) => a.time - b.time),
          enabled: true,
        });
      } else {
        actions.addAutomationLane(track.id, 'volume');
        const created = project.tracks.find((t) => t.id === track.id);
        const newLane = created?.automation.find((l) => l.target === 'volume');
        if (newLane) actions.updateAutomationLane(track.id, newLane.id, { points });
      }
      return {
        reply: `${track.name} ${louder ? 'raised' : 'reduced'} by ${Math.abs(delta)} dB during the ${section}, automated back afterwards.`,
        applied: true,
      };
    }

    const volume = Math.max(0.01, Math.min(2, track.volume * dbToGain(delta)));
    actions.updateTrack(track.id, { volume });
    return {
      reply: `${track.name} ${louder ? 'up' : 'down'} ${Math.abs(delta)} dB.`,
      applied: true,
    };
  }

  // --- move a section ------------------------------------------------------
  if (/\b(move|shift|nudge|bring)\b/.test(text)) {
    const earlier = /\b(earlier|forward|sooner|up)\b/.test(text);
    const later = /\b(later|back|after)\b/.test(text);
    if (earlier || later) {
      const bars = Number(/(\d+)\s*bars?/.exec(text)?.[1] ?? 4);
      const delta = bars * barDuration(project.bpm, project.meter) * (earlier ? -1 : 1);
      const section = findSection(text);
      const track = findTrack(text, project);
      const candidates = project.clips.filter(
        (c) => (!track || c.trackId === track.id) && (!section || c.name.toLowerCase().includes(section)),
      );
      const targets = candidates.length ? candidates : project.clips;
      if (targets.length === 0) return { reply: 'There are no clips on the timeline to move.', applied: false };
      for (const clip of targets) {
        actions.updateClip(clip.id, { start: Math.max(0, clip.start + delta) }, { history: false });
      }
      return {
        reply: `Moved ${targets.length} clip${targets.length === 1 ? '' : 's'} ${bars} bar${bars === 1 ? '' : 's'} ${earlier ? 'earlier' : 'later'}.`,
        applied: true,
      };
    }
  }

  return {
    reply: "I didn't understand that one. Here are some things I can do:",
    applied: false,
    suggestions: [
      'Make the vocals louder',
      'Use the drums from source 2',
      'Reduce the bass during the verse',
      'Match everything to 128 BPM',
      'Clean up the vocals',
      'Make the transitions smoother',
    ],
  };
}

/** Timeline range covered by the first clip whose source section matches. */
function sectionRange(project: Project, label: SectionLabel): { start: number; end: number } | null {
  for (const clip of project.clips) {
    const source = project.sources.find((s) => s.id === clip.sourceId);
    const section = source?.analysis?.sections.find((s) => s.label === label);
    if (!section) continue;
    // Map the source-time section onto the clip's place on the timeline.
    const localStart = (section.startTime - clip.offset) * clip.stretch;
    const localEnd = (section.endTime - clip.offset) * clip.stretch;
    if (localEnd <= 0 || localStart >= clip.duration) continue;
    return {
      start: clip.start + Math.max(0, localStart),
      end: clip.start + Math.min(clip.duration, localEnd),
    };
  }
  return null;
}
