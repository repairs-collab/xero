import { seedLaunchScenario } from '@bc5000/testing';

export default async function globalSetup(): Promise<void> {
  await seedLaunchScenario(
    process.env.DATABASE_URL ??
      'postgres://bc5000:bc5000@127.0.0.1:5432/bc5000'
  );
}
