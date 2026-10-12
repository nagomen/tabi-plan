import { yen } from "../format";

const MINUS = "−";

export type Sign = "plus" | "minus" | "auto";

/** 符号つきの金額。auto は値の正負で＋/−を決める。 */
export function Money({ value, sign = "auto" }: { value: number; sign?: Sign }) {
  const negative = sign === "minus" || (sign === "auto" && value < 0);
  const prefix = sign === "minus" || value < 0 ? MINUS : sign === "plus" || value > 0 ? "+" : "";
  return (
    <span className={`dn-money ${negative ? "is-negative" : "is-positive"}`}>
      {prefix}{yen.format(Math.abs(value))}
    </span>
  );
}

/** 幅のある金額（最小〜最大）。両端を別々に色分けし、マイナスの端だけ赤くする。 */
export function MoneyRange({ minimum, maximum, sign = "auto" }: { minimum: number; maximum: number; sign?: Sign }) {
  if (minimum === maximum) return <Money value={maximum} sign={sign} />;
  return <><Money value={minimum} sign={sign} /><span className="dn-range-dash">〜</span><Money value={maximum} sign={sign} /></>;
}

/** 残るお金。マイナスは「¥3,000 不足」と赤字、プラスは「+¥53,000」と緑で示す。 */
export function Leftover({ value }: { value: number }) {
  return (
    <span className={`dn-money ${value < 0 ? "is-negative" : "is-positive"}`}>
      {value < 0 ? `${yen.format(Math.abs(value))} 不足` : `${value > 0 ? "+" : ""}${yen.format(value)}`}
    </span>
  );
}

export function LeftoverRange({ minimum, maximum }: { minimum: number; maximum: number }) {
  if (minimum === maximum) return <Leftover value={maximum} />;
  return <><Leftover value={minimum} /><span className="dn-range-dash">〜</span><Leftover value={maximum} /></>;
}
