/**
 * Virtual clock. `sleep` advances time immediately, so tests that exercise
 * minute-long rate-limit windows run in microseconds without asserting on
 * real wall-clock behaviour.
 */
export class FakeClock {
  private time = 0;
  readonly sleeps: number[] = [];

  now(): number {
    return this.time;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.time += ms;
    await Promise.resolve();
  }

  advance(ms: number): void {
    this.time += ms;
  }
}
