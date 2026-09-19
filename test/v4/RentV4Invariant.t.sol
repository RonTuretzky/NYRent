// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {RentV4TestBase, V4TestCurrency} from "./RentV4.t.sol";
import {RentV4Market} from "../../src/v4/RentV4Market.sol";
import {RentV4Router} from "../../src/v4/RentV4Router.sol";
import {MockObservationOracle} from "../utils/Helpers.sol";

contract RentV4Handler is Test {
    V4TestCurrency public immutable currency;
    RentV4Market public immutable market;
    RentV4Router public immutable router;
    MockObservationOracle public immutable oracle;
    address[3] public actors;
    uint256 public donations;
    bool public forbiddenTradeSucceeded;
    bool public forbiddenTransferSucceeded;
    bool public forbiddenRemovalSucceeded;
    int24 internal constant LOWER = -887220;
    int24 internal constant UPPER = 887220;

    constructor(
        V4TestCurrency c,
        RentV4Market m,
        RentV4Router r,
        MockObservationOracle o,
        address a,
        address b,
        address buyer
    ) {
        currency = c;
        market = m;
        router = r;
        oracle = o;
        actors = [a, b, buyer];
    }

    function deposit(uint256 actorSeed, uint96 amountSeed) external {
        address actor = actors[actorSeed % 3];
        uint256 amount = bound(amountSeed, 1, 1000e6);
        currency.mint(actor, amount);
        vm.startPrank(actor);
        currency.approve(address(market), type(uint256).max);
        bool open = market.tradingOpen();
        try market.depositAndMint(amount, actor) {
            if (!open) forbiddenTradeSucceeded = true;
        } catch {}
        vm.stopPrank();
    }

    function swap(uint256 actorSeed, bool buy, uint96 amountSeed) external {
        address actor = actors[actorSeed % 3];
        uint256 balance = buy ? currency.balanceOf(actor) : market.balanceOf(actor);
        if (balance == 0) return;
        uint128 amount = uint128(bound(amountSeed, 1, balance < 100e6 ? balance : 100e6));
        bool open = market.tradingOpen();
        vm.prank(actor);
        try router.swapExactInput(
            RentV4Router.SwapRequest(address(market), buy, amount, 0, 0, actor, block.timestamp)
        ) returns (
            uint256, uint256
        ) {
            if (!open) forbiddenTradeSucceeded = true;
        } catch {}
    }

    function addLiquidity(uint256 actorSeed, uint96 amountSeed) external {
        address actor = actors[actorSeed % 3];
        int128 amount = int128(int256(bound(amountSeed, 1, 100e6)));
        bool open = market.tradingOpen();
        vm.prank(actor);
        try router.modifyLiquidity(
            RentV4Router.LiquidityRequest(
                address(market), LOWER, UPPER, amount, type(uint128).max, type(uint128).max, actor, block.timestamp
            )
        ) {
            if (!open) forbiddenTradeSucceeded = true;
        } catch {}
    }

    function removeLiquidity(uint256 actorSeed, uint96 amountSeed) external {
        address actor = actors[actorSeed % 3];
        uint128 current = router.liquidityOf(actor, address(market), LOWER, UPPER);
        if (current == 0) return;
        int128 amount = int128(int256(bound(amountSeed, 0, current)));
        bool open = market.liquidityRemovalOpen();
        vm.prank(actor);
        try router.modifyLiquidity(
            RentV4Router.LiquidityRequest(address(market), LOWER, UPPER, -amount, 0, 0, actor, block.timestamp)
        ) {
            if (!open) forbiddenRemovalSucceeded = true;
        } catch {}
    }

    function transfer(uint256 actorSeed, uint96 amountSeed) external {
        address actor = actors[actorSeed % 3];
        address recipient = actors[(actorSeed % 3 + 1) % 3];
        uint256 balance = market.balanceOf(actor);
        if (balance == 0) return;
        uint256 amount = bound(amountSeed, 0, balance);
        bool open = market.transfersOpen();
        vm.prank(actor);
        try market.transfer(recipient, amount) {
            if (!open) forbiddenTransferSucceeded = true;
        } catch {}
    }

    function advanceTime(uint32 secondsSeed) external {
        uint256 next;
        uint256 mode = secondsSeed % 6;
        if (mode == 0) next = market.saleEnd() - 1;
        else if (mode == 1) next = market.saleEnd();
        else if (mode == 2) next = market.obsEnd();
        else if (mode == 3) next = market.redeemEnd();
        else if (mode == 4) next = market.redeemEnd() + 1;
        else next = block.timestamp + bound(secondsSeed, 1, 10 days);
        if (next > block.timestamp) vm.warp(next);
    }

    function settle(uint32 centsSeed) external {
        if (block.timestamp < market.obsStart() || market.settled()) return;
        uint64 timestamp = uint64(block.timestamp > market.obsEnd() ? market.obsEnd() : block.timestamp);
        uint32 cents = uint32(bound(centsSeed, 9000, 11000));
        uint256 index = oracle.push(timestamp, cents, keccak256(abi.encode(timestamp, cents)));
        market.settle(index);
    }

    function redeem(uint256 actorSeed, uint96 amountSeed) external {
        address actor = actors[actorSeed % 3];
        uint256 balance = market.balanceOf(actor);
        if (balance == 0) return;
        uint256 amount = bound(amountSeed, 1, balance);
        vm.prank(actor);
        try market.redeem(amount, actor) {} catch {}
    }

    function withdrawResidual(uint256 actorSeed) external {
        address actor = actors[actorSeed % 3];
        vm.prank(actor);
        try market.withdrawResidual(actor) {} catch {}
    }

    function donate(uint96 amountSeed) external {
        uint256 amount = bound(amountSeed, 1, 100e6);
        currency.mint(address(market), amount);
        donations += amount;
    }
}

contract RentV4InvariantTest is StdInvariant, RentV4TestBase {
    RentV4Handler internal handler;

    function setUp() public override {
        super.setUp();
        _liquidity(alice, SEED_LIQUIDITY);
        handler = new RentV4Handler(currency, market, router, oracle, alice, bob, buyer);
        bytes4[] memory selectors = new bytes4[](10);
        selectors[0] = handler.deposit.selector;
        selectors[1] = handler.swap.selector;
        selectors[2] = handler.addLiquidity.selector;
        selectors[3] = handler.removeLiquidity.selector;
        selectors[4] = handler.transfer.selector;
        selectors[5] = handler.advanceTime.selector;
        selectors[6] = handler.settle.selector;
        selectors[7] = handler.redeem.selector;
        selectors[8] = handler.withdrawResidual.selector;
        selectors[9] = handler.donate.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
        targetContract(address(handler));
    }

    function invariant_escrowConservationIncludingDonations() public view {
        assertEq(
            currency.balanceOf(address(market)),
            market.totalDeposited() - market.paidOut() - market.residualPaid() + handler.donations()
        );
        assertEq(market.escrowAccounted() + market.paidOut() + market.residualPaid(), market.totalDeposited());
    }

    function invariant_claimsRemainFullyFundedWhileRedeemable() public view {
        if (block.timestamp <= market.redeemEnd()) {
            // Stronger than ratio-adjusted solvency: every remaining RENT is still backed at face value.
            assertLe(market.totalSupply(), currency.balanceOf(address(market)));
        }
        assertLe(market.paidOut() + market.residualPaid(), market.totalDeposited());
    }

    function invariant_allRentRemainsAccountedAndRouterHasNoCustody() public view {
        uint256 held = market.balanceOf(alice) + market.balanceOf(bob) + market.balanceOf(buyer)
            + market.balanceOf(address(manager));
        assertEq(held, market.totalSupply());
        assertEq(market.balanceOf(address(router)), 0);
        assertEq(currency.balanceOf(address(router)), 0);
    }

    function invariant_noWindowBypass() public view {
        assertFalse(handler.forbiddenTradeSucceeded());
        assertFalse(handler.forbiddenTransferSucceeded());
        assertFalse(handler.forbiddenRemovalSucceeded());
    }

    function invariant_residualSharesStayWithDepositors() public view {
        assertEq(
            market.residualShares(alice) + market.residualShares(bob) + market.residualShares(buyer),
            market.totalDeposited()
        );
    }
}
