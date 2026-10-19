---
name: New target
about: Propose a destination for purchases or refunds
labels: enhancement
---

**Destination** (name and link to its server-side or conversions API docs)

**Endpoint and auth** (URL, how the credential is sent, where a user finds it)

**Purchase fields it needs** (and which of them the worker already has: see `Order` and `Identity` in `src/core/types.ts`)

**Refunds** (does the API support them, and how)

**Consent category** (analytics, marketing, preferences or sale_of_data) and why

**Browser identity it needs** (cookies or click ids the pixel would have to collect)

**Test mode** (does the API have one)

**Are you planning to write it?**

docs/writing-a-target.md explains the contract.
