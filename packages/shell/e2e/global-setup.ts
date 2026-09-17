import { startHarness } from "./harness";

export default async function globalSetup(): Promise<void> {
  const env = await startHarness();
  process.stdout.write(
    `\n[e2e] core daemon 就绪：pid=${env.daemonPid} ws=${env.wsPort} home=${env.pulpoHome} cwd=${env.cwd}\n`,
  );
}
