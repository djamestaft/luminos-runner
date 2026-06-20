import "dotenv/config";

import { loadConfig } from "./config.js";
import { Runner } from "./runner.js";

const main = async () => {
  const runner = new Runner(loadConfig());

  const stop = async (signal: string) => {
    console.log(JSON.stringify({ event: "runner_stopping", signal }));
    await runner.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void stop("SIGINT");
  });

  process.on("SIGTERM", () => {
    void stop("SIGTERM");
  });

  await runner.start();
};

main().catch((error) => {
  console.error("runner crashed", error);
  process.exit(1);
});
