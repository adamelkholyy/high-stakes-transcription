import ReviewWorkspace from './core/ReviewWorkspace'
import { FULL_CONFIG } from './core/config'

// Full / Scottish-police build: every feature, free risk-dimension toggle,
// upload + record + auto-transcribe, free-text case focus.
export default function AppFull() {
  return <ReviewWorkspace config={FULL_CONFIG} />
}
