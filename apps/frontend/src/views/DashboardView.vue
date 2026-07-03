<script setup lang="ts">
import Button from 'primevue/button';
import Card from 'primevue/card';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const router = useRouter();
const auth = useAuthStore();

const email = computed(() => auth.user?.email ?? '');
const role = computed(() => auth.user?.role ?? '');
const displayName = computed(() => auth.user?.name ?? auth.user?.email ?? '');

const loggingOut = ref(false);

// Bootstrap the freshest profile when the dashboard opens. `reload` surfaces
// failures as store state (error + retry) instead of throwing.
onMounted(() => {
  void auth.reload();
});

async function onLogout(): Promise<void> {
  loggingOut.value = true;
  try {
    await auth.logout();
  } catch {
    // auth.logout() clears the local session in its own finally; a failed
    // server-side logout must not strand the user on this protected page.
  } finally {
    await router.push({ name: 'login' });
    loggingOut.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center p-4">
    <Card class="w-full max-w-md shadow-lg">
      <template #title>
        <span class="text-xl font-semibold">Dashboard</span>
      </template>
      <template #content>
        <div class="flex flex-col gap-4 pt-2">
          <div
            v-if="auth.error"
            data-testid="dashboard-error"
            role="alert"
            aria-live="assertive"
            class="flex flex-col gap-3"
          >
            <p class="text-red-500">{{ auth.error }}</p>
            <Button label="Retry" :loading="auth.loading" @click="auth.reload()" />
          </div>

          <div
            v-else-if="auth.loading && !auth.user"
            data-testid="dashboard-loading"
            class="text-surface-500"
          >
            Loading your profile…
          </div>

          <template v-else>
            <p class="text-base">
              Signed in as <span class="font-medium">{{ displayName }}</span>
            </p>
            <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt class="font-medium text-surface-500">Email</dt>
              <dd>{{ email }}</dd>
              <dt class="font-medium text-surface-500">Role</dt>
              <dd>{{ role }}</dd>
            </dl>
            <Button
              label="Reload"
              severity="secondary"
              outlined
              :loading="auth.loading"
              @click="auth.reload()"
            />
          </template>

          <Button label="Log out" severity="secondary" :loading="loggingOut" @click="onLogout" />
        </div>
      </template>
    </Card>
  </div>
</template>
