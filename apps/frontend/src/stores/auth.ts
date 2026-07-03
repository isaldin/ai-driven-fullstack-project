import type { UserDto } from '@app/contracts';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api, describeError, setAccessTokenGetter } from '../lib/api';

export const useAuthStore = defineStore('auth', () => {
  const accessToken = ref<string | null>(null);
  const user = ref<UserDto | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const isAuthenticated = computed(() => accessToken.value !== null && user.value !== null);

  // Let the API client read the in-memory access token without importing the store.
  setAccessTokenGetter(() => accessToken.value);

  async function fetchMe(): Promise<void> {
    user.value = await api.me();
  }

  /**
   * (Re)load the current user's profile, tracking loading/error for the view.
   * Unlike `fetchMe` it never throws — the error is surfaced as state so the
   * dashboard can render an error + retry affordance.
   */
  async function reload(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      await fetchMe();
    } catch (e) {
      error.value = describeError(e, 'Unable to load your profile.');
    } finally {
      loading.value = false;
    }
  }

  async function login(email: string, password: string): Promise<void> {
    const tokens = await api.login({ email, password });
    accessToken.value = tokens.accessToken;
    await fetchMe();
  }

  function clear(): void {
    accessToken.value = null;
    user.value = null;
  }

  async function logout(): Promise<void> {
    try {
      await api.logout();
    } finally {
      clear();
    }
  }

  async function tryRefresh(): Promise<boolean> {
    try {
      const tokens = await api.refresh();
      accessToken.value = tokens.accessToken;
      await fetchMe();
      return true;
    } catch {
      clear();
      return false;
    }
  }

  return {
    accessToken,
    user,
    loading,
    error,
    isAuthenticated,
    fetchMe,
    reload,
    login,
    logout,
    tryRefresh,
  };
});
