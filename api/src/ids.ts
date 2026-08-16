let idSeq = 0;

export function newId(prefix: string): string {
  idSeq = (idSeq + 1) % 46656;
  return `${prefix}_${Date.now().toString(36)}${idSeq.toString(36).padStart(3, "0")}`;
}
