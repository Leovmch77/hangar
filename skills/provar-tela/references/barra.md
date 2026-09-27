# The bar

- One line per pixel-touching Task. Three tests, all mandatory: named (a specific screen), findable
  (absolute screenshot path, or an app screen that can be opened), comparable (same state, same
  width). A Task that draws nothing needs no bar.
- Propose, instead of asking "what's the bar?": two or three candidates already passed through the
  three tests, one sentence each on why it is hard, plus "no bar":

```
Task 3 touches the Settings sheet. Bar — pick one:
a) `EnginesSheet.svelte`, desktop, centered modal, 1440px — same `wide`/`centered` pair.
b) `Git.svelte`, same width — same glass material, with tabs.
c) A screenshot from another product — send me the path.
d) No bar for this Task.
```

- "No bar" chosen → `Bar: none — user's decision, <date>`; that Task's visual gate is the
  `executor.md` protocol without the blind comparison.
- Weak candidates → say so and propose others.
