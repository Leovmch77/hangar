# Reviewer — the recipe

Read at step 3 of `revisor.md`, for every blocker. A blocker without a recipe is not a delivery.

```
Cause reproduced: <step by step that makes it happen + what is observed>
Where: <file:line, exact function/symbol>
All the callers: <git grep of the symbol — the COMPLETE list, not "and others">
Proof of the recipe: <what I measured that supports step 1 — the MECHANISM I propose, not the defect>
Steps:
  1. <concrete change>
  2. <...>
Final behavior: <what starts happening under the same step by step>
Proof: <test/harness to create or run, and what it must say>
```

## Fields

- One design, described. Cannot close the recipe → investigate more, or downgrade to NOTED
  saying what is missing.
- The caller inventory is mandatory for "unify X", "centralize Y", "every path must validate
  Z": run the `git grep`, paste the list, say what each caller becomes.
- Async data read by a screen → the recipe declares the three states (success, failure,
  pending). An action that types into the user's session → the recipe declares its trigger.
  Same for a recipe the arbiter closes in a replanning.

## Close the class, not the entry

- Defect is a GLOBAL ACTION (focus, scroll, write to a shared store) → inventory the points that
  PERFORM the action (`git grep` the verb); the recipe fixes all at once. Write the cause as
  what the code does wrong; a recipe naming a state or an origin component describes the entry.
- Defect is a STATE stuck or wrong → count the doors that reach the condition, including those
  through no symbol (a media-query `{#if}` unmount, a route change, a parent going away).
  Prefer the fix that closes the condition over one per door.

## Prove the recipe before sending it

1. It proposes a framework MECHANISM (cleanup, lifecycle, unmount, reactivity, flush order) →
   prove the mechanism: stamp the live instance before acting and check the stamp after; a
   presence check does not distinguish "reappeared" from "never left".
2. It picks a NUMBER to contain a symptom (cap, reserve, layout limit) → measure why the element
   has the size it has first.
3. It names a CASE where the rule is an ORDERING → write the rule ("the line belongs to whoever
   claims it most specifically") and ask "and when neither matches?".
