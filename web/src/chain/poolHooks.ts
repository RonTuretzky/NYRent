/**
 * Read hooks for the PERMISSIONLESS CoverPool (single contract version),
 * scoped to the ACTIVE deployment from the registry context — pages never
 * pass chainIds. Reads pin `chainId` explicitly so they hit the right
 * transport in the multi-chain wagmi config regardless of the wallet's chain.
 *
 * The Series shape/decoder is the canonical one in chain/types.ts; these
 * hooks add the per-series paused flag (mapping read) and the wallet-scoped
 * currency/cover reads the underwrite + redeem pages need.
 */
import { useEffect, useMemo } from "react";
import type { Address } from "viem";
import {
  useAccount,
  useBlockNumber,
  useReadContract,
  useReadContracts,
} from "wagmi";
import { erc20Abi, oracleAbi, poolAbi, tokenAbi } from "./contracts";
import { isNetworkError } from "./errors";
import { isLiveDeployment, useActiveDeployment } from "./registry";
import {
  decodeObservation,
  decodeSeries,
  type Observation,
  type Series,
} from "./types";

/** The reference series shape the app curates around: an 800-cent strike
 * band with the sale closing exactly when observation opens. */
export const STANDARD_BAND_CENTS = 800;

export function isStandardShape(s: {
  strikeLowCents: number;
  strikeHighCents: number;
  saleEnd: bigint;
  obsStart: bigint;
}): boolean {
  return (
    s.strikeHighCents - s.strikeLowCents === STANDARD_BAND_CENTS &&
    s.saleEnd === s.obsStart
  );
}

/** Refetch a wagmi read on every new block of the active chain. */
function useRefetchOnBlock(
  chainId: number,
  refetch: () => void,
  enabled: boolean,
) {
  const { data: blockNumber } = useBlockNumber({
    watch: true,
    chainId,
    query: { enabled },
  });
  useEffect(() => {
    if (enabled && blockNumber !== undefined) refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockNumber]);
}

/** True only for transport/network failures — a contract revert (e.g. series
 * on a nonexistent id) is NOT an RPC failure. */
function isRpcFailure(error: unknown): boolean {
  return error != null && isNetworkError(error);
}

type BatchItem = { status: string; error?: unknown };

function anyRpcFailure(items: readonly BatchItem[] | undefined): boolean {
  return (items ?? []).some(
    (r) => r.status === "failure" && isRpcFailure(r.error),
  );
}

export interface SeriesRow {
  id: number;
  series: Series;
  paused: boolean;
}

/** One series + its per-series paused flag on the active deployment. */
export function useSeriesRow(seriesId: number | undefined): {
  series: Series | undefined;
  paused: boolean;
  isLoading: boolean;
  rpcError: boolean;
} {
  const { deployment } = useActiveDeployment();
  const enabled = isLiveDeployment(deployment) && seriesId !== undefined;
  const read = useReadContracts({
    allowFailure: true,
    contracts: [
      {
        abi: poolAbi,
        address: deployment.pool,
        chainId: deployment.chainId,
        functionName: "series",
        args: [BigInt(seriesId ?? 0)],
      },
      {
        abi: poolAbi,
        address: deployment.pool,
        chainId: deployment.chainId,
        functionName: "seriesPaused",
        args: [BigInt(seriesId ?? 0)],
      },
    ],
    query: { enabled },
  });
  useRefetchOnBlock(deployment.chainId, read.refetch, enabled);
  const [seriesRead, pausedRead] = read.data ?? [];
  return {
    series: useMemo(
      () =>
        seriesRead?.status === "success"
          ? decodeSeries(seriesRead.result)
          : undefined,
      [seriesRead],
    ),
    paused:
      pausedRead?.status === "success" ? Boolean(pausedRead.result) : false,
    isLoading: enabled && read.isLoading,
    rpcError: enabled && (isRpcFailure(read.error) || anyRpcFailure(read.data)),
  };
}

/** Every series on the active deployment, with paused flags. Enumeration is
 * on-chain (seriesCount → ids 0..n−1) so new series appear without a rebuild;
 * the deployment's baked seriesIds only seed the very first render. */
export function useSeriesIndex(): {
  rows: SeriesRow[];
  isLoading: boolean;
  rpcError: boolean;
} {
  const { deployment } = useActiveDeployment();
  const live = isLiveDeployment(deployment);
  const countRead = useReadContract({
    abi: poolAbi,
    address: deployment.pool,
    chainId: deployment.chainId,
    functionName: "seriesCount",
    query: { enabled: live },
  });
  useRefetchOnBlock(deployment.chainId, countRead.refetch, live);
  const onChainCount =
    countRead.data !== undefined ? Number(countRead.data) : undefined;
  const ids = useMemo(
    () =>
      onChainCount !== undefined
        ? Array.from({ length: onChainCount }, (_, i) => i)
        : deployment.seriesIds,
    [onChainCount, deployment.seriesIds],
  );
  const enabled = live && ids.length > 0;
  const read = useReadContracts({
    allowFailure: true,
    contracts: ids.flatMap((id) => [
      {
        abi: poolAbi,
        address: deployment.pool,
        chainId: deployment.chainId,
        functionName: "series",
        args: [BigInt(id)],
      } as const,
      {
        abi: poolAbi,
        address: deployment.pool,
        chainId: deployment.chainId,
        functionName: "seriesPaused",
        args: [BigInt(id)],
      } as const,
    ]),
    query: { enabled },
  });
  useRefetchOnBlock(deployment.chainId, read.refetch, enabled);
  const rows = useMemo<SeriesRow[]>(() => {
    if (!read.data) return [];
    const out: SeriesRow[] = [];
    ids.forEach((id, i) => {
      const s = read.data![i * 2];
      const p = read.data![i * 2 + 1];
      const decoded =
        s?.status === "success" ? decodeSeries(s.result) : undefined;
      if (decoded) {
        out.push({
          id,
          series: decoded,
          paused: p?.status === "success" ? Boolean(p.result) : false,
        });
      }
    });
    return out;
  }, [read.data, ids]);
  return {
    rows,
    isLoading:
      live &&
      ((enabled && read.isLoading) ||
        (countRead.isLoading && deployment.seriesIds.length === 0)),
    rpcError:
      live &&
      (isRpcFailure(countRead.error) ||
        isRpcFailure(read.error) ||
        anyRpcFailure(read.data)),
  };
}

/** The connected wallet's pool-currency balance and pool allowance on the
 * active chain (underwriting escrow / premium approvals). */
export function useWalletCurrency(): {
  address?: Address;
  balance?: bigint;
  allowance?: bigint;
  rpcError: boolean;
  refetch: () => void;
} {
  const { deployment } = useActiveDeployment();
  const { address } = useAccount();
  const enabled = isLiveDeployment(deployment) && !!address;
  const read = useReadContracts({
    allowFailure: true,
    contracts: [
      {
        abi: erc20Abi,
        address: deployment.currency.address,
        chainId: deployment.chainId,
        functionName: "balanceOf",
        args: [address ?? deployment.pool],
      },
      {
        abi: erc20Abi,
        address: deployment.currency.address,
        chainId: deployment.chainId,
        functionName: "allowance",
        args: [address ?? deployment.pool, deployment.pool],
      },
    ],
    query: { enabled },
  });
  useRefetchOnBlock(deployment.chainId, read.refetch, enabled);
  const [bal, allow] = read.data ?? [];
  return {
    address,
    balance: bal?.status === "success" ? (bal.result as bigint) : undefined,
    allowance:
      allow?.status === "success" ? (allow.result as bigint) : undefined,
    rpcError: enabled && (isRpcFailure(read.error) || anyRpcFailure(read.data)),
    refetch: read.refetch,
  };
}

/** The connected wallet's soulbound cover balance for a series. */
export function useCoverUnits(seriesId: number | undefined): {
  balance?: bigint;
  rpcError: boolean;
  refetch: () => void;
} {
  const { deployment } = useActiveDeployment();
  const { address } = useAccount();
  const enabled =
    isLiveDeployment(deployment) && !!address && seriesId !== undefined;
  const read = useReadContract({
    abi: tokenAbi,
    address: deployment.token,
    chainId: deployment.chainId,
    functionName: "balanceOf",
    args: [address ?? deployment.pool, BigInt(seriesId ?? 0)],
    query: { enabled },
  });
  useRefetchOnBlock(deployment.chainId, read.refetch, enabled);
  return {
    balance: enabled ? (read.data as bigint | undefined) : undefined,
    rpcError: enabled && isRpcFailure(read.error),
    refetch: read.refetch,
  };
}

/** Every oracle observation on the active deployment. */
export function useOracleObservations(): {
  observations: Observation[];
  isLoading: boolean;
  rpcError: boolean;
} {
  const { deployment } = useActiveDeployment();
  const live = isLiveDeployment(deployment);
  const countRead = useReadContract({
    abi: oracleAbi,
    address: deployment.oracle,
    chainId: deployment.chainId,
    functionName: "observationCount",
    query: { enabled: live },
  });
  useRefetchOnBlock(deployment.chainId, countRead.refetch, live);
  const count = countRead.data !== undefined ? Number(countRead.data) : 0;
  const read = useReadContracts({
    allowFailure: true,
    contracts: Array.from({ length: count }, (_, i) => ({
      abi: oracleAbi,
      address: deployment.oracle,
      chainId: deployment.chainId,
      functionName: "observations",
      args: [BigInt(i)],
    })),
    query: { enabled: live && count > 0 },
  });
  const observations = useMemo(() => {
    if (!read.data) return [];
    return read.data
      .map((r, i) =>
        r.status === "success" ? decodeObservation(r.result, i) : undefined,
      )
      .filter((o): o is Observation => !!o);
  }, [read.data]);
  return {
    observations,
    isLoading: live && (countRead.isLoading || (count > 0 && read.isLoading)),
    rpcError:
      live &&
      (isRpcFailure(countRead.error) ||
        isRpcFailure(read.error) ||
        anyRpcFailure(read.data)),
  };
}
