<script setup lang="ts">
import { computed, ref } from 'vue'
import { renderMarkdownSafe } from '../export/markdown'
import { useSqlContrastGuard } from './useSqlContrastGuard'

const props = defineProps<{ text: string; streaming?: boolean }>()
const host = ref<HTMLElement | null>(null)
useSqlContrastGuard(host)

const html = computed(() => {
  if (props.streaming) return ''
  const doc = new DOMParser().parseFromString(`<body>${renderMarkdownSafe(props.text, { highlightSql: true })}</body>`, 'text/html')
  doc.querySelectorAll('a').forEach((a) => {
    if (/^https?:/i.test(a.getAttribute('href') ?? '')) { a.setAttribute('rel', 'noopener noreferrer'); a.removeAttribute('target') } else a.removeAttribute('href')
  })
  doc.querySelectorAll('img').forEach((img) => img.replaceWith(doc.createTextNode(img.getAttribute('alt') ?? '')))
  doc.querySelectorAll('table').forEach((tb) => {
    const wrap = doc.createElement('div')
    wrap.className = 'tbl'
    wrap.tabIndex = 0
    tb.replaceWith(wrap)
    wrap.appendChild(tb)
  })
  return doc.body.innerHTML
})
</script>

<template>
  <p v-if="streaming" class="txt plain">{{ text }}</p>
  <div v-else ref="host" class="txt md" data-test="chat-md" v-html="html" />
</template>

<style scoped>
.plain { margin: 2px 0 0; white-space: pre-wrap; word-break: break-word; user-select: text; }
.md { margin: 2px 0 0; word-break: break-word; user-select: text; }
.md :deep(> :first-child) { margin-top: 0; }
.md :deep(> :last-child) { margin-bottom: 0; }
.md :deep(p), .md :deep(ul), .md :deep(ol), .md :deep(pre), .md :deep(blockquote) { margin: 0 0 6px; }
.md :deep(ul), .md :deep(ol) { padding-left: 20px; }
.md :deep(h1), .md :deep(h2), .md :deep(h3), .md :deep(h4), .md :deep(h5), .md :deep(h6) { margin: 8px 0 4px; font-size: 1em; font-weight: 600; }
.md :deep(code) { font-family: ui-monospace, monospace; font-size: 12px; background: var(--color-background); border-radius: 3px; padding: 0 3px; }
.md :deep(pre) { background: var(--color-background); border: 1px solid var(--color-border); border-radius: 4px; padding: 6px 8px; overflow: auto; }
.md :deep(pre code) { background: none; padding: 0; white-space: pre; }
.md :deep(blockquote) { border-left: 3px solid var(--color-border); padding-left: 8px; color: var(--color-muted-foreground); }
.md :deep(.tbl) { overflow-x: auto; margin: 0 0 6px; max-width: 100%; }
.md :deep(table) { border-collapse: collapse; font-size: 12px; }
.md :deep(th), .md :deep(td) { border: 1px solid var(--color-border); padding: 2px 6px; text-align: left; }
.md :deep(th) { background: var(--color-background); }
.md :deep(a) { color: var(--color-primary); text-decoration: underline; }
.md :deep(a:focus-visible), .md:focus-visible, .md :deep(.tbl:focus-visible) { outline: 2px solid var(--color-primary); outline-offset: 1px; }
</style>
