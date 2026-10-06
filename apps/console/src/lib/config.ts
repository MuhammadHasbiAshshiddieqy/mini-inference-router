import { z } from "zod";

// Build-time configuration (docs/06 §3). Demo tenant keys are public by design (low quotas, resettable);
// the private reviewer key is typed in by the user and kept in sessionStorage only.

export const GATEWAY_URL = (import.meta.env.VITE_GATEWAY_URL ?? "http://localhost:8787").replace(/\/$/, "");

const DemoTenants = z.array(z.object({ name: z.string().min(1), key: z.string().min(1) }));

function parseDemoTenants(raw: string | undefined): { name: string; key: string }[] {
  if (!raw) return [];
  try {
    const parsed = DemoTenants.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    console.warn("VITE_DEMO_TENANTS is not a [{name,key}] array", parsed.error.issues);
  } catch (err) {
    console.warn("VITE_DEMO_TENANTS is not valid JSON", err);
  }
  return [];
}

export const DEMO_TENANTS = parseDemoTenants(import.meta.env.VITE_DEMO_TENANTS);
