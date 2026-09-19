// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CoverToken} from "./CoverToken.sol";
import {IObservationOracle} from "./interfaces/IObservationOracle.sol";

/// @title CoverPool
/// @notice Fully permissionless rent-protection pool with NO roles at all. ANYONE
///         creates a series by escrowing its full capacity 1:1 in the pool currency;
///         buyers pay a premium to mint {CoverToken} claim units backed by that
///         series' escrow alone; settlement is permissionless against a qualifying
///         {CredailyRentOracle} observation; redemption pays `amount × payoutRatio`
///         out of the series escrow while the claim window is open. No upgradeability,
///         no series setters, no fee sink, no shared pot.
///
///         Core features:
///         - {createSeries} is callable by anyone and pulls `capacity` currency from
///           the caller as the series escrow — every claim unit is backed 1:1 by
///           construction, so no solvency check is ever needed at purchase time;
///         - accounting is strictly per series: escrow, sold, premiumsAccrued,
///           paidOut and withdrawn never mix across series, so one creator's claims
///           can never touch another creator's escrow;
///         - `saleEnd ≤ obsStart` is enforced on-chain, so buyers can never trade on
///           a qualifying observation that already exists (see docs/PROTOCOL.md);
///         - {buyProtectionFor} splits payer from holder: the premium is pulled from
///           `msg.sender` while the claim units are minted to `recipient`, so routers
///           and agent wallets never strand cover on themselves;
///         - the series creator alone can pause its sales ({setSeriesPaused}), top up
///           escrow before the sale ends ({addCapacity}), cancel an unsold series
///           ({cancelSeries}) and collect the residual after the claim window
///           ({withdrawResidual}) — there is no global pause and no other lever.
///
///         SOULBOUND: {CoverToken} transfers are disabled. The `recipient` of
///         {buyProtectionFor} is a MINT DESTINATION only — cover cannot change hands
///         after minting, and only the recipient can redeem.
///
///         UNSETTLED SERIES: a series that never settles pays no claims at all —
///         {redeem} requires settlement — and once `redeemEnd` passes the full escrow
///         plus premiums return to the creator via {withdrawResidual}. {settle} itself
///         has no deadline; only the observation's `t` must lie inside
///         `[obsStart, obsEnd]`, and a settlement landing after `redeemEnd` no longer
///         opens redemption.
/// @dev    Conservation invariant: Σ over series of (escrow + premiumsAccrued −
///         paidOut − withdrawn) == currency.balanceOf(pool) at all times (absent
///         donations). Per-series solvency: paidOut ≤ sold × ratio / 1e18 ≤ escrow.
contract CoverPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────────────────

    struct Series {
        address creator; // escrowed the capacity; sole holder of the series levers
        uint32 strikeLowCents; // payout 0 at/below     (demo: 9288)
        uint32 strikeHighCents; // payout 1 at/above     (demo: 10088)
        uint16 premiumRateBps; // premium per 1e4 of max claim (demo: 1133)
        bool settled;
        bool cancelled; // creator refund taken while unsold; series permanently closed
        uint64 saleEnd; // no purchases after; ≤ obsStart by construction
        uint64 obsStart; // observation window [obsStart, obsEnd]
        uint64 obsEnd;
        uint64 redeemEnd; // = obsEnd + claim window; after: residual releases
        uint128 escrow; // max sellable claim, backed 1:1 (currency wei); zeroed by cancel
        uint128 sold; // total max-claim sold
        uint128 premiumsAccrued; // Σ premiums pulled into this series' bucket
        uint128 paidOut; // Σ currency paid to redeemers of this series
        uint256 withdrawn; // Σ currency returned to the creator via withdrawResidual (a
        // cancel refund zeroes `escrow` instead, closing the books the same way)
        bool residualWithdrawn; // one-shot latch across the cancel and residual paths
        uint64 payoutRatioWad; // ratio in 1e18, set once
        uint64 observationT; // provenance
        bytes32 emailId;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Events / errors
    // ─────────────────────────────────────────────────────────────────────────

    event SeriesCreated(
        uint256 indexed seriesId,
        address indexed creator,
        uint32 strikeLowCents,
        uint32 strikeHighCents,
        uint16 premiumRateBps,
        uint64 saleEnd,
        uint64 obsStart,
        uint64 obsEnd,
        uint64 redeemEnd,
        uint128 capacity
    );
    event CapacityAdded(uint256 indexed seriesId, address indexed creator, uint256 amount, uint256 newEscrow);
    event SeriesCancelled(uint256 indexed seriesId, address indexed creator, uint256 refund);
    event SeriesPausedSet(uint256 indexed seriesId, bool paused);
    event ProtectionBought(
        uint256 indexed seriesId, address indexed buyer, address indexed recipient, uint256 maxClaim, uint256 premium
    );
    event SeriesSettled(
        uint256 indexed seriesId,
        uint256 obsIndex,
        uint64 payoutRatioWad,
        uint32 cents,
        uint64 observationT,
        bytes32 emailId
    );
    event Redeemed(uint256 indexed seriesId, address indexed holder, uint256 amount, uint256 payout);
    event ResidualWithdrawn(uint256 indexed seriesId, address indexed creator, uint256 amount);

    error NotCreator();
    error ZeroAddress();
    error InvalidSeries();
    error InvalidParams(string what);
    error SaleClosed();
    error SalesArePaused();
    error SeriesClosed();
    error ZeroAmount();
    error CapacityExceeded();
    error PremiumTooHigh(uint256 premium, uint256 maxPremium);
    error PremiumRoundsToZero();
    error AlreadySettled();
    error NotSettled();
    error ObservationOutOfWindow(uint64 t);
    error RedeemWindowClosed();
    error RedeemWindowOpen();
    error AlreadySold();
    error ResidualAlreadyWithdrawn();

    // ─────────────────────────────────────────────────────────────────────────
    // Immutable configuration
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Minimum claim window: {createSeries} requires `redeemEnd ≥ obsEnd +
    ///         MIN_REDEEM_WINDOW`, so holders always have a real chance to submit the
    ///         email, settle and redeem — a creator can no longer sell premium-bearing
    ///         cover whose redemption window is seconds long and then reclaim escrow
    ///         plus premiums via {withdrawResidual}.
    uint64 public constant MIN_REDEEM_WINDOW = 7 days;

    IERC20 public immutable currency;
    CoverToken public immutable token;
    IObservationOracle public immutable oracle;

    // ─────────────────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────────────────

    Series[] internal _series;

    /// @notice Creator-controlled per-series sales switch. NEVER blocks settle or
    ///         redeem. There is no global pause.
    mapping(uint256 seriesId => bool) public seriesPaused;

    /// @dev `currency_` MUST be a standard ERC-20: no transfer fee, no rebasing, no
    ///      hooks that change state (reentry is blocked contract-wide, but a deviating
    ///      token would record more escrow/premium than the pool actually received and
    ///      the shortfall would bleed across series). The deployment currencies are
    ///      fixed here at deploy time — WXDAI on Gnosis, native USDC on Arbitrum —
    ///      both of which comply.
    constructor(IERC20 currency_, CoverToken token_, IObservationOracle oracle_) {
        currency = currency_;
        token = token_;
        oracle = oracle_;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    function seriesCount() external view returns (uint256) {
        return _series.length;
    }

    function series(uint256 seriesId) external view returns (Series memory) {
        if (seriesId >= _series.length) revert InvalidSeries();
        return _series[seriesId];
    }

    /// @notice Premium quote for `maxClaim` of protection.
    /// @return premium Total premium in currency wei.
    /// @return rateBps The series premium rate.
    /// @return capacityLeft Unsold escrow-backed capacity (max-claim wei). Zero for a
    ///         cancelled series: the refund zeroed its escrow, so no phantom capacity
    ///         is ever reported.
    /// @return issuableNow Max-claim actually buyable right now: the full
    ///         `capacityLeft` while the sale is open (every unit is escrow-backed
    ///         1:1), zero once the series is paused, settled, cancelled or past
    ///         `saleEnd`.
    function quote(uint256 seriesId, uint256 maxClaim)
        external
        view
        returns (uint256 premium, uint16 rateBps, uint256 capacityLeft, uint256 issuableNow)
    {
        if (seriesId >= _series.length) revert InvalidSeries();
        Series storage s = _series[seriesId];
        premium = (maxClaim * s.premiumRateBps) / 1e4;
        rateBps = s.premiumRateBps;
        capacityLeft = s.escrow - s.sold;
        bool open = !s.cancelled && !s.settled && !seriesPaused[seriesId] && block.timestamp <= s.saleEnd;
        issuableNow = open ? capacityLeft : 0;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Creator actions
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Creates a new protection series, pulling `capacity` currency from the
    ///         caller as the series escrow. Callable by ANYONE; the caller becomes the
    ///         series creator. Parameters are immutable afterwards — no setter exists
    ///         at all.
    /// @dev On-chain requirements: strikes ordered and nonzero, `premiumRateBps ≤ 1e4`,
    ///      all timestamps in the future and ordered `saleEnd ≤ obsStart < obsEnd <
    ///      redeemEnd` (the `saleEnd ≤ obsStart` informed-trading rule is a contract
    ///      invariant, not a recommendation), `redeemEnd ≥ obsEnd + MIN_REDEEM_WINDOW`
    ///      (7 days — holders always get a real settle-and-redeem window; see
    ///      docs/PROTOCOL.md), `capacity > 0`.
    function createSeries(
        uint32 strikeLowCents,
        uint32 strikeHighCents,
        uint16 premiumRateBps,
        uint64 saleEnd,
        uint64 obsStart,
        uint64 obsEnd,
        uint64 redeemEnd,
        uint128 capacity
    ) external nonReentrant returns (uint256 seriesId) {
        if (strikeLowCents == 0 || strikeLowCents >= strikeHighCents) revert InvalidParams("strikes");
        if (premiumRateBps > 1e4) revert InvalidParams("premiumRate");
        if (block.timestamp >= saleEnd) revert InvalidParams("saleEnd");
        if (!(saleEnd <= obsStart && obsStart < obsEnd && obsEnd < redeemEnd)) revert InvalidParams("windows");
        if (uint256(redeemEnd) < uint256(obsEnd) + MIN_REDEEM_WINDOW) revert InvalidParams("claimWindow");
        if (capacity == 0) revert InvalidParams("capacity");
        seriesId = _series.length;
        _series.push(
            Series({
                creator: msg.sender,
                strikeLowCents: strikeLowCents,
                strikeHighCents: strikeHighCents,
                premiumRateBps: premiumRateBps,
                settled: false,
                cancelled: false,
                saleEnd: saleEnd,
                obsStart: obsStart,
                obsEnd: obsEnd,
                redeemEnd: redeemEnd,
                escrow: capacity,
                sold: 0,
                premiumsAccrued: 0,
                paidOut: 0,
                withdrawn: 0,
                residualWithdrawn: false,
                payoutRatioWad: 0,
                observationT: 0,
                emailId: bytes32(0)
            })
        );
        currency.safeTransferFrom(msg.sender, address(this), capacity);
        emit SeriesCreated(
            seriesId,
            msg.sender,
            strikeLowCents,
            strikeHighCents,
            premiumRateBps,
            saleEnd,
            obsStart,
            obsEnd,
            redeemEnd,
            capacity
        );
    }

    /// @notice Pauses or resumes sales for `seriesId`; other series are unaffected.
    ///         Series creator only. NEVER blocks settle or redeem.
    function setSeriesPaused(uint256 seriesId, bool paused) external {
        if (seriesId >= _series.length) revert InvalidSeries();
        if (msg.sender != _series[seriesId].creator) revert NotCreator();
        seriesPaused[seriesId] = paused;
        emit SeriesPausedSet(seriesId, paused);
    }

    /// @notice Pulls `amount` more currency from the creator into the series escrow,
    ///         raising the sellable capacity. Series creator only, before `saleEnd`,
    ///         and only while the series is unsettled — once settled, sales are shut
    ///         forever, so a top-up could never be sold and would only sit as dead
    ///         escrow until `redeemEnd`.
    function addCapacity(uint256 seriesId, uint128 amount) external nonReentrant {
        if (seriesId >= _series.length) revert InvalidSeries();
        Series storage s = _series[seriesId];
        if (msg.sender != s.creator) revert NotCreator();
        if (amount == 0) revert ZeroAmount();
        if (s.cancelled) revert SeriesClosed();
        if (s.settled) revert AlreadySettled();
        if (block.timestamp > s.saleEnd) revert SaleClosed();
        s.escrow += amount;
        currency.safeTransferFrom(msg.sender, address(this), amount);
        emit CapacityAdded(seriesId, msg.sender, amount, s.escrow);
    }

    /// @notice Cancels `seriesId` and refunds the full escrow to the creator. Series
    ///         creator only, and only while nothing has been sold and the series is
    ///         unsettled. Permanently closes the series: no purchase, settlement,
    ///         capacity top-up or residual withdrawal can follow.
    /// @dev MUTUALLY EXCLUSIVE with {withdrawResidual}: the two creator exits share the
    ///      `residualWithdrawn` latch, consumed in BOTH directions — cancel blocks a
    ///      later residual withdrawal and a taken residual blocks cancel — so the
    ///      creator's capital can only ever leave the series once. The refund also
    ///      ZEROES the escrow, closing the series' book: even hypothetically past the
    ///      latch, a second exit would find nothing left to pay.
    function cancelSeries(uint256 seriesId) external nonReentrant {
        if (seriesId >= _series.length) revert InvalidSeries();
        Series storage s = _series[seriesId];
        if (msg.sender != s.creator) revert NotCreator();
        if (s.cancelled) revert SeriesClosed();
        if (s.residualWithdrawn) revert ResidualAlreadyWithdrawn();
        if (s.settled) revert AlreadySettled();
        if (s.sold != 0) revert AlreadySold();
        s.cancelled = true;
        s.residualWithdrawn = true; // the refund IS the residual — one-shot across both exits
        uint256 refund = s.escrow;
        s.escrow = 0; // book the refund out of the series: a cancelled series backs nothing
        currency.safeTransfer(msg.sender, refund);
        emit SeriesCancelled(seriesId, msg.sender, refund);
    }

    /// @notice Transfers the series residual — escrow + premiumsAccrued − paidOut −
    ///         anything already withdrawn — to the creator. Series creator only, after
    ///         `redeemEnd`, never on a cancelled series (the refund already took the
    ///         one-shot residual through {cancelSeries}). One-shot.
    /// @dev Unredeemed claims release here: whatever settled cover was never redeemed
    ///      before `redeemEnd` stays in the escrow and returns to the creator, exactly
    ///      like the reserve release of an unsettled series. MUTUALLY EXCLUSIVE with
    ///      {cancelSeries} — see the latch note there; after this runs, cancel reverts
    ///      {ResidualAlreadyWithdrawn}.
    function withdrawResidual(uint256 seriesId) external nonReentrant {
        if (seriesId >= _series.length) revert InvalidSeries();
        Series storage s = _series[seriesId];
        if (msg.sender != s.creator) revert NotCreator();
        if (s.cancelled) revert SeriesClosed();
        if (s.residualWithdrawn) revert ResidualAlreadyWithdrawn();
        if (block.timestamp <= s.redeemEnd) revert RedeemWindowOpen();
        s.residualWithdrawn = true;
        uint256 amount = uint256(s.escrow) + s.premiumsAccrued - s.paidOut - s.withdrawn;
        s.withdrawn += amount;
        currency.safeTransfer(msg.sender, amount);
        emit ResidualWithdrawn(seriesId, msg.sender, amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Buyer / holder actions
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Buys `maxClaim` of protection for `msg.sender`, paying at most `maxPremium`.
    /// @dev Thin wrapper over {buyProtectionFor} with `recipient = msg.sender`.
    function buyProtection(uint256 seriesId, uint256 maxClaim, uint256 maxPremium) external {
        buyProtectionFor(seriesId, maxClaim, maxPremium, msg.sender);
    }

    /// @notice Buys `maxClaim` of protection minted to `recipient`; the premium is
    ///         pulled from `msg.sender` into the SERIES bucket and capped at
    ///         `maxPremium`.
    /// @dev Backing: `sold + maxClaim ≤ escrow`, so every claim unit is covered 1:1 by
    ///      the series' own escrow — no cross-series solvency check exists. Purchases
    ///      stop once a series is settled (buying a known outcome would drain the
    ///      escrow) or cancelled. A purchase whose nonzero premium rate truncates to
    ///      zero currency wei is rejected ({PremiumRoundsToZero}) — no free cover from
    ///      dust-sized claims; the smallest buyable claim is the one whose
    ///      `maxClaim × rateBps / 1e4` is at least 1 wei. A zero-rate series charges
    ///      no premium at all.
    ///
    ///      SOULBOUND: `recipient` only chooses where the claim units are MINTED —
    ///      {CoverToken} transfers stay disabled, so the position cannot move afterwards
    ///      and only `recipient` can redeem. A contract recipient must implement
    ///      `onERC1155Received` or the whole purchase reverts and no funds move.
    ///
    ///      ID BINDING: the purchase pins `seriesId` and `maxPremium` only — NOT the
    ///      strikes, windows or creator behind that id. Ids are append-only
    ///      (`seriesId == _series.length` at creation), so this only matters to a
    ///      buyer acting on an UNCONFIRMED `SeriesCreated` event: a racing
    ///      `createSeries` (or a reorg) can change which series id N resolves to,
    ///      including to one with the same premium rate but hostile strikes.
    ///      `maxPremium` bounds the price paid either way; the reference app resolves
    ///      the id and simulates against it before sending. Buy against confirmed
    ///      events. (This 4-arg signature is frozen — {SwapAndBuyRouter} pins it.)
    function buyProtectionFor(uint256 seriesId, uint256 maxClaim, uint256 maxPremium, address recipient)
        public
        nonReentrant
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (seriesId >= _series.length) revert InvalidSeries();
        Series storage s = _series[seriesId];
        if (maxClaim == 0) revert ZeroAmount();
        if (seriesPaused[seriesId]) revert SalesArePaused();
        if (s.cancelled) revert SeriesClosed();
        if (block.timestamp > s.saleEnd) revert SaleClosed();
        if (s.settled) revert SaleClosed();
        if (uint256(s.sold) + maxClaim > s.escrow) revert CapacityExceeded();

        uint256 premium = (maxClaim * s.premiumRateBps) / 1e4;
        if (premium == 0 && s.premiumRateBps > 0) revert PremiumRoundsToZero();
        if (premium > maxPremium) revert PremiumTooHigh(premium, maxPremium);

        s.sold += uint128(maxClaim); // ≤ escrow ≤ uint128.max, checked above
        s.premiumsAccrued += uint128(premium); // premium ≤ maxClaim, same bound
        if (premium > 0) currency.safeTransferFrom(msg.sender, address(this), premium);

        token.mint(recipient, seriesId, maxClaim);
        emit ProtectionBought(seriesId, msg.sender, recipient, maxClaim, premium);
    }

    /// @notice Permissionlessly settles `seriesId` from oracle observation `obsIndex`.
    /// @dev FIRST-SETTLE-WINS: settlement is one-shot, so when several qualifying
    ///      observations exist inside `[obsStart, obsEnd]` with different values, the
    ///      first successful call fixes the ratio forever and no later call can change
    ///      it. Creators (who prefer the lowest cents) and holders (who prefer the
    ///      highest) are both permissionless callers and must race; settling also shuts
    ///      the sale, so a settle-fast keeper both closes any informed-buy window and
    ///      fixes the ratio before selection games. `nonReentrant` is
    ///      defense in depth: settle is never legitimately called from within another
    ///      pool function, so it cannot be reached from the ERC-1155 mint acceptance
    ///      callback inside {buyProtectionFor}.
    function settle(uint256 seriesId, uint256 obsIndex) external nonReentrant {
        if (seriesId >= _series.length) revert InvalidSeries();
        Series storage s = _series[seriesId];
        if (s.cancelled) revert SeriesClosed();
        if (s.settled) revert AlreadySettled();
        (uint64 t, uint32 cents, bytes32 emailId) = oracle.observations(obsIndex);
        if (t < s.obsStart || t > s.obsEnd) revert ObservationOutOfWindow(t);

        uint256 ratio;
        if (cents <= s.strikeLowCents) {
            ratio = 0;
        } else if (cents >= s.strikeHighCents) {
            ratio = 1e18;
        } else {
            ratio = (uint256(cents - s.strikeLowCents) * 1e18) / (s.strikeHighCents - s.strikeLowCents);
        }

        s.settled = true;
        s.payoutRatioWad = uint64(ratio); // 1e18 < 2^64
        s.observationT = t;
        s.emailId = emailId;
        emit SeriesSettled(seriesId, obsIndex, uint64(ratio), cents, t, emailId);
    }

    /// @notice Burns `amount` claim units and pays `amount × ratio / 1e18` out of the
    ///         series escrow.
    /// @dev Claims are always payable while the window is open — the series pause
    ///      never blocks redemption.
    function redeem(uint256 seriesId, uint256 amount) external nonReentrant {
        if (seriesId >= _series.length) revert InvalidSeries();
        Series storage s = _series[seriesId];
        if (amount == 0) revert ZeroAmount();
        if (!s.settled) revert NotSettled();
        if (block.timestamp > s.redeemEnd) revert RedeemWindowClosed();

        token.burn(msg.sender, seriesId, amount); // reverts if balance < amount
        uint256 payout = (amount * s.payoutRatioWad) / 1e18;
        s.paidOut += uint128(payout); // ≤ sold × ratio ≤ escrow ≤ uint128.max
        if (payout > 0) currency.safeTransfer(msg.sender, payout);
        emit Redeemed(seriesId, msg.sender, amount, payout);
    }
}
