# Domain docs

Single-context domain documentation layout for `silo-tizen`.

## Before exploring, read these

- [GLOSSARY.md](../../GLOSSARY.md) for canonical terms and `_Avoid_` lists.
- [docs/domain-model.md](../domain-model.md) for entity relationships, Authority lifecycle, Library visibility, and playback rules.
- `docs/adr/` for architectural decisions touching the area you plan to change (created lazily; skip silently if absent).

## File structure

```
/
├── GLOSSARY.md
├── docs/
│   ├── domain-model.md
│   └── adr/
│       └── 0001-decision-slug.md
└── src/
```

Create `docs/adr/` lazily when a hard-to-reverse, surprising trade-off decision is settled.

## Using domain vocabulary

- Use the exact terms defined in `GLOSSARY.md` across code, issues, PRs, plans, and tests, avoiding synonyms listed under `_Avoid_`.
- When a needed concept is missing from `GLOSSARY.md`, check whether an existing term fits or note the gap for `/domain-modeling`.
- When a proposal conflicts with an existing ADR, call out the conflict explicitly:

> _Contradicts ADR-NNNN (short title), worth reopening because..._
