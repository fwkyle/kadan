export type ResourceState<T> = {
  data?: T;
  error: string | null;
  refreshing: boolean;
  updatedAt: number;
  // 시간 초과로 이번 조회를 중단했지만 이전 자료가 있어 그대로 보여 주는 중. 큰 오류 띠 대신 작은 표시만 쓴다.
  timedOut: boolean;
};
export type ResourceOptions = {
  pollMs?: number;
  deadlineMs?: number;
  staleMs?: number;
};
type Listener = () => void;
// 2026-10-14 격리 측정(원장 사본, 부하 평균 50): 개선 전 동시 조회 p95 61초, 개선 후 최악 13초.
// 개선 후 느린 쪽(13초)의 4배 넘게 두어, 부하가 높아도 정상 응답을 시간 초과로 끊지 않는다.
const DEFAULT_DEADLINE_MS = 60_000;

// One owner per URL. Cancellation and generations prevent an older request replacing a newer one.
export class Resource<T> {
  private state: ResourceState<T> = {
    error: null,
    refreshing: false,
    updatedAt: 0,
    timedOut: false,
  };
  private listeners = new Set<Listener>();
  private controller: AbortController | null = null;
  private pending: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private visible = true;
  private loader: (signal: AbortSignal, force?: boolean) => Promise<T>;
  private options: ResourceOptions;

  constructor(
    loader: (signal: AbortSignal, force?: boolean) => Promise<T>,
    options: ResourceOptions = {},
  ) {
    this.loader = loader;
    this.options = options;
  }
  getSnapshot = () => this.state;
  get subscribed() {
    return this.listeners.size > 0;
  }
  private publish(state: ResourceState<T>) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.subscribed && this.visible && this.options.pollMs) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.refresh();
      }, this.options.pollMs);
    }
  }
  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    if (
      this.visible &&
      (!this.state.updatedAt ||
        Date.now() - this.state.updatedAt >= (this.options.staleMs ?? 0))
    )
      void this.refresh();
    else this.schedule();
    return () => {
      this.listeners.delete(listener);
      if (!this.subscribed) {
        this.cancel();
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
      }
    };
  };
  setVisible(visible: boolean) {
    const resumed = visible && !this.visible;
    this.visible = visible;
    if (!visible) this.cancel();
    if (resumed && this.subscribed) void this.refresh();
    else this.schedule();
  }
  cancel() {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    this.pending = null;
    if (this.state.refreshing)
      this.publish({ ...this.state, refreshing: false });
  }
  refresh = (force = false): Promise<void> => {
    if (this.pending && !force) return this.pending;
    if (force) this.cancel();
    const controller = new AbortController(),
      generation = ++this.generation;
    this.controller = controller;
    this.publish({ ...this.state, refreshing: true });
    const promise = this.run(controller, generation, force);
    this.pending = promise;
    return promise;
  };
  private async run(
    controller: AbortController,
    generation: number,
    force: boolean,
  ) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error("응답 시간이 초과됐습니다. 다시 읽어주세요."));
        }, this.options.deadlineMs ?? DEFAULT_DEADLINE_MS);
        controller.signal.addEventListener(
          "abort",
          () => {
            if (!timedOut) reject(new Error("조회 취소"));
          },
          { once: true },
        );
      });
      const data = await Promise.race([
        Promise.resolve().then(() => this.loader(controller.signal, force)),
        deadline,
      ]);
      if (generation === this.generation && !controller.signal.aborted)
        this.publish({
          data,
          error: null,
          refreshing: false,
          updatedAt: Date.now(),
          timedOut: false,
        });
    } catch (error) {
      if (
        generation === this.generation &&
        (!controller.signal.aborted || timedOut)
      )
        // 시간 초과만 조용히 넘긴다. 연결 거부·서버 오류·깨진 응답은 이전 자료가 있어도 오류로 알린다.
        // 첫 조회라 보여 줄 자료가 없으면 시간 초과도 오류다.
        this.publish({
          ...this.state,
          ...(timedOut && this.state.data !== undefined
            ? { error: null, timedOut: true }
            : {
                error: error instanceof Error ? error.message : "조회 실패",
                timedOut: false,
              }),
          refreshing: false,
        });
    } finally {
      clearTimeout(timeout);
      if (generation === this.generation) {
        this.controller = null;
        this.pending = null;
        this.schedule();
      }
    }
  }
  invalidate() {
    this.state = { ...this.state, updatedAt: 0 };
    if (this.subscribed && this.visible) void this.refresh(true);
  }
}
