import { loadData } from "./api-data-source";
import { CONFIG, SAMPLE, state } from "./state";
import { setLoading } from "./dom";
import { showError } from "./errors";
import { renderData } from "./render";

let syncInFlight: Promise<void> | null = null;
let lastSyncAt = 0;

// ---- 同期・初期化 -------------------------------------------------------

export async function syncData(isInitial: boolean): Promise<void> {
  if (syncInFlight) return syncInFlight;
  const minInterval = Number(CONFIG.minRefreshSeconds || 0) * 1000;
  if (!isInitial && minInterval && Date.now() - lastSyncAt < minInterval) return;
  if (isInitial) setLoading(true, "最新データを取得しています");

  syncInFlight = (async (): Promise<void> => {
    try {
      const data = await loadData(CONFIG, SAMPLE);
      lastSyncAt = Date.now();
      renderData(data, CONFIG.mode);
      if (isInitial) setLoading(false);
    } catch (error) {
      showError(error);
      if (isInitial || !state.days.length) renderData(SAMPLE, "sample");
      if (isInitial) setLoading(false);
    }
  })();

  try {
    return await syncInFlight;
  } finally {
    syncInFlight = null;
  }
}
