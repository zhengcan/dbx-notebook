<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { t } from '../i18n'
import type { ChatMessage } from './chatTypes'
import MarkdownMessage from './MarkdownMessage.vue'
import RawOutput from './RawOutput.vue'
import { createImeGuard } from '../ui/imeEnter'

const MAX = 2000
const props = defineProps<{ messages: ChatMessage[]; busy: boolean; progress: string; error: string; rawOutput: string; notices?: string[]; disabledReason?: string; placeholder: string }>()
const emit = defineEmits<{ (e: 'send', text: string): void; (e: 'cancel'): void; (e: 'clear'): void }>()
const uid = Math.random().toString(36).slice(2, 8)
const text = ref('')
const list = ref<HTMLElement | null>(null)
const canSend = computed(() => !props.busy && !props.disabledReason && text.value.trim() !== '')
function onInput(e: Event) {
  const el = e.target as HTMLTextAreaElement
  if (el.value.length > MAX) el.value = el.value.slice(0, MAX)
  text.value = el.value
}
function send() {
  if (!canSend.value) return
  emit('send', text.value.trim())
  text.value = ''
}
const ime = createImeGuard()
function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !ime.isImeEnter(e)) { e.preventDefault(); send() }
}
watch(() => props.messages.length, async () => { await nextTick(); if (list.value) list.value.scrollTop = list.value.scrollHeight })
// Data-tagged parts stay in the cache for prompts but are never shown in the chat.
const body = (m: ChatMessage) => m.parts.filter((p) => p.kind === 'text').map((p) => p.text).join('\n')
const input = ref<HTMLTextAreaElement | null>(null)
// Send is replaced by Cancel (and back): keep keyboard focus from falling to <body>.
watch(() => props.busy, async () => { await nextTick(); if (!document.activeElement || document.activeElement === document.body) input.value?.focus() })
</script>

<template>
  <section class="chat" data-test="chat-pane">
    <div ref="list" class="msgs" data-test="chat-messages" role="log" :aria-label="t('drawer.chat')">
      <div v-for="m in messages" :key="m.id" class="msg" :class="m.role" data-test="chat-msg">
        <span class="who">{{ m.role === 'user' ? t('drawer.you') : t('drawer.ai') }}</span>
        <p v-if="m.role === 'user'" class="txt">{{ body(m) }}</p>
        <MarkdownMessage v-else :text="body(m)" :streaming="busy && m === messages[messages.length - 1]" />
      </div>
    </div>
    <p v-for="(n, i) in notices ?? []" :key="i" class="status" data-test="chat-notice" role="status">{{ n }}</p>
    <p class="status" data-test="chat-progress" role="status" aria-live="polite">{{ busy ? (progress || t('ai.waiting')) : '' }}</p>
    <p v-if="error" class="err" data-test="chat-error" role="alert">{{ error }}</p>
    <RawOutput :text="rawOutput" />
    <p v-if="disabledReason" :id="`chat-why-${uid}`" class="why" data-test="chat-disabled-reason">{{ disabledReason }}</p>
    <div class="row">
      <textarea
        ref="input" class="input" data-test="chat-input" rows="3" :maxlength="MAX" :placeholder="placeholder" :aria-label="t('drawer.inputLabel')"
        :aria-describedby="disabledReason ? `chat-why-${uid}` : undefined" :value="text" @input="onInput" @keydown="onKey" @compositionstart="ime.onCompositionStart()" @compositionend="ime.onCompositionEnd()" @compositioncancel="ime.onReset()" @blur="ime.onReset()"
      />
      <div class="btns">
        <button v-if="busy" type="button" class="btn" data-test="chat-cancel" @click="emit('cancel')">{{ t('ai.cancel') }}</button>
        <button v-else type="button" class="btn primary" data-test="chat-send" :disabled="!canSend" :aria-describedby="disabledReason ? `chat-why-${uid}` : undefined" @click="send">{{ t('drawer.send') }}</button>
        <button type="button" class="btn" data-test="chat-clear" :disabled="busy || messages.length === 0" @click="emit('clear')">{{ t('drawer.clear') }}</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.chat { display: flex; flex-direction: column; gap: 6px; height: 100%; min-height: 0; }
.msgs { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 8px; }
.msg { padding: 6px 8px; border-radius: 6px; border: 1px solid var(--color-border); background: var(--color-muted); }
.msg.user { background: var(--color-background); }
.who { font-size: 11px; color: var(--color-muted-foreground); }
.txt { margin: 2px 0 0; white-space: pre-wrap; word-break: break-word; user-select: text; }
.status { margin: 0; min-height: 1em; font-size: 12px; color: var(--color-muted-foreground); }
.err { margin: 0; color: var(--color-destructive); }
.why { margin: 0; font-size: 12px; color: var(--color-muted-foreground); }
.row { display: flex; gap: 6px; align-items: flex-end; }
.input { flex: 1; resize: vertical; font: inherit; padding: 6px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-background); color: var(--color-foreground); }
.btns { display: flex; flex-direction: column; gap: 4px; }
.btn { font: inherit; padding: 4px 12px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-muted); color: inherit; cursor: pointer; }
.btn.primary { background: var(--color-primary); color: var(--color-primary-foreground); border-color: transparent; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 1px; }
</style>
