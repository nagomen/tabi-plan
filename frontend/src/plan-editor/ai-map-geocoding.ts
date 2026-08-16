import type { GeoContext, GeoResult } from "../shared/geocoding";

/** AI行程を地図へ反映するための、UIに依存しない住所検索ジョブ。 */
export interface AiMapGeocodeJob {
  query: string;
  context?: GeoContext;
  apply: (result: GeoResult) => void;
}

export interface AiMapGeocodeSummary {
  attempted: number;
  resolved: number;
  unresolved: number;
}

type Search = (query: string, context?: GeoContext) => Promise<GeoResult[]>;

/**
 * 検索側で順位付け済みの先頭候補を採用する。
 * 1件の失敗で残りの住所登録を止めず、同時実行数だけを小さく制限する。
 */
export async function resolveAiMapGeocodeJobs(
  jobs: AiMapGeocodeJob[],
  search: Search,
  concurrency = 3,
): Promise<AiMapGeocodeSummary> {
  const queue = jobs.filter((job) => job.query.trim());
  let cursor = 0;
  let resolved = 0;

  const worker = async (): Promise<void> => {
    while (cursor < queue.length) {
      const job = queue[cursor++];
      try {
        const result = (await search(job.query.trim(), job.context))[0];
        if (!result) continue;
        job.apply(result);
        resolved += 1;
      } catch {
        // 住所検索は補助処理。失敗した予定を数え、ほかの予定と行程保存は継続する。
      }
    }
  };

  const workers = Math.min(queue.length, Math.max(1, Math.floor(concurrency) || 1));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return { attempted: queue.length, resolved, unresolved: queue.length - resolved };
}
