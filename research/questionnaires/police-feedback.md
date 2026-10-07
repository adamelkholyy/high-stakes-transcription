# Police feedback questionnaire

Static archive of the approved police-feedback questionnaire. This file is not
connected to the prototype and does not collect responses.

Unless a question is explicitly marked optional, radio and scale questions are
required. Open-text questions are optional.

## Professional background

These questions help us understand the range of professional experience
represented in the study.

1. **How often does your work involve reviewing interviews, statements, audio, or transcripts?** (`bg1`, required)
   - Daily
   - Weekly
   - Monthly
   - A few times per year
   - Less than once per year
   - Never
2. **How familiar are you with automatic transcription tools?** (`bg2`, required)
   - Not at all familiar
   - Slightly familiar
   - Moderately familiar
   - Very familiar
   - Extremely familiar
3. **How familiar are you with AI-assisted work tools?** (`bg3`, required)
   - Not at all familiar
   - Slightly familiar
   - Moderately familiar
   - Very familiar
   - Extremely familiar
4. **If you are comfortable doing so, please tell us a little more about your professional background (for example, country or region, role, years of policing experience, or other relevant experience).** (`bg4`, optional, open text)

## A. Overall impact

1. **To what extent could this tool improve current practice?** (`imp1`, required)
   - Scale: 1 = Not at all; 5 = Significantly
2. **Please explain your answer.** (`imp2`, optional, open text)

For the following statements, use: 1 = Strongly disagree; 2 = Disagree;
3 = Neither agree nor disagree; 4 = Agree; 5 = Strongly agree; or Not sure.

3. **Overall, I feel like using this interface is likely to result in time saving.** (`oa1`, required)
4. **Overall, I feel like this interface is likely to result in more accurate transcripts.** (`oa2`, required)
5. **I believe the interface would help me find important information quicker.** (`oa3`, required)
6. **The interface would improve handover to another officer or team.** (`oa4`, required)
7. **The interface could support handover to typist or CPS.** (`oa5`, required)
8. **I would want to use this (or a slightly improved) interface in my work.** (`oa6`, required)
9. **The interface provides all the functions I need for transcript review.** (`oa7`, required)
10. **AI-generated summary and information can be traced to its audio source and verified.** (`oa8`, required)

## C. Overall feedback — auditability and workflow

For agreement statements, use the agreement scale above, including Not sure.

1. **The change log clearly records edits and verification actions.** (`aw1`, required)
2. **The export options provide an appropriate review record.** (`aw2`, required)
3. **The manually verified text is clearly distinguished from the automated transcript.** (`aw3`, required)
4. **How useful is segment verification?** (`aw4`, required)
   - Scale: 1 = Not useful; 5 = Extremely useful; or Not sure
5. **How useful is the clean view / show changes control?** (`aw5`, required)
   - Scale: 1 = Not useful; 5 = Extremely useful; or Not sure

## E. Transcript review and highlighting

For usefulness questions, use: 1 = Not useful; 5 = Extremely useful; or Not sure.

1. **Overall, how useful are the confidence highlights?** (`hl1`, required)
2. **How useful is the sentence low-confidence highlighting?** (`hl2`, required)
3. **How useful is the word low-confidence highlighting?** (`hl3`, required)
4. **How useful is the Confidence / Importance / Both control?** (`hl4`, required)
5. **How useful is word correction?** (`hl5`, required)
6. **How useful is sentence rewriting?** (`hl6`, required)
7. **Which highlighting approach would you prefer?** (`hlpref`, required)
   - Word highlighting only
   - Sentence highlighting only
   - Both word and sentence highlighting
   - No highlighting
   - It depends on the task
   - Unable to judge

## F. AI tools

For each question, use: 1 = Not useful; 5 = Extremely useful; or Not sure.

1. **How useful is the Find feature?** (`ai1`, required)
2. **How useful is the Assistant feature?** (`ai2`, required)
3. **How useful are the Assistant's source links?** (`ai3`, required)
4. **How useful is the conflict finding feature?** (`ai4`, required)
5. **How useful is the Timeline feature?** (`ai5`, required)
6. **How useful is the Outline feature?** (`ai6`, required)

## H. Feature priorities

**If you wanted to simplify the interface, which features will you keep?**
(`fp1`, optional, select any)

- Sentence low-confidence highlighting
- Word low-confidence highlighting
- Confidence / Importance / Both control
- Word correction
- Sentence rewriting
- Segment verification
- Clean view / show changes control
- Find
- Assistant
- Conflicts
- Timeline
- Outline
- Change log
- Export options

## I. Final comments

All questions in this section are optional open text.

1. **Is there any features / ability that you would want to add?** (`fc1`)
2. **Which features are the most useful, and why?** (`fc2`)
3. **Is any feature inaccurate, misleading, or difficult to verify?** (`fc3`)
4. **Which feature is least useful or hardest to understand, and why?** (`fc4`)
5. **Do you have any other concerns or suggestions?** (`fc5`)

## Archival notes

The former runtime definition recorded these source corrections:

- The time-saving item had no response type/required flag in the source sheet;
  it was treated as a required agreement scale with a Not sure option.
- Two source-sheet rows had their response types swapped; the archived version
  uses the corrected types.
- Obvious source typos were corrected in the runtime version.
