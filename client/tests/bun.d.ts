// Минимальные типы для `Bun.serve` — только то, чем пользуется мок бэкенда (@types/bun не подключаем).
interface MockWebSocket {
  send(data: string): void;
  close(): void;
}

declare const Bun: {
  serve(options: {
    port: number;
    fetch(
      request: Request,
      server: { upgrade(request: Request): boolean },
    ): Response | undefined | Promise<Response | undefined>;
    websocket: { open(ws: MockWebSocket): void; close(ws: MockWebSocket): void; message(ws: MockWebSocket): void };
  }): unknown;
  sleep(ms: number): Promise<void>;
};
