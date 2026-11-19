/** Журнал запросов, которые код пытался сделать через `fetch` (сети в тестах нет — см. `setup.ts`). */
export const networkLog: string[] = [];

export function recordRequest(input: RequestInfo | URL, init?: RequestInit): void {
  const url = input instanceof Request ? input.url : String(input);
  networkLog.push(`${init?.method ?? (input instanceof Request ? input.method : 'GET')} ${url}`);
}

export const clearNetworkLog = () => {
  networkLog.length = 0;
};
