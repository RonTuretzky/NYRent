import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createPublicKey } from "node:crypto";
import { JsonRpcProvider, ContractFactory, toUtf8Bytes } from "ethers";
import { artifact } from "./deploy.mjs";
import { getKeys, makeMail, profiles } from "./fixtures.mjs";

export const ARCHIVE_RPC = "http://127.0.0.1:18547";
export const ARCHIVE_START = Date.parse("2026-02-18T12:00:00Z") / 1000;
export async function deployArchives(
  provider = new JsonRpcProvider(ARCHIVE_RPC),
  save = true,
) {
  const network = await provider.getNetwork();
  if (network.chainId !== 31339n)
    throw Error("Archive harness deploys only to local chain 31339");
  const signer = await provider.getSigner(0);
  const create = async (name, args = []) => {
    const a = await artifact(name, name);
    const c = await new ContractFactory(
      a.abi,
      a.bytecode.object,
      signer,
    ).deploy(...args, { gasLimit: 30000000 });
    await c.waitForDeployment();
    return c;
  };
  const decoder = await create("RentParser");
  const parser = await create("ArchiveRentParser", [
    await decoder.getAddress(),
  ]);
  const dkim = await create("DkimVerifier");
  const keys = await getKeys();
  const sources = profiles.slice(0, 2).map((p, i) => ({
    domain: toUtf8Bytes(p.domain),
    from: toUtf8Bytes(p.from),
    listId: toUtf8Bytes(""),
    selector: toUtf8Bytes("rent"),
    modulus:
      "0x" +
      Buffer.from(
        createPublicKey(keys["mail" + p.id]).export({ format: "jwk" }).n,
        "base64url",
      ).toString("hex"),
    publication: i,
  }));
  const feed = await create("PinnedRentFeed", [
    await dkim.getAddress(),
    await parser.getAddress(),
    sources,
    2,
    true,
  ]);
  const cases = JSON.parse(await readFile("web/archive/corpus.json", "utf8"));
  const emails = ["pinpointe-2026-02", "bigger-2026-02"].map((id, i) => {
    const entry = cases.find((r) => r.id === id);
    const raw = makeMail(keys, profiles[i].id, {
      body: `ARCHIVE WORDING IN A SYNTHETIC SIGNED ENVELOPE. NOT A PUBLISHER EMAIL.\r\n\r\n${entry.text.replace(/\n/g, "\r\n")}\r\n`,
      timestamp: entry.issuedAt,
      month: "2026-01",
      amount: "4,695.00",
    });
    return { id, raw, sourceId: i };
  });
  if (save) {
    await mkdir("web/archive", { recursive: true });
    for (const name of [
      "RentParser",
      "ArchiveRentParser",
      "DkimVerifier",
      "PinnedRentFeed",
    ])
      await writeFile(
        `web/abi/${name}.json`,
        JSON.stringify((await artifact(name, name)).abi),
      );
    for (const e of emails)
      await writeFile(
        `web/archive/${e.id}-test.eml`,
        Buffer.from(e.raw, "latin1"),
      );
    const config = {
      rpc: ARCHIVE_RPC,
      chainId: 31339,
      testDeployment: true,
      parser: await parser.getAddress(),
      feed: await feed.getAddress(),
      dkim: await dkim.getAddress(),
      policyHash: await feed.policyHash(),
      month: 202601,
      warning:
        "Real archive wording; synthetic signing keys and envelopes. No real publisher key has been configured.",
      sources: profiles
        .slice(0, 2)
        .map((p, i) => ({ ...p, publication: i, archiveId: emails[i].id })),
    };
    await writeFile("web/archive/config.json", JSON.stringify(config, null, 2));
  }
  return {
    provider,
    signer,
    decoder,
    parser,
    dkim,
    feed,
    keys,
    sources,
    emails,
  };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const p = new JsonRpcProvider(ARCHIVE_RPC);
  try {
    await deployArchives(p);
  } finally {
    p.destroy();
  }
}
