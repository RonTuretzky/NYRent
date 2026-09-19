// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CoverPool} from "../src/CoverPool.sol";
import {CoverToken} from "../src/CoverToken.sol";
import {MockObservationOracle} from "./utils/Helpers.sol";
import {TestUSDC} from "./CoverPool.t.sol";

/// @notice Randomized-sequence handler for {CoverPool}: fund / buy / buyFor / settle /
///         redeem / withdraw / pause (global and per-series) / sponsor handoff (start,
///         cancel, accept) / warp in any order the fuzzer picks. `currentSponsor`
///         shadows the pool's sponsor through every two-step handoff the fuzzer
///         completes.
contract PoolHandler is Test {
    CoverPool public pool;
    CoverToken public token;
    TestUSDC public usdc;
    MockObservationOracle public oracle;
    address[3] public sponsors;
    address public currentSponsor;
    address[3] public buyers;

    uint256 public constant ONE = 1e6;
    uint64 public constant T0 = 1_789_000_000;
    uint64 public constant OBS_START = T0 - 10 days;
    uint64 public constant OBS_END = T0 + 10 days;
    uint64 public constant REDEEM_END = OBS_END + 30 days;

    uint256 public ghostRedeemed; // Σ payouts sent to buyers

    constructor(
        CoverPool pool_,
        CoverToken token_,
        TestUSDC usdc_,
        MockObservationOracle oracle_,
        address[3] memory sponsors_
    ) {
        pool = pool_;
        token = token_;
        usdc = usdc_;
        oracle = oracle_;
        sponsors = sponsors_;
        currentSponsor = sponsors_[0];
        buyers[0] = makeAddr("h-buyer0");
        buyers[1] = makeAddr("h-buyer1");
        buyers[2] = makeAddr("h-buyer2");
        for (uint256 i = 0; i < 3; ++i) {
            usdc.mint(buyers[i], 1_000_000 * ONE);
            vm.prank(buyers[i]);
            usdc.approve(address(pool), type(uint256).max);
            usdc.mint(sponsors[i], 1_000_000 * ONE);
            vm.prank(sponsors[i]);
            usdc.approve(address(pool), type(uint256).max);
        }
    }

    function createSeries(uint16 rateBps, uint96 capRaw) external {
        uint128 cap = uint128(bound(uint256(capRaw), ONE, 10_000 * ONE));
        vm.prank(currentSponsor);
        pool.createSeries(8800, 9600, uint16(bound(rateBps, 0, 1e4)), OBS_END, OBS_START, OBS_END, REDEEM_END, cap);
    }

    function fund(uint96 amtRaw) external {
        uint256 amt = bound(uint256(amtRaw), 1, 10_000 * ONE);
        vm.prank(currentSponsor);
        pool.fundPool(amt);
    }

    function buy(uint8 who, uint8 seriesRaw, uint96 amtRaw) external {
        uint256 n = pool.seriesCount();
        if (n == 0) return;
        uint256 id = seriesRaw % n;
        address buyer = buyers[who % 3];
        uint256 amt = bound(uint256(amtRaw), 1, 100 * ONE);
        vm.prank(buyer);
        try pool.buyProtection(id, amt, type(uint256).max) {} catch {}
    }

    function buyFor(uint8 who, uint8 recipientRaw, uint8 seriesRaw, uint96 amtRaw) external {
        uint256 n = pool.seriesCount();
        if (n == 0) return;
        uint256 id = seriesRaw % n;
        address payer = buyers[who % 3];
        address recipient = buyers[recipientRaw % 3];
        uint256 amt = bound(uint256(amtRaw), 1, 100 * ONE);
        vm.prank(payer);
        try pool.buyProtectionFor(id, amt, type(uint256).max, recipient) {} catch {}
    }

    function settle(uint8 seriesRaw, uint32 cents, uint32 tOffset) external {
        uint256 n = pool.seriesCount();
        if (n == 0) return;
        uint256 id = seriesRaw % n;
        uint64 t = uint64(bound(uint256(tOffset), 0, 30 days)) + OBS_START - 5 days; // sometimes out of window
        uint256 obsIndex = oracle.push(t, cents, keccak256(abi.encode(t, cents, obsIndexSalt++)));
        try pool.settle(id, obsIndex) {} catch {}
    }

    uint256 internal obsIndexSalt;

    function redeem(uint8 who, uint8 seriesRaw, uint96 amtRaw) external {
        uint256 n = pool.seriesCount();
        if (n == 0) return;
        uint256 id = seriesRaw % n;
        address buyer = buyers[who % 3];
        uint256 balance = token.balanceOf(buyer, id);
        if (balance == 0) return;
        uint256 amt = bound(uint256(amtRaw), 1, balance);
        uint256 before = usdc.balanceOf(buyer);
        vm.prank(buyer);
        try pool.redeem(id, amt) {
            ghostRedeemed += usdc.balanceOf(buyer) - before;
        } catch {}
    }

    function withdrawExcess(uint96 amtRaw) external {
        uint256 free = pool.freeCapital();
        if (free == 0) return;
        uint256 amt = bound(uint256(amtRaw), 1, free);
        vm.prank(currentSponsor);
        pool.withdrawExcess(amt);
    }

    function setPaused(bool paused) external {
        vm.prank(currentSponsor);
        pool.setSalesPaused(paused);
    }

    function setSeriesPaused(uint8 seriesRaw, bool paused) external {
        uint256 n = pool.seriesCount();
        if (n == 0) return;
        vm.prank(currentSponsor);
        pool.setSeriesPaused(seriesRaw % n, paused);
    }

    function startHandoff(uint8 toRaw) external {
        vm.prank(currentSponsor);
        pool.transferSponsorship(sponsors[toRaw % 3]); // may overwrite an in-flight handoff
    }

    function cancelHandoff() external {
        if (pool.pendingSponsor() == address(0)) return;
        vm.prank(currentSponsor);
        pool.cancelSponsorshipTransfer();
    }

    function acceptHandoff() external {
        address pending = pool.pendingSponsor();
        if (pending == address(0)) return;
        vm.prank(pending);
        pool.acceptSponsorship();
        currentSponsor = pending;
    }

    function warp(uint32 delta) external {
        vm.warp(block.timestamp + bound(uint256(delta), 0, 5 days));
    }
}

/// @notice PRD invariants under random sequences — solvency, reserve/sold, ratio
///         bounds, capacity, plus the sponsor-consistency check for the two-step
///         handoff (with cancel).
contract CoverPoolInvariantTest is Test {
    TestUSDC internal usdc;
    MockObservationOracle internal oracle;
    CoverToken internal token;
    CoverPool internal pool;
    PoolHandler internal handler;
    address[3] internal sponsors;

    function setUp() public {
        vm.warp(1_789_000_000);
        sponsors = [makeAddr("sponsor0"), makeAddr("sponsor1"), makeAddr("sponsor2")];
        usdc = new TestUSDC();
        oracle = new MockObservationOracle();
        uint64 nonce = vm.getNonce(address(this));
        address predictedPool = vm.computeCreateAddress(address(this), nonce + 1);
        token = new CoverToken(predictedPool, usdc.decimals());
        pool = new CoverPool(usdc, token, oracle, sponsors[0]);
        handler = new PoolHandler(pool, token, usdc, oracle, sponsors);
        targetContract(address(handler));
    }

    /// @notice SOLVENCY: the pool always holds at least Σ reservedOf(series).
    function invariant_solvency() public view {
        assertGe(usdc.balanceOf(address(pool)), pool.totalReserved());
    }

    /// @notice Token supply accounting: for every series, circulating claim units
    ///         equal sold − redeemed-units, where redeemed value maps back through
    ///         the ratio. Checked as: reserved never exceeds sold (before release).
    function invariant_reserveNeverExceedsSold() public view {
        uint256 n = pool.seriesCount();
        for (uint256 i = 0; i < n; ++i) {
            assertLe(pool.reservedOf(i), pool.series(i).sold);
        }
    }

    /// @notice Settlement is one-shot: a settled series' ratio and provenance are
    ///         immutable (spot-check: ratio stays within [0, 1e18]).
    function invariant_ratioBounded() public view {
        uint256 n = pool.seriesCount();
        for (uint256 i = 0; i < n; ++i) {
            CoverPool.Series memory s = pool.series(i);
            assertLe(s.payoutRatioWad, 1e18);
            if (!s.settled) assertEq(s.payoutRatioWad, 0);
        }
    }

    /// @notice Sold never exceeds capacity.
    function invariant_capacityRespected() public view {
        uint256 n = pool.seriesCount();
        for (uint256 i = 0; i < n; ++i) {
            CoverPool.Series memory s = pool.series(i);
            assertLe(s.sold, s.capacity);
        }
    }

    /// @notice Sponsor consistency: the pool's sponsor is always the handler's shadow
    ///         copy (never zero, never an unknown address), and any pending sponsor is
    ///         zero or a known candidate.
    function invariant_sponsorConsistent() public view {
        address s = pool.sponsor();
        assertEq(s, handler.currentSponsor());
        assertTrue(s == sponsors[0] || s == sponsors[1] || s == sponsors[2]);
        address pending = pool.pendingSponsor();
        assertTrue(pending == address(0) || pending == sponsors[0] || pending == sponsors[1] || pending == sponsors[2]);
    }
}
