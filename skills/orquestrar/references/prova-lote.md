# Proof batch — the proof session and its judge

Read when `orq batch take` printed a batch (`Prova: lote(N)`): the arbiter to open both
sessions, the proof session and the judge to do their part. Read only this page and the
siblings it names.

`orq` below = `~/.claude/skills/orquestrar/scripts/orq.py --dir <durable dir>`.

## The arbiter

1. `orq batch take` prints `lote <n>: T<N> <roteiro> <commit> …`: one Task per triple, the
   roteiro as an absolute path.
2. Open the proof session from the executor row (recipe in `arbitro-lancamento.md`) on the
   integrated branch, at the tip that holds every printed commit. Kick-off: this page's path,
   `Role: proof session`, `Batch: <n>`, the printed line whole, the durable dir.
3. Every result file written → open the judge from the reviewer row. Kick-off: this page's path,
   `Role: proof judge`, `Batch: <n>`, the durable dir.
4. A `fail` in `pareceres/lote-<n>.md` → ONE fix Task in the next wave, through the gate
   (`arbitro.md`, steps 2–5), naming every failed Task and its result file.

Done when `pareceres/lote-<n>.md` exists and its failures, if any, are one Task of the next wave.

## The proof session

1. Per printed Task: the roteiro path and the commit it proves.
   `git merge-base --is-ancestor <commit> HEAD` for each; one missing → stop and tell the arbiter.
2. Run each roteiro whole, in the printed order, on that tree. Change no code: a failure is
   written, not fixed.
3. Per Task write `<durable dir>/provas/lote-<n>/task<N>.md`: first line `pass` or `fail`; then,
   per roteiro step, what you did and what you saw, with the absolute path of each evidence file
   (logs, captures), kept under `<durable dir>/provas/lote-<n>/`.
4. Send the arbiter the directory path; nothing else.

Done when every printed Task has its result file.

## The judge (reviewer row)

1. Read each `provas/lote-<n>/task<N>.md`, its roteiro and the evidence it points to (a roteiro
   citing a skill: read that skill's reviewer side). A roteiro step without evidence is `fail`,
   reason "no evidence".
2. Write `<durable dir>/pareceres/lote-<n>.md`, one line per Task:
   `T<N>: pass | fail — <reason, evidence path>`.
3. Send the arbiter the path. You fix nothing and open no Task.

Done when every Task of the batch has its pass or fail line.
