<script setup lang="ts">
import { computed, ref } from 'vue'
import { lineDiff } from './lineDiff'
import { t } from '../i18n'
import { DIFF_HIGHLIGHT_MAX_LINES, makeLineHighlighter } from './diffHighlight'
import { useSqlContrastGuard } from './useSqlContrastGuard'

const props = defineProps<{ before: string; after: string }>()
const lines = computed(() => lineDiff(props.before, props.after))
const host = ref<HTMLElement | null>(null)
useSqlContrastGuard(host)
const hl = computed(() => makeLineHighlighter(lines.value.length <= DIFF_HIGHLIGHT_MAX_LINES))
const mark = { same: ' ', add: '+', del: '-' } as const
const label = (k: 'same' | 'add' | 'del') => t(k === 'same' ? 'ai.diffSame' : k === 'add' ? 'ai.diffAdd' : 'ai.diffDel')
</script>

<template>
  <pre ref="host" class="diff" data-test="ai-diff" tabindex="0" role="group" :aria-label="t('ai.suggestion')"><span v-if="!lines.length" class="empty">{{ t('ai.diffEmpty') }}</span><span v-for="(l, i) in lines" :key="i" class="ln" :class="l.kind" :data-kind="l.kind"><span class="mk" aria-hidden="true">{{ mark[l.kind] }}</span><span class="sr">{{ label(l.kind) }}: </span><span class="tx" v-html="hl(l.text)"></span>
</span></pre>
</template>

<style scoped>
.diff { margin: 4px 0; padding: 6px; max-height: 280px; overflow: auto; font-family: var(--font-mono, monospace); font-size: 12px; border: 1px solid var(--color-border); border-radius: 4px; background: var(--color-background); color: var(--color-foreground); white-space: pre-wrap; user-select: text; }
.ln { display: block; }
.mk { display: inline-block; width: 1.5em; color: var(--color-muted-foreground); }
.ln.add { background: color-mix(in srgb, var(--color-success) 18%, transparent); }
.ln.del { background: color-mix(in srgb, var(--color-destructive) 18%, transparent); text-decoration: line-through; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.empty { color: var(--color-muted-foreground); }
</style>
