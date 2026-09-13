import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import {
  JsonRpcProvider,
  ContractFactory,
  Contract,
  keccak256,
  toUtf8Bytes,
} from "ethers";
export const RPC = process.env.RENT_RPC ?? "http://127.0.0.1:18545";
export async function artifact(file, name) {
  return JSON.parse(await readFile(`out/${file}.sol/${name}.json`, "utf8"));
}
export async function deploy(provider = new JsonRpcProvider(RPC), save = true) {
  const network = await provider.getNetwork();
  if (network.chainId !== 31338n)
    throw Error("Local deployment only: expected chain 31338");
  const signer = await provider.getSigner(0);
  const manifest = JSON.parse(await readFile(".local/fixtures.json", "utf8"));
  const addresses = {};
  const create = async (file, name, args = []) => {
    const a = await artifact(file, name);
    const c = await new ContractFactory(
      a.abi,
      a.bytecode.object,
      signer,
    ).deploy(...args, { gasLimit: 30000000 });
    await c.waitForDeployment();
    addresses[name] = await c.getAddress();
    return c;
  };
  const dns = await create("KeyProof", "FrozenDNSSEC", [manifest.rootDS]);
  const keys = await create("KeyProof", "KeyProof", [addresses.FrozenDNSSEC]);
  const dkim = await create("DkimVerifier", "DkimVerifier");
  const parser = await create("RentParser", "RentParser");
  const sources = manifest.profiles.map((p) => ({
    ...p,
    domain: toUtf8Bytes(p.domain),
    from: toUtf8Bytes(p.from),
    listId: toUtf8Bytes(p.listId),
    template: Object.fromEntries(
      Object.entries(p.template).map(([k, v]) => [k, toUtf8Bytes(v)]),
    ),
  }));
  const feed = await create("RentEmailFeed", "RentEmailFeed", [
    addresses.KeyProof,
    addresses.DkimVerifier,
    addresses.RentParser,
    keccak256(
      toUtf8Bytes(
        "manhattan:mean:1br:corcoran:publisher-sample:USD/month:TEST",
      ),
    ),
    sources,
    2,
    45 * 86400,
    true,
  ]);
  if (save) {
    await mkdir("web/vendor", { recursive: true });
    await mkdir("web/abi", { recursive: true });
    await copyFile(
      "node_modules/ethers/dist/ethers.min.js",
      "web/vendor/ethers.min.js",
    );
    for (const [file, name] of [
      ["RentEmailFeed", "RentEmailFeed"],
      ["KeyProof", "KeyProof"],
      ["DkimVerifier", "DkimVerifier"],
      ["RentParser", "RentParser"],
      ["KeyProof", "FrozenDNSSEC"],
    ])
      await writeFile(
        `web/abi/${name}.json`,
        JSON.stringify((await artifact(file, name)).abi),
      );
    const config = {
      chainId: 31338,
      rpc: RPC,
      ...addresses,
      policyHash: await feed.policyHash(),
      anchorHash: await keys.anchorHash(),
      testDeployment: true,
      series: "Manhattan · 1 bedroom · arithmetic mean · Corcoran sample",
      month: 202608,
      sources: manifest.profiles,
      startingTimestamp: manifest.start,
    };
    await writeFile("web/config.json", JSON.stringify(config, null, 2));
    await writeFile(".local/deployment.json", JSON.stringify(config, null, 2));
    console.log(
      JSON.stringify({ network: "LOCAL TEST CHAIN", ...addresses }, null, 2),
    );
  }
  return { feed, keys, dkim, parser, dns, provider, signer, addresses };
}
if (import.meta.url === `file://${process.argv[1]}`) await deploy();
