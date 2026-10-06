import { ref, watch } from "vue";
import { readSession, writeSession } from "./session.ts";

// The admin key is typed in by the operator and kept in sessionStorage only; it is never bundled (docs/06 §1).
export const adminKey = ref(readSession("mir.adminKey"));
watch(adminKey, (v) => writeSession("mir.adminKey", v.trim()));
