<script setup lang="ts">
interface Suggestion { id: string; name: string; file: string; matched: string[] }

const q = ref('')
const suggestions = ref<Suggestion[]>([])
const open = ref(false)
const active = ref(0)
const error = ref('')
let timer: ReturnType<typeof setTimeout> | undefined

async function fetchSuggestions() {
  try {
    suggestions.value = await $fetch<Suggestion[]>('/api/search', { query: { q: q.value } })
    error.value = ''
  } catch {
    suggestions.value = []
    error.value = 'Search service is not reachable — is the Flask backend running?'
  }
  active.value = 0
  open.value = true
}

watch(q, () => {
  clearTimeout(timer)
  timer = setTimeout(fetchSuggestions, 150)
})

function go(s = suggestions.value[active.value]) {
  if (s) navigateTo(`/case/${s.id}`)
}

function onKey(e: KeyboardEvent) {
  const n = suggestions.value.length
  if (e.key === 'ArrowDown' && n) active.value = (active.value + 1) % n
  else if (e.key === 'ArrowUp' && n) active.value = (active.value - 1 + n) % n
  else if (e.key === 'Enter') go()
  else if (e.key === 'Escape') open.value = false
  else return
  e.preventDefault()
}
</script>

<template>
  <main class="min-h-screen bg-gradient-to-br from-white to-[#f1f4f8]">
    <div class="mx-auto max-w-6xl px-4 py-10 md:px-8">
      <AppHeader />
      <hr class="mt-8 border-t-2 border-black">

      <div class="mt-16 flex justify-center gap-3">
        <button
          type="button" disabled title="Coming soon"
          class="cursor-not-allowed rounded-lg border border-zinc-200 bg-white px-6 py-2.5 text-zinc-400"
        >
          Start new process
        </button>
        <button type="button" class="rounded-lg bg-black px-6 py-2.5 text-white">
          Search
        </button>
      </div>

      <div class="relative mx-auto mt-10 max-w-5xl">
        <form class="flex items-center gap-4 rounded-2xl bg-[#e5e6ea] py-4 pl-8 pr-4" @submit.prevent="go()">
          <input
            v-model="q" type="text" autocomplete="off" aria-label="Search process name or number"
            placeholder="search process name, number or tag"
            class="min-w-0 flex-1 bg-transparent py-3 text-lg outline-none placeholder:text-zinc-400"
            @focus="fetchSuggestions" @blur="open = false" @keydown="onKey"
          >
          <button
            type="submit" aria-label="Open" :disabled="!suggestions.length"
            class="grid size-12 shrink-0 place-items-center rounded-lg bg-white text-xl disabled:opacity-50"
          >
            →
          </button>
        </form>

        <ul
          v-if="open && (suggestions.length || error || q)"
          class="absolute inset-x-0 top-full z-10 mt-2 overflow-hidden rounded-xl border border-zinc-100 bg-white shadow-lg"
        >
          <li v-if="error" class="px-6 py-4 text-sm text-red-600">{{ error }}</li>
          <li v-else-if="!suggestions.length" class="px-6 py-4 text-sm text-zinc-500">No process matches “{{ q }}”</li>
          <li
            v-for="(s, i) in suggestions" :key="s.id"
            class="flex cursor-pointer items-center gap-4 px-6 py-3"
            :class="i === active ? 'bg-zinc-100' : ''"
            @mousedown.prevent="go(s)" @mouseenter="active = i"
          >
            <span class="rounded-md bg-black px-2 py-0.5 font-mono text-xs text-white">{{ s.id }}</span>
            <span class="capitalize">{{ s.name }}</span>
            <span v-if="s.matched.length" class="ml-auto truncate text-xs text-zinc-500">
              tag: {{ s.matched.join(', ') }}
            </span>
          </li>
        </ul>
      </div>
    </div>
  </main>
</template>
