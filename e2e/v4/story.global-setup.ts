import fs from "node:fs";
import path from "node:path";
import { build, loadConfigFromFile, mergeConfig, type Plugin } from "../../web/node_modules/vite/dist/node/index.js";
import {
  buildDeployments,
  computeDefaultChainId,
  isLiveDeployment,
  legacyToTestDeployment,
  ZERO_ADDRESS,
  type LegacyDeployment,
  type RawDeployment,
} from "../../web/src/chain/registryCore";
import setupLiveMarket from "./global-setup";
import cleanup from "./global-teardown";
import { ART, HERE, ROOT, RPC } from "./constants";

/** A second static bundle exercises the true undeployed path, using test-only aliases. */
export default async function setupStory() {
  // If another test owns the ports, this rejects without touching its processes.
  await setupLiveMarket();
  try {
    const deployed = JSON.parse(fs.readFileSync(path.join(ART, "legacy-deployment.json"), "utf8")) as LegacyDeployment;
    const undeployedLegacy: LegacyDeployment = {
      chainId: 31337,
      oracle: ZERO_ADDRESS,
      pool: ZERO_ADDRESS,
      token: ZERO_ADDRESS,
      currency: deployed.currency,
      seriesIds: [],
    };
    const undeployedRegistry: Record<string, RawDeployment> = {
      "31337": {
        chainId: 31337,
        name: "Local chain 31337",
        oracle: ZERO_ADDRESS,
        pool: ZERO_ADDRESS,
        token: ZERO_ADDRESS,
        currency: { address: deployed.currency, symbol: "USDC", decimals: 6 },
        seriesIds: [],
        explorerBase: "",
      },
    };
    // A zero-address legacy entry is deliberately not merged by the registry.
    // The dedicated raw-registry alias keeps the known local target selectable.
    const testDeployment = legacyToTestDeployment(undeployedLegacy);
    const registry = buildDeployments(undeployedRegistry, testDeployment, true);
    if (isLiveDeployment(registry[31337]) || computeDefaultChainId(registry, testDeployment) !== 31337) {
      throw new Error("Undeployed Story fixture must default to the known, unconfigured local chain");
    }

    const fixtureDirectory = path.join(ART, "story-unconfigured-fixtures");
    fs.mkdirSync(fixtureDirectory, { recursive: true });
    const fixtureFiles = {
      "../deployment.json": path.join(fixtureDirectory, "legacy-deployment.json"),
      "./deployments.json": path.join(fixtureDirectory, "deployments.json"),
      "./v4-deployments.json": path.join(fixtureDirectory, "v4-deployments.json"),
    };
    fs.writeFileSync(fixtureFiles["../deployment.json"], JSON.stringify(undeployedLegacy, null, 2));
    fs.writeFileSync(fixtureFiles["./deployments.json"], JSON.stringify(undeployedRegistry, null, 2));
    fs.writeFileSync(fixtureFiles["./v4-deployments.json"], "{}\n");
    const aliases: Plugin = {
      name: "story-undeployed-fixtures",
      enforce: "pre",
      resolveId(source, importer) {
        if (!importer?.includes(path.join(ROOT, "web", "src"))) return;
        if (!Object.hasOwn(fixtureFiles, source)) return;
        return fixtureFiles[source as keyof typeof fixtureFiles];
      },
    };
    const output = path.join(ART, "story-undeployed");
    const loadedConfig = await loadConfigFromFile({ command: "build", mode: "production" }, path.join(HERE, "vite.config.ts"), ROOT);
    if (!loadedConfig) throw new Error("Could not load the local Vite test configuration");
    const config = mergeConfig(loadedConfig.config, {
      configFile: false,
      build: { outDir: output, emptyOutDir: true },
    });
    // Prepend to the existing local aliases, which otherwise resolve live manifests.
    config.plugins = [aliases, ...(config.plugins ?? [])];
    const previousAllow = process.env.VITE_ALLOW_TEST_CHAIN;
    const previousRpc = process.env.VITE_RPC_URL;
    process.env.VITE_ALLOW_TEST_CHAIN = "1";
    process.env.VITE_RPC_URL = RPC;
    try {
      await build(config);
    } finally {
      if (previousAllow === undefined) delete process.env.VITE_ALLOW_TEST_CHAIN;
      else process.env.VITE_ALLOW_TEST_CHAIN = previousAllow;
      if (previousRpc === undefined) delete process.env.VITE_RPC_URL;
      else process.env.VITE_RPC_URL = previousRpc;
    }
    const destination = path.join(ART, "site", "unconfigured");
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(output, destination, { recursive: true });
  } catch (error) {
    // The live setup succeeded, so this wrapper owns the processes in pids.json.
    await cleanup();
    throw error;
  }
}
