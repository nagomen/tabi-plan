import { timingSafeEqual } from "node:crypto";
import type { ItineraryCandidate } from "@tabi/contracts";
import { AiInputError } from "./ai-errors.js";
import { hmac } from "./signing.js";

const TOKEN_TTL_MS = 30 * 60 * 1000;

export interface ConsultationContext {
  area: string;
  startDate: string;
  endDate: string;
  note: string;
  people?: number;
  cities: { name: string; from_date?: string; to_date?: string }[];
}

interface ConsultationPayload {
  version: 1;
  user_id: string;
  expires_at: number;
  context: ConsultationContext;
  candidates: Pick<ItineraryCandidate, "id" | "name" | "area">[];
}

function canonicalContext(context: ConsultationContext): ConsultationContext {
  return {
    area: String(context.area || "").trim(),
    startDate: String(context.startDate || ""),
    endDate: String(context.endDate || ""),
    note: String(context.note || "").trim(),
    people: context.people,
    cities: (context.cities || []).map((city) => ({
      name: String(city.name || "").trim(),
      from_date: String(city.from_date || ""),
      to_date: String(city.to_date || ""),
    })),
  };
}

export function createConsultationToken(
  userId: string,
  context: ConsultationContext,
  candidates: ItineraryCandidate[],
): string {
  const payload: ConsultationPayload = {
    version: 1,
    user_id: userId,
    expires_at: Date.now() + TOKEN_TTL_MS,
    context: canonicalContext(context),
    candidates: candidates.map(({ id, name, area }) => ({ id, name, area })),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${hmac(encoded).toString("base64url")}`;
}

function decodeToken(token: string): ConsultationPayload {
  const [encoded, suppliedSignature, extra] = String(token || "").split(".");
  if (!encoded || !suppliedSignature || extra) throw new AiInputError("AI相談を最初からやり直してください");
  const expected = hmac(encoded);
  let supplied: Buffer;
  try {
    supplied = Buffer.from(suppliedSignature, "base64url");
  } catch {
    throw new AiInputError("AI相談を最初からやり直してください");
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new AiInputError("AI相談の内容を確認できません。最初からやり直してください");
  }
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as ConsultationPayload;
  } catch {
    throw new AiInputError("AI相談を最初からやり直してください");
  }
}

export function selectedCandidatesFromToken(args: {
  token: string;
  userId: string;
  context: ConsultationContext;
  selectedIds: string[];
}): Pick<ItineraryCandidate, "id" | "name" | "area">[] {
  const payload = decodeToken(args.token);
  if (payload.version !== 1 || payload.user_id !== args.userId || payload.expires_at < Date.now()) {
    throw new AiInputError("AI相談の有効期限が切れました。候補選びからやり直してください");
  }
  if (JSON.stringify(payload.context) !== JSON.stringify(canonicalContext(args.context))) {
    throw new AiInputError("候補を表示した後に都市または日程が変わりました。候補選びからやり直してください");
  }
  const requested = new Set(args.selectedIds.map((id) => String(id).trim()).filter(Boolean));
  const selected = payload.candidates.filter((candidate) => requested.has(candidate.id));
  if (!selected.length || selected.length !== requested.size) {
    throw new AiInputError("選択した観光地を確認できません。候補選びからやり直してください");
  }
  const areas = [...new Set(payload.candidates.map((candidate) => candidate.area))];
  const missing = areas.filter((area) => !selected.some((candidate) => candidate.area === area));
  if (missing.length) throw new AiInputError(`各都市から観光地を1件以上選んでください: ${missing.join("、")}`);
  return selected;
}
