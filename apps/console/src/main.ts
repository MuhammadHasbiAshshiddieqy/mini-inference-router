import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import PlaygroundPage from "./pages/PlaygroundPage.vue";
import RequestDetailPage from "./pages/RequestDetailPage.vue";
import RequestsPage from "./pages/RequestsPage.vue";
import UsagePage from "./pages/UsagePage.vue";
import "./style.css";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/playground" },
    { path: "/playground", component: PlaygroundPage },
    { path: "/usage", component: UsagePage },
    { path: "/requests", component: RequestsPage },
    { path: "/requests/:id", component: RequestDetailPage },
  ],
});

createApp(App).use(router).mount("#app");
