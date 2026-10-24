---
name: Onboarding step file layout
description: Where each onboarding capability is implemented in packages/worker/src/step-engine/steps/onboarding/
type: project
originSessionId: 412b1d33-07e1-405b-9941-ab357c4badf8
---

Step files all live in `packages/worker/src/step-engine/steps/onboarding/`:

- `_agent-templates.ts` — `SEARCH_ORDER_BLOCK` (lines 7-32) injected into every agent body via `buildAgentBody()`. References `.claude/rag/query.py` which does NOT ship. Agent specs (knowledge-miner, code-reviewer, etc.) defined here with `executionSteps` strings that contain hardcoded RAG/grep instructions (e.g. line 161, line 660).
- `07-generate-files.ts` — emits agent files, AGENTS.md, `.claude/commands/*.md`. `BASELINE_COMMANDS` array at line 218 lists the 4 baseline commands (workflow, review, learn, sync-agents-md). Writing loop at 763-764. Candidates path at line 610.
- `08-knowledge-acquisition.ts` — KB generation. Detect proposes topics via LLM, form lets user select, apply writes selected topics into `.claude/knowledge_base/`. KB is split across canonical sections (ARCHITECTURE, API_REFERENCE, etc.), `ANTI_PATTERNS/`, `TECH_PATTERNS/{tech}/`. The detect prompt's topic list controls KB scope — currently misses BEST_PRACTICES/, QUICK_REFERENCE/, BUSINESS_LOGIC.md, DEPLOYMENT.md, SECURITY_STANDARDS.md.
- `09-qa.ts` / `09_1-qa-suggestions.ts` / `09_2-qa-resolve.ts` — KB quality Q&A loop. Refines existing KB; doesn't add new top-level categories.
- `09_5-skill-generation.ts` — skill + sub-skill generation. Prompt body schema at line 762 asks for `## Purpose, ## Process, ## Code Pattern, ## Pitfalls, ## Related` only — 5 sections. Original LLM orchestration emitted 12+ section sub-skills. SKILL.md cap ~1000 tokens is at line 733.
- `09_7-rag-source-selection.ts` — picks code/KB extension set for RAG.
- `10-rag-populate.ts` — chunks + embeds via Ollama into postgres `ai_rag_embeddings` table. Output: `ragMode='internal'`, `tableName='ai_rag_embeddings'`. RAG is server-side; no `.claude/rag/` folder is ever shipped.

Why: investigating onboarding gaps for RDApi project (task 90516357), need to find emit points to remove commands, deepen skills, strip phantom RAG refs.

How to apply: when adding/editing onboarding steps, work from this map. KB scope expansion = edit detect prompt in 08. Sub-skill depth = edit prompt body schema in 09_5 line 762. Commands removal = delete BASELINE_COMMANDS et al in 07. RAG refs = strip SEARCH_ORDER_BLOCK in _agent-templates.ts:7-32.
