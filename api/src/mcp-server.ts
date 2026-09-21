import type http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";
import {
  loadPublishedTrip,
  type PublicTripData,
  type PublicTripItineraryItem,
} from "./public-trip-repo.js";
import {
  createTargetExpense,
  deleteTargetExpense,
  loadTargetTripExpenses,
  restoreTargetExpense,
  updateTargetExpense,
} from "./mcp-expense-repo.js";
import { TARGET_TRIP_SLUG, TARGET_TRIP_URL } from "./mcp-constants.js";
import { MCP_WRITE_SCOPE } from "./mcp-oauth.js";

export { MCP_PATH, TARGET_TRIP_SLUG, TARGET_TRIP_URL } from "./mcp-constants.js";

type TripLoader = (slug: string) => Promise<PublicTripData | null>;

export interface McpActor {
  userId: string;
  scopes: string[];
}

const toolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const itineraryKinds = ["sight", "move", "food", "stay", "todo", "form"] as const;
const expenseCategories = ["food", "transport", "lodging", "sightseeing", "communication", "other"] as const;
const splitMethods = ["equal_all", "equal_selected", "custom", "none"] as const;
const paymentMethods = ["card", "cash", "transfer", "other"] as const;
const expenseSharesSchema = z.array(z.object({
  memberId: z.string().min(1).max(32).describe("負担する旅行メンバーID"),
  amountBaseMinor: z.number().int().positive().describe("基準通貨での負担額（最小通貨単位）"),
})).max(30);

function publicItem(item: PublicTripItineraryItem): Record<string, unknown> {
  return {
    date: item.item_date,
    dayIndex: item.day_index,
    order: item.sort_order,
    kind: item.kind,
    startTime: item.start_time,
    title: item.title,
    place: item.place,
    area: item.area,
    note: item.note,
    mapQuery: item.map_query,
    latitude: item.lat,
    longitude: item.lng,
    from: item.from_place,
    to: item.to_place,
    transport: item.transport,
    durationMinutes: item.duration_minutes,
  };
}

function textResult(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function unavailableResult() {
  return {
    content: [{
      type: "text" as const,
      text: "対象の旅行は、現在公開されていないか取得できません。",
    }],
    isError: true,
  };
}

function includesNormalized(value: unknown, query: string): boolean {
  return typeof value === "string" && value.toLocaleLowerCase("ja-JP").includes(query);
}

function itemMatchesQuery(item: PublicTripItineraryItem, query: string): boolean {
  return [
    item.item_date, item.kind, item.start_time, item.title, item.place, item.area, item.note,
    item.map_query, item.from_place, item.to_place, item.transport,
  ].some((value) => includesNormalized(value, query));
}

function writeDenied() {
  return {
    content: [{ type: "text" as const, text: "費用を変更する権限がありません。接続をやり直してください。" }],
    isError: true,
  };
}

function expenseInput(input: {
  paidOn: string;
  payerMemberId: string;
  category: typeof expenseCategories[number];
  title: string;
  amountMinor: number;
  currency: string;
  fxRate: number;
  splitMethod: typeof splitMethods[number];
  paymentMethod: typeof paymentMethods[number] | null;
  note?: string | null;
  receiptUrl?: string | null;
  shares: { memberId: string; amountBaseMinor: number }[];
}) {
  return {
    paid_on: input.paidOn,
    payer_user_id: input.payerMemberId,
    category: input.category,
    title: input.title,
    amount_minor: input.amountMinor,
    currency: input.currency,
    fx_rate: input.fxRate,
    split_method: input.splitMethod,
    payment_method: input.paymentMethod,
    note: input.note ?? null,
    receipt_url: input.receiptUrl ?? null,
    shares: input.shares.map((share) => ({
      user_id: share.memberId,
      amount_base_minor: share.amountBaseMinor,
    })),
  };
}

/** 認証済み利用者に、この旅行専用の旅程参照・費用編集ツールを公開する。 */
export function createTravelMcpServer(
  actor: McpActor,
  loadTrip: TripLoader = loadPublishedTrip,
): McpServer {
  const server = new McpServer(
    { name: "tabi-plan-travel", version: "1.0.0" },
    {
      instructions:
        "香港・マカオ・金門旅行だけを扱う。旅程は公開済みデータを読み、費用は接続した編集メンバーとして読み書きする。費用を書き込む前に、内容・支払日・金額・通貨・支払者・負担者を利用者へ提示して確認する。未登録の情報は推測しない。",
    },
  );

  server.registerTool("get_trip_overview", {
    title: "中国旅行の概要を取得",
    description:
      "香港・マカオ・金門旅行の期間、訪問都市、公開行程件数、更新版を取得する。",
    annotations: toolAnnotations,
  }, async () => {
    const trip = await loadTrip(TARGET_TRIP_SLUG);
    if (!trip) return unavailableResult();
    return textResult({
      trip: {
        slug: trip.plan.slug,
        title: trip.plan.title,
        note: trip.plan.note,
        startDate: trip.plan.start_date,
        endDate: trip.plan.end_date,
        datesLabel: trip.plan.dates_label,
        version: trip.plan.version,
        updatedAt: trip.plan.updated_at,
        dashboardUrl: TARGET_TRIP_URL,
      },
      cities: trip.cities.map((city) => ({
        name: city.name,
        fromDate: city.from_date,
        toDate: city.to_date,
      })),
      itineraryItemCount: trip.itinerary.length,
      publicLinkCount: trip.links.length,
    });
  });

  server.registerTool("get_itinerary", {
    title: "日付・都市別の行程を取得",
    description:
      "中国旅行の公開行程を取得する。日付、都市・地域、予定種別で絞り込める。",
    inputSchema: {
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
        .describe("旅行先の現地日付。YYYY-MM-DD形式"),
      city: z.string().trim().min(1).max(80).optional()
        .describe("都市、地域、施設名に含まれる文字列"),
      kind: z.enum(itineraryKinds).optional().describe("予定種別"),
    },
    annotations: toolAnnotations,
  }, async ({ date, city, kind }) => {
    const trip = await loadTrip(TARGET_TRIP_SLUG);
    if (!trip) return unavailableResult();
    const cityQuery = city?.toLocaleLowerCase("ja-JP");
    const items = trip.itinerary.filter((item) => {
      if (date && item.item_date !== date) return false;
      if (kind && item.kind !== kind) return false;
      if (cityQuery && ![
        item.area, item.place, item.title, item.from_place, item.to_place,
      ].some((value) => includesNormalized(value, cityQuery))) return false;
      return true;
    });
    return textResult({
      title: trip.plan.title,
      version: trip.plan.version,
      updatedAt: trip.plan.updated_at,
      filters: { date: date || null, city: city || null, kind: kind || null },
      count: items.length,
      items: items.map(publicItem),
      dashboardUrl: TARGET_TRIP_URL,
    });
  });

  server.registerTool("search_itinerary", {
    title: "旅程を検索",
    description:
      "施設名、便名、交通手段、メモ、都市名などから公開行程を検索する。",
    inputSchema: {
      query: z.string().trim().min(1).max(100).describe("検索語"),
      limit: z.number().int().min(1).max(50).default(20).describe("返す最大件数"),
    },
    annotations: toolAnnotations,
  }, async ({ query, limit }) => {
    const trip = await loadTrip(TARGET_TRIP_SLUG);
    if (!trip) return unavailableResult();
    const normalized = query.toLocaleLowerCase("ja-JP");
    const matches = trip.itinerary.filter((item) => itemMatchesQuery(item, normalized));
    return textResult({
      title: trip.plan.title,
      version: trip.plan.version,
      updatedAt: trip.plan.updated_at,
      query,
      totalMatches: matches.length,
      truncated: matches.length > limit,
      items: matches.slice(0, limit).map(publicItem),
      dashboardUrl: TARGET_TRIP_URL,
    });
  });

  server.registerTool("get_trip_links", {
    title: "旅行の公開リンクを取得",
    description:
      "行程、地図、写真など、公開が許可された旅行リンクだけを取得する。",
    annotations: toolAnnotations,
  }, async () => {
    const trip = await loadTrip(TARGET_TRIP_SLUG);
    if (!trip) return unavailableResult();
    return textResult({
      title: trip.plan.title,
      version: trip.plan.version,
      updatedAt: trip.plan.updated_at,
      dashboardUrl: TARGET_TRIP_URL,
      links: trip.links.map(({ sort_order: _sortOrder, ...link }) => link),
    });
  });

  server.registerTool("list_trip_expenses", {
    title: "中国旅行の費用を一覧する",
    description:
      "香港・マカオ・金門旅行の費用、旅行内メンバーID、負担額を取得する。費用の追加・訂正前に必ず呼ぶ。",
    inputSchema: {
      includeDeleted: z.boolean().default(false).describe("削除済みの費用も含めるか"),
    },
    annotations: toolAnnotations,
  }, async ({ includeDeleted }) => {
    const data = await loadTargetTripExpenses(actor.userId, includeDeleted);
    const names = new Map(data.members.map((member) => [member.id, member.display_name]));
    return textResult({
      trip: {
        title: data.plan.title,
        baseCurrency: data.plan.base_currency,
        updatedAt: data.plan.updated_at,
        dashboardUrl: TARGET_TRIP_URL,
      },
      members: data.members.map((member) => ({
        memberId: member.id,
        name: member.display_name,
        status: member.status,
      })),
      expenses: data.expenses.map((expense) => ({
        expenseId: expense.id,
        paidOn: expense.paid_on,
        payerMemberId: expense.payer_user_id,
        payerName: names.get(expense.payer_user_id) || "",
        category: expense.category,
        title: expense.title,
        amountMinor: expense.amount_minor,
        currency: expense.currency,
        fxRate: expense.fx_rate,
        amountBaseMinor: expense.amount_base_minor,
        splitMethod: expense.split_method,
        paymentMethod: expense.payment_method,
        note: expense.note,
        receiptUrl: expense.receipt_url,
        updatedAt: expense.updated_at,
        deletedAt: expense.deleted_at,
        shares: expense.shares.map((share) => ({
          memberId: share.user_id,
          memberName: names.get(share.user_id) || "",
          amountBaseMinor: share.amount_base_minor,
        })),
      })),
    });
  });

  server.registerTool("create_trip_expense", {
    title: "中国旅行の費用を追加する",
    description:
      "確認済みの費用を香港・マカオ・金門旅行へ1件追加する。通貨が基準通貨と異なる場合は、支払日の確定レートをfxRateへ指定する。値を推測してはならない。",
    inputSchema: {
      requestId: z.string().uuid().describe("この登録操作固有のUUID。同じ要求の再送では同じ値を使う"),
      paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("支払日（YYYY-MM-DD）"),
      payerMemberId: z.string().min(1).max(32).describe("一覧で得た支払者のメンバーID"),
      category: z.enum(expenseCategories),
      title: z.string().trim().min(1).max(200),
      amountMinor: z.number().int().positive().describe("支払通貨の最小単位。JPYなら円、HKDならセント"),
      currency: z.string().regex(/^[A-Z]{3}$/).describe("ISO 4217通貨コード"),
      fxRate: z.number().positive().max(1_000_000).describe("支払通貨1最小単位あたりの基準通貨換算率"),
      splitMethod: z.enum(splitMethods),
      paymentMethod: z.enum(paymentMethods).nullable(),
      note: z.string().max(4000).nullable().optional(),
      receiptUrl: z.string().url().max(1024).nullable().optional(),
      shares: expenseSharesSchema.describe("基準通貨での負担額。splitMethod=noneなら空配列"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ requestId, ...input }) => {
    if (!actor.scopes.includes(MCP_WRITE_SCOPE)) return writeDenied();
    const created = await createTargetExpense(actor.userId, expenseInput(input), requestId);
    return textResult({
      ok: true,
      expenseId: created.id,
      replayed: created.replayed,
      message: created.replayed ? "同じ登録要求は既に保存済みです。" : "費用を追加しました。",
      trip: TARGET_TRIP_SLUG,
    });
  });

  server.registerTool("update_trip_expense", {
    title: "中国旅行の費用を訂正する",
    description:
      "一覧で得たexpenseIdの費用を部分更新する。変更内容を利用者へ示して確認してから呼ぶ。sharesを変える場合は全負担者を指定する。",
    inputSchema: {
      expenseId: z.string().min(1).max(32),
      paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      payerMemberId: z.string().min(1).max(32).optional(),
      category: z.enum(expenseCategories).optional(),
      title: z.string().trim().min(1).max(200).optional(),
      amountMinor: z.number().int().positive().optional(),
      currency: z.string().regex(/^[A-Z]{3}$/).optional(),
      fxRate: z.number().positive().max(1_000_000).optional(),
      splitMethod: z.enum(splitMethods).optional(),
      paymentMethod: z.enum(paymentMethods).nullable().optional(),
      note: z.string().max(4000).nullable().optional(),
      receiptUrl: z.string().url().max(1024).nullable().optional(),
      shares: expenseSharesSchema.optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ expenseId, ...input }) => {
    if (!actor.scopes.includes(MCP_WRITE_SCOPE)) return writeDenied();
    await updateTargetExpense(actor.userId, expenseId, {
      ...(input.paidOn !== undefined ? { paid_on: input.paidOn } : {}),
      ...(input.payerMemberId !== undefined ? { payer_user_id: input.payerMemberId } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.amountMinor !== undefined ? { amount_minor: input.amountMinor } : {}),
      ...(input.currency !== undefined ? { currency: input.currency } : {}),
      ...(input.fxRate !== undefined ? { fx_rate: input.fxRate } : {}),
      ...(input.splitMethod !== undefined ? { split_method: input.splitMethod } : {}),
      ...(input.paymentMethod !== undefined ? { payment_method: input.paymentMethod } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.receiptUrl !== undefined ? { receipt_url: input.receiptUrl } : {}),
      ...(input.shares !== undefined ? { shares: input.shares.map((share) => ({
        user_id: share.memberId,
        amount_base_minor: share.amountBaseMinor,
      })) } : {}),
    });
    return textResult({ ok: true, expenseId, message: "費用を更新しました。", trip: TARGET_TRIP_SLUG });
  });

  server.registerTool("delete_trip_expense", {
    title: "中国旅行の費用を削除する",
    description:
      "一覧で得たexpenseIdの費用を論理削除する。対象を利用者へ示して明示確認してから呼ぶ。",
    inputSchema: { expenseId: z.string().min(1).max(32) },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ expenseId }) => {
    if (!actor.scopes.includes(MCP_WRITE_SCOPE)) return writeDenied();
    await deleteTargetExpense(actor.userId, expenseId);
    return textResult({ ok: true, expenseId, message: "費用を削除しました。元に戻すこともできます。", trip: TARGET_TRIP_SLUG });
  });

  server.registerTool("restore_trip_expense", {
    title: "削除した中国旅行の費用を元へ戻す",
    description: "削除済みの費用を元へ戻す。",
    inputSchema: { expenseId: z.string().min(1).max(32) },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ expenseId }) => {
    if (!actor.scopes.includes(MCP_WRITE_SCOPE)) return writeDenied();
    await restoreTargetExpense(actor.userId, expenseId);
    return textResult({ ok: true, expenseId, message: "費用を元へ戻しました。", trip: TARGET_TRIP_SLUG });
  });

  return server;
}

/** 1回のHTTP要求ごとにstatelessなMCP接続を開く。 */
export async function handleMcpHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  actor: McpActor,
  parsedBody?: unknown,
): Promise<void> {
  const server = createTravelMcpServer(actor);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    void transport.close().finally(() => server.close());
  };
  res.once("close", close);
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (error) {
    console.error("[travel-api] MCP request failed", error);
    if (!res.headersSent) {
      res.writeHead(500, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      }));
    }
  } finally {
    if (res.writableEnded) close();
  }
}
