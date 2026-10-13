import { AsyncLocalStorage } from "node:async_hooks";

const requestSignal = new AsyncLocalStorage();

export function runWithRequestSignal(signal, work) {
  return requestSignal.run(signal, work);
}

export function getRequestSignal() {
  return requestSignal.getStore();
}
