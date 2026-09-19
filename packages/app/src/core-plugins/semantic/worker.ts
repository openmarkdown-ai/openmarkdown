/// <reference lib="webworker" />
/** The search worker: holds every passage vector and answers top-k queries off the main thread. */
import { VectorTable, type WorkerRequest } from "./vectors";

const table = new VectorTable();

self.onmessage = (evt: MessageEvent<WorkerRequest>) => {
  try {
    (self as unknown as Worker).postMessage(table.handle(evt.data));
  } catch (e) {
    (self as unknown as Worker).postMessage({ id: evt.data.id, error: String((e as Error)?.message ?? e) });
  }
};
