# Named target routing

**Single principle: fuzzy-similarity matching by target name.**

When the user names a target — in chat, in a voice transcript, or anywhere else — match the named alias by similarity to the closest registered target name in the harness's target list. Use substring containment, edit distance, and phonetic similarity together; the highest-similarity match wins.

Voice transcripts have known mishearings on short proper-noun aliases (`bot-alpha` → "Bought Alpha", "Boat Alpha"). **Re-read the transcript twice if a target name is involved**, and prefer any reasonable similarity match over a default.

Apply this LITERALLY before any default/fallback routing. Only fall back to a generic catch-all (e.g. `<harness>/default`) when no reasonable similarity match exists across the registered targets.

```
Registered targets: <harness>/bot-alpha, <harness>/bot-beta, <harness>/default

User: "Tell Bought Alpha to review the PR."  →  <harness>/bot-alpha   (phonetic match)
User: "Ask beta what it thinks."              →  <harness>/bot-beta   (substring match)
User: "Sync with the other agent."            →  <harness>/default    (no name → fallback OK)
```
