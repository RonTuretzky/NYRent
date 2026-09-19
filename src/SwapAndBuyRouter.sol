// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ICoverPool
/// @notice The {CoverPool} surface the router needs: the pool currency, an on-chain
///         quote, and `buyProtectionFor`, which mints the cover to an explicit
///         recipient instead of stranding soulbound cover in the router.
interface ICoverPool {
    function currency() external view returns (address);

    function quote(uint256 seriesId, uint256 maxClaim)
        external
        view
        returns (uint256 premium, uint16 rateBps, uint256 capacityLeft, uint256 issuableNow);

    function buyProtectionFor(uint256 seriesId, uint256 maxClaim, uint256 maxPremium, address recipient) external;
}

/// @title ISwapRouter02
/// @notice The Uniswap SwapRouter02 surface the router needs. `ExactOutputParams`
///         carries no deadline (SwapRouter02 dropped it from the struct); the buy is
///         deadline-free by construction because the premium is re-quoted in the same
///         transaction.
interface ISwapRouter02 {
    struct ExactOutputParams {
        bytes path;
        address recipient;
        uint256 amountOut;
        uint256 amountInMaximum;
    }

    function WETH9() external view returns (address);
    function exactOutput(ExactOutputParams calldata params) external payable returns (uint256 amountIn);
}

/// @title IWETH9
/// @notice The single WETH entry point the router uses to wrap native ETH.
interface IWETH9 {
    function deposit() external payable;
}

/// @title SwapAndBuyRouter
/// @notice Pay-with-any-token entry point for {ICoverPool}: pulls `tokenIn` (or wraps
///         native ETH), exact-output swaps to exactly the quoted premium in the pool
///         currency via Uniswap SwapRouter02, buys protection minted directly to the
///         caller, and sweeps every leftover wei back to the caller. Immutable and
///         ownerless — no setters, no rescue surface beyond refund-to-caller — and it
///         never holds funds between transactions.
/// @dev    Atomicity: any failing leg (pull, swap, buy) reverts the whole call, so the
///         caller can never spend `tokenIn` without receiving cover. Slippage is
///         bounded by `amountInMaximum`; the premium is re-quoted on-chain in the same
///         transaction, so quote and purchase cannot diverge. The pool currency is read
///         from the pool itself at deployment — a currency mismatch is impossible by
///         construction.
contract SwapAndBuyRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────────────────
    // Events / errors
    // ─────────────────────────────────────────────────────────────────────────

    event SwappedAndBought(
        uint256 indexed seriesId,
        address indexed buyer,
        address indexed tokenIn,
        uint256 amountIn,
        uint256 premium,
        uint256 maxClaim
    );

    error ZeroAmount();
    error InvalidPath(string what);
    error NativeInputNotWeth();
    error NativeValueMismatch(uint256 value, uint256 amountInMaximum);

    // ─────────────────────────────────────────────────────────────────────────
    // Immutable configuration
    // ─────────────────────────────────────────────────────────────────────────

    ISwapRouter02 public immutable swapRouter;
    ICoverPool public immutable pool;

    /// @notice The pool currency (USDC on Arbitrum), read from the pool at deployment.
    IERC20 public immutable usdc;

    /// @notice Canonical wrapped native token, read from the swap router at deployment.
    address public immutable weth9;

    constructor(ISwapRouter02 swapRouter_, ICoverPool pool_) {
        swapRouter = swapRouter_;
        pool = pool_;
        usdc = IERC20(pool_.currency());
        weth9 = swapRouter_.WETH9();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Buyer actions
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Buys `maxClaim` of protection on `seriesId` for the caller, paying in
    ///         `tokenIn`: at most `amountInMaximum` is spent, the swap outputs exactly
    ///         the quoted premium, and all unspent `tokenIn` is refunded.
    /// @dev    `path` is a Uniswap V3 exact-OUTPUT path, so it is encoded in REVERSE:
    ///         it must start with the pool currency (the output) and end with `tokenIn`.
    ///         Native ETH: send `msg.value == amountInMaximum` with `tokenIn = weth9`;
    ///         the value is wrapped once on entry and treated as WETH from then on, so
    ///         the dust refund is paid in WETH (never a raw ETH send, which a contract
    ///         caller without a payable fallback could not receive). The sweep also
    ///         returns any stray `tokenIn`/currency balance donated to the router,
    ///         keeping its balances at zero after every call.
    /// @param tokenIn The token the caller pays with (the last token of `path`).
    /// @param amountInMaximum Slippage bound: the most `tokenIn` the swap may consume.
    /// @param path Exact-output swap path, pool-currency-first (see dev note).
    /// @param seriesId The series to buy protection on.
    /// @param maxClaim Claim units to buy (currency wei, 6 decimals for USDC).
    /// @return amountIn The `tokenIn` actually consumed by the swap.
    function swapAndBuy(
        address tokenIn,
        uint256 amountInMaximum,
        bytes calldata path,
        uint256 seriesId,
        uint256 maxClaim
    ) external payable nonReentrant returns (uint256 amountIn) {
        if (maxClaim == 0 || amountInMaximum == 0) revert ZeroAmount();
        // V3 path = 20-byte token + n × (3-byte fee + 20-byte token), n ≥ 1.
        if (path.length < 43 || (path.length - 20) % 23 != 0) revert InvalidPath("length");
        if (address(bytes20(path[:20])) != address(usdc)) revert InvalidPath("tokenOut");
        if (address(bytes20(path[path.length - 20:])) != tokenIn) revert InvalidPath("tokenIn");

        if (msg.value > 0) {
            if (tokenIn != weth9) revert NativeInputNotWeth();
            if (msg.value != amountInMaximum) revert NativeValueMismatch(msg.value, amountInMaximum);
            IWETH9(weth9).deposit{value: msg.value}();
        } else {
            IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountInMaximum);
        }

        (uint256 premium,,,) = pool.quote(seriesId, maxClaim);

        if (premium > 0) {
            IERC20(tokenIn).forceApprove(address(swapRouter), amountInMaximum);
            amountIn = swapRouter.exactOutput(
                ISwapRouter02.ExactOutputParams({
                    path: path, recipient: address(this), amountOut: premium, amountInMaximum: amountInMaximum
                })
            );
            IERC20(tokenIn).forceApprove(address(swapRouter), 0);
        }

        // maxPremium = premium: quoted in this same transaction, so the pool computes
        // the identical amount and pulls the approval in full.
        usdc.forceApprove(address(pool), premium);
        pool.buyProtectionFor(seriesId, maxClaim, premium, msg.sender);

        uint256 refund = IERC20(tokenIn).balanceOf(address(this));
        if (refund > 0) IERC20(tokenIn).safeTransfer(msg.sender, refund);
        uint256 usdcLeft = usdc.balanceOf(address(this));
        if (usdcLeft > 0) usdc.safeTransfer(msg.sender, usdcLeft);

        emit SwappedAndBought(seriesId, msg.sender, tokenIn, amountIn, premium, maxClaim);
    }
}
