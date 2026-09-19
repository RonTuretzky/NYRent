// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CoverToken} from "./CoverToken.sol";
import {IObservationOracle} from "./interfaces/IObservationOracle.sol";

/// @title CoverPool
/// @notice Fully collateralized rent-protection pool. The sponsor funds capital and
///         creates series; buyers pay a premium to mint {CoverToken} claim units;
///         settlement is permissionless against a qualifying {CredailyRentOracle}
///         observation; redemption pays `amount × payoutRatio` while the claim window
///         is open. No upgradeability, no series setters, no fee sink.
///
///         Core features:
///         - the sponsor role is transferable through the two-step
///           {transferSponsorship} / {acceptSponsorship} handoff (cancellable via
///           {cancelSponsorshipTransfer}) — renouncing to the zero address is
///           disallowed, so the pool always has a live sponsor;
///         - {buyProtectionFor} splits payer from holder: the premium is pulled from
///           `msg.sender` while the claim units are minted to `recipient`, so routers
///           and agent wallets never strand cover on themselves;
///         - sales can be paused per series ({setSeriesPaused}) in addition to the
///           global {setSalesPaused} switch.
///
///         SOULBOUND: {CoverToken} transfers are disabled. The `recipient` of
///         {buyProtectionFor} is a MINT DESTINATION only — cover cannot change hands
///         after minting, and only the recipient can redeem.
/// @dev    Solvency invariant: currency.balanceOf(pool) ≥ Σ reservedOf(seriesId) at all
///         times — enforced at issuance and on sponsor withdrawals; settlement and
///         redemption can only lower Σ reserved.
contract CoverPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────────────────

    struct Series {
        uint32 strikeLowCents; // payout 0 at/below     (demo: 9288)
        uint32 strikeHighCents; // payout 1 at/above     (demo: 10088)
        uint16 premiumRateBps; // premium per 1e4 of max claim (demo: 1133)
        uint64 saleEnd; // no purchases after
        uint64 obsStart; // observation window [obsStart, obsEnd]
        uint64 obsEnd;
        uint64 redeemEnd; // = obsEnd + claim window; after: reserves release
        uint128 capacity; // max total max-claim (currency wei)
        uint128 sold; // total max-claim sold
        bool settled;
        uint64 payoutRatioWad; // ratio in 1e18, set once
        uint64 observationT; // provenance
        bytes32 emailId;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Events / errors
    // ─────────────────────────────────────────────────────────────────────────

    event SeriesCreated(
        uint256 indexed seriesId,
        uint32 strikeLowCents,
        uint32 strikeHighCents,
        uint16 premiumRateBps,
        uint64 saleEnd,
        uint64 obsStart,
        uint64 obsEnd,
        uint64 redeemEnd,
        uint128 capacity
    );
    event PoolFunded(address indexed from, uint256 amount);
    event ExcessWithdrawn(address indexed to, uint256 amount);
    event SalesPausedSet(bool paused);
    event SeriesPausedSet(uint256 indexed seriesId, bool paused);
    event SponsorshipTransferStarted(address indexed sponsor, address indexed pendingSponsor);
    event SponsorshipTransferCanceled(address indexed sponsor, address indexed pendingSponsor);
    event SponsorshipTransferred(address indexed oldSponsor, address indexed newSponsor);
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

    error NotSponsor();
    error NotPendingSponsor();
    error NoHandoffInFlight();
    error ZeroAddress();
    error InvalidSeries();
    error InvalidParams(string what);
    error SaleClosed();
    error SalesArePaused();
    error ZeroAmount();
    error CapacityExceeded();
    error PremiumTooHigh(uint256 premium, uint256 maxPremium);
    error PremiumRoundsToZero();
    error Insolvent();
    error AlreadySettled();
    error NotSettled();
    error ObservationOutOfWindow(uint64 t);
    error RedeemWindowClosed();
    error InsufficientFreeCapital(uint256 requested, uint256 free);

    // ─────────────────────────────────────────────────────────────────────────
    // Immutable configuration
    // ─────────────────────────────────────────────────────────────────────────

    IERC20 public immutable currency;
    CoverToken public immutable token;
    IObservationOracle public immutable oracle;

    // ─────────────────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Sole holder of the fund/withdraw/pause/create levers. Hands over via
    ///         {transferSponsorship} + {acceptSponsorship} only.
    address public sponsor;

    /// @notice Address that may claim the sponsor role via {acceptSponsorship};
    ///         zero when no handoff is in flight.
    address public pendingSponsor;

    Series[] internal _series;

    /// @notice Cumulative currency paid out to redeemers, per series.
    mapping(uint256 seriesId => uint256) public redeemedPayout;

    /// @notice Sponsor-controlled global sales switch. NEVER blocks settle or redeem.
    bool public salesPaused;

    /// @notice Sponsor-controlled per-series sales switch. A purchase requires both
    ///         this and {salesPaused} to be false. NEVER blocks settle or redeem.
    mapping(uint256 seriesId => bool) public seriesPaused;

    modifier onlySponsor() {
        if (msg.sender != sponsor) revert NotSponsor();
        _;
    }

    constructor(IERC20 currency_, CoverToken token_, IObservationOracle oracle_, address sponsor_) {
        if (sponsor_ == address(0)) revert ZeroAddress();
        currency = currency_;
        token = token_;
        oracle = oracle_;
        sponsor = sponsor_;
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

    /// @notice Currency the pool must hold back for `seriesId` right now:
    ///         `sold` before settlement; `sold × ratio − paid out` after settlement
    ///         until `redeemEnd`; 0 after `redeemEnd` (reserves release).
    function reservedOf(uint256 seriesId) public view returns (uint256) {
        Series storage s = _series[seriesId];
        if (block.timestamp > s.redeemEnd) return 0;
        if (!s.settled) return s.sold;
        return (uint256(s.sold) * s.payoutRatioWad) / 1e18 - redeemedPayout[seriesId];
    }

    /// @notice Σ reservedOf over all series.
    function totalReserved() public view returns (uint256 total) {
        uint256 n = _series.length;
        for (uint256 i = 0; i < n; ++i) {
            total += reservedOf(i);
        }
    }

    /// @notice Capital not backing any live claim; the sponsor may withdraw up to this.
    function freeCapital() public view returns (uint256) {
        uint256 balance = currency.balanceOf(address(this));
        uint256 reserved = totalReserved();
        return balance > reserved ? balance - reserved : 0;
    }

    /// @notice Premium quote for `maxClaim` of protection.
    /// @return premium Total premium in currency wei.
    /// @return rateBps The series premium rate.
    /// @return capacityLeft Unsold capacity (max-claim wei).
    /// @return issuableNow Max-claim the pool could actually back right now
    ///         (min of capacity left and free capital + incoming premium headroom).
    function quote(uint256 seriesId, uint256 maxClaim)
        external
        view
        returns (uint256 premium, uint16 rateBps, uint256 capacityLeft, uint256 issuableNow)
    {
        if (seriesId >= _series.length) revert InvalidSeries();
        Series storage s = _series[seriesId];
        premium = (maxClaim * s.premiumRateBps) / 1e4;
        rateBps = s.premiumRateBps;
        capacityLeft = s.capacity - s.sold;
        // Issuing x adds x to reserved and x·rate/1e4 to balance, so headroom satisfies
        // x − x·rate/1e4 ≤ freeCapital  ⇒  x ≤ freeCapital·1e4/(1e4 − rate)  (rate < 1e4).
        uint256 free = freeCapital();
        uint256 solvencyMax = s.premiumRateBps >= 1e4 ? type(uint256).max : (free * 1e4) / (1e4 - s.premiumRateBps);
        issuableNow = capacityLeft < solvencyMax ? capacityLeft : solvencyMax;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Sponsor actions
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Starts the two-step sponsor handoff: `newSponsor` takes over only once
    ///         it calls {acceptSponsorship}. Overwrites any handoff still in flight.
    /// @dev Renouncing is disallowed — the pool must always keep a sponsor who can
    ///      fund, pause and withdraw — so the zero address is rejected; use
    ///      {cancelSponsorshipTransfer} to abort a handoff instead.
    ///
    ///      TRUST MODEL: the handoff transfers the levers, not any capital guarantee.
    ///      Until {acceptSponsorship} lands, the OUTGOING sponsor keeps every lever —
    ///      it can withdraw all free capital, pause sales, or overwrite/cancel the
    ///      pending handoff. Reserved backing for sold cover stays untouchable either
    ///      way. Incoming sponsors: verify `freeCapital()` and both pause switches
    ///      right after accepting, and fund only once the handoff has completed (see
    ///      docs/OPERATIONS.md).
    function transferSponsorship(address newSponsor) external onlySponsor {
        if (newSponsor == address(0)) revert ZeroAddress();
        pendingSponsor = newSponsor;
        emit SponsorshipTransferStarted(msg.sender, newSponsor);
    }

    /// @notice Aborts the handoff in flight in one transaction: the pending sponsor
    ///         loses its claim immediately and can no longer accept.
    function cancelSponsorshipTransfer() external onlySponsor {
        address pending = pendingSponsor;
        if (pending == address(0)) revert NoHandoffInFlight();
        delete pendingSponsor;
        emit SponsorshipTransferCanceled(msg.sender, pending);
    }

    /// @notice Completes the handoff started by {transferSponsorship}. Callable only by
    ///         the pending sponsor; the previous sponsor loses every lever atomically.
    function acceptSponsorship() external {
        if (msg.sender != pendingSponsor) revert NotPendingSponsor();
        address oldSponsor = sponsor;
        sponsor = msg.sender;
        delete pendingSponsor;
        emit SponsorshipTransferred(oldSponsor, msg.sender);
    }

    /// @notice Pulls `amt` currency from the sponsor into the pool as backing capital.
    function fundPool(uint256 amt) external onlySponsor nonReentrant {
        if (amt == 0) revert ZeroAmount();
        currency.safeTransferFrom(msg.sender, address(this), amt);
        emit PoolFunded(msg.sender, amt);
    }

    /// @notice Withdraws capital not reserved for any live claim.
    function withdrawExcess(uint256 amt) external onlySponsor nonReentrant {
        uint256 free = freeCapital();
        if (amt > free) revert InsufficientFreeCapital(amt, free);
        currency.safeTransfer(msg.sender, amt);
        emit ExcessWithdrawn(msg.sender, amt);
    }

    /// @notice Global sales switch across every series. NEVER blocks settle or redeem.
    function setSalesPaused(bool paused) external onlySponsor {
        salesPaused = paused;
        emit SalesPausedSet(paused);
    }

    /// @notice Pauses or resumes sales for `seriesId` alone; other series keep selling.
    ///         NEVER blocks settle or redeem.
    function setSeriesPaused(uint256 seriesId, bool paused) external onlySponsor {
        if (seriesId >= _series.length) revert InvalidSeries();
        seriesPaused[seriesId] = paused;
        emit SeriesPausedSet(seriesId, paused);
    }

    /// @notice Creates a new protection series. Parameters are immutable afterwards —
    ///         no setter exists at all.
    /// @dev Production recommendation: `saleEnd ≤ obsStart` so buyers cannot trade on a
    ///      qualifying observation that already exists (the demo series pins
    ///      `saleEnd = obsStart`; see docs/PROTOCOL.md).
    function createSeries(
        uint32 strikeLowCents,
        uint32 strikeHighCents,
        uint16 premiumRateBps,
        uint64 saleEnd,
        uint64 obsStart,
        uint64 obsEnd,
        uint64 redeemEnd,
        uint128 capacity
    ) external onlySponsor returns (uint256 seriesId) {
        if (strikeLowCents >= strikeHighCents) revert InvalidParams("strikes");
        if (saleEnd > obsEnd) revert InvalidParams("saleEnd");
        if (!(obsStart < obsEnd && obsEnd < redeemEnd)) revert InvalidParams("windows");
        if (capacity == 0) revert InvalidParams("capacity");
        seriesId = _series.length;
        _series.push(
            Series({
                strikeLowCents: strikeLowCents,
                strikeHighCents: strikeHighCents,
                premiumRateBps: premiumRateBps,
                saleEnd: saleEnd,
                obsStart: obsStart,
                obsEnd: obsEnd,
                redeemEnd: redeemEnd,
                capacity: capacity,
                sold: 0,
                settled: false,
                payoutRatioWad: 0,
                observationT: 0,
                emailId: bytes32(0)
            })
        );
        emit SeriesCreated(
            seriesId, strikeLowCents, strikeHighCents, premiumRateBps, saleEnd, obsStart, obsEnd, redeemEnd, capacity
        );
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
    ///         pulled from `msg.sender` and capped at `maxPremium`.
    /// @dev Solvency: after collecting the premium, Σ reserved (with the new `sold`)
    ///      must not exceed the pool balance. Purchases stop once a series is settled
    ///      (buying a known outcome would drain the pool). A purchase whose premium
    ///      truncates to zero currency wei is rejected ({PremiumRoundsToZero}) — no
    ///      free cover from dust-sized claims; the smallest buyable claim is the one
    ///      whose `maxClaim × rateBps / 1e4` is at least 1 wei.
    ///
    ///      SOULBOUND: `recipient` only chooses where the claim units are MINTED —
    ///      {CoverToken} transfers stay disabled, so the position cannot move afterwards
    ///      and only `recipient` can redeem. A contract recipient must implement
    ///      `onERC1155Received` or the whole purchase reverts and no funds move.
    function buyProtectionFor(uint256 seriesId, uint256 maxClaim, uint256 maxPremium, address recipient)
        public
        nonReentrant
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (seriesId >= _series.length) revert InvalidSeries();
        Series storage s = _series[seriesId];
        if (maxClaim == 0) revert ZeroAmount();
        if (salesPaused || seriesPaused[seriesId]) revert SalesArePaused();
        if (block.timestamp > s.saleEnd) revert SaleClosed();
        if (s.settled) revert SaleClosed();
        if (uint256(s.sold) + maxClaim > s.capacity) revert CapacityExceeded();

        uint256 premium = (maxClaim * s.premiumRateBps) / 1e4;
        if (premium == 0) revert PremiumRoundsToZero();
        if (premium > maxPremium) revert PremiumTooHigh(premium, maxPremium);

        s.sold += uint128(maxClaim); // ≤ capacity ≤ uint128.max, checked above
        currency.safeTransferFrom(msg.sender, address(this), premium);
        if (currency.balanceOf(address(this)) < totalReserved()) revert Insolvent();

        token.mint(recipient, seriesId, maxClaim);
        emit ProtectionBought(seriesId, msg.sender, recipient, maxClaim, premium);
    }

    /// @notice Permissionlessly settles `seriesId` from oracle observation `obsIndex`.
    /// @dev One-shot: if several observations qualify inside the window, the FIRST
    ///      successful call wins and the ratio is fixed forever. `nonReentrant` is
    ///      defense in depth: settle is never legitimately called from within another
    ///      pool function, so it cannot be reached from the ERC-1155 mint acceptance
    ///      callback inside {buyProtectionFor}.
    function settle(uint256 seriesId, uint256 obsIndex) external nonReentrant {
        if (seriesId >= _series.length) revert InvalidSeries();
        Series storage s = _series[seriesId];
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

    /// @notice Burns `amount` claim units and pays `amount × ratio / 1e18`.
    /// @dev Claims are always payable while reserved — neither pause switch ever blocks
    ///      redemption.
    function redeem(uint256 seriesId, uint256 amount) external nonReentrant {
        if (seriesId >= _series.length) revert InvalidSeries();
        Series storage s = _series[seriesId];
        if (amount == 0) revert ZeroAmount();
        if (!s.settled) revert NotSettled();
        if (block.timestamp > s.redeemEnd) revert RedeemWindowClosed();

        token.burn(msg.sender, seriesId, amount); // reverts if balance < amount
        uint256 payout = (amount * s.payoutRatioWad) / 1e18;
        redeemedPayout[seriesId] += payout;
        if (payout > 0) currency.safeTransfer(msg.sender, payout);
        emit Redeemed(seriesId, msg.sender, amount, payout);
    }
}
