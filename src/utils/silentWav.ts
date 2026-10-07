// Builds a silent mono 16-bit PCM WAV blob of the given duration.
// Used as a placeholder so wavesurfer renders a usable waveform/timeline
// without a real audio file.
export function makeSilentWav(durationSeconds: number, sampleRate = 8000): Blob {
  const numSamples = Math.floor(durationSeconds * sampleRate)
  const bytesPerSample = 2
  const dataSize = numSamples * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }

  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)         // PCM chunk size
  view.setUint16(20, 1, true)          // format = PCM
  view.setUint16(22, 1, true)          // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true) // byte rate
  view.setUint16(32, bytesPerSample, true)              // block align
  view.setUint16(34, 16, true)                          // bits per sample
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)
  // samples are already zero — silence.

  return new Blob([buffer], { type: 'audio/wav' })
}
