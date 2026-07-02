<script setup lang="ts">
import { ApiError } from '@app/api-client';
import Button from 'primevue/button';
import Card from 'primevue/card';
import InputText from 'primevue/inputtext';
import Password from 'primevue/password';
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const router = useRouter();
const auth = useAuthStore();

const email = ref('');
const password = ref('');
const errorMessage = ref<string | null>(null);
const submitting = ref(false);

async function onSubmit(): Promise<void> {
  errorMessage.value = null;
  submitting.value = true;
  try {
    await auth.login(email.value, password.value);
    await router.push({ name: 'dashboard' });
  } catch (error) {
    errorMessage.value =
      error instanceof ApiError ? error.message : 'Unable to sign in. Please try again.';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center p-4">
    <Card class="w-full max-w-sm shadow-lg">
      <template #title>
        <span class="text-xl font-semibold">Sign in</span>
      </template>
      <template #content>
        <form class="flex flex-col gap-4 pt-2" @submit.prevent="onSubmit">
          <div class="flex flex-col gap-2">
            <label for="email" class="text-sm font-medium">Email</label>
            <InputText
              id="email"
              v-model="email"
              type="email"
              autocomplete="email"
              required
              fluid
            />
          </div>
          <div class="flex flex-col gap-2">
            <label for="password" class="text-sm font-medium">Password</label>
            <Password
              v-model="password"
              input-id="password"
              :feedback="false"
              toggle-mask
              fluid
              :input-props="{ autocomplete: 'current-password', required: true }"
            />
          </div>
          <small v-if="errorMessage" class="text-red-500">{{ errorMessage }}</small>
          <Button type="submit" label="Sign in" :loading="submitting" fluid />
        </form>
      </template>
    </Card>
  </div>
</template>
