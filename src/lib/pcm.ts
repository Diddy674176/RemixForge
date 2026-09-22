/**
 * Web Audio's typed-array signatures are generic over the backing buffer and
 * insist on a plain `ArrayBuffer`. Arrays we build always satisfy that, but
 * the inferred type is the wider `ArrayBufferLike`, so this narrows it in one
 * place rather than scattering casts through the audio code.
 */
export function asPcm(data: Float32Array): Float32Array<ArrayBuffer> {
  return data as Float32Array<ArrayBuffer>;
}
