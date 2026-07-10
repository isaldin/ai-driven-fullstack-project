// Must be first: patches window.fetch for browser tracing before @app/api-client binds it.
import './observability/tracing';
import Aura from '@primeuix/themes/aura';
import { createPinia } from 'pinia';
import PrimeVue from 'primevue/config';
import { createApp } from 'vue';
import App from './App.vue';
import { initSentry } from './observability/sentry';
import router from './router';
import './style.css';

const app = createApp(App);

// Last-resort handler so an unexpected error in a component/render never leaves a
// blank page silently — it is logged with the Vue lifecycle context that threw.
app.config.errorHandler = (err, _instance, info) => {
  console.error(`[app] unhandled error (${info})`, err);
};

// Opt-in error/Session-Replay capture. No-op unless VITE_SENTRY_DSN is set; when on, Sentry wraps
// (and still calls) the handler above and correlates events with the OTel trace by trace_id.
initSentry(app);

app.use(createPinia());
app.use(PrimeVue, {
  theme: {
    preset: Aura,
    options: {
      darkModeSelector: '.app-dark',
    },
  },
});
app.use(router);

app.mount('#app');
