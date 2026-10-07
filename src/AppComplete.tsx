import ReviewWorkspace from './core/ReviewWorkspace'
import { COMPLETE_CONFIG } from './core/config'
import { ASR_ENABLED } from './lib/apiBase'

// Direct handoff build: open the bundled demo with every review and AI tool
// enabled, including Timeline and Conflicts, without showing the study launcher.
export default function AppComplete() {
  return (
    <ReviewWorkspace
      config={
        ASR_ENABLED
          ? COMPLETE_CONFIG
          : { ...COMPLETE_CONFIG, allowAutoTranscribe: false, allowRecord: false }
      }
    />
  )
}
