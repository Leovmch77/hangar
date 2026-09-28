<script lang="ts">
  import * as m from '../paraglide/messages';
  import { renderMarkdown } from '../lib/markdown';

  // Skill que o harness injetou como fala do usuário: uma linha recolhida, com o SKILL.md
  // renderizado só quando a pessoa abre (skill grande em toda conversa custaria render à toa).
  interface Props { skill: { name: string; path?: string | null; body: string } }
  let { skill }: Props = $props();

  let aberto = $state(false);
</script>

<details class="skill" bind:open={aberto}>
  <summary title={skill.path ?? undefined}>{m.notice_skill_loaded({ name: skill.name })}</summary>
  {#if aberto}
    <div class="md">{@html renderMarkdown(skill.body)}</div>
  {/if}
</details>

<style>
  .skill {
    margin: var(--space-2) 0;
    font-size: 0.78rem;
    color: var(--text-muted);
  }
  summary {
    text-align: center;
    cursor: pointer;
    list-style-position: inside;
  }
  .md {
    margin-top: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-left: 2px solid var(--border-subtle);
    color: var(--text-secondary);
    overflow-wrap: anywhere;
  }
</style>
