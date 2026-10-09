import { handle } from "hono/vercel";
import app from "../src/index.ts";

// Vercel entry. The zero-config Hono builder runs a strict type check with its own tsconfig lookup that does
// not honour this repo's tsconfig, so the app is exposed as a plain Node function instead. `vercel.json`
// rewrites every path to /api. `hono/vercel` is marked deprecated in Hono 4 (replaced by `@hono/vercel` in v5).
const handler = handle(app);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const HEAD = handler;
