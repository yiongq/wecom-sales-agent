<script setup lang="ts">
import { computed, ref } from 'vue';
import { withBase } from 'vitepress';
import { loadSearch, searchGuides, type SearchEntry } from './search';
const query = ref('');
const entries = ref<SearchEntry[]>([]);
const state = ref<'idle' | 'loading' | 'ready' | 'error'>('idle');
const matches = computed(() => searchGuides(entries.value, query.value));
async function load() {
  if (state.value === 'ready' || state.value === 'loading') return;
  state.value = 'loading';
  try {
    entries.value = await loadSearch(fetch, withBase('/search-index.json'));
    state.value = 'ready';
  } catch {
    state.value = 'error';
  }
}
function close(event: KeyboardEvent) {
  const details = (event.target as HTMLElement).closest('details');
  if (details) {
    details.open = false;
    details.querySelector('summary')?.focus();
  }
}
function open(event: Event) {
  if ((event.target as HTMLDetailsElement).open) void load();
}
</script>
<template>
  <details class="guide-search" @toggle="open" @keydown.esc="close">
    <summary>搜索指南</summary>
    <div class="search-panel">
      <noscript><p>搜索需要 JavaScript，请通过正文的指南目录阅读。</p></noscript>
      <label for="guide-query">在六类使用指南中搜索</label>
      <input id="guide-query" v-model="query" type="search" autocomplete="off" placeholder="试试：报价审批" />
      <button v-if="query" type="button" @click="query = ''">清除搜索</button>
      <div aria-live="polite">
        <p v-if="state === 'loading'">正在加载本地搜索…</p>
        <div v-else-if="state === 'error'" role="alert">
          <p>搜索暂时不可用，仍可通过目录阅读正文。</p>
          <button type="button" @click="load">重试搜索</button>
        </div>
        <p v-else-if="!query.trim()">输入型号、产品库或权限等关键词。</p>
        <p v-else-if="!matches.length">没有找到相关指南。可清除搜索后重试。</p>
        <ul v-else>
          <li v-for="entry in matches" :key="entry.href">
            <a :href="entry.href">{{ entry.title }}</a>
            <p>{{ entry.text.slice(0, 90) }}…</p>
          </li>
        </ul>
      </div>
    </div>
  </details>
</template>
