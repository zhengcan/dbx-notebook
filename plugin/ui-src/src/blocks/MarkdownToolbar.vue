<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { t } from '../i18n'
import type { MdAction } from '../markdown/toolbarActions'
import { ICONS, type ToolbarIcon } from './toolbarIcons'
import { isMacPlatform } from './mdPlatform'

const props = defineProps<{ composing: boolean }>()
const emit = defineEmits<{ action: [a: MdAction]; image: []; escape: [] }>()

type Item = { id: ToolbarIcon; key: 'mdtb.heading' | 'mdtb.bold' | 'mdtb.italic' | 'mdtb.code' | 'mdtb.codeBlock' | 'mdtb.link' | 'mdtb.quote' | 'mdtb.ul' | 'mdtb.ol' | 'mdtb.table' | 'mdtb.image'; keys?: string }
const GROUPS: Item[][] = [
  [{ id: 'heading', key: 'mdtb.heading' }, { id: 'bold', key: 'mdtb.bold', keys: 'B' }, { id: 'italic', key: 'mdtb.italic', keys: 'I' }, { id: 'code', key: 'mdtb.code' }],
  [{ id: 'codeBlock', key: 'mdtb.codeBlock' }, { id: 'link', key: 'mdtb.link', keys: 'K' }],
  [{ id: 'quote', key: 'mdtb.quote' }, { id: 'ul', key: 'mdtb.ul' }, { id: 'ol', key: 'mdtb.ol' }],
  [{ id: 'table', key: 'mdtb.table' }, { id: 'image', key: 'mdtb.image' }],
]
const ITEMS = GROUPS.flat()

const mod = isMacPlatform() ? '⌘' : 'Ctrl+'
const label = (i: Item) => t(i.key, { mod })
const root = ref<HTMLElement | null>(null)
const btns = ref<HTMLButtonElement[]>([])
const active = ref(0)
const idx = (id: ToolbarIcon) => ITEMS.findIndex((i) => i.id === id)
const shortcuts = computed(() => (isMacPlatform() ? 'Meta+' : 'Control+'))

function focusAt(i: number) {
  const n = Math.min(Math.max(i, 0), ITEMS.length - 1)
  active.value = n
  void nextTick(() => btns.value[n]?.focus())
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); emit('escape'); return }
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
  const cur = btns.value.indexOf(document.activeElement as HTMLButtonElement)
  const from = cur >= 0 ? cur : active.value
  let to = -1
  if (e.key === 'ArrowRight') to = from + 1
  else if (e.key === 'ArrowLeft') to = from - 1
  else if (e.key === 'Home') to = 0
  else if (e.key === 'End') to = ITEMS.length - 1
  if (to < 0) return
  e.preventDefault()
  focusAt(to)
}
function click(i: Item) {
  if (props.composing) return
  if (i.id === 'image') emit('image')
  else emit('action', i.id)
}
function focusActive() { btns.value[active.value]?.focus() }
defineExpose({ focusActive, root })
</script>

<template>
  <div ref="root" class="md-toolbar" role="toolbar" aria-orientation="horizontal" :aria-label="t('mdtb.label')" @mousedown.prevent @keydown="onKey">
    <span v-for="(g, gi) in GROUPS" :key="gi" class="tb-grp">
      <button
        v-for="i in g"
        :key="i.id"
        ref="btns"
        type="button"
        class="tb-btn"
        :data-action="i.id"
        :title="label(i)"
        :aria-label="label(i)"
        :aria-keyshortcuts="i.keys ? shortcuts + i.keys : undefined"
        :aria-disabled="composing ? 'true' : undefined"
        :tabindex="idx(i.id) === active ? 0 : -1"
        @focus="active = idx(i.id)"
        @click="click(i)"
      >
        <!-- eslint-disable-next-line vue/no-v-html -->
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" v-html="ICONS[i.id]" />
      </button>
    </span>
  </div>
</template>

<style scoped>
.md-toolbar { display: flex; flex-wrap: wrap; gap: 2px 0; padding: 2px; box-sizing: border-box; background: var(--color-muted, #f4f4f5); border: 1px solid var(--color-border, #ddd); border-bottom: 0; border-radius: 4px 4px 0 0; margin: 0; }
.tb-grp { display: inline-flex; gap: 2px; padding: 0 4px; border-right: 1px solid var(--color-border, #ddd); }
.tb-grp:first-child { padding-left: 0; }
.tb-grp:last-child { border-right: 0; padding-right: 0; }
.tb-btn { width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border: 1px solid transparent; border-radius: 4px; background: transparent; color: var(--color-foreground, inherit); cursor: pointer; }
.tb-btn svg { width: 16px; height: 16px; stroke: currentColor; fill: none; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
.tb-btn :deep(svg text) { fill: currentColor; stroke: none; font: 600 5.5px system-ui; }
.tb-btn :deep(svg .fl) { fill: currentColor; stroke: none; }
.tb-btn:hover { background: var(--color-background, #fff); border-color: var(--color-border, #ddd); }
.tb-btn:active { background: color-mix(in srgb, var(--color-primary, #3b82f6) 24%, var(--color-background, #fff)); border-color: var(--color-primary, #3b82f6); }
.tb-btn:focus-visible { outline: 2px solid var(--color-primary, #3b82f6); outline-offset: 1px; }
.tb-btn[aria-disabled='true'] { opacity: 0.45; cursor: not-allowed; }
.tb-btn[aria-disabled='true']:hover { background: transparent; border-color: transparent; }
</style>
