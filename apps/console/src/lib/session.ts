// sessionStorage for the custom tenant key and the admin key (never localStorage, never in the build).
// Storage can be unavailable (private mode, blocked site data), so every access is guarded.

export function readSession(key: string): string {
  try {
    return sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function writeSession(key: string, value: string): void {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    // storage unavailable: the value simply is not remembered for this tab
  }
}
