import type { ModelName, Transcript, Word } from '../types'

export const MODELS: ModelName[] = [
  'Model A (Whisper-large)',
  'Model B (wav2vec2)',
  'Model C (Consensus)',
]

export const DEFAULT_MODEL: ModelName = 'Model A (Whisper-large)'

const w = (text: string): Word => ({ text, risk: 'low' })

const m = (text: string, alternatives: string[]): Word => ({
  text,
  risk: 'med',
  alternatives,
})

const h = (text: string, alternatives: string[]): Word => ({
  text,
  risk: 'high',
  alternatives,
})

// Split a plain sentence into low-risk Word objects.
const lo = (text: string): Word[] =>
  text
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => w(t))

export const mockTranscript: Transcript = {
  audioDuration: 280,
  segments: [
    // 1. Officer opening — record-of-time preamble.
    {
      id: 1,
      speaker: 'Officer',
      start: 0,
      end: 14,
      paraRisk: 'low',
      words: {
        'Model A (Whisper-large)': lo(
          'For the record, this interview is being conducted at Riverside Police Station on the morning of Thursday, the',
        ),
        'Model B (wav2vec2)': lo(
          'For the record, this interview is being conducted at Riverside Police Station on the morning of Thursday, the',
        ),
        'Model C (Consensus)': lo(
          'For the record, this interview is being conducted at Riverside Police Station on the morning of Thursday, the',
        ),
      },
    },

    // 2. Date — fourteenth / fortieth.
    {
      id: 2,
      speaker: 'Officer',
      start: 15,
      end: 30,
      paraRisk: 'med',
      words: {
        'Model A (Whisper-large)': [
          m('fourteenth', ['fourteenth', 'fortieth']),
          ...lo('of March, two thousand and twenty-four, at exactly nine forty-two in the morning.'),
        ],
        'Model B (wav2vec2)': [
          m('fortieth', ['fourteenth', 'fortieth']),
          ...lo('of March, two thousand and twenty-four, at exactly nine forty-two in the morning.'),
        ],
        'Model C (Consensus)': [
          m('fourteenth', ['fourteenth', 'fortieth']),
          ...lo('of March, two thousand and twenty-four, at exactly nine forty-two in the morning.'),
        ],
      },
    },

    // 3. Officer roll call + name request.
    {
      id: 3,
      speaker: 'Officer',
      start: 31,
      end: 50,
      paraRisk: 'low',
      words: {
        'Model A (Whisper-large)': lo(
          'Present in the room are myself, Detective Sergeant Marlowe, and the interviewee. For the record, please state your full name and current address.',
        ),
        'Model B (wav2vec2)': lo(
          'Present in the room are myself, Detective Sergeant Marlowe, and the interviewee. For the record, please state your full name and current address.',
        ),
        'Model C (Consensus)': lo(
          'Present in the room are myself, Detective Sergeant Marlowe, and the interviewee. For the record, please state your full name and current address.',
        ),
      },
    },

    // 4. Witness self-intro — Daniel / Damien.
    {
      id: 4,
      speaker: 'Witness',
      start: 51,
      end: 72,
      paraRisk: 'med',
      words: {
        'Model A (Whisper-large)': [
          ...lo('My name is'),
          m('Daniel', ['Daniel', 'Damien']),
          ...lo('Hargreaves, spelled H-A-R-G-R-E-A-V-E-S. I live at forty-seven Ashfield Road, in the Mill End district of the city, and I have lived at that address for approximately six years.'),
        ],
        'Model B (wav2vec2)': [
          ...lo('My name is'),
          m('Damien', ['Daniel', 'Damien']),
          ...lo('Hargreaves, spelled H-A-R-G-R-E-A-V-E-S. I live at forty-seven Ashfield Road, in the Mill End district of the city, and I have lived at that address for approximately six years.'),
        ],
        'Model C (Consensus)': [
          ...lo('My name is'),
          m('Daniel', ['Daniel', 'Damien']),
          ...lo('Hargreaves, spelled H-A-R-G-R-E-A-V-E-S. I live at forty-seven Ashfield Road, in the Mill End district of the city, and I have lived at that address for approximately six years.'),
        ],
      },
    },

    // 5. Officer prompt about events — saw / seized.
    {
      id: 5,
      speaker: 'Officer',
      start: 73,
      end: 94,
      paraRisk: 'med',
      words: {
        'Model A (Whisper-large)': [
          ...lo('Thank you, Mr Hargreaves. I want to take you back to the events of last Saturday evening. Can you tell me, in your own words, what you'),
          m('saw', ['saw', 'seized']),
          ...lo('when you first arrived at the property on Whitcombe Lane?'),
        ],
        'Model B (wav2vec2)': [
          ...lo('Thank you, Mr Hargreaves. I want to take you back to the events of last Saturday evening. Can you tell me, in your own words, what you'),
          m('seized', ['saw', 'seized']),
          ...lo('when you first arrived at the property on Whitcombe Lane?'),
        ],
        'Model C (Consensus)': [
          ...lo('Thank you, Mr Hargreaves. I want to take you back to the events of last Saturday evening. Can you tell me, in your own words, what you'),
          m('saw', ['saw', 'seized']),
          ...lo('when you first arrived at the property on Whitcombe Lane?'),
        ],
      },
    },

    // 6. Witness — scene / seen.
    {
      id: 6,
      speaker: 'Witness',
      start: 95,
      end: 122,
      paraRisk: 'med',
      words: {
        'Model A (Whisper-large)': [
          ...lo('Yes. I arrived at around eight in the evening. The front door was already slightly ajar, which struck me as unusual. When I walked in, the'),
          m('scene', ['scene', 'seen']),
          ...lo('inside was chaotic. Furniture was overturned, a lamp had been smashed against the wall, and the back door at the far end of the hallway was wide open.'),
        ],
        'Model B (wav2vec2)': [
          ...lo('Yes. I arrived at around eight in the evening. The front door was already slightly ajar, which struck me as unusual. When I walked in, the'),
          m('seen', ['scene', 'seen']),
          ...lo('inside was chaotic. Furniture was overturned, a lamp had been smashed against the wall, and the back door at the far end of the hallway was wide open.'),
        ],
        'Model C (Consensus)': [
          ...lo('Yes. I arrived at around eight in the evening. The front door was already slightly ajar, which struck me as unusual. When I walked in, the'),
          m('scene', ['scene', 'seen']),
          ...lo('inside was chaotic. Furniture was overturned, a lamp had been smashed against the wall, and the back door at the far end of the hallway was wide open.'),
        ],
      },
    },

    // 7. Officer follow-up — knife / life.
    {
      id: 7,
      speaker: 'Officer',
      start: 123,
      end: 148,
      paraRisk: 'med',
      words: {
        'Model A (Whisper-large)': [
          ...lo('I want to be careful here. You mentioned earlier, during the initial statement at the scene, that you had observed a'),
          m('knife', ['knife', 'life']),
          ...lo('resting on the kitchen counter, partially obscured by a folded tea towel. Is that account still correct, to the best of your recollection?'),
        ],
        'Model B (wav2vec2)': [
          ...lo('I want to be careful here. You mentioned earlier, during the initial statement at the scene, that you had observed a'),
          m('life', ['knife', 'life']),
          ...lo('resting on the kitchen counter, partially obscured by a folded tea towel. Is that account still correct, to the best of your recollection?'),
        ],
        'Model C (Consensus)': [
          ...lo('I want to be careful here. You mentioned earlier, during the initial statement at the scene, that you had observed a'),
          m('knife', ['knife', 'life']),
          ...lo('resting on the kitchen counter, partially obscured by a folded tea towel. Is that account still correct, to the best of your recollection?'),
        ],
      },
    },

    // 8. Witness — CRITICAL HIGH-RISK. Model B drops "not".
    {
      id: 8,
      speaker: 'Witness',
      start: 149,
      end: 180,
      paraRisk: 'high',
      words: {
        'Model A (Whisper-large)': [
          ...lo('Yes, that is correct, and I stand by what I told the responding officers at the scene. But I want to be absolutely clear, for the record and on the advice of my solicitor — I did'),
          h('not', ['not', '']),
          ...lo('have a gun, a firearm, or any kind of weapon on my person at any point that evening.'),
        ],
        'Model B (wav2vec2)': [
          ...lo('Yes, that is correct, and I stand by what I told the responding officers at the scene. But I want to be absolutely clear, for the record and on the advice of my solicitor — I did'),
          // "not" dropped here — the meaning-flipping error.
          ...lo('have a gun, a firearm, or any kind of weapon on my person at any point that evening.'),
        ],
        'Model C (Consensus)': [
          ...lo('Yes, that is correct, and I stand by what I told the responding officers at the scene. But I want to be absolutely clear, for the record and on the advice of my solicitor — I did'),
          h('not', ['not', '']),
          ...lo('have a gun, a firearm, or any kind of weapon on my person at any point that evening.'),
        ],
      },
    },

    // 9. Officer recap — low risk.
    {
      id: 9,
      speaker: 'Officer',
      start: 181,
      end: 208,
      paraRisk: 'low',
      words: {
        'Model A (Whisper-large)': lo(
          'Understood, and that is noted. Just so the record is clear, and so there can be no ambiguity later when this statement is reviewed by the Crown Prosecution Service, you are saying that you were unarmed at the time you entered the property at Whitcombe Lane.',
        ),
        'Model B (wav2vec2)': lo(
          'Understood, and that is noted. Just so the record is clear, and so there can be no ambiguity later when this statement is reviewed by the Crown Prosecution Service, you are saying that you were unarmed at the time you entered the property at Whitcombe Lane.',
        ),
        'Model C (Consensus)': lo(
          'Understood, and that is noted. Just so the record is clear, and so there can be no ambiguity later when this statement is reviewed by the Crown Prosecution Service, you are saying that you were unarmed at the time you entered the property at Whitcombe Lane.',
        ),
      },
    },

    // 10. Witness closing — low risk.
    {
      id: 10,
      speaker: 'Witness',
      start: 209,
      end: 248,
      paraRisk: 'low',
      words: {
        'Model A (Whisper-large)': lo(
          'That is exactly what I am saying. I have never owned a firearm in my entire life, I have never held a firearms certificate of any description, and I did not bring any weapon with me on the night in question. I went there to check on my brother, nothing more, nothing less.',
        ),
        'Model B (wav2vec2)': lo(
          'That is exactly what I am saying. I have never owned a firearm in my entire life, I have never held a firearms certificate of any description, and I did not bring any weapon with me on the night in question. I went there to check on my brother, nothing more, nothing less.',
        ),
        'Model C (Consensus)': lo(
          'That is exactly what I am saying. I have never owned a firearm in my entire life, I have never held a firearms certificate of any description, and I did not bring any weapon with me on the night in question. I went there to check on my brother, nothing more, nothing less.',
        ),
      },
    },
  ],
}
