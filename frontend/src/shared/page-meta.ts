/** 旅行名を含む document title と、必要ならPWA表示名を更新する。 */
export function setTripDocumentTitle(
  value: string | undefined,
  format: (tripTitle: string) => string,
  appleTitle?: string,
): void {
  const tripTitle = value || "旅行";
  document.title = format(tripTitle);
  if (appleTitle !== undefined) {
    document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute("content", appleTitle || tripTitle);
  }
}
