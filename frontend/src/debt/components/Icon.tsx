import { icon, type IconName } from "../../shared/icons";

interface IconProps {
  name: IconName;
  /** 既定の dn-ic は緑。状態表示のように親の色を継ぎたいときは別のクラスを渡す。 */
  className?: string;
  strokeWidth?: number;
}

/** heroicon（shared/icons.ts の固定SVG文字列）を描く。利用者の入力は混ざらない。 */
export function Icon({ name, className = "dn-ic", strokeWidth }: IconProps) {
  return <span className={className} aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon(name, { strokeWidth }) }} />;
}
