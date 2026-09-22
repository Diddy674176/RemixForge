import type { ClipStem } from '../state/types.ts';
import type { SectionLabel } from '../audio/analysis/structure.ts';
import type { EffectType } from '../state/types.ts';

/** Words a producer would actually type, mapped to stem ids. */
export const STEM_WORDS: { words: string[]; stem: ClipStem }[] = [
  { words: ['lead vocal', 'lead vocals', 'vocal', 'vocals', 'voice', 'singer', 'acapella'], stem: 'lead-vocals' },
  { words: ['backing vocal', 'backing vocals', 'harmonies', 'backups', 'background vocals'], stem: 'backing-vocals' },
  { words: ['drum', 'drums', 'beat', 'beats', 'percussion kit'], stem: 'drums' },
  { words: ['kick', 'bass drum'], stem: 'kick' },
  { words: ['snare'], stem: 'snare' },
  { words: ['hihat', 'hi-hat', 'hi-hats', 'hihats', 'hats'], stem: 'hihat' },
  { words: ['perc', 'percussion'], stem: 'percussion' },
  { words: ['bass', 'bassline', 'low end', '808'], stem: 'bass' },
  { words: ['melody', 'lead', 'tune'], stem: 'melody' },
  { words: ['instrumental', 'backing track', 'the music', 'beat track'], stem: 'instrumental' },
  { words: ['full mix', 'whole track', 'everything'], stem: 'full' },
  { words: ['other', 'rest'], stem: 'other' },
];

export const SECTION_WORDS: { words: string[]; label: SectionLabel }[] = [
  { words: ['intro'], label: 'intro' },
  { words: ['verse'], label: 'verse' },
  { words: ['pre-chorus', 'prechorus', 'pre chorus'], label: 'pre-chorus' },
  { words: ['chorus', 'hook'], label: 'chorus' },
  { words: ['bridge'], label: 'bridge' },
  { words: ['drop'], label: 'drop' },
  { words: ['breakdown'], label: 'breakdown' },
  { words: ['instrumental section'], label: 'instrumental' },
  { words: ['outro', 'ending'], label: 'outro' },
];

export const EFFECT_WORDS: { words: string[]; type: EffectType }[] = [
  { words: ['reverb', 'room', 'space', 'hall'], type: 'reverb' },
  { words: ['delay', 'echo'], type: 'delay' },
  { words: ['chorus effect', 'chorusing'], type: 'chorus' },
  { words: ['flanger'], type: 'flanger' },
  { words: ['phaser'], type: 'phaser' },
  { words: ['distortion', 'distort'], type: 'distortion' },
  { words: ['saturation', 'warmth', 'tape'], type: 'saturation' },
  { words: ['compressor', 'compression'], type: 'compressor' },
  { words: ['limiter'], type: 'limiter' },
  { words: ['gate', 'noise gate'], type: 'gate' },
  { words: ['de-esser', 'deesser', 'de esser', 'sibilance'], type: 'deesser' },
  { words: ['bitcrush', 'bitcrusher', 'crush'], type: 'bitcrush' },
  { words: ['lofi', 'lo-fi'], type: 'lofi' },
  { words: ['widener', 'width', 'wider', 'stereo'], type: 'widener' },
  { words: ['high-pass', 'highpass', 'hpf'], type: 'highpass' },
  { words: ['low-pass', 'lowpass', 'lpf'], type: 'lowpass' },
];

/** Longest match wins, so "backing vocals" beats "vocals". */
export function matchLongest<R extends { words: string[] }, T>(
  text: string,
  table: readonly R[],
  pick: (row: R) => T,
): { value: T; word: string } | null {
  let best: { value: T; word: string } | null = null;
  for (const row of table) {
    for (const word of row.words) {
      if (!text.includes(word)) continue;
      if (!best || word.length > best.word.length) best = { value: pick(row), word };
    }
  }
  return best;
}

export const EXAMPLES = [
  'Make the vocals louder',
  'Use the drums from source 2',
  'Try the vocals over source 3',
  'Match everything to 128 BPM',
  'Reduce the bass during the verse',
  'Clean up the vocals',
  'Make the transitions smoother',
  'Add reverb to the lead vocals',
  'Move the chorus 8 bars earlier',
  'Mute the backing vocals',
  'Pan the hi-hats left',
  'High-pass the melody at 200 Hz',
];
