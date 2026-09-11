const params = new URLSearchParams(location.search);
export const personName = (params.get("name") || "").trim();
export const personId = (params.get("user") || "").trim();

export const $ = <T extends HTMLElement = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);

export const today = new Date();
