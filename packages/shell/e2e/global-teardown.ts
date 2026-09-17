import { stopHarness } from "./harness";

export default async function globalTeardown(): Promise<void> {
  await stopHarness();
}
