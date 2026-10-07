import ReviewWorkspace from './core/ReviewWorkspace'
import { SENTENCE_CONFIG } from './core/config'

// Sentence-importance build (Police Scotland feedback round): a local LLM
// triages which sentences matter; word uncertainty marks appear only inside
// those. Same workspace, different paradigm — see SENTENCE_CONFIG.
export default function AppSentence() {
  return <ReviewWorkspace config={SENTENCE_CONFIG} />
}
