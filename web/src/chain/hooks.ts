import { useEffect, useMemo } from "react";
import type { Address } from "viem";
import {
  useAccount,
  useBlockNumber,
  useReadContract,
  useReadContracts,
} from "wagmi";
import { deployment, isDeployed } from "./deployment";
import { isNetworkError } from "./errors";
import { erc20Abi, oracleAbi, poolAbi, tokenAbi } from "./contracts";
import {
  decodeObservation,
  decodeSeries,
  type Observation,
  type Series,
} from "./types";

/** Refetch a wagmi read on every new block. */
function useRefetchOnBlock(refetch: () => void, enabled: boolean) {
  const { data: blockNumber } = useBlockNumber({
    watch: true,
    query: { enabled },
  });
  useEffect(() => {
    if (enabled && blockNumber !== undefined) refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockNumber]);
}

/**
 * True only for transport/network failures (RPC unreachable, HTTP error,
 * timeout). A contract revert — e.g. series(id) on a nonexistent id — is NOT
 * an RPC failure: pages must render "not found" for those, and the distinct
 * RPC-down state only when the chain itself couldn't be reached.
 */
function isRpcFailure(error: unknown): boolean {
  return error != null && isNetworkError(error);
}

type BatchItem = { status: string; error?: unknown };

function anyRpcFailure(items: readonly BatchItem[] | undefined): boolean {
  return (items ?? []).some(
    (r) => r.status === "failure" && isRpcFailure(r.error),
  );
}

export function useSeries(seriesId: number | undefined): {
  series: Series | undefined;
  isLoading: boolean;
  rpcError: boolean;
  error: unknown;
} {
  const enabled = isDeployed && seriesId !== undefined;
  const read = useReadContract({
    abi: poolAbi,
    address: deployment.pool,
    functionName: "series",
    args: [BigInt(seriesId ?? 0)],
    query: { enabled },
  });
  useRefetchOnBlock(read.refetch, enabled);
  return {
    series: useMemo(() => decodeSeries(read.data), [read.data]),
    isLoading: enabled && read.isLoading,
    rpcError: enabled && isRpcFailure(read.error),
    error: read.error,
  };
}

export function useAllSeries(): {
  series: { id: number; series: Series }[];
  isLoading: boolean;
  rpcError: boolean;
} {
  // Enumeration is on-chain: seriesCount() → ids 0..n-1, so a series created
  // after the site build appears without a rebuild. deployment.seriesIds is
  // only the instant-render seed while the count is still resolving.
  const countRead = useReadContract({
    abi: poolAbi,
    address: deployment.pool,
    functionName: "seriesCount",
    query: { enabled: isDeployed },
  });
  useRefetchOnBlock(countRead.refetch, isDeployed);
  const onChainCount =
    countRead.data !== undefined ? Number(countRead.data) : undefined;
  const ids = useMemo(
    () =>
      onChainCount !== undefined
        ? Array.from({ length: onChainCount }, (_, i) => i)
        : deployment.seriesIds,
    [onChainCount],
  );
  const enabled = isDeployed && ids.length > 0;
  const read = useReadContracts({
    contracts: ids.map((id) => ({
      abi: poolAbi,
      address: deployment.pool,
      functionName: "series",
      args: [BigInt(id)],
    })),
    query: { enabled },
  });
  useRefetchOnBlock(read.refetch, enabled);
  const series = useMemo(() => {
    if (!read.data) return [];
    return read.data
      .map((r, i) => ({
        id: ids[i],
        series: r.status === "success" ? decodeSeries(r.result) : undefined,
      }))
      .filter((x): x is { id: number; series: Series } => !!x.series);
  }, [read.data, ids]);
  return {
    series,
    isLoading:
      isDeployed &&
      ((enabled && read.isLoading) ||
        (countRead.isLoading && deployment.seriesIds.length === 0)),
    rpcError:
      isDeployed &&
      (isRpcFailure(countRead.error) ||
        isRpcFailure(read.error) ||
        anyRpcFailure(read.data)),
  };
}

export interface PoolStats {
  salesPaused?: boolean | undefined;
  balance?: bigint;
  freeCapital?: bigint;
  reserved?: bigint;
  sponsor?: Address;
}

export function usePoolStats(): {
  stats: PoolStats;
  isLoading: boolean;
  rpcError: boolean;
} {
  const enabled = isDeployed;
  const read = useReadContracts({
    allowFailure: true,
    contracts: [
      {
        abi: erc20Abi,
        address: deployment.currency,
        functionName: "balanceOf",
        args: [deployment.pool],
      },
      { abi: poolAbi, address: deployment.pool, functionName: "freeCapital" },
      { abi: poolAbi, address: deployment.pool, functionName: "sponsor" },
      { abi: poolAbi, address: deployment.pool, functionName: "salesPaused" },
    ],
    query: { enabled },
  });
  useRefetchOnBlock(read.refetch, enabled);
  const stats = useMemo<PoolStats>(() => {
    const [bal, free, sponsor, paused] = read.data ?? [];
    const balance =
      bal?.status === "success" ? (bal.result as bigint) : undefined;
    const freeCapital =
      free?.status === "success" ? (free.result as bigint) : undefined;
    return {
      balance,
      freeCapital,
      salesPaused: paused?.status === "success" ? (paused.result as boolean) : undefined,
      reserved:
        balance !== undefined && freeCapital !== undefined
          ? balance - freeCapital
          : undefined,
      sponsor:
        sponsor?.status === "success"
          ? (sponsor.result as Address)
          : undefined,
    };
  }, [read.data]);
  return {
    stats,
    isLoading: enabled && read.isLoading,
    rpcError:
      enabled && (isRpcFailure(read.error) || anyRpcFailure(read.data)),
  };
}

export interface CurrencyMeta {
  symbol: string;
  decimals: number;
}

export function useCurrencyMeta(): CurrencyMeta & { rpcError: boolean } {
  const read = useReadContracts({
    allowFailure: true,
    contracts: [
      { abi: erc20Abi, address: deployment.currency, functionName: "symbol" },
      { abi: erc20Abi, address: deployment.currency, functionName: "decimals" },
    ],
    query: { enabled: isDeployed, staleTime: Infinity },
  });
  const [sym, dec] = read.data ?? [];
  return {
    symbol: sym?.status === "success" ? (sym.result as string) : "WXDAI",
    decimals: dec?.status === "success" ? Number(dec.result) : 18,
    rpcError:
      isDeployed && (isRpcFailure(read.error) || anyRpcFailure(read.data)),
  };
}

export function useUserCurrency(): {
  address?: Address;
  balance?: bigint;
  allowance?: bigint;
  rpcError: boolean;
  refetch: () => void;
} {
  const { address } = useAccount();
  const enabled = isDeployed && !!address;
  const read = useReadContracts({
    allowFailure: true,
    contracts: [
      {
        abi: erc20Abi,
        address: deployment.currency,
        functionName: "balanceOf",
        args: [address ?? deployment.pool],
      },
      {
        abi: erc20Abi,
        address: deployment.currency,
        functionName: "allowance",
        args: [address ?? deployment.pool, deployment.pool],
      },
    ],
    query: { enabled },
  });
  useRefetchOnBlock(read.refetch, enabled);
  const [bal, allow] = read.data ?? [];
  return {
    address,
    balance: bal?.status === "success" ? (bal.result as bigint) : undefined,
    allowance:
      allow?.status === "success" ? (allow.result as bigint) : undefined,
    rpcError:
      enabled && (isRpcFailure(read.error) || anyRpcFailure(read.data)),
    refetch: read.refetch,
  };
}

export function useCoverBalance(seriesId: number | undefined): {
  balance?: bigint;
  rpcError: boolean;
  refetch: () => void;
} {
  const { address } = useAccount();
  const enabled = isDeployed && !!address && seriesId !== undefined;
  const read = useReadContract({
    abi: tokenAbi,
    address: deployment.token,
    functionName: "balanceOf",
    args: [address ?? deployment.pool, BigInt(seriesId ?? 0)],
    query: { enabled },
  });
  useRefetchOnBlock(read.refetch, enabled);
  return {
    balance: enabled ? (read.data as bigint | undefined) : undefined,
    rpcError: enabled && isRpcFailure(read.error),
    refetch: read.refetch,
  };
}

export function useObservations(): {
  observations: Observation[];
  isLoading: boolean;
  rpcError: boolean;
} {
  const countRead = useReadContract({
    abi: oracleAbi,
    address: deployment.oracle,
    functionName: "observationCount",
    query: { enabled: isDeployed },
  });
  useRefetchOnBlock(countRead.refetch, isDeployed);
  const count = countRead.data !== undefined ? Number(countRead.data) : 0;
  const read = useReadContracts({
    allowFailure: true,
    contracts: Array.from({ length: count }, (_, i) => ({
      abi: oracleAbi,
      address: deployment.oracle,
      functionName: "observations",
      args: [BigInt(i)],
    })),
    query: { enabled: isDeployed && count > 0 },
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
    isLoading: isDeployed && (countRead.isLoading || (count > 0 && read.isLoading)),
    rpcError:
      isDeployed &&
      (isRpcFailure(countRead.error) ||
        isRpcFailure(read.error) ||
        anyRpcFailure(read.data)),
  };
}

/** Premium quote — prefers the on-chain quote() view, falls back to local math. */
export function useQuote(
  seriesId: number | undefined,
  maxClaim: bigint | null,
  premiumRateBps: number | undefined,
): bigint | undefined {
  const enabled =
    isDeployed && seriesId !== undefined && maxClaim !== null && maxClaim > 0n;
  const read = useReadContract({
    abi: poolAbi,
    address: deployment.pool,
    functionName: "quote",
    args: [BigInt(seriesId ?? 0), maxClaim ?? 0n],
    query: { enabled },
  });
  if (!enabled) return undefined;
  if (read.data !== undefined) {
    const d = read.data;
    if (typeof d === "bigint") return d;
    if (Array.isArray(d) && typeof d[0] === "bigint") return d[0];
  }
  if (premiumRateBps !== undefined && maxClaim !== null) {
    return (maxClaim * BigInt(premiumRateBps)) / 10_000n;
  }
  return undefined;
}
