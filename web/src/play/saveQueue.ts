// Saves that run one at a time, in the order they were asked for. Two answers given quickly
// (fun 2, then 5) would otherwise race, and whichever request landed last would be what Yama
// kept, whatever the screen shows.

/** A queue of saves: each waits for the one before it, whether that one worked or not. */
export function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job, job);
    tail = run.catch(() => undefined);
    return run;
  };
}
