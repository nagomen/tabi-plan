import type { ItineraryCandidate, ItineraryOptions } from "@tabi/contracts";

export type AiStage = "idle" | "candidates" | "preferences" | "building" | "done";

export interface AiCandidateGroup {
  city: string;
  candidates: ItineraryCandidate[];
}

/** DOMから独立したAI相談の状態と選択ルール。画面側は描画とイベント接続だけを担当する。 */
export class AiConsultationState {
  stage: AiStage = "idle";
  options: ItineraryOptions | null = null;
  readonly selectedIds = new Set<string>();

  start(options: ItineraryOptions): void {
    this.options = options;
    this.selectedIds.clear();
    this.stage = "candidates";
  }

  reset(): void {
    this.options = null;
    this.selectedIds.clear();
    this.stage = "idle";
  }

  select(candidateId: string, selected: boolean): void {
    if (selected) this.selectedIds.add(candidateId);
    else this.selectedIds.delete(candidateId);
  }

  selectedCandidates(): ItineraryCandidate[] {
    return (this.options?.candidates || []).filter((candidate) => this.selectedIds.has(candidate.id));
  }

  candidateGroups(): AiCandidateGroup[] {
    const groups = new Map<string, ItineraryCandidate[]>();
    for (const candidate of this.options?.candidates || []) {
      const city = candidate.area.trim() || "その他";
      const group = groups.get(city) || [];
      group.push(candidate);
      groups.set(city, group);
    }
    return Array.from(groups, ([city, candidates]) => ({ city, candidates }));
  }

  unselectedCities(): string[] {
    return this.candidateGroups()
      .filter((group) => !group.candidates.some((candidate) => this.selectedIds.has(candidate.id)))
      .map((group) => group.city);
  }
}
