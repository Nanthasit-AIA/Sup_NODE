<script setup lang="ts">
import { REVIEW_ACTION_LABEL, type ReviewAction, type ReviewRequest } from '~/utils/assess'

const props = defineProps<{ request: ReviewRequest | null; caseId: string }>()
const emit = defineEmits<{ close: []; saved: [] }>()

const dialog = ref<HTMLDialogElement>()
const reviewer = ref('')
const role = ref('')
const action = ref<ReviewAction>('confirm_assessment')
const values = ref<Record<string, string | number | null>>({})
const reason = ref('')
const evidence = ref('')
const error = ref('')
const busy = ref(false)

// The reviewer's name and role are remembered in this browser only.
onMounted(() => {
  try {
    reviewer.value = localStorage.getItem('sn.reviewer') ?? ''
    role.value = localStorage.getItem('sn.role') ?? ''
  }
  catch { /* storage blocked: the fields just start empty */ }
})

watch(() => props.request, (r) => {
  if (!r) return dialog.value?.close()
  action.value = r.actions[0]!
  values.value = Object.fromEntries((r.fields ?? []).map(f => [f.key, f.value]))
  reason.value = evidence.value = error.value = ''
  dialog.value?.showModal()
})

const change = computed(() => {
  const out: Record<string, unknown> = { ...props.request?.change }
  for (const f of props.request?.fields ?? []) if (values.value[f.key] !== f.value) out[f.key] = values.value[f.key]
  return out
})
const ready = computed(() => reviewer.value.trim() && role.value.trim() && reason.value.trim()
  && (action.value !== 'revise' || Object.keys(change.value).length))

async function submit() {
  if (!props.request || !ready.value) return
  busy.value = true
  error.value = ''
  try {
    await $fetch(`/api/assess/${props.caseId}/review`, {
      method: 'POST',
      body: {
        deviation: props.request.deviation, item: props.request.item, action: action.value,
        change: action.value === 'revise' ? change.value : {}, reviewer: reviewer.value, role: role.value, reason: reason.value, evidence: evidence.value,
      },
    })
    try {
      localStorage.setItem('sn.reviewer', reviewer.value)
      localStorage.setItem('sn.role', role.value)
    }
    catch { /* not remembered, still saved on the server */ }
    emit('saved')
  }
  catch (e) {
    error.value = `Could not save the decision (${(e as { statusCode?: number }).statusCode ?? 'network error'}).`
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <dialog
    ref="dialog" class="m-auto w-[min(560px,calc(100vw-32px))] rounded-2xl bg-white p-0 shadow-2xl backdrop:bg-black/40"
    @close="emit('close')" @click.self="dialog?.close()"
  >
    <form v-if="request" class="space-y-4 p-6 text-sm" @submit.prevent="submit">
      <header class="flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <p class="font-mono text-[11px] text-zinc-400">{{ request.item }}</p>
          <h3 class="mt-0.5 text-lg font-medium leading-snug">{{ request.title }}</h3>
        </div>
        <button type="button" aria-label="Close" class="text-zinc-400 hover:text-black" @click="dialog?.close()">✕</button>
      </header>

      <fieldset v-if="request.actions.length > 1" class="flex flex-wrap gap-2">
        <legend class="mb-1 text-xs text-zinc-500">Decision</legend>
        <label v-for="a in request.actions" :key="a" class="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5" :class="action === a ? 'border-black' : 'border-zinc-200'">
          <input v-model="action" type="radio" :value="a" class="accent-black">{{ REVIEW_ACTION_LABEL[a] }}
        </label>
      </fieldset>

      <div v-if="action === 'revise' && request.fields?.length" class="grid gap-3 sm:grid-cols-2">
        <label v-for="f in request.fields" :key="f.key" class="block">
          <span class="text-xs text-zinc-500">{{ f.label }}</span>
          <select v-model="values[f.key]" class="mt-1 w-full rounded-md border border-zinc-200 px-2 py-1.5">
            <option v-for="o in f.options" :key="String(o.value)" :value="o.value">{{ o.label }}</option>
          </select>
        </label>
      </div>

      <label class="block">
        <span class="text-xs text-zinc-500">Reason (required)</span>
        <textarea v-model="reason" rows="2" class="mt-1 w-full rounded-md border border-zinc-200 px-2 py-1.5" />
      </label>
      <label class="block">
        <span class="text-xs text-zinc-500">Evidence (document, test record, drawing reference)</span>
        <input v-model="evidence" class="mt-1 w-full rounded-md border border-zinc-200 px-2 py-1.5">
      </label>
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="block">
          <span class="text-xs text-zinc-500">Reviewer</span>
          <input v-model="reviewer" autocomplete="name" class="mt-1 w-full rounded-md border border-zinc-200 px-2 py-1.5">
        </label>
        <label class="block">
          <span class="text-xs text-zinc-500">Role</span>
          <input v-model="role" placeholder="e.g. process safety engineer" class="mt-1 w-full rounded-md border border-zinc-200 px-2 py-1.5">
        </label>
      </div>

      <p v-if="error" class="text-xs text-red-600">{{ error }}</p>
      <footer class="flex items-center gap-3">
        <p class="flex-1 text-[11px] leading-relaxed text-zinc-400">
          Logged with your name, role, the time and the input versions. The log is append-only.
        </p>
        <button type="submit" :disabled="!ready || busy" class="rounded-lg bg-black px-4 py-2 text-white disabled:opacity-40">
          {{ busy ? 'Saving…' : 'Save decision' }}
        </button>
      </footer>
    </form>
  </dialog>
</template>
