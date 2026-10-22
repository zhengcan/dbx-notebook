import { ref } from 'vue'

// While an IME composition is active the DOM value is ahead of the model (updates are not recorded);
// binding `:value` to bound(model) keeps a re-render from resetting the field and destroying the composition.
export function useComposingDraft() {
  const composing = ref(false)
  const draft = ref('')
  return {
    composing,
    start(e: Event) { composing.value = true; draft.value = (e.target as HTMLInputElement | HTMLTextAreaElement).value },
    track(e: Event) { draft.value = (e.target as HTMLInputElement | HTMLTextAreaElement).value },
    end() { composing.value = false },
    bound<T>(v: T): T | string { return composing.value ? draft.value : v },
  }
}
