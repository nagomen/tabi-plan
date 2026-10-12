import type { PaymentState } from "../schedule";
import { Icon } from "./Icon";

/** 状態は heroicon と文字で示す（アイコンだけだと意味を取り違えやすいので文字も残す）。 */
export function StateBadge({ state }: { state: PaymentState }) {
  return (
    <span className={`dn-state ${state.className}`}>
      <Icon name={state.icon} className="dn-state-ic" strokeWidth={1.8} />
      <span>{state.label}</span>
    </span>
  );
}
