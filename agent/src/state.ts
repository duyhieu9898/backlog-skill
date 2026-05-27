import { getJsonState, setJsonState } from "./storage/repositories";

export function readOffset(): number | null {
  const state = getJsonState<{ offset: number }>("kv_state", "telegram.offset");
  return state?.offset ?? null;
}

export function writeOffset(offset: number): void {
  setJsonState("kv_state", "telegram.offset", { offset });
}
